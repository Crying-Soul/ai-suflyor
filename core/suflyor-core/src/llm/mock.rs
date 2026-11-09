//! Scripted session for the answer pipeline tests.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;

use super::{Chunk, Turn};

/// Each `ask` as received: its text and whether an image came with it.
pub type Seen = Arc<Mutex<Vec<(String, bool)>>>;

pub struct MockSession {
    /// Pause before each reply chunk.
    pub delay: Duration,
    pub reply: Vec<&'static str>,
    /// This many first asks never answer (a hung backend).
    pub stall: usize,
    pub seen: Seen,
    /// Every ask fails (a backend that is down).
    pub fail: bool,
    fresh: bool,
}

impl MockSession {
    pub fn new(delay: Duration, reply: Vec<&'static str>, stall: usize) -> (MockSession, Seen) {
        let seen = Seen::default();
        (MockSession { delay, reply, stall, seen: seen.clone(), fail: false, fresh: true }, seen)
    }

    pub fn prepare(&mut self) -> bool {
        std::mem::replace(&mut self.fresh, false)
    }

    pub fn reset(&mut self) {
        self.fresh = true;
    }

    pub async fn ask(&mut self, turn: &Turn, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        let n = {
            let mut seen = self.seen.lock().unwrap();
            seen.push((turn.text.clone(), turn.image.is_some()));
            seen.len()
        };
        if self.fail {
            anyhow::bail!("backend down");
        }
        if n <= self.stall {
            std::future::pending::<()>().await;
        }
        for c in &self.reply {
            tokio::time::sleep(self.delay).await;
            out(Chunk::Text(c.to_string()));
        }
        Ok(())
    }
}
