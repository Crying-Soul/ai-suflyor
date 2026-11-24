//! Answer pipeline: one actor per tier (quick hint, full answer). Each owns an LLM session,
//! turns a transcript snapshot into a user turn and streams the reply to the UI.
//! A newer request cancels the one in progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use protocol::{ErrorKind, Event, Tier, Trigger};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{Backend, Config};
use crate::context;
use crate::llm::{self, Chunk, Session};
use crate::screen::Shot;
use crate::{FinalSegment, Shared};

struct Req {
    id: u64,
    turn: u64,
    model: String,
    trigger: Trigger,
    question: String,
    q_t: Option<u64>,
    segs: Arc<Vec<FinalSegment>>,
    shot: Option<Arc<Shot>>,
    /// File name of the shot saved in the open call.
    shot_file: Option<String>,
}

enum Msg {
    Ask(Req),
    Clear,
    /// New system prompt (another call's context): the session restarts on it. `warm_cache`: write it
    /// to the prompt cache now (a call is open, a question is near).
    Reconfigure {
        system: String,
        warm_cache: bool,
    },
    /// Drop answer turn `turn` (an early answer whose question went on); other turns ignore it.
    Cancel {
        turn: u64,
    },
    /// New notes stand in for the old transcript: restart the session on them once the current answer is done.
    Compact,
    /// The answerer is replaced (`reload_llm`): finish the answer in progress, then stop.
    Stop,
}

/// What the STT side tells auto-detect about the other side.
enum Auto {
    /// A confirmed final.
    Final,
    /// Speculative decode at the first pause (speculative mode): the final unless speech resumes.
    Early(FinalSegment),
    /// Speech came back after that pause.
    Resumed,
    /// The answerer is replaced.
    Stop,
}

#[derive(Clone)]
pub struct Answerer {
    cfg: Arc<Config>,
    full: mpsc::UnboundedSender<Msg>,
    quick: Option<(mpsc::UnboundedSender<Msg>, String)>,
    /// Answer and turn ids; shared with the answerer this one replaces, so ids keep growing.
    next_id: Arc<AtomicU64>,
    /// "them" finals, early decodes and resumes for auto-detect.
    auto: mpsc::UnboundedSender<Auto>,
    /// `brief::key` of the context now in use: a brief made for an older one is not applied.
    context_key: Arc<std::sync::Mutex<String>>,
    /// A call is open: a new system prompt goes to the prompt cache right away.
    warm_cache: Arc<AtomicBool>,
    /// For the token usage of one-off sessions (notes, brief, summary).
    events: crate::EventTx,
}

/// Rolling summary of a long call: the transcript before `upto` is replaced by `text` in new sessions.
#[derive(Default)]
pub struct Notes {
    pub text: String,
    /// Index into `Shared::transcript` of the first segment still sent verbatim.
    pub upto: usize,
    /// A summary is being made.
    busy: bool,
    /// Bumped when the transcript is replaced; a summary of the old one is dropped.
    generation: u64,
}

/// Once the verbatim transcript passes this, its older part is summarized (one cache reset per step).
const COMPACT_TOKENS: u64 = 25_000;
/// The newest part stays verbatim.
const KEEP_TOKENS: u64 = 5_000;

const NOTES_SYSTEM: &str = "You compress the earlier part of a live call (often a job interview) into notes for an assistant \
that keeps helping the user in the same call. Lines starting with \"Q:\" are the other side, \"A:\" the user; \
the transcript comes from speech recognition. Keep: topics covered, each question asked and the gist of the user's answer, \
facts about the user, the company and the role, numbers and names, promises and open threads. \
Keep a separate list of the user's own claims: stories and projects told, numbers, salary or conditions named, \
so later answers do not contradict them. \
Merge the previous notes in. Terse bullet points in the language of the call, at most 500 words, no preamble.";

/// Where to cut `segs` (the verbatim part) for a summary: None while it is short enough.
fn compact_cut(segs: &[FinalSegment]) -> Option<usize> {
    if context::tokens(&llm::render(segs)) < COMPACT_TOKENS {
        return None;
    }
    let mut kept = 0;
    let mut cut = segs.len();
    while cut > 0 && kept < KEEP_TOKENS {
        cut -= 1;
        kept += context::tokens(&segs[cut].text);
    }
    (cut > 0).then_some(cut)
}

/// After a "them" final, wait this long for more speech before deciding the turn is over.
const AUTO_SETTLE_MS: u64 = 250;

impl Answerer {
    /// `context`: the assembled context block (`context::assemble`) for the system prompt.
    pub fn start(cfg: &Config, shared: Arc<Shared>, context: &str) -> Answerer {
        let cfg = Arc::new(cfg.clone());
        let tier = |tier: Tier, model: &str| {
            let system = llm::system_prompt(tier == Tier::Quick, context, &cfg.user_language);
            TierActor::spawn(tier, session(&cfg, tier, system), model.to_string(), shared.clone())
        };
        let full = tier(Tier::Full, &cfg.model);
        let quick = cfg.two_tier.then(|| (tier(Tier::Quick, &cfg.quick_model), cfg.quick_model.clone()));
        let (auto, auto_rx) = mpsc::unbounded_channel();
        let a = Answerer {
            cfg: cfg.clone(),
            full,
            quick,
            next_id: shared.ids.clone(),
            auto,
            context_key: Arc::new(std::sync::Mutex::new(crate::brief::key(context))),
            warm_cache: Default::default(),
            events: shared.events.clone(),
        };
        tokio::spawn(auto_detect(a.clone(), shared, auto_rx));
        a
    }

    /// Stops the tiers (each after its answer in progress) and auto-detect: a new answerer takes over.
    pub fn stop(&self) {
        self.send_all(|| Msg::Stop);
        let _ = self.auto.send(Auto::Stop);
    }

    /// Called by the STT worker for every "them" final.
    pub fn on_them_final(&self) {
        let _ = self.auto.send(Auto::Final);
    }

    /// Called by the STT worker for a "them" speculative decode (text at the first pause).
    pub fn on_them_early(&self, seg: FinalSegment) {
        let _ = self.auto.send(Auto::Early(seg));
    }

    /// Called when the other side's speech resumes after a pause.
    pub fn on_them_resumed(&self) {
        let _ = self.auto.send(Auto::Resumed);
    }

    /// Starts both tiers. `question`: (text, start of its transcript run); None = the latest "them" run.
    pub fn ask(&self, shared: &Arc<Shared>, trigger: Trigger, question: Option<(String, Option<u64>)>, shot: Option<Shot>) {
        let segs = Arc::new(shared.transcript.lock().unwrap().clone());
        self.ask_on(shared, trigger, question, shot, segs);
    }

    /// Starts a summary of the older transcript once the verbatim part is too long.
    fn maybe_compact(&self, shared: &Arc<Shared>, segs: &[FinalSegment]) {
        let (upto, prev, generation) = {
            let n = shared.notes.lock().unwrap();
            if n.busy {
                return;
            }
            (n.upto.min(segs.len()), n.text.clone(), n.generation)
        };
        let Some(cut) = compact_cut(&segs[upto..]).map(|c| upto + c) else { return };
        shared.notes.lock().unwrap().busy = true;
        info!("notes: summarizing segments {upto}..{cut} of {}", segs.len());
        let (a, shared, old) = (self.clone(), shared.clone(), segs[upto..cut].to_vec());
        tokio::spawn(async move {
            let started = Instant::now();
            let r = a.notes(&prev, &old).await;
            let mut n = shared.notes.lock().unwrap();
            n.busy = false;
            match r {
                Ok(text) if n.generation == generation => {
                    info!("notes: {} tokens in {} ms, the next turns start a session on them", context::tokens(&text), started.elapsed().as_millis());
                    n.text = text;
                    n.upto = cut;
                    drop(n);
                    a.send_all(|| Msg::Compact);
                }
                Ok(_) => info!("notes: transcript replaced meanwhile, dropped"),
                Err(e) => warn!("notes: summary failed: {e:#}"),
            }
        });
    }

    /// The notes summary with the quick model.
    async fn notes(&self, prev: &str, segs: &[FinalSegment]) -> anyhow::Result<String> {
        let prev = if prev.is_empty() { String::new() } else { format!("<earlier_notes>\n{prev}\n</earlier_notes>\n") };
        let text = format!("{prev}<transcript>\n{}\n</transcript>\nWrite the notes.", llm::render(segs));
        self.one_off(Tier::Summary, NOTES_SYSTEM.to_string(), &self.cfg.quick_model, text).await
    }

    /// `ask` on the given transcript; returns the turn id.
    fn ask_on(&self, shared: &Arc<Shared>, trigger: Trigger, question: Option<(String, Option<u64>)>, shot: Option<Shot>, segs: Arc<Vec<FinalSegment>>) -> u64 {
        self.maybe_compact(shared, &segs);
        let (question, q_t) = question.unwrap_or_else(|| llm::question(&segs));
        let model = shared.status.lock().unwrap().model.clone();
        let turn = self.next_id();
        let shot = shot.map(Arc::new);
        let mut shot_file = None;
        if let Some(sh) = &shot {
            use base64::Engine as _;
            let thumb = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&sh.thumb));
            let _ = shared.events.send(Event::Screenshot { turn, width: sh.width, height: sh.height, thumb });
            shot_file = crate::call::save_shot(shared, turn, &sh.image);
        }
        let req = |model: String| Req {
            id: self.next_id(),
            turn,
            model,
            trigger,
            question: question.clone(),
            q_t,
            segs: segs.clone(),
            shot: shot.clone(),
            shot_file: shot_file.clone(),
        };
        if let Some((tx, quick_model)) = &self.quick {
            let _ = tx.send(Msg::Ask(req(quick_model.clone())));
        }
        let _ = self.full.send(Msg::Ask(req(model)));
        turn
    }

    /// Both tiers drop answer turn `turn` with the error `RETRACTED`.
    fn retract(&self, turn: u64) {
        self.send_all(|| Msg::Cancel { turn });
    }

    fn send_all(&self, msg: impl Fn() -> Msg) {
        let _ = self.full.send(msg());
        if let Some((tx, _)) = &self.quick {
            let _ = tx.send(msg());
        }
    }

    /// The transcript was replaced or cleared: its notes no longer apply.
    pub fn forget_notes(shared: &Shared) {
        let mut n = shared.notes.lock().unwrap();
        let generation = n.generation + 1;
        *n = Notes { generation, ..Default::default() };
    }

    pub fn clear(&self) {
        self.send_all(|| Msg::Clear);
    }

    /// Both tiers restart on a system prompt with their context; the next ask resends the transcript.
    /// `context`: the assembled context, the key a later brief must match. `full_context`: it, maybe with
    /// prepared answers. `quick_context`: what the quick tier gets (the brief of a large context, or the full one).
    /// `call_open`: a question is near, so the new prompts go to the prompt cache right away.
    pub fn reconfigure(&self, context: &str, full_context: &str, quick_context: &str, call_open: bool) {
        *self.context_key.lock().unwrap() = crate::brief::key(context);
        self.warm_cache.store(call_open, Ordering::Relaxed);
        let lang = &self.cfg.user_language;
        let _ = self.full.send(Msg::Reconfigure { system: llm::system_prompt(false, full_context, lang), warm_cache: call_open });
        if let Some((tx, _)) = &self.quick {
            let _ = tx.send(Msg::Reconfigure { system: llm::system_prompt(true, quick_context, lang), warm_cache: call_open });
        }
    }

    /// A brief finished: the quick tier switches to it, unless the context changed meanwhile.
    pub fn set_brief(&self, key: &str, brief: &str) -> bool {
        if *self.context_key.lock().unwrap() != key {
            return false;
        }
        if let Some((tx, _)) = &self.quick {
            let system = llm::system_prompt(true, brief, &self.cfg.user_language);
            let _ = tx.send(Msg::Reconfigure { system, warm_cache: self.warm_cache.load(Ordering::Relaxed) });
        }
        true
    }

    /// Only the quick tier reads a brief; without it there is nothing to make one for.
    pub fn has_quick(&self) -> bool {
        self.quick.is_some()
    }

    /// The brief of `context`, written by the full model.
    pub async fn brief(&self, context: &str) -> anyhow::Result<String> {
        let events = self.events.clone();
        make_brief(&self.cfg, context, &mut |e| {
            let _ = events.send(e);
        })
        .await
    }

    /// `one_shot` with its token usage sent to the UI.
    async fn one_off(&self, tier: Tier, system: String, model: &str, text: String) -> anyhow::Result<String> {
        let events = self.events.clone();
        one_shot(&self.cfg, tier, system, model, text, &mut |e| {
            let _ = events.send(e);
        })
        .await
    }

    /// A fresh answer/turn id (also used to replay saved answers).
    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// One-off summary of `segs` with the full model, through the configured backend.
    pub async fn summarize(&self, context: &str, segs: &[FinalSegment], hints: &[crate::call::AnswerRecord]) -> anyhow::Result<String> {
        let text = format!("<transcript>\n{}\n</transcript>\n{}Summarize this call.", llm::render(segs), hints_block(hints));
        // The full model: nobody waits for a summary, so its latency does not matter.
        self.one_off(Tier::Summary, llm::summary_system(context), &self.cfg.model, text).await
    }
}

/// One turn of a fresh session (notes, brief, summary, eval): its text, trimmed. `usage` gets the
/// turn's `usage` event.
pub async fn one_shot(cfg: &Config, tier: Tier, system: String, model: &str, text: String, usage: &mut (dyn FnMut(Event) + Send)) -> anyhow::Result<String> {
    let mut s = session(cfg, tier, system);
    s.prepare(model)?;
    let api = s.is_api();
    let mut out = String::new();
    s.ask(model, &llm::Turn { text, image: None }, &mut |c| match c {
        Chunk::Text(t) => out.push_str(&t),
        c => {
            if let Some(e) = llm::usage_event(tier, model, api, &c) {
                usage(e);
            }
        }
    })
    .await?;
    Ok(out.trim().to_string())
}

/// The brief of `context` with the full model. Also run outside a call by `brief` («Подготовить» in «Звонки»).
pub async fn make_brief(cfg: &Config, context: &str, usage: &mut (dyn FnMut(Event) + Send)) -> anyhow::Result<String> {
    let system = crate::brief::SYSTEM.replace("{user_language}", &llm::language_name(&cfg.user_language));
    one_shot(cfg, Tier::Brief, system, &cfg.model, format!("{context}\n\nWrite the brief."), usage).await
}

/// The full-tier answers of a call for its summary: question and hint, each cut to keep the prompt small.
fn hints_block(answers: &[crate::call::AnswerRecord]) -> String {
    let cut = |s: &str, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_string() };
    let items: Vec<String> = answers
        .iter()
        .filter(|a| a.tier == Tier::Full && !a.text.is_empty())
        .map(|a| format!("<hint question=\"{}\">\n{}\n</hint>", cut(&a.question, 200).replace('"', "'"), cut(&a.text, 600)))
        .collect();
    if items.is_empty() { String::new() } else { format!("<hints>\n{}\n</hints>\n", items.join("\n")) }
}

pub(crate) fn session(cfg: &Config, tier: Tier, system: String) -> Session {
    let max_tokens = match tier {
        Tier::Quick => 200,
        Tier::Full => 2048,
        Tier::Summary => 4000,
        Tier::Brief => 6000,
        Tier::Translate => 400,
    };
    match cfg.llm.backend {
        Backend::ClaudeCode => {
            Session::Code(Box::new(llm::claude_code::CodeSession::new(cfg.claude_code.command.clone(), system, cfg.effort.clone(), tier.as_str())))
        }
        Backend::Api => Session::Api(llm::api::ApiSession::new(cfg.anthropic_api_key.clone(), system, cfg.effort.clone(), max_tokens)),
        Backend::Openai => {
            // Reasoning models spend part of the budget thinking even at low effort: the short tiers get headroom.
            let max_tokens = if matches!(tier, Tier::Quick | Tier::Translate) { max_tokens * 4 } else { max_tokens };
            Session::OpenAi(llm::openai::OpenAiSession::new(
                &cfg.llm.provider,
                &cfg.llm.base_url,
                cfg.llm.api_key.clone(),
                system,
                cfg.effort.clone(),
                max_tokens,
            ))
        }
    }
}

/// Auto-detect state: the last question asked and an early answer still in doubt.
#[derive(Default)]
struct AutoState {
    last_asked: String,
    /// (turn, its question) of an early answer not yet confirmed by the final.
    early: Option<(u64, String)>,
}

impl AutoState {
    fn retract_early(&mut self, a: &Answerer, why: &str) {
        if let Some((turn, question)) = self.early.take() {
            info!("auto: early answer {turn} cancelled, {why}");
            a.retract(turn);
            // The same words may come back as part of a longer question: allow asking again.
            if self.last_asked == question {
                self.last_asked.clear();
            }
        }
    }

    /// Speculative mode: answer at the first pause, before the final is confirmed.
    fn on_early(&mut self, a: &Answerer, shared: &Arc<Shared>, seg: FinalSegment) {
        let mut segs = shared.transcript.lock().unwrap().clone();
        segs.push(seg);
        let (question, q_t) = llm::question(&segs);
        if question == self.last_asked || !textproc::is_question(&question) {
            return;
        }
        self.retract_early(a, "a newer early question");
        info!("auto: early question: {question}");
        self.last_asked = question.clone();
        let turn = a.ask_on(shared, Trigger::Early, Some((question.clone(), q_t)), None, Arc::new(segs));
        self.early = Some((turn, question));
    }

    /// After a final: keep a matching early answer, or ask once their turn is over.
    fn on_final(&mut self, a: &Answerer, shared: &Arc<Shared>) {
        let (question, q_t) = llm::question(&shared.transcript.lock().unwrap());
        if let Some((turn, q)) = &self.early {
            if *q == question {
                info!("auto: early answer {turn} confirmed by the final");
                self.early = None;
                return;
            }
            self.retract_early(a, "the final differs");
        }
        if shared.them_speaking.load(Ordering::Relaxed) || question == self.last_asked || !textproc::is_question(&question) {
            return;
        }
        info!("auto: question detected: {question}");
        self.last_asked = question.clone();
        a.ask(shared, Trigger::Auto, Some((question, q_t)), None);
    }
}

/// Confirmed mode: answer once the other side stops talking and the last "them" run is a question.
/// Speculative mode also answers at the first pause (`Auto::Early`) and drops that answer if they go on.
async fn auto_detect(a: Answerer, shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Auto>) {
    let mut st = AutoState::default();
    // Some(true): a final to decide on; None: stop.
    let handle = |st: &mut AutoState, ev: Auto| -> Option<bool> {
        let (auto, mode) = {
            let s = shared.status.lock().unwrap();
            (s.auto, s.answer_mode)
        };
        match ev {
            Auto::Resumed => st.retract_early(&a, "speech resumed"),
            Auto::Early(seg) if auto && mode == protocol::AnswerMode::Speculative => st.on_early(&a, &shared, seg),
            Auto::Early(_) => {}
            Auto::Final => return Some(auto),
            Auto::Stop => return None,
        }
        Some(false)
    };
    while let Some(ev) = rx.recv().await {
        match handle(&mut st, ev) {
            None => return,
            Some(false) => continue,
            Some(true) => {}
        }
        // A final: wait for more speech, then decide on everything heard so far.
        tokio::time::sleep(Duration::from_millis(AUTO_SETTLE_MS)).await;
        while let Ok(ev) = rx.try_recv() {
            if handle(&mut st, ev).is_none() {
                return;
            }
        }
        st.on_final(&a, &shared);
    }
}

/// A hung backend (a stuck `claude -p`, a stalled stream) must not block its tier forever.
const FIRST_TOKEN_TIMEOUT: Duration = Duration::from_secs(30);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

/// Resolves when the answer is overdue: no first token in time, or too long in total.
async fn overdue(got_first: &AtomicBool, first: Duration, total: Duration) -> u64 {
    tokio::time::sleep(first).await;
    if !got_first.load(Ordering::Relaxed) {
        return first.as_secs();
    }
    tokio::time::sleep(total.saturating_sub(first)).await;
    total.as_secs()
}

/// How one answer turn went.
enum Outcome {
    Done,
    Failed {
        error: anyhow::Error,
        stuck: bool,
    },
    /// A newer message cut it off (it waits in `pending`).
    Interrupted,
}

/// One tier (quick or full): owns its LLM session and answers one ask at a time; a newer ask cancels
/// the one in progress.
struct TierActor {
    tier: Tier,
    session: Session,
    /// The quick tier's model (the full tier follows the model in the status).
    model: String,
    shared: Arc<Shared>,
    rx: mpsc::UnboundedReceiver<Msg>,
    /// Transcript segments already sent in this session.
    sent: usize,
    /// dHash of the last screen image this session holds: the same screen is not sent twice.
    last_screen: Option<u64>,
    /// A message that arrived during an answer, handled next.
    pending: Option<Msg>,
    stopping: bool,
}

impl TierActor {
    fn spawn(tier: Tier, session: Session, model: String, shared: Arc<Shared>) -> mpsc::UnboundedSender<Msg> {
        let (tx, rx) = mpsc::unbounded_channel();
        let actor = TierActor { tier, session, model, shared, rx, sent: 0, last_screen: None, pending: None, stopping: false };
        tokio::spawn(actor.run());
        tx
    }

    async fn run(mut self) {
        if let Err(e) = self.warm(false).await {
            warn!("[{}] warm-up failed: {e:#}", self.tier.as_str());
            let message = format!("Claude ({}): {e:#}", self.tier.as_str());
            let _ = self.shared.events.send(Event::Error { message, kind: Some(llm::error_kind(&e)) });
        }
        while !self.stopping {
            let msg = match self.pending.take() {
                Some(m) => m,
                None => match self.rx.recv().await {
                    Some(m) => m,
                    None => break,
                },
            };
            match msg {
                Msg::Ask(req) => self.answer(req).await,
                Msg::Clear => self.reset(),
                Msg::Reconfigure { system, warm_cache } => {
                    self.session.set_system(system);
                    self.reset();
                    self.warm_quietly(warm_cache).await;
                }
                Msg::Cancel { .. } => {} // that turn is over already
                Msg::Compact => {
                    self.reset();
                    self.warm_quietly(false).await;
                }
                Msg::Stop => break,
            }
        }
    }

    /// The model the next answer will most likely use: what its prompt cache should hold.
    fn warm_model(&self) -> String {
        if self.tier == Tier::Full { self.shared.status.lock().unwrap().model.clone() } else { self.model.clone() }
    }

    async fn warm(&mut self, cache: bool) -> anyhow::Result<()> {
        let model = self.warm_model();
        let (events, tier, api) = (self.shared.events.clone(), self.tier, self.session.is_api());
        let usage = |c: Chunk| {
            if let Some(e) = llm::usage_event(tier, &model, api, &c) {
                let _ = events.send(e);
            }
        };
        self.session.warm(&model, cache, &mut { usage }).await
    }

    async fn warm_quietly(&mut self, cache: bool) {
        if let Err(e) = self.warm(cache).await {
            warn!("[{}] warm-up failed: {e:#}", self.tier.as_str());
        }
    }

    /// A new session: the next ask sends the transcript again.
    fn reset(&mut self) {
        self.session.reset();
        self.sent = 0;
        self.last_screen = None;
    }

    async fn answer(&mut self, req: Req) {
        let (id, tier) = (req.id, self.tier);
        let ev = self.shared.events.clone();
        let _ = ev.send(Event::AnswerStart { id, turn: req.turn, trigger: req.trigger, question: req.question.clone(), q_t: req.q_t, tier });
        if tier == Tier::Full {
            self.shared.update_status(|s| s.busy = true);
        }
        let started = Instant::now();
        let mut answer = String::new();
        let mut compact = false;
        let outcome = self.turn(&req, &mut answer, started, &mut compact).await;
        let (error, kind) = match outcome {
            Outcome::Done => {
                crate::call::save_answer(
                    &self.shared,
                    crate::call::AnswerRecord {
                        id: String::new(),
                        turn: req.turn,
                        tier,
                        trigger: req.trigger,
                        question: req.question.clone(),
                        q_t: req.q_t,
                        model: req.model.clone(),
                        text: answer,
                        shot: req.shot_file.clone(),
                        feedback: None,
                    },
                );
                (None, None)
            }
            Outcome::Failed { error, stuck } => {
                warn!("[{}] answer failed: {error:#}", tier.as_str());
                if stuck {
                    // The backend's state is unknown: start a new session (claude-code restarts).
                    self.reset();
                }
                (Some(format!("{error:#}")), Some(llm::error_kind(&error)))
            }
            Outcome::Interrupted => {
                let retracted = matches!(self.pending, Some(Msg::Cancel { turn }) if turn == req.turn);
                let kind = if retracted { ErrorKind::Retracted } else { ErrorKind::Cancelled };
                (Some(if retracted { "retracted" } else { "cancelled" }.to_string()), Some(kind))
            }
        };
        let _ = ev.send(Event::Metrics { name: format!("answer_total_{}", tier.as_str()), ms: started.elapsed().as_secs_f64() * 1000.0 });
        let _ = ev.send(Event::AnswerEnd { id, error, kind, feedback: None });
        if compact {
            if self.pending.is_none() {
                self.pending = Some(Msg::Compact); // reset and warm while idle
            } else {
                self.reset(); // a newer ask waits: no time to warm
            }
        }
        if tier == Tier::Full && !matches!(self.pending, Some(Msg::Ask(_))) {
            self.shared.update_status(|s| s.busy = false);
        }
    }

    /// Sends the turn and streams the reply into `answer` and the UI, until it ends, fails, times out
    /// or a newer message cuts it off. `compact`: a `Compact` arrived meanwhile.
    async fn turn(&mut self, req: &Req, answer: &mut String, started: Instant, compact: &mut bool) -> Outcome {
        let fresh = match self.session.prepare(&req.model) {
            Ok(f) => f,
            Err(error) => return Outcome::Failed { error, stuck: false },
        };
        let mut earlier = String::new();
        if fresh {
            let n = self.shared.notes.lock().unwrap();
            self.sent = n.upto.min(req.segs.len());
            if self.sent > 0 {
                earlier = format!("<earlier_notes>\n{}\n</earlier_notes>\n", n.text);
            }
            self.last_screen = None;
        }
        let tier = self.tier.as_str();
        let screen = match &req.shot {
            None => llm::Screen::None,
            Some(sh) if self.last_screen.is_some_and(|h| crate::screen::same_screen(h, sh.hash)) => {
                info!("[{tier}] screen unchanged, image not resent");
                llm::Screen::Unchanged
            }
            Some(sh) => {
                self.last_screen = Some(sh.hash);
                llm::Screen::Attached
            }
        };
        let image = (screen == llm::Screen::Attached).then(|| req.shot.as_ref().map(|s| Arc::new(s.image.clone()))).flatten();
        let turn = llm::Turn { text: earlier + &llm::turn_text(&req.segs[self.sent.min(req.segs.len())..], &req.question, screen), image };
        // A cancelled turn resends its segments: an early one may hold a text the final changed.
        let sent_before = self.sent;
        self.sent = req.segs.len();
        let api = self.session.is_api();
        let ev = self.shared.events.clone();
        let got_first = AtomicBool::new(false);
        // End of the other side's last phrase: for auto answers, the wait the user actually feels.
        let them_end = matches!(req.trigger, Trigger::Auto | Trigger::Early)
            .then(|| req.segs.iter().rev().find(|s| s.speaker == protocol::Speaker::Them).map(|s| s.end_ms))
            .flatten();
        let mut emit = |c: Chunk| match c {
            Chunk::Text(t) => {
                if !got_first.swap(true, Ordering::Relaxed) {
                    let ms = started.elapsed().as_secs_f64() * 1000.0;
                    let _ = ev.send(Event::Metrics { name: format!("answer_first_token_{tier}"), ms });
                    if let Some(end) = them_end {
                        let ms = crate::now_ms().saturating_sub(end) as f64;
                        info!("[{tier}] question to first token: {ms} ms");
                        let _ = ev.send(Event::Metrics { name: format!("question_to_first_token_{tier}"), ms });
                    }
                }
                answer.push_str(&t);
                let _ = ev.send(Event::AnswerDelta { id: req.id, text: t });
            }
            c @ Chunk::Usage { input, cache_read, cache_write, output, .. } => {
                info!("[{tier}] tokens: input {input}, cache read {cache_read}, cache write {cache_write}, output {output}");
                if let Some(e) = llm::usage_event(self.tier, &req.model, api, &c) {
                    let _ = ev.send(e);
                }
            }
        };
        let outcome = {
            let ask = self.session.ask(&req.model, &turn, &mut emit);
            let timer = overdue(&got_first, FIRST_TOKEN_TIMEOUT, ANSWER_TIMEOUT);
            tokio::pin!(ask, timer);
            loop {
                tokio::select! {
                    r = &mut ask => break match r {
                        Ok(()) => Outcome::Done,
                        Err(error) => Outcome::Failed { error, stuck: false },
                    },
                    secs = &mut timer => {
                        break Outcome::Failed { error: llm::fail(ErrorKind::Timeout, format!("Claude не ответил за {secs} с")), stuck: true };
                    }
                    m = self.rx.recv() => match m {
                        Some(Msg::Cancel { turn }) if turn != req.turn => {}
                        Some(Msg::Compact) => *compact = true,
                        Some(Msg::Stop) => self.stopping = true,
                        m => {
                            self.pending = m;
                            break Outcome::Interrupted;
                        }
                    }
                }
            }
        };
        if matches!(outcome, Outcome::Interrupted) {
            self.session.cancel().await;
            self.sent = sent_before;
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::mock::MockSession;
    use protocol::Speaker;

    fn segs() -> Arc<Vec<FinalSegment>> {
        Arc::new(vec![FinalSegment { speaker: Speaker::Them, t_ms: 0, end_ms: 0, text: "Что такое горутина?".into() }])
    }

    fn ask(id: u64, shot: Option<Arc<Shot>>) -> Msg {
        Msg::Ask(Req {
            id,
            turn: id,
            model: "test".into(),
            trigger: Trigger::Hotkey,
            question: "Что такое горутина?".into(),
            q_t: None,
            segs: segs(),
            shot,
            shot_file: None,
        })
    }

    /// How the answer `id` ended (None = it finished).
    async fn end(rx: &mut mpsc::UnboundedReceiver<Event>, want: u64) -> Option<ErrorKind> {
        loop {
            if let Event::AnswerEnd { id, kind, .. } = rx.recv().await.expect("tier stopped")
                && id == want
            {
                return kind;
            }
        }
    }

    fn tier(mock: MockSession) -> (mpsc::UnboundedSender<Msg>, Arc<Shared>, mpsc::UnboundedReceiver<Event>) {
        let (shared, rx) = Shared::for_test();
        (TierActor::spawn(Tier::Full, Session::Mock(mock), "test".into(), shared.clone()), shared, rx)
    }

    #[tokio::test]
    async fn newer_ask_cancels_running_one() {
        let (mock, _) = MockSession::new(Duration::from_millis(50), vec!["a", "b", "c"], 0);
        let (tx, _shared, mut rx) = tier(mock);
        tx.send(ask(1, None)).unwrap();
        tx.send(ask(2, None)).unwrap();
        assert_eq!(end(&mut rx, 1).await, Some(ErrorKind::Cancelled));
        assert_eq!(end(&mut rx, 2).await, None);
    }

    #[tokio::test]
    async fn same_screen_is_not_sent_twice() {
        let (mock, seen) = MockSession::new(Duration::ZERO, vec!["ok"], 0);
        let (tx, _shared, mut rx) = tier(mock);
        let shot = |hash| Some(Arc::new(Shot { image: vec![1], width: 1, height: 1, hash, thumb: vec![], source: "test".into() }));
        for (id, hash) in [(1, 42), (2, 43), (3, !0)] {
            tx.send(ask(id, shot(hash))).unwrap();
            assert_eq!(end(&mut rx, id).await, None);
        }
        let seen = seen.lock().unwrap();
        assert!(seen[0].1, "first screen goes with the image");
        assert!(!seen[1].1 && seen[1].0.contains("Unchanged"), "one bit off is the same screen");
        assert!(seen[2].1, "another screen goes again");
    }

    #[tokio::test]
    async fn finished_answer_is_saved_to_the_open_call() {
        let dir = tempfile::tempdir().unwrap();
        let (mock, _) = MockSession::new(Duration::ZERO, vec!["Лёгкий ", "поток"], 0);
        let (tx, shared, mut rx) = tier(mock);
        *shared.call.lock().unwrap() = Some(dir.path().to_path_buf());
        tx.send(ask(1, None)).unwrap();
        assert_eq!(end(&mut rx, 1).await, None);
        let saved = std::fs::read_to_string(dir.path().join("answers.jsonl")).unwrap();
        assert!(saved.contains("\"text\":\"Лёгкий поток\""), "{saved}");
    }

    #[tokio::test]
    async fn cancel_drops_only_its_turn() {
        let (mock, _) = MockSession::new(Duration::from_millis(30), vec!["a", "b"], 0);
        let (tx, _shared, mut rx) = tier(mock);
        tx.send(ask(1, None)).unwrap();
        tx.send(Msg::Cancel { turn: 7 }).unwrap();
        assert_eq!(end(&mut rx, 1).await, None, "another turn's cancel is ignored");
        tx.send(ask(2, None)).unwrap();
        tx.send(Msg::Cancel { turn: 2 }).unwrap();
        assert_eq!(end(&mut rx, 2).await, Some(ErrorKind::Retracted));
    }

    /// An answerer on one mock tier, as auto-detect drives it.
    fn answerer(delay: Duration) -> (Answerer, Arc<Shared>, mpsc::UnboundedReceiver<Event>) {
        let (mock, _) = MockSession::new(delay, vec!["ok"], 0);
        let (full, shared, rx) = tier(mock);
        let (auto, _) = mpsc::unbounded_channel();
        let a = Answerer {
            cfg: Arc::new(Config::default()),
            full,
            quick: None,
            next_id: shared.ids.clone(),
            auto,
            context_key: Default::default(),
            warm_cache: Default::default(),
            events: shared.events.clone(),
        };
        (a, shared, rx)
    }

    fn them(t_ms: u64, text: &str) -> FinalSegment {
        FinalSegment { speaker: Speaker::Them, t_ms, end_ms: t_ms + 1000, text: text.into() }
    }

    /// (turn, trigger) of each answer start, and the error of each end, in order.
    fn drain(rx: &mut mpsc::UnboundedReceiver<Event>) -> (Vec<String>, Vec<Option<ErrorKind>>) {
        let (mut starts, mut ends) = (vec![], vec![]);
        while let Ok(e) = rx.try_recv() {
            match e {
                Event::AnswerStart { turn, trigger, .. } => starts.push(format!("{turn} {trigger:?}")),
                Event::AnswerEnd { kind, .. } => ends.push(kind),
                _ => {}
            }
        }
        (starts, ends)
    }

    #[tokio::test]
    async fn early_answer_kept_when_the_final_matches() {
        let (a, shared, mut rx) = answerer(Duration::ZERO);
        let mut st = AutoState::default();
        st.on_early(&a, &shared, them(0, "Что такое горутина?"));
        shared.transcript.lock().unwrap().push(them(0, "Что такое горутина?"));
        st.on_final(&a, &shared);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(drain(&mut rx), (vec!["1 Early".to_string()], vec![None]));
    }

    #[tokio::test]
    async fn early_answer_dropped_when_speech_resumes() {
        let (a, shared, mut rx) = answerer(Duration::from_millis(100));
        let mut st = AutoState::default();
        st.on_early(&a, &shared, them(0, "Что такое горутина?"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        st.retract_early(&a, "speech resumed");
        shared.transcript.lock().unwrap().push(them(0, "Что такое горутина и чем она отличается от потока?"));
        st.on_final(&a, &shared);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (starts, ends) = drain(&mut rx);
        assert_eq!(starts, vec!["1 Early".to_string(), "3 Auto".to_string()]);
        assert_eq!(ends, vec![Some(ErrorKind::Retracted), None]);
    }

    #[tokio::test]
    async fn early_answer_dropped_when_the_final_differs() {
        let (a, shared, mut rx) = answerer(Duration::from_millis(100));
        let mut st = AutoState::default();
        st.on_early(&a, &shared, them(0, "Что такое горутина?"));
        shared.transcript.lock().unwrap().push(them(0, "Что такое горутина в Go?"));
        st.on_final(&a, &shared);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (starts, ends) = drain(&mut rx);
        assert_eq!(starts, vec!["1 Early".to_string(), "3 Auto".to_string()]);
        assert_eq!(ends, vec![Some(ErrorKind::Retracted), None]);
    }

    #[test]
    fn compact_cut_keeps_the_newest_part() {
        let seg = |i: u64| them(i * 1000, &"слово ".repeat(500)); // ~1000 tokens each
        let short: Vec<_> = (0..10).map(seg).collect();
        assert_eq!(compact_cut(&short), None);
        let long: Vec<_> = (0..30).map(seg).collect();
        assert_eq!(compact_cut(&long), Some(25), "the last ~5k tokens stay verbatim");
    }

    #[tokio::test]
    async fn compact_restarts_the_session_on_the_notes() {
        let (mock, seen) = MockSession::new(Duration::ZERO, vec!["ok"], 0);
        let (tx, shared, mut rx) = tier(mock);
        tx.send(ask(1, None)).unwrap();
        assert_eq!(end(&mut rx, 1).await, None);
        *shared.notes.lock().unwrap() = Notes { text: "- спросили про горутины".into(), upto: 1, ..Default::default() };
        tx.send(Msg::Compact).unwrap();
        let mut segs = (*segs()).clone();
        segs.push(them(5000, "А каналы?"));
        tx.send(Msg::Ask(Req {
            segs: Arc::new(segs),
            ..match ask(2, None) {
                Msg::Ask(r) => r,
                _ => unreachable!(),
            }
        }))
        .unwrap();
        assert_eq!(end(&mut rx, 2).await, None);
        let seen = seen.lock().unwrap();
        let t = &seen[1].0;
        assert!(t.contains("<earlier_notes>") && t.contains("спросили про горутины"), "{t}");
        assert!(t.contains("А каналы?") && !t.contains("Q: Что такое горутина?"), "old segments are left to the notes: {t}");
    }

    #[tokio::test(start_paused = true)]
    async fn hung_backend_times_out_and_session_restarts() {
        let (mock, seen) = MockSession::new(Duration::ZERO, vec!["ok"], 1);
        let (tx, _shared, mut rx) = tier(mock);
        tx.send(ask(1, None)).unwrap();
        assert_eq!(end(&mut rx, 1).await, Some(ErrorKind::Timeout));
        tx.send(ask(2, None)).unwrap();
        assert_eq!(end(&mut rx, 2).await, None);
        let seen = seen.lock().unwrap();
        assert!(seen[1].0.contains("горутина"), "the new session gets the transcript again: {}", seen[1].0);
    }

    #[tokio::test]
    async fn overdue_waits_for_first_token_then_total() {
        let first = Duration::from_millis(40);
        let total = Duration::from_millis(160);
        let none = AtomicBool::new(false);
        let t = Instant::now();
        overdue(&none, first, total).await;
        assert!(t.elapsed() < Duration::from_millis(120), "no first token: gives up at the first deadline");
        let got = AtomicBool::new(true);
        let t = Instant::now();
        overdue(&got, first, total).await;
        assert!(t.elapsed() >= total, "first token seen: waits for the total deadline");
    }

    /// Auto-detect running on `answerer`'s mock tier, as the STT worker drives it.
    fn auto() -> (mpsc::UnboundedSender<Auto>, tokio::task::JoinHandle<()>, Arc<Shared>, mpsc::UnboundedReceiver<Event>) {
        let (a, shared, rx) = answerer(Duration::ZERO);
        let (tx, auto_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(auto_detect(a, shared.clone(), auto_rx));
        (tx, task, shared, rx)
    }

    /// Longer than `AUTO_SETTLE_MS` plus a mock answer.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(AUTO_SETTLE_MS + 200)).await;
    }

    #[tokio::test]
    async fn confirmed_mode_answers_a_question_once_after_the_final() {
        let (tx, _task, shared, mut rx) = auto();
        shared.transcript.lock().unwrap().push(them(0, "Что такое горутина?"));
        tx.send(Auto::Early(them(0, "Что такое горутина?"))).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, Vec::<String>::new(), "confirmed mode does not answer at a pause");
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, vec!["1 Auto".to_string()]);
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert!(drain(&mut rx).0.is_empty(), "the same question is not answered twice");
        shared.transcript.lock().unwrap().push(them(5000, "А что такое канал?"));
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, vec!["3 Auto".to_string()]);
    }

    #[tokio::test]
    async fn no_answer_while_auto_is_off_they_still_talk_or_no_question() {
        let (tx, _task, shared, mut rx) = auto();
        shared.transcript.lock().unwrap().push(them(0, "Спасибо, это всё."));
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert!(drain(&mut rx).0.is_empty(), "not a question");
        shared.transcript.lock().unwrap().push(them(2000, "Что такое горутина?"));
        shared.status.lock().unwrap().auto = false;
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert!(drain(&mut rx).0.is_empty(), "auto-detect is off");
        shared.status.lock().unwrap().auto = true;
        shared.them_speaking.store(true, Ordering::Relaxed);
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert!(drain(&mut rx).0.is_empty(), "they are still talking");
        shared.them_speaking.store(false, Ordering::Relaxed);
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, vec!["1 Auto".to_string()]);
    }

    #[tokio::test]
    async fn finals_within_the_settle_time_make_one_answer() {
        let (tx, _task, shared, mut rx) = auto();
        shared.transcript.lock().unwrap().push(them(0, "Что такое горутина?"));
        tx.send(Auto::Final).unwrap();
        shared.transcript.lock().unwrap().push(them(1500, "И чем она отличается от потока?"));
        tx.send(Auto::Final).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, vec!["1 Auto".to_string()], "one answer to the whole turn");
    }

    #[tokio::test]
    async fn speculative_mode_answers_at_the_pause_and_stop_ends_it() {
        let (tx, task, shared, mut rx) = auto();
        shared.status.lock().unwrap().answer_mode = protocol::AnswerMode::Speculative;
        tx.send(Auto::Early(them(0, "Что такое горутина?"))).unwrap();
        settle().await;
        assert_eq!(drain(&mut rx).0, vec!["1 Early".to_string()]);
        tx.send(Auto::Stop).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task).await.expect("auto-detect stops").unwrap();
    }
}
