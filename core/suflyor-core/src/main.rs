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

use std::path::{Path, PathBuf};
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
    /// The brief being made in the background (`call::apply`), if any.
    pub brief_task: Mutex<Option<tokio::task::AbortHandle>>,
    /// `Status::mute_me` / `mute_them` by `Speaker::idx`, mirrored by `update_status`: the audio threads read them per chunk.
    pub muted: [AtomicBool; 2],
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
            brief_task: Default::default(),
            muted: Default::default(),
        }
    }

    pub fn update_status(&self, f: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            self.muted[Speaker::Me.idx()].store(s.mute_me, std::sync::atomic::Ordering::Relaxed);
            self.muted[Speaker::Them.idx()].store(s.mute_them, std::sync::atomic::Ordering::Relaxed);
            s.clone()
        };
        let _ = self.events.send(Event::Status(snapshot));
    }

    /// The Claude side in use. `run` starts it before audio and commands, so it is always there.
    pub fn answerer(&self) -> answer::Answerer {
        self.answerer.read().unwrap().clone().expect("the answerer starts before audio and commands")
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

/// suflyor-core: the speech pipeline and Claude client of Suflyor. Without a command it runs
/// the live pipeline and talks NDJSON over stdio.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

/// One-shot commands for the UI and for development.
#[derive(clap::Subcommand)]
enum Cmd {
    /// Effective config (file + defaults) as JSON, for the settings UI.
    PrintConfig,
    /// The exact system prompt a call would get (no directory: the profile alone).
    PrintContext {
        call_dir: Option<PathBuf>,
    },
    /// «Подготовить»: build the call's brief.md now, whatever the context size, and print it.
    Brief {
        call_dir: PathBuf,
    },
    /// Answer quality offline (eval.rs).
    Eval {
        dir: PathBuf,
        /// Results file.
        #[arg(long)]
        out: Option<PathBuf>,
        /// An earlier run to compare with.
        #[arg(long)]
        baseline: Option<PathBuf>,
        /// A strong model scores the answers.
        #[arg(long)]
        judge: bool,
    },
    /// Screenshot as the answer would get it (the foreground window).
    Snap {
        out: PathBuf,
        /// The monitor under the cursor.
        #[arg(long)]
        monitor: bool,
        /// This rectangle in physical pixels. One `X,Y,W,H` token; X and Y may be negative.
        #[arg(long, value_name = "X,Y,W,H", allow_hyphen_values = true, value_parser = parse_rect)]
        rect: Option<[i32; 4]>,
    },
    /// Display affinity of windows (0x11 = hidden from capture).
    CheckAffinity {
        #[arg(required = true)]
        hwnds: Vec<isize>,
    },
    /// Text of a PDF (cached next to it in .text/), for the UI's preview.
    Extract {
        pdf: PathBuf,
    },
    ListAudioApps,
    ListMics,
}

/// `X,Y,W,H` as one token. clap's `num_args` counts tokens before a delimiter splits them,
/// so "0,0,200,100" was one value of four and the UI's capture test always failed.
fn parse_rect(s: &str) -> Result<[i32; 4], String> {
    let v = s.split(',').map(|p| p.trim().parse::<i32>().map_err(|_| format!("not a number: {p:?}"))).collect::<Result<Vec<_>, _>>()?;
    v.try_into().map_err(|v: Vec<i32>| format!("need X,Y,W,H (4 numbers), got {}", v.len()))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,ort=warn".into()))
        .init();
    let args = Args::parse();
    let Some(cmd) = args.cmd else {
        let (cfg, loaded_from) = Config::load(args.config.as_deref())?;
        match &loaded_from {
            Some(p) => info!("config: {}", p.display()),
            None => warn!("config.json not found, using defaults"),
        }
        return tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run(cfg, loaded_from));
    };
    let cfg = || Config::load(args.config.as_deref()).map(|(c, _)| c);
    match cmd {
        Cmd::Snap { out, monitor, rect } => {
            screen::dpi_aware();
            let t = std::time::Instant::now();
            let shot = match rect {
                Some([x, y, w, h]) => screen::capture_rect(x, y, w, h)?,
                None => screen::capture(monitor)?,
            };
            std::fs::write(out, &shot.image)?;
            eprintln!("{}x{} за {} мс: {}", shot.width, shot.height, t.elapsed().as_millis(), shot.source);
        }
        Cmd::CheckAffinity { hwnds } => {
            for h in hwnds {
                println!("{h} {}", screen::affinity(h).map_or_else(|e| format!("error {e}"), |a| format!("{a:#x}")));
            }
        }
        Cmd::Extract { pdf } => println!("{}", context::pdf_text(&pdf)?),
        Cmd::ListAudioApps => audio::list_audio_apps()?.iter().for_each(|m| println!("{m}")),
        Cmd::ListMics => audio::list_mics()?.iter().for_each(|m| println!("{m}")),
        // The keys are `serde(skip)`: they never reach other processes' pipes and logs.
        Cmd::PrintConfig => println!("{}", serde_json::to_string(&cfg()?)?),
        Cmd::PrintContext { call_dir } => {
            let cfg = cfg()?;
            let dir = call_dir.as_deref();
            if let Some(d) = dir.filter(|d| !d.is_dir()) {
                anyhow::bail!("no call directory {}", d.display());
            }
            let a = context::assemble(&cfg.profile_dir(), dir, &cfg.user_context, &cfg.glossary);
            // As the full tier gets it: with the prepared answers of a current brief.
            let place = dir.map_or_else(|| cfg.profile_dir(), PathBuf::from);
            let full = brief::with_prepared(&a.text, brief::cached(&place, &brief::key(&a.text)).as_deref());
            println!("{}", llm::system_prompt(false, &full, &cfg.user_language));
            // Read by the «Звонки» window: Russian, one line each.
            eprintln!("≈{} токенов. Глоссарий: {}", a.tokens(), if a.glossary.is_empty() { "пусто".into() } else { a.glossary.join(", ") });
            for w in &a.warnings {
                eprintln!("{w}");
            }
        }
        Cmd::Brief { call_dir } => {
            let cfg = cfg()?;
            if !call_dir.is_dir() {
                anyhow::bail!("no call directory {}", call_dir.display());
            }
            let a = context::assemble(&cfg.profile_dir(), Some(&call_dir), &cfg.user_context, &cfg.glossary);
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            let b = rt.block_on(answer::make_brief(&cfg, &a.text, &mut |_| {}))?;
            if b.is_empty() {
                anyhow::bail!("пустой ответ модели");
            }
            brief::store(&call_dir, &brief::key(&a.text), &b)?;
            println!("{b}");
        }
        Cmd::Eval { dir, out, baseline, judge } => {
            let cfg = cfg()?;
            tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(eval::run(&cfg, &dir, out, judge, baseline))?;
        }
    }
    Ok(())
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
        let base = config_path.as_ref().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
        base.join(&cfg.debug.record_dir)
    });
    let shared = Arc::new(Shared::new(initial_status(&cfg, record_dir.as_ref().map(|d| d.display().to_string())), tx.clone()));
    // Until a call is opened: the profile alone.
    let profile = context::assemble(&cfg.profile_dir(), None, &cfg.user_context, &cfg.glossary);
    *shared.glossary.write().unwrap() = profile.glossary.clone();

    let _ = tx.send(Event::Ready { version: env!("CARGO_PKG_VERSION").into() });
    shared.update_status(|_| {});

    start_llm(&cfg, &shared, &profile.text);
    let queue = Arc::new(SttQueue::default());
    let stt = stt_worker::spawn(&cfg, shared.clone(), queue.clone())?;
    let streams = StreamSet::start(&cfg, shared.clone(), queue.clone(), record_dir)?;
    // Calls left open at the last quit get their summary now.
    for dir in call::pending_summaries(&cfg) {
        call::summarize(&cfg, &shared, dir);
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
                    Ok(Command::ReloadLlm { anthropic_api_key, llm_api_key }) => if let Err(e) = reload_llm(&mut cfg, config_path.as_deref(), (anthropic_api_key, llm_api_key), &shared) {
                        let _ = tx.send(Event::Error { message: format!("настройки не применились: {e:#}"), kind: None });
                    },
                    Ok(cmd) => handle(cmd, &cfg, &shared),
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
fn start_llm(cfg: &Config, shared: &Arc<Shared>, context: &str) {
    *shared.answerer.write().unwrap() = Some(answer::Answerer::start(cfg, shared.clone(), context));
    let translator = translate::Translator::start(cfg, shared.clone());
    if shared.status.lock().unwrap().translate {
        translator.warm();
    }
    *shared.translator.write().unwrap() = Some(translator);
}

/// `reload_llm`: re-reads the config and replaces the Claude side; audio and speech recognition go on.
/// Status switches the new config changed (auto, model, mode, translation) follow it; the others
/// keep what the user set with hotkeys.
fn reload_llm(cfg: &mut Config, path: Option<&std::path::Path>, (key, llm_key): (Option<String>, Option<String>), shared: &Arc<Shared>) -> Result<()> {
    let (mut new, _) = Config::load(path)?;
    if let Some(k) = key {
        new.anthropic_api_key = k;
    }
    if let Some(k) = llm_key {
        new.llm.api_key = k;
    }
    shared.answerer().stop();
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
    start_llm(cfg, shared, &profile.text);
    // The open call's context (or the profile) goes to the new tiers; the transcript stays.
    call::reload(cfg, shared);
    info!("LLM settings reloaded: model {}, quick {}, backend {:?} {}", cfg.model, cfg.quick_model, cfg.llm.backend, cfg.llm.provider);
    Ok(())
}

fn handle(cmd: Command, cfg: &Config, shared: &Arc<Shared>) {
    match cmd {
        Command::Ask { kind: AskKind::Answer, screenshot, question } => {
            let picked = question.filter(|q| !q.trim().is_empty()).map(|q| (q, None));
            if !screenshot {
                shared.answerer().ask(shared, if picked.is_some() { Trigger::Picked } else { Trigger::Hotkey }, picked, None);
                return;
            }
            let shared = shared.clone();
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
                shared.answerer().ask(&shared, Trigger::Screen, picked, shot);
            });
        }
        Command::Ask { kind, .. } => {
            let (trigger, text) = match kind {
                AskKind::Questions => (Trigger::Questions, llm::MY_QUESTIONS),
                AskKind::Continue => (Trigger::Continue, llm::CONTINUE),
                AskKind::More => (Trigger::More, llm::MORE),
                AskKind::Shorter => (Trigger::Shorter, llm::SHORTER),
                AskKind::Simpler => (Trigger::Simpler, llm::SIMPLER),
                AskKind::Example => (Trigger::Example, llm::EXAMPLE),
                AskKind::Answer => unreachable!("matched above"),
            };
            shared.answerer().ask(shared, trigger, Some((text.to_string(), None)), None);
        }
        Command::ToggleModel => shared.update_status(|s| s.model = if s.model == cfg.model { cfg.alt_model.clone() } else { cfg.model.clone() }),
        Command::Set { auto, answer_mode, translate, mute_me, mute_them } => shared.update_status(|s| {
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
            if let Some(m) = answer_mode {
                s.answer_mode = m;
            }
        }),
        Command::Clear => {
            shared.transcript.lock().unwrap().clear();
            answer::Answerer::forget_notes(shared);
            shared.answerer().clear();
            if let Some(t) = shared.translator() {
                t.clear();
            }
        }
        // shortcut: assembly runs on the command loop; a large uncached PDF stalls commands for a second or two.
        Command::OpenCall { dir } => {
            if let Err(e) = call::open(cfg, shared, PathBuf::from(dir)) {
                let _ = shared.events.send(Event::Error { message: format!("{e:#}"), kind: None });
            }
        }
        Command::ReloadContext => call::reload(cfg, shared),
        Command::CloseCall => call::close(cfg, shared),
        Command::Summarize { dir } => {
            let dir = PathBuf::from(dir);
            let open = shared.call.lock().unwrap().as_ref() == Some(&dir);
            if open || !dir.is_dir() {
                let why = if open { "звонок ещё идёт, сначала завершите его" } else { "нет папки звонка" };
                let _ = shared.events.send(Event::Summary { dir: dir.display().to_string(), ok: false, error: Some(why.into()) });
            } else {
                call::summarize(cfg, shared, dir);
            }
        }
        Command::Feedback { turn, value } => call::set_feedback(shared, turn, value),
        Command::Shutdown | Command::ReloadLlm { .. } => unreachable!("handled by the command loop"),
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn status_mutes_reach_the_audio_threads_and_toggle_swaps_the_model() {
        let (shared, _rx) = Shared::for_test();
        shared.update_status(|s| s.mute_them = true);
        let muted = |s: Speaker| shared.muted[s.idx()].load(std::sync::atomic::Ordering::Relaxed);
        assert!(muted(Speaker::Them) && !muted(Speaker::Me));
        let cfg = Config::default();
        shared.status.lock().unwrap().model = cfg.model.clone();
        handle(Command::ToggleModel, &cfg, &shared);
        assert_eq!(shared.status.lock().unwrap().model, cfg.alt_model);
    }

    #[test]
    fn rect_is_one_token_and_may_be_negative() {
        let rect = |r: &str| match Args::try_parse_from(["core", "snap", "a.webp", "--rect", r]).map(|a| a.cmd) {
            Ok(Some(Cmd::Snap { rect, .. })) => rect,
            _ => None,
        };
        assert_eq!(rect("0,0,200,100"), Some([0, 0, 200, 100]));
        // A monitor left of the primary one starts at a negative X.
        assert_eq!(rect("-1920,-8,1920,1080"), Some([-1920, -8, 1920, 1080]));
        assert_eq!(rect("0,0,200"), None);
        assert_eq!(rect("0,0,x,1"), None);
        // `--config` goes before or after a command.
        let a = Args::try_parse_from(["core", "print-context", "--config", "c.json"]).unwrap();
        assert!(matches!(a.cmd, Some(Cmd::PrintContext { call_dir: None })));
        assert_eq!(a.config.as_deref(), Some(std::path::Path::new("c.json")));
        assert!(Args::try_parse_from(["core", "--config", "c.json"]).unwrap().cmd.is_none(), "no command: the live pipeline");
    }
}
