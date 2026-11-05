//! Answer pipeline: one actor per tier (quick hint, full answer). Each owns an LLM session,
//! turns a transcript snapshot into a user turn and streams the reply to the UI.
//! A newer request cancels the one in progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use protocol::Event;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{Backend, Config};
use crate::llm::{self, Chunk, Session};
use crate::{FinalSegment, Shared};

struct Req {
    id: u64,
    turn: u64,
    model: String,
    trigger: String,
    question: String,
    q_t: Option<u64>,
    segs: Arc<Vec<FinalSegment>>,
}

enum Msg {
    Ask(Req),
    Clear,
}

#[derive(Clone)]
pub struct Answerer {
    full: mpsc::UnboundedSender<Msg>,
    quick: Option<(mpsc::UnboundedSender<Msg>, String)>,
    next_id: Arc<AtomicU64>,
    /// "them" finals for auto-detect.
    auto: mpsc::UnboundedSender<()>,
}

/// After a "them" final, wait this long for more speech before deciding the turn is over.
const AUTO_SETTLE_MS: u64 = 250;

impl Answerer {
    pub fn start(cfg: &Config, shared: Arc<Shared>) -> Answerer {
        let make = |quick: bool| {
            let system = llm::system_prompt(quick, &cfg.user_context);
            let tier = if quick { "quick" } else { "full" };
            if cfg.llm.backend == Backend::ClaudeCode {
                Session::Code(llm::claude_code::CodeSession::new(cfg.claude_code.command.clone(), system, cfg.effort.clone(), tier))
            } else {
                let key = Some(cfg.anthropic_api_key.clone())
                    .filter(|k| !k.is_empty())
                    .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                    .unwrap_or_default();
                Session::Api(llm::api::ApiSession::new(key, system, cfg.effort.clone(), if quick { 200 } else { 2048 }))
            }
        };
        let full = spawn_tier("full", make(false), cfg.model.clone(), shared.clone());
        let quick = cfg.two_tier.then(|| (spawn_tier("quick", make(true), cfg.quick_model.clone(), shared.clone()), cfg.quick_model.clone()));
        let (auto, auto_rx) = mpsc::unbounded_channel();
        let a = Answerer { full, quick, next_id: Arc::new(AtomicU64::new(1)), auto };
        tokio::spawn(auto_detect(a.clone(), shared, auto_rx));
        a
    }

    /// Called by the STT worker for every "them" final.
    pub fn on_them_final(&self) {
        let _ = self.auto.send(());
    }

    /// Starts both tiers. `question`: (text, start of its transcript run); None = the latest "them" run.
    pub fn ask(&self, shared: &Shared, trigger: &str, question: Option<(String, Option<u64>)>) {
        let segs = Arc::new(shared.transcript.lock().unwrap().clone());
        let (question, q_t) = question.unwrap_or_else(|| llm::question(&segs));
        let model = shared.status.lock().unwrap().model.clone();
        let turn = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = |model: String| Req {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            turn,
            model,
            trigger: trigger.to_string(),
            question: question.clone(),
            q_t,
            segs: segs.clone(),
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
        a.ask(&shared, "auto", Some((question, q_t)));
    }
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
            let result = match session.prepare(&req.model).await {
                Err(e) => Some(Err(e)),
                Ok(fresh) => {
                    if fresh {
                        sent = 0;
                    }
                    let text = llm::turn_text(&req.segs[sent.min(req.segs.len())..], &req.question);
                    sent = req.segs.len();
                    let mut first = true;
                    let mut emit = |c: Chunk| match c {
                        Chunk::Text(t) => {
                            if std::mem::take(&mut first) {
                                let ms = started.elapsed().as_secs_f64() * 1000.0;
                                let _ = ev.send(Event::Metrics { name: format!("answer_first_token_{tier}"), ms });
                            }
                            let _ = ev.send(Event::AnswerDelta { id, text: t });
                        }
                        Chunk::Usage { input, cache_read, cache_write, output } => {
                            info!("[{tier}] tokens: input {input}, cache read {cache_read}, cache write {cache_write}, output {output}")
                        }
                    };
                    tokio::select! {
                        r = session.ask(&req.model, text, &mut emit) => Some(r),
                        m = rx.recv() => {
                            pending = m;
                            None
                        }
                    }
                }
            };
            let error = match result {
                Some(Ok(())) => None,
                Some(Err(e)) => {
                    warn!("[{tier}] answer failed: {e:#}");
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
