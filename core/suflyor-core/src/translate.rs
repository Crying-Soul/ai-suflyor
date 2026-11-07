//! Translation of the other side's speech into the user's language.
//! A local Opus-MT model (`crates/mt`) on the CPU: no network, no tokens. One actor; lines that
//! arrive while a translation runs go out together next, so the translation never falls behind.

use std::sync::Arc;

use protocol::Event;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::Shared;
use crate::config::Config;

/// The one pair the bundled model translates.
pub const FROM: &str = "en";
pub const TO: &str = "ru";

/// Something that turns a line into the user's language; the real one is `mt::Translator`.
pub trait Mt: Send + 'static {
    fn translate(&mut self, text: &str) -> anyhow::Result<String>;
}

impl Mt for mt::Translator {
    fn translate(&mut self, text: &str) -> anyhow::Result<String> {
        mt::Translator::translate(self, text)
    }
}

enum Msg {
    Line(u64, String),
    Clear,
}

#[derive(Clone)]
pub struct Translator {
    tx: mpsc::UnboundedSender<Msg>,
}

impl Translator {
    /// The model loads on the first line: with translation off, startup costs nothing.
    pub fn start(cfg: &Config, shared: Arc<Shared>) -> Translator {
        let dir = cfg.path(&cfg.translate_model);
        let load = move || -> anyhow::Result<Box<dyn Mt>> {
            let started = std::time::Instant::now();
            let t = mt::Translator::load(vad::env()?, &dir).map_err(|e| anyhow::anyhow!("модель перевода ({}): {e:#}", dir.display()))?;
            info!("translate: model loaded in {} ms", started.elapsed().as_millis());
            Ok(Box::new(t))
        };
        Translator::with(shared, load)
    }

    fn with(shared: Arc<Shared>, load: impl FnOnce() -> anyhow::Result<Box<dyn Mt>> + Send + 'static) -> Translator {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(load, shared, rx));
        Translator { tx }
    }

    /// A final "them" utterance starting at `t`.
    pub fn push(&self, t: u64, text: String) {
        let _ = self.tx.send(Msg::Line(t, text));
    }

    /// The transcript was cleared: queued lines are dropped.
    pub fn clear(&self) {
        let _ = self.tx.send(Msg::Clear);
    }
}

/// Everything queued right now, after `first`. None when a `Clear` came: the batch is void.
fn drain(first: (u64, String), rx: &mut mpsc::UnboundedReceiver<Msg>) -> Option<Vec<(u64, String)>> {
    let mut lines = vec![first];
    while let Ok(m) = rx.try_recv() {
        match m {
            Msg::Line(t, text) => lines.push((t, text)),
            Msg::Clear => return None,
        }
    }
    Some(lines)
}

/// The model, loaded on the first line.
enum Model<F> {
    Unloaded(F),
    Ready(Box<dyn Mt>),
    /// The load failed and was reported; lines are dropped until the core restarts.
    Failed,
}

impl<F: FnOnce() -> anyhow::Result<Box<dyn Mt>>> Model<F> {
    /// Translates on the blocking pool's thread; returns the model for the next line.
    fn translate(self, text: &str) -> (Self, anyhow::Result<String>) {
        let mut m = match self {
            Model::Ready(m) => m,
            Model::Failed => return (Model::Failed, Ok(String::new())),
            Model::Unloaded(load) => match load() {
                Ok(m) => m,
                Err(e) => return (Model::Failed, Err(e)),
            },
        };
        let r = m.translate(text);
        (Model::Ready(m), r)
    }
}

async fn run<F>(load: F, shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Msg>)
where
    F: FnOnce() -> anyhow::Result<Box<dyn Mt>> + Send + 'static,
{
    let mut model = Some(Model::Unloaded(load));
    while let Some(m) = rx.recv().await {
        let Msg::Line(t, text) = m else { continue };
        let Some(lines) = drain((t, text), &mut rx) else { continue };
        let ts: Vec<u64> = lines.iter().map(|(t, _)| *t).collect();
        let text = lines.into_iter().map(|(_, s)| s).collect::<Vec<_>>().join(" ");
        let current = model.take().unwrap_or(Model::Failed);
        let (back, r) = tokio::task::spawn_blocking(move || current.translate(&text))
            .await
            .unwrap_or_else(|e| (Model::Failed, Err(anyhow::anyhow!("translate task: {e}"))));
        model = Some(back);
        match r {
            Ok(text) if !text.trim().is_empty() => {
                let _ = shared.events.send(Event::Translation { ts, text: text.trim().to_string() });
            }
            Ok(_) => {}
            Err(e) => {
                warn!("translate: {e:#}");
                let _ = shared.events.send(Event::Error { message: format!("перевод: {e:#}") });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Upper;
    impl Mt for Upper {
        fn translate(&mut self, text: &str) -> anyhow::Result<String> {
            Ok(text.to_uppercase())
        }
    }

    #[tokio::test]
    async fn queued_lines_go_out_as_one_request() {
        let (shared, mut events) = Shared::for_test();
        let (tx, rx) = mpsc::unbounded_channel();
        // All three are queued before the actor runs: one request, all three keys.
        tx.send(Msg::Line(1, "how did you".into())).unwrap();
        tx.send(Msg::Line(2, "scale".into())).unwrap();
        tx.send(Msg::Line(3, "the service?".into())).unwrap();
        tokio::spawn(run(|| Ok(Box::new(Upper) as Box<dyn Mt>), shared, rx));
        let ev = loop {
            if let Event::Translation { ts, text } = events.recv().await.unwrap() {
                break (ts, text);
            }
        };
        assert_eq!(ev, (vec![1, 2, 3], "HOW DID YOU SCALE THE SERVICE?".to_string()));
    }

    #[tokio::test]
    async fn a_missing_model_is_reported_once() {
        let (shared, mut events) = Shared::for_test();
        let t = Translator::with(shared, || Err(anyhow::anyhow!("нет файла")));
        t.push(1, "a".into());
        let first = events.recv().await.unwrap();
        assert!(matches!(first, Event::Error { ref message } if message.contains("нет файла")));
        t.push(2, "b".into());
        t.push(3, "c".into());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
