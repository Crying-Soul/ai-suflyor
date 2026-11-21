//! suflyor-core: audio capture, speech pipeline and Claude client for Suflyor, the live call prompter.
//! Talks NDJSON over stdio to the Electron UI (see the `protocol` crate).

mod answer;
mod brief;
mod call;
mod config;
mod context;
mod eval;
mod llm;
mod screen;
mod streams;
mod stt_worker;
mod translate;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};

use anyhow::Result;
use clap::Parser;
use protocol::{AskKind, Command, Event, Speaker, Status, SttState, Trigger};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::streams::StreamSet;
use crate::stt_worker::SttQueue;

pub type EventTx = mpsc::UnboundedSender<Event>;

/// Epoch milliseconds now.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FinalSegment {
    pub speaker: Speaker,
    pub t_ms: u64,
    /// Epoch ms of the end of speech.
    pub end_ms: u64,
    pub text: String,
}

pub struct Shared {
    pub status: Mutex<Status>,
    pub events: EventTx,
    /// Final transcript, chronological per speaker (merged by time when rendered).
    pub transcript: Mutex<Vec<FinalSegment>>,
    /// VAD of the other side is active (auto-detect waits for the end of their turn).
    pub them_speaking: AtomicBool,
    /// The Claude side; `reload_llm` replaces it. The STT worker reports "them" finals to it.
    pub answerer: RwLock<Option<answer::Answerer>>,
    /// The STT worker hands it "them" finals while translation is on; replaced with the answerer.
    pub translator: RwLock<Option<translate::Translator>>,
    /// Answer and turn ids, kept across answerers so the UI never sees one twice.
    pub ids: Arc<AtomicU64>,
    /// Whisper spelling hints of the current context (call, folder, profile, config).
    pub glossary: RwLock<Vec<String>>,
    /// Directory of the open call; finals and answers are appended to it.
    pub call: Mutex<Option<PathBuf>>,
    /// Notes standing in for the early transcript of a long call.
    pub notes: Mutex<answer::Notes>,
    /// The saved answer records of each live turn of the open call, for ratings.
    pub answer_ids: Mutex<call::AnswerIds>,
}

impl Shared {
    pub fn new(status: Status, events: EventTx) -> Shared {
        Shared {
            status: Mutex::new(status),
            events,
            transcript: Default::default(),
            them_speaking: Default::default(),
            answerer: Default::default(),
            translator: Default::default(),
            ids: Arc::new(AtomicU64::new(1)),
            glossary: Default::default(),
            call: Default::default(),
            notes: Default::default(),
            answer_ids: Default::default(),
        }
    }

    pub fn update_status(&self, f: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.events.send(Event::Status(snapshot));
    }

    pub fn answerer(&self) -> Option<answer::Answerer> {
        self.answerer.read().unwrap().clone()
    }

    pub fn translator(&self) -> Option<translate::Translator> {
        self.translator.read().unwrap().clone()
    }

    #[cfg(test)]
    pub fn for_test() -> (Arc<Shared>, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Shared::new(initial_status(&Config::default(), None), tx)), rx)
    }
}

fn initial_status(cfg: &Config, recording_dir: Option<String>) -> Status {
    Status {
        me: Default::default(),
        them: Default::default(),
        stt: SttState::Off,
        auto: cfg.auto_detect,
        model: cfg.model.clone(),
        answer_mode: cfg.answer_mode,
        translate: cfg.translate,
        mute_me: false,
        mute_them: false,
        busy: false,
        recording_dir,
    }
}

/// suflyor-core: the speech pipeline and Claude client of Suflyor. Without a one-shot flag it runs
/// the live pipeline and talks NDJSON over stdio.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    #[arg(long)]
    config: Option<PathBuf>,
    /// Effective config (file + defaults) as JSON, for the settings UI.
    #[arg(long)]
    print_config: bool,
    /// The exact system prompt a call would get (no value: the profile alone).
    #[arg(long, value_name = "CALL_DIR", num_args = 0..=1, default_missing_value = "")]
    print_context: Option<PathBuf>,
    /// «Подготовить»: build the call's brief.md now, whatever the context size, and print it.
    #[arg(long, value_name = "CALL_DIR")]
    brief: Option<PathBuf>,
    /// Answer quality offline (eval.rs).
    #[arg(long, value_name = "DIR")]
    eval: Option<PathBuf>,
    /// Results file of `--eval`.
    #[arg(long, requires = "eval")]
    out: Option<PathBuf>,
    /// An earlier `--eval` run to compare with.
    #[arg(long, requires = "eval")]
    baseline: Option<PathBuf>,
    /// `--eval`: a strong model scores the answers.
    #[arg(long, requires = "eval")]
    judge: bool,
    /// Screenshot as the answer would get it (the foreground window).
    #[arg(long, value_name = "OUT")]
    snap: Option<PathBuf>,
    /// `--snap`: the monitor under the cursor.
    #[arg(long, requires = "snap")]
    monitor: bool,
    /// `--snap`: this rectangle in physical pixels.
    #[arg(long, requires = "snap", value_name = "X,Y,W,H", value_delimiter = ',', num_args = 4)]
    rect: Option<Vec<i32>>,
    /// Display affinity of windows (0x11 = hidden from capture).
    #[arg(long, value_name = "HWND", num_args = 1..)]
    check_affinity: Option<Vec<isize>>,
    /// Text of a PDF (cached next to it in .text/), for the UI's preview.
    #[arg(long, value_name = "PDF")]
    extract: Option<PathBuf>,
    #[arg(long)]
    list_audio_apps: bool,
    #[arg(long)]
    list_mics: bool,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,ort=warn".into()))
        .init();
    let args = Args::parse();

    if let Some(out) = &args.snap {
        screen::dpi_aware();
        let t = std::time::Instant::now();
        let shot = match args.rect.as_deref() {
            Some(&[x, y, w, h]) => screen::capture_rect(x, y, w, h)?,
            _ => screen::capture(args.monitor)?,
        };
        std::fs::write(out, &shot.image)?;
        eprintln!("{}x{} за {} мс: {}", shot.width, shot.height, t.elapsed().as_millis(), shot.source);
        return Ok(());
    }
    if let Some(hwnds) = &args.check_affinity {
        for &h in hwnds {
            println!("{h} {}", screen::affinity(h).map_or_else(|e| format!("error {e}"), |a| format!("{a:#x}")));
        }
        return Ok(());
    }
    if let Some(pdf) = &args.extract {
        println!("{}", context::pdf_text(pdf)?);
        return Ok(());
    }
    if args.list_audio_apps || args.list_mics {
        for m in if args.list_mics { audio::list_mics()? } else { audio::list_audio_apps()? } {
            println!("{m}");
        }
        return Ok(());
    }

    let (cfg, loaded_from) = Config::load(args.config.as_deref())?;
    if args.print_config {
        // The key stays out of other processes' pipes and logs; the UI keeps its own copy.
        let mut shown = cfg.clone();
        if !shown.anthropic_api_key.is_empty() {
            shown.anthropic_api_key = "set".into();
        }
        println!("{}", serde_json::to_string(&shown)?);
        return Ok(());
    }
    if let Some(dir) = &args.print_context {
        let dir = Some(dir.as_path()).filter(|d| !d.as_os_str().is_empty());
        if let Some(d) = dir.filter(|d| !d.is_dir()) {
            anyhow::bail!("no call directory {}", d.display());
        }
        let a = context::assemble(&cfg.profile_dir(), dir, &cfg.user_context, &cfg.glossary);
        // As the full tier gets it: with the prepared answers of a current brief.
        let place = dir.map(PathBuf::from).unwrap_or_else(|| cfg.profile_dir());
        let full = brief::with_prepared(&a.text, brief::cached(&place, &brief::key(&a.text)).as_deref());
        println!("{}", llm::system_prompt(false, &full, &cfg.user_language));
        // Read by the «Звонки» window: Russian, one line each.
        eprintln!("≈{} токенов. Глоссарий: {}", a.tokens(), if a.glossary.is_empty() { "пусто".into() } else { a.glossary.join(", ") });
        for w in &a.warnings {
            eprintln!("{w}");
        }
        return Ok(());
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    if let Some(dir) = &args.brief {
        if !dir.is_dir() {
            anyhow::bail!("no call directory {}", dir.display());
        }
        let a = context::assemble(&cfg.profile_dir(), Some(dir), &cfg.user_context, &cfg.glossary);
        let b = rt.block_on(answer::make_brief(&cfg, &a.text, &mut |_, _| {}))?;
        if b.is_empty() {
            anyhow::bail!("пустой ответ модели");
        }
        brief::store(dir, &brief::key(&a.text), &b)?;
        println!("{b}");
        return Ok(());
    }
    if let Some(dir) = &args.eval {
        rt.block_on(eval::run(&cfg, dir, args.out, args.judge, args.baseline))?;
        return Ok(());
    }
    match &loaded_from {
        Some(p) => info!("config: {}", p.display()),
        None => warn!("config.json not found, using defaults"),
    }
    rt.block_on(run(cfg, loaded_from))
}

async fn run(mut cfg: Config, config_path: Option<PathBuf>) -> Result<()> {
    screen::dpi_aware();
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

    // stdout writer: the only place that writes to stdout.
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(ev) = rx.recv().await {
            let mut line = match serde_json::to_vec(&ev) {
                Ok(l) => l,
                Err(e) => {
                    error!("serialize event: {e}");
                    continue;
                }
            };
            line.push(b'\n');
            if out.write_all(&line).await.is_err() || out.flush().await.is_err() {
                break; // UI is gone
            }
        }
    });

    let record_dir = cfg.debug.record_wav.then(|| {
        let base = config_path.as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
        base.join(&cfg.debug.record_dir)
    });
    let shared = Arc::new(Shared::new(initial_status(&cfg, record_dir.as_ref().map(|d| d.display().to_string())), tx.clone()));
    // Until a call is opened: the profile alone.
    let profile = context::assemble(&cfg.profile_dir(), None, &cfg.user_context, &cfg.glossary);
    *shared.glossary.write().unwrap() = profile.glossary.clone();

    let _ = tx.send(Event::Ready { version: env!("CARGO_PKG_VERSION").into() });
    shared.update_status(|_| {});

    let queue = Arc::new(SttQueue::default());
    let stt = stt_worker::spawn(&cfg, shared.clone(), queue.clone())?;
    let streams = StreamSet::start(&cfg, shared.clone(), queue.clone(), record_dir)?;
    let mut answerer = start_llm(&cfg, &shared, &profile.text);
    // Calls left open at the last quit get their summary now.
    for dir in call::pending_summaries(&cfg) {
        call::summarize(&cfg, &shared, &answerer, dir);
    }

    // stdin reader: commands from the UI. EOF means the UI died -> shut down.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { info!("stdin closed, shutting down"); break; };
                if line.trim().is_empty() { continue; }
                match serde_json::from_str::<Command>(&line) {
                    Ok(Command::Shutdown) => break,
                    Ok(Command::ReloadLlm { anthropic_api_key }) => match reload_llm(&mut cfg, config_path.as_deref(), anthropic_api_key, &shared, &answerer) {
                        Ok(a) => answerer = a,
                        Err(e) => { let _ = tx.send(Event::Error { message: format!("настройки не применились: {e:#}"), kind: None }); }
                    },
                    Ok(cmd) => handle(cmd, &cfg, &shared, &answerer),
                    Err(e) => { let _ = tx.send(Event::Error { message: format!("bad command {line:?}: {e}"), kind: None }); }
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }

    // A call still open: its summary is written at the next start, so quitting never waits for it.
    call::defer_summary(&shared);
    streams.stop();
    queue.close();
    // The STT worker may be stuck loading the model; don't hold up shutdown for it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !stt.is_finished() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    drop(shared);
    drop(tx);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer).await;
    Ok(())
}

/// The Claude side: the answerer and the translator, put into `shared`.
fn start_llm(cfg: &Config, shared: &Arc<Shared>, context: &str) -> answer::Answerer {
    let answerer = answer::Answerer::start(cfg, shared.clone(), context);
    *shared.answerer.write().unwrap() = Some(answerer.clone());
    let translator = translate::Translator::start(cfg, shared.clone());
    if shared.status.lock().unwrap().translate {
        translator.warm();
    }
    *shared.translator.write().unwrap() = Some(translator);
    answerer
}

/// `reload_llm`: re-reads the config and replaces the Claude side; audio and speech recognition go on.
/// Status switches the new config changed (auto, model, mode, translation) follow it; the others
/// keep what the user set with hotkeys.
fn reload_llm(cfg: &mut Config, path: Option<&std::path::Path>, key: Option<String>, shared: &Arc<Shared>, old: &answer::Answerer) -> Result<answer::Answerer> {
    let (mut new, _) = Config::load(path)?;
    if let Some(k) = key.filter(|_| new.anthropic_api_key.is_empty()) {
        new.anthropic_api_key = k;
    }
    old.stop();
    shared.update_status(|s| {
        if new.auto_detect != cfg.auto_detect {
            s.auto = new.auto_detect;
        }
        if new.model != cfg.model || new.alt_model != cfg.alt_model {
            s.model = new.model.clone();
        }
        if new.answer_mode != cfg.answer_mode {
            s.answer_mode = new.answer_mode;
        }
        if new.translate != cfg.translate {
            s.translate = new.translate;
        }
    });
    *cfg = new;
    let profile = context::assemble(&cfg.profile_dir(), None, &cfg.user_context, &cfg.glossary);
    let answerer = start_llm(cfg, shared, &profile.text);
    // The open call's context (or the profile) goes to the new tiers; the transcript stays.
    call::reload(cfg, shared, &answerer);
    info!("Claude settings reloaded: model {}, quick {}, backend {:?}", cfg.model, cfg.quick_model, cfg.llm.backend);
    Ok(answerer)
}

fn handle(cmd: Command, cfg: &Config, shared: &Arc<Shared>, answerer: &answer::Answerer) {
    match cmd {
        Command::Ask { kind: AskKind::Answer, screenshot, question } => {
            let picked = question.filter(|q| !q.trim().is_empty()).map(|q| (q, None));
            if !screenshot {
                answerer.ask(shared, if picked.is_some() { Trigger::Picked } else { Trigger::Hotkey }, picked, None);
                return;
            }
            let (shared, answerer) = (shared.clone(), answerer.clone());
            tokio::spawn(async move {
                let t = std::time::Instant::now();
                let shot = match tokio::task::spawn_blocking(|| screen::capture(false)).await {
                    Ok(Ok(s)) => {
                        info!("screenshot {}x{}, {} KB in {} ms: {}", s.width, s.height, s.image.len() / 1024, t.elapsed().as_millis(), s.source);
                        Some(s)
                    }
                    Ok(Err(e)) => {
                        let _ = shared.events.send(Event::Error { message: format!("не удалось снять экран: {e:#}"), kind: None });
                        None
                    }
                    Err(e) => {
                        warn!("screenshot task: {e}");
                        None
                    }
                };
                answerer.ask(&shared, Trigger::Screen, picked, shot);
            });
        }
        Command::Ask { kind, .. } => {
            let (trigger, text) = match kind {
                AskKind::Questions => (Trigger::Questions, llm::MY_QUESTIONS),
                AskKind::Continue => (Trigger::Continue, llm::CONTINUE),
                AskKind::More => (Trigger::More, llm::MORE),
                AskKind::Shorter => (Trigger::Shorter, llm::SHORTER),
                AskKind::Simpler => (Trigger::Simpler, llm::SIMPLER),
                _ => (Trigger::Example, llm::EXAMPLE),
            };
            answerer.ask(shared, trigger, Some((text.to_string(), None)), None);
        }
        Command::Set { auto, model, answer_mode, translate, mute_me, mute_them } => shared.update_status(|s| {
            if let Some(t) = translate {
                if t && !s.translate
                    && let Some(tr) = shared.translator()
                {
                    tr.warm();
                }
                s.translate = t;
            }
            if let Some(m) = mute_me {
                s.mute_me = m;
            }
            if let Some(m) = mute_them {
                s.mute_them = m;
            }
            if let Some(a) = auto {
                s.auto = a;
            }
            if let Some(m) = model {
                s.model = if m == "toggle" { if s.model == cfg.model { cfg.alt_model.clone() } else { cfg.model.clone() } } else { m };
            }
            if let Some(m) = answer_mode {
                s.answer_mode = m;
            }
        }),
        Command::Clear => {
            shared.transcript.lock().unwrap().clear();
            answer::Answerer::forget_notes(shared);
            answerer.clear();
            if let Some(t) = shared.translator() {
                t.clear();
            }
        }
        // shortcut: assembly runs on the command loop; a large uncached PDF stalls commands for a second or two.
        Command::OpenCall { dir } => {
            if let Err(e) = call::open(cfg, shared, answerer, PathBuf::from(dir)) {
                let _ = shared.events.send(Event::Error { message: format!("{e:#}"), kind: None });
            }
        }
        Command::ReloadContext => call::reload(cfg, shared, answerer),
        Command::CloseCall => call::close(cfg, shared, answerer),
        Command::Summarize { dir } => {
            let dir = PathBuf::from(dir);
            let open = shared.call.lock().unwrap().as_ref() == Some(&dir);
            if open || !dir.is_dir() {
                let why = if open { "звонок ещё идёт, сначала завершите его" } else { "нет папки звонка" };
                let _ = shared.events.send(Event::Summary { dir: dir.display().to_string(), ok: false, error: Some(why.into()) });
            } else {
                call::summarize(cfg, shared, answerer, dir);
            }
        }
        Command::Feedback { turn, value } => call::set_feedback(shared, turn, value),
        Command::Shutdown | Command::ReloadLlm { .. } => unreachable!("handled by the command loop"),
    }
}
