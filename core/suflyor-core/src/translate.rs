//! Translation of the other side's speech into the user's language, by the quick model (Haiku)
//! through the configured backend. Its own session with a small prompt and no call context, so a
//! line costs little. One actor; lines that arrive while a translation runs go out together next,
//! so the translation never falls behind.

use std::sync::Arc;

use protocol::{Event, Tier};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::Shared;
use crate::config::Config;
use crate::llm::{Chunk, Session, Turn};

const SYSTEM: &str = "You translate what the other side says in a live call, often a job interview, into {lang}. \
Each message is their speech from speech recognition: it may have recognition errors, infer the intended words. \
Translate into natural spoken {lang}, keeping the meaning exact. \
Keep technical terms, product names, abbreviations and code identifiers in English as they are (event loop, backpressure, Kubernetes, PostgreSQL, CI/CD). \
Reply with the translation only: no comments, no quotes, no original text.";

/// The session restarts after this many lines: its history only grows.
const RESET_EVERY: u32 = 100;

enum Msg {
    Line(u64, String),
    Clear,
    Warm,
}

#[derive(Clone)]
pub struct Translator {
    tx: mpsc::UnboundedSender<Msg>,
    /// ISO 639-1: speech already in it is not translated.
    user_language: String,
}

/// The name the prompt uses for an ISO 639-1 code.
impl Translator {
    pub fn start(cfg: &Config, shared: Arc<Shared>) -> Translator {
        let session = crate::answer::session(cfg, Tier::Translate, SYSTEM.replace("{lang}", &crate::llm::language_name(&cfg.user_language)));
        Translator::with(session, cfg.quick_model.clone(), cfg.user_language.clone(), shared)
    }

    fn with(session: Session, model: String, user_language: String, shared: Arc<Shared>) -> Translator {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(session, model, shared, rx));
        Translator { tx, user_language }
    }

    /// A final "them" utterance starting at `t`, in `lang` (None: unknown). Speech in the user's own
    /// language is skipped.
    pub fn push(&self, t: u64, text: String, lang: Option<&str>) {
        if lang != Some(self.user_language.as_str()) {
            let _ = self.tx.send(Msg::Line(t, text));
        }
    }

    /// The transcript was cleared: queued lines are dropped, the session starts over.
    pub fn clear(&self) {
        let _ = self.tx.send(Msg::Clear);
    }

    /// Translation was turned on: start the backend now, so the first line does not wait for it.
    pub fn warm(&self) {
        let _ = self.tx.send(Msg::Warm);
    }
}

/// Everything queued right now, after `first`. None when a `Clear` came: the batch is void.
fn drain(first: (u64, String), rx: &mut mpsc::UnboundedReceiver<Msg>) -> Option<Vec<(u64, String)>> {
    let mut lines = vec![first];
    while let Ok(m) = rx.try_recv() {
        match m {
            Msg::Line(t, text) => lines.push((t, text)),
            Msg::Clear => return None,
            Msg::Warm => {}
        }
    }
    Some(lines)
}

async fn run(mut session: Session, model: String, shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let mut asked = 0u32;
    // One error event until a translation succeeds again: a dead backend must not flood the UI.
    let mut reported = false;
    while let Some(m) = rx.recv().await {
        let (t, text) = match m {
            Msg::Line(t, text) => (t, text),
            Msg::Clear => {
                session.reset();
                asked = 0;
                continue;
            }
            Msg::Warm => {
                if let Err(e) = session.warm(&model, false, &mut |_| {}).await {
                    warn!("translate: warm-up failed: {e:#}");
                }
                continue;
            }
        };
        let Some(lines) = drain((t, text), &mut rx) else {
            session.reset();
            asked = 0;
            continue;
        };
        if asked >= RESET_EVERY {
            session.reset();
            asked = 0;
        }
        let ts: Vec<u64> = lines.iter().map(|(t, _)| *t).collect();
        let text = lines.into_iter().map(|(_, s)| s).collect::<Vec<_>>().join(" ");
        let started = std::time::Instant::now();
        let mut out = String::new();
        let api = session.is_api();
        let r = async {
            session.prepare(&model)?;
            session
                .ask(&model, &Turn::text(&text), &mut |c| match c {
                    Chunk::Text(t) => out.push_str(&t),
                    c => {
                        if let Some(e) = crate::llm::usage_event(Tier::Translate, &model, api, &c) {
                            let _ = shared.events.send(e);
                        }
                    }
                })
                .await
        }
        .await;
        asked += 1;
        match r {
            Ok(()) => {
                reported = false;
                info!("translate: {} chars in {} ms", text.len(), started.elapsed().as_millis());
                if !out.trim().is_empty() {
                    let _ = shared.events.send(Event::Translation { ts, text: out.trim().to_string() });
                }
            }
            Err(e) => {
                warn!("translate: {e:#}");
                if !std::mem::replace(&mut reported, true) {
                    let _ = shared.events.send(Event::Error { message: format!("перевод: {e:#}"), kind: Some(crate::llm::error_kind(&e)) });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::mock::MockSession;
    use std::time::Duration;

    #[tokio::test]
    async fn queued_lines_go_out_as_one_request() {
        let (shared, mut events) = Shared::for_test();
        let (mock, seen) = MockSession::new(Duration::ZERO, vec!["Как вы масштабировали сервис?"], 0);
        let (tx, rx) = mpsc::unbounded_channel();
        // All three are queued before the actor runs: one request, all three keys.
        tx.send(Msg::Line(1, "how did you".into())).unwrap();
        tx.send(Msg::Line(2, "scale".into())).unwrap();
        tx.send(Msg::Line(3, "the service?".into())).unwrap();
        tokio::spawn(run(Session::Mock(mock), "haiku".into(), shared, rx));
        let ev = loop {
            if let Event::Translation { ts, text } = events.recv().await.unwrap() {
                break (ts, text);
            }
        };
        assert_eq!(ev, (vec![1, 2, 3], "Как вы масштабировали сервис?".to_string()));
        assert_eq!(seen.lock().unwrap()[0].0, "how did you scale the service?");
    }

    #[tokio::test]
    async fn a_failing_backend_is_reported_once() {
        let (shared, mut events) = Shared::for_test();
        let mut mock = MockSession::new(Duration::ZERO, vec![], 0).0;
        mock.fail = true;
        let t = Translator::with(Session::Mock(mock), "haiku".into(), "ru".into(), shared);
        t.push(0, "уже по-русски".into(), Some("ru"));
        t.push(1, "a".into(), Some("de"));
        let first = events.recv().await.unwrap();
        assert!(matches!(first, Event::Error { ref message, .. } if message.contains("перевод")));
        t.push(2, "b".into(), None);
        tokio::time::sleep(Duration::from_millis(50)).await;
        t.push(3, "c".into(), Some("en"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(events.try_recv().is_err(), "no second error, no translation");
    }

    #[test]
    fn clear_voids_the_batch() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(Msg::Line(2, "b".into())).unwrap();
        tx.send(Msg::Clear).unwrap();
        assert!(drain((1, "a".into()), &mut rx).is_none());
    }
}
