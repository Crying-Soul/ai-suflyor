//! Answer pipeline: one actor per tier (quick hint, full answer). Each owns an LLM session,
//! turns a transcript snapshot into a user turn and streams the reply to the UI.
//! A newer request cancels the one in progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use protocol::Event;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{Backend, Config};
use crate::llm::{self, Chunk, Session};
use crate::screen::Shot;
use crate::{FinalSegment, Shared};

struct Req {
    id: u64,
    turn: u64,
    model: String,
    trigger: String,
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
    /// New system prompt (another call's context): the session restarts on it.
    Reconfigure(String),
}

#[derive(Clone)]
pub struct Answerer {
    cfg: Arc<Config>,
    full: mpsc::UnboundedSender<Msg>,
    quick: Option<(mpsc::UnboundedSender<Msg>, String)>,
    next_id: Arc<AtomicU64>,
    /// "them" finals for auto-detect.
    auto: mpsc::UnboundedSender<()>,
}

/// After a "them" final, wait this long for more speech before deciding the turn is over.
const AUTO_SETTLE_MS: u64 = 250;

impl Answerer {
    /// `context`: the assembled context block (`context::assemble`) for the system prompt.
    pub fn start(cfg: &Config, shared: Arc<Shared>, context: &str) -> Answerer {
        let cfg = Arc::new(cfg.clone());
        let make = |tier: &'static str| session(&cfg, tier, llm::system_prompt(tier == "quick", context));
        let full = spawn_tier("full", make("full"), cfg.model.clone(), shared.clone());
        let quick = cfg.two_tier.then(|| (spawn_tier("quick", make("quick"), cfg.quick_model.clone(), shared.clone()), cfg.quick_model.clone()));
        let (auto, auto_rx) = mpsc::unbounded_channel();
        let a = Answerer { cfg: cfg.clone(), full, quick, next_id: Arc::new(AtomicU64::new(1)), auto };
        tokio::spawn(auto_detect(a.clone(), shared, auto_rx));
        a
    }

    /// Called by the STT worker for every "them" final.
    pub fn on_them_final(&self) {
        let _ = self.auto.send(());
    }

    /// Starts both tiers. `question`: (text, start of its transcript run); None = the latest "them" run.
    pub fn ask(&self, shared: &Shared, trigger: &str, question: Option<(String, Option<u64>)>, shot: Option<Shot>) {
        let segs = Arc::new(shared.transcript.lock().unwrap().clone());
        let (question, q_t) = question.unwrap_or_else(|| llm::question(&segs));
        let model = shared.status.lock().unwrap().model.clone();
        let turn = self.next_id();
        let shot = shot.map(Arc::new);
        let mut shot_file = None;
        if let Some(sh) = &shot {
            use base64::Engine as _;
            let thumb = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&sh.thumb));
            let _ = shared.events.send(Event::Screenshot { turn, width: sh.width, height: sh.height, thumb });
            shot_file = crate::call::save_shot(shared, turn, &sh.png);
        }
        let req = |model: String| Req {
            id: self.next_id(),
            turn,
            model,
            trigger: trigger.to_string(),
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
    }

    pub fn clear(&self) {
        let _ = self.full.send(Msg::Clear);
        if let Some((tx, _)) = &self.quick {
            let _ = tx.send(Msg::Clear);
        }
    }

    /// Both tiers restart on a system prompt with this context; the next ask resends the transcript.
    pub fn reconfigure(&self, context: &str) {
        let _ = self.full.send(Msg::Reconfigure(llm::system_prompt(false, context)));
        if let Some((tx, _)) = &self.quick {
            let _ = tx.send(Msg::Reconfigure(llm::system_prompt(true, context)));
        }
    }

    /// A fresh answer/turn id (also used to replay saved answers).
    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// One-off summary of `segs` with the quick model, through the configured backend.
    pub async fn summarize(&self, context: &str, segs: &[FinalSegment]) -> anyhow::Result<String> {
        let mut s = session(&self.cfg, "summary", llm::summary_system(context));
        let model = &self.cfg.quick_model;
        s.prepare(model).await?;
        let mut out = String::new();
        let text = format!("<transcript>\n{}\n</transcript>\nSummarize this call.", llm::render(segs));
        s.ask(model, &llm::Turn { text, image: None }, &mut |c| {
            if let Chunk::Text(t) = c {
                out.push_str(&t);
            }
        })
        .await?;
        Ok(out.trim().to_string())
    }
}

fn session(cfg: &Config, tier: &'static str, system: String) -> Session {
    if cfg.llm.backend == Backend::ClaudeCode {
        Session::Code(llm::claude_code::CodeSession::new(cfg.claude_code.command.clone(), system, cfg.effort.clone(), tier))
    } else {
        let key = Some(cfg.anthropic_api_key.clone())
            .filter(|k| !k.is_empty())
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
            .unwrap_or_default();
        let max_tokens = match tier {
            "quick" => 200,
            "summary" => 1500,
            _ => 2048,
        };
        Session::Api(llm::api::ApiSession::new(key, system, cfg.effort.clone(), max_tokens))
    }
}

/// Confirmed mode: answer once the other side stops talking and the last "them" run is a question.
// shortcut: speculative mode takes the same path; starting at the early pause (VAD Pause event) is still to do.
async fn auto_detect(a: Answerer, shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<()>) {
    let mut last_asked = String::new();
    while rx.recv().await.is_some() {
        tokio::time::sleep(std::time::Duration::from_millis(AUTO_SETTLE_MS)).await;
        while rx.try_recv().is_ok() {} // later finals are covered by this check
        if !shared.status.lock().unwrap().auto || shared.them_speaking.load(Ordering::Relaxed) {
            continue;
        }
        let (question, q_t) = llm::question(&shared.transcript.lock().unwrap());
        if question == last_asked || !textproc::is_question(&question) {
            continue;
        }
        info!("auto: question detected: {question}");
        last_asked = question.clone();
        a.ask(&shared, "auto", Some((question, q_t)), None);
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

fn spawn_tier(tier: &'static str, mut session: Session, warm_model: String, shared: Arc<Shared>) -> mpsc::UnboundedSender<Msg> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    tokio::spawn(async move {
        if let Err(e) = session.warm(&warm_model).await {
            warn!("[{tier}] warm-up failed: {e:#}");
            let _ = shared.events.send(Event::Error { message: format!("Claude ({tier}): {e:#}") });
        }
        // Transcript segments already sent in this session.
        let mut sent = 0usize;
        // dHash of the last screen image this session holds: the same screen is not sent twice.
        let mut last_screen: Option<u64> = None;
        let mut pending: Option<Msg> = None;
        loop {
            let msg = match pending.take() {
                Some(m) => m,
                None => match rx.recv().await {
                    Some(m) => m,
                    None => break,
                },
            };
            let req = match msg {
                Msg::Clear => {
                    session.reset().await;
                    sent = 0;
                    last_screen = None;
                    continue;
                }
                Msg::Reconfigure(system) => {
                    session.set_system(system);
                    session.reset().await;
                    sent = 0;
                    last_screen = None;
                    if let Err(e) = session.warm(&warm_model).await {
                        warn!("[{tier}] warm-up failed: {e:#}");
                    }
                    continue;
                }
                Msg::Ask(r) => r,
            };
            let id = req.id;
            let ev = shared.events.clone();
            let _ = ev.send(Event::AnswerStart {
                id,
                turn: req.turn,
                trigger: req.trigger.clone(),
                question: req.question.clone(),
                q_t: req.q_t,
                tier: tier.into(),
            });
            if tier == "full" {
                shared.update_status(|s| s.busy = true);
            }
            let started = Instant::now();
            let mut answer = String::new();
            let mut stuck = false;
            let result = match session.prepare(&req.model).await {
                Err(e) => Some(Err(e)),
                Ok(fresh) => {
                    if fresh {
                        sent = 0;
                        last_screen = None;
                    }
                    let screen = match &req.shot {
                        None => llm::Screen::None,
                        Some(sh) if last_screen.is_some_and(|h| crate::screen::same_screen(h, sh.hash)) => {
                            info!("[{tier}] screen unchanged, image not resent");
                            llm::Screen::Unchanged
                        }
                        Some(sh) => {
                            last_screen = Some(sh.hash);
                            llm::Screen::Attached
                        }
                    };
                    let image = (screen == llm::Screen::Attached).then(|| req.shot.as_ref().map(|s| Arc::new(s.png.clone()))).flatten();
                    let turn = llm::Turn { text: llm::turn_text(&req.segs[sent.min(req.segs.len())..], &req.question, screen), image };
                    sent = req.segs.len();
                    let got_first = AtomicBool::new(false);
                    let mut emit = |c: Chunk| match c {
                        Chunk::Text(t) => {
                            if !got_first.swap(true, Ordering::Relaxed) {
                                let ms = started.elapsed().as_secs_f64() * 1000.0;
                                let _ = ev.send(Event::Metrics { name: format!("answer_first_token_{tier}"), ms });
                            }
                            answer.push_str(&t);
                            let _ = ev.send(Event::AnswerDelta { id, text: t });
                        }
                        Chunk::Usage { input, cache_read, cache_write, output } => {
                            info!("[{tier}] tokens: input {input}, cache read {cache_read}, cache write {cache_write}, output {output}")
                        }
                    };
                    tokio::select! {
                        r = session.ask(&req.model, &turn, &mut emit) => Some(r),
                        secs = overdue(&got_first, FIRST_TOKEN_TIMEOUT, ANSWER_TIMEOUT) => {
                            stuck = true;
                            Some(Err(anyhow::anyhow!("Claude не ответил за {secs} с")))
                        }
                        m = rx.recv() => {
                            pending = m;
                            None
                        }
                    }
                }
            };
            let error = match result {
                Some(Ok(())) => {
                    crate::call::save_answer(&shared, crate::call::AnswerRecord {
                        turn: req.turn,
                        tier: tier.into(),
                        trigger: req.trigger.clone(),
                        question: req.question.clone(),
                        q_t: req.q_t,
                        model: req.model.clone(),
                        text: std::mem::take(&mut answer),
                        shot: req.shot_file.clone(),
                    });
                    None
                }
                Some(Err(e)) => {
                    warn!("[{tier}] answer failed: {e:#}");
                    if stuck {
                        // The backend's state is unknown: start a new session (claude-code restarts).
                        session.reset().await;
                        sent = 0;
                        last_screen = None;
                    }
                    Some(format!("{e:#}"))
                }
                None => {
                    session.cancel().await;
                    Some("cancelled".into())
                }
            };
            let _ = ev.send(Event::Metrics { name: format!("answer_total_{tier}"), ms: started.elapsed().as_secs_f64() * 1000.0 });
            let _ = ev.send(Event::AnswerEnd { id, error });
            if tier == "full" && pending.is_none() {
                shared.update_status(|s| s.busy = false);
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
