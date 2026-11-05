//! call-core: audio capture, speech pipeline and Claude client for the call assistant.
//! Talks NDJSON over stdio to the Electron UI (see the `protocol` crate).

mod answer;
mod call;
mod config;
mod context;
mod llm;
mod screen;
mod streams;
mod stt_worker;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use anyhow::Result;
use protocol::{Command, Event, Speaker, Status};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::streams::StreamSet;
use crate::stt_worker::SttQueue;

pub type EventTx = mpsc::UnboundedSender<Event>;

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
    pub them_speaking: std::sync::atomic::AtomicBool,
    /// Set once at startup; the STT worker reports "them" finals to it.
    pub answerer: std::sync::OnceLock<answer::Answerer>,
    /// Whisper spelling hints of the current context (call, folder, profile, config).
    pub glossary: RwLock<Vec<String>>,
    /// Directory of the open call; finals and answers are appended to it.
    pub call: Mutex<Option<PathBuf>>,
    /// Notes standing in for the early transcript of a long call.
    pub notes: Mutex<answer::Notes>,
}

impl Shared {
    pub fn update_status(&self, f: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.events.send(Event::Status(snapshot));
    }

    #[cfg(test)]
    pub fn for_test() -> (Arc<Shared>, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Shared {
            status: Mutex::new(Status {
                me: Default::default(),
                them: Default::default(),
                stt: "off".into(),
                auto: false,
                model: "test".into(),
                answer_mode: Default::default(),
                busy: false,
                recording_dir: None,
            }),
            events: tx,
            transcript: Default::default(),
            them_speaking: Default::default(),
            answerer: Default::default(),
            glossary: Default::default(),
            call: Default::default(),
            notes: Default::default(),
        };
        (Arc::new(shared), rx)
    }
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,ort=warn".into()),
        )
        .init();

    let mut config_path: Option<PathBuf> = None;
    let mut print_config = false;
    let mut print_context: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" => config_path = args.next().map(PathBuf::from),
            // Effective config (file + defaults) as JSON, for the settings UI.
            "--print-config" => print_config = true,
            // The exact system prompt a call would get: `--print-context <call dir>` (or "" for the profile alone).
            "--print-context" => print_context = Some(args.next().map(PathBuf::from).unwrap_or_default()),
            // Screenshot as the answer would get it: `--snap <out.png> [--monitor | --rect x,y,w,h]`.
            "--snap" => {
                let out = args.next().map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("--snap <out.png> [--monitor]"))?;
                let mode = args.next();
                screen::dpi_aware();
                let t = std::time::Instant::now();
                let shot = match mode.as_deref() {
                    Some("--monitor") => screen::capture(true)?,
                    // `--rect x,y,w,h` in physical pixels.
                    Some("--rect") => {
                        let v: Vec<i32> = args.next().unwrap_or_default().split(',').filter_map(|n| n.trim().parse().ok()).collect();
                        let [x, y, w, h] = v[..] else { anyhow::bail!("--rect x,y,w,h") };
                        screen::capture_rect(x, y, w, h)?
                    }
                    _ => screen::capture(false)?,
                };
                std::fs::write(&out, &shot.png)?;
                eprintln!("{}x{} за {} мс: {}", shot.width, shot.height, t.elapsed().as_millis(), shot.source);
                return Ok(());
            }
            // Display affinity of windows (0x11 = hidden from capture): `--check-affinity <hwnd>...`.
            "--check-affinity" => {
                for h in args.by_ref() {
                    let a = h.parse::<isize>().map_err(anyhow::Error::from).and_then(screen::affinity);
                    println!("{h} {}", a.map_or_else(|e| format!("error {e}"), |a| format!("{a:#x}")));
                }
                return Ok(());
            }
            // Text of a PDF (cached next to it in .text/), for the UI's preview.
            "--extract" => {
                let pdf = args.next().map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("--extract <pdf>"))?;
                println!("{}", context::pdf_text(&pdf)?);
                return Ok(());
            }
            "--list-mics" => {
                for m in audio::list_mics()? {
                    println!("{m}");
                }
                return Ok(());
            }
            other => warn!("unknown argument {other}"),
        }
    }

    let (cfg, loaded_from) = Config::load(config_path.as_deref())?;
    if print_config {
        println!("{}", serde_json::to_string(&cfg)?);
        return Ok(());
    }
    if let Some(dir) = print_context {
        let dir = Some(dir.as_path()).filter(|d| !d.as_os_str().is_empty());
        if let Some(d) = dir.filter(|d| !d.is_dir()) {
            anyhow::bail!("no call directory {}", d.display());
        }
        let a = context::assemble(&cfg.profile_dir(), dir, &cfg.user_context, &cfg.glossary);
        println!("{}", llm::system_prompt(false, &a.text));
        // Read by the «Звонки» window: Russian, one line each.
        eprintln!("≈{} токенов. Глоссарий: {}", a.tokens(), if a.glossary.is_empty() { "пусто".into() } else { a.glossary.join(", ") });
        for w in &a.warnings {
            eprintln!("{w}");
        }
        return Ok(());
    }
    match &loaded_from {
        Some(p) => info!("config: {}", p.display()),
        None => warn!("config.json not found, using defaults"),
    }

    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run(cfg, loaded_from))
}

async fn run(cfg: Config, config_path: Option<PathBuf>) -> Result<()> {
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

    let shared = Arc::new(Shared {
        status: Mutex::new(Status {
            me: Default::default(),
            them: Default::default(),
            stt: "off".into(),
            auto: cfg.auto_detect,
            model: cfg.model.clone(),
            answer_mode: cfg.answer_mode,
            busy: false,
            recording_dir: record_dir.as_ref().map(|d| d.display().to_string()),
        }),
        events: tx.clone(),
        transcript: Mutex::new(Vec::new()),
        them_speaking: Default::default(),
        answerer: Default::default(),
        glossary: Default::default(),
        call: Default::default(),
        notes: Default::default(),
    });
    // Until a call is opened: the profile alone.
    let profile = context::assemble(&cfg.profile_dir(), None, &cfg.user_context, &cfg.glossary);
    *shared.glossary.write().unwrap() = profile.glossary.clone();

    let _ = tx.send(Event::Ready { version: env!("CARGO_PKG_VERSION").into() });
    shared.update_status(|_| {});

    let queue = Arc::new(SttQueue::default());
    let stt = stt_worker::spawn(&cfg, shared.clone(), queue.clone())?;
    let streams = StreamSet::start(&cfg, shared.clone(), queue.clone(), record_dir)?;
    let answerer = answer::Answerer::start(&cfg, shared.clone(), &profile.text);
    let _ = shared.answerer.set(answerer.clone());

    // stdin reader: commands from the UI. EOF means the UI died -> shut down.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { info!("stdin closed, shutting down"); break; };
                if line.trim().is_empty() { continue; }
                match serde_json::from_str::<Command>(&line) {
                    Ok(Command::Shutdown) => break,
                    Ok(cmd) => handle(cmd, &cfg, &shared, &answerer),
                    Err(e) => { let _ = tx.send(Event::Error { message: format!("bad command {line:?}: {e}") }); }
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }

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

fn handle(cmd: Command, cfg: &Config, shared: &Arc<Shared>, answerer: &answer::Answerer) {
    match cmd {
        Command::Ask { screenshot, question } => {
            let picked = question.filter(|q| !q.trim().is_empty()).map(|q| (q, None));
            if !screenshot {
                answerer.ask(shared, if picked.is_some() { "picked" } else { "hotkey" }, picked, None);
                return;
            }
            let (shared, answerer) = (shared.clone(), answerer.clone());
            tokio::spawn(async move {
                let t = std::time::Instant::now();
                let shot = match tokio::task::spawn_blocking(|| screen::capture(false)).await {
                    Ok(Ok(s)) => {
                        info!("screenshot {}x{}, {} KB in {} ms: {}", s.width, s.height, s.png.len() / 1024, t.elapsed().as_millis(), s.source);
                        Some(s)
                    }
                    Ok(Err(e)) => {
                        let _ = shared.events.send(Event::Error { message: format!("не удалось снять экран: {e:#}") });
                        None
                    }
                    Err(e) => {
                        warn!("screenshot task: {e}");
                        None
                    }
                };
                answerer.ask(&shared, "screen", picked, shot);
            });
        }
        Command::Set { auto, model, answer_mode } => shared.update_status(|s| {
            if let Some(a) = auto {
                s.auto = a;
            }
            if let Some(m) = model {
                s.model = if m == "toggle" {
                    if s.model == cfg.model { cfg.alt_model.clone() } else { cfg.model.clone() }
                } else {
                    m
                };
            }
            if let Some(m) = answer_mode {
                s.answer_mode = m;
            }
        }),
        Command::Clear => {
            shared.transcript.lock().unwrap().clear();
            answer::Answerer::forget_notes(shared);
            answerer.clear();
        }
        // shortcut: assembly runs on the command loop; a large uncached PDF stalls commands for a second or two.
        Command::OpenCall { dir } => {
            if let Err(e) = call::open(cfg, shared, answerer, PathBuf::from(dir)) {
                let _ = shared.events.send(Event::Error { message: format!("{e:#}") });
            }
        }
        Command::ReloadContext => call::reload(cfg, shared, answerer),
        Command::CloseCall => call::close(cfg, shared, answerer),
        Command::Shutdown => unreachable!(),
    }
}
