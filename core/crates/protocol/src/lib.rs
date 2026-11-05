//! NDJSON protocol between the Electron UI and call-core (one JSON object per line).
//! UI -> core: [`Command`] on stdin. core -> UI: [`Event`] on stdout. Logs go to stderr.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    Me,
    Them,
}

impl Speaker {
    pub fn as_str(self) -> &'static str {
        match self {
            Speaker::Me => "me",
            Speaker::Them => "them",
        }
    }
}

/// When the core starts an automatic answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnswerMode {
    /// Only after the end of the question is confirmed (silence + end-of-turn score).
    #[default]
    Confirmed,
    /// Start early on a likely end of turn; confirm or cancel later.
    Speculative,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Ask {
        #[serde(default)]
        screenshot: bool,
    },
    Set {
        #[serde(default)]
        auto: Option<bool>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        answer_mode: Option<AnswerMode>,
    },
    Clear,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureState {
    #[default]
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CaptureStatus {
    pub state: CaptureState,
    /// Human-readable source, e.g. device name or "process chrome.exe (pid 1234)".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub me: CaptureStatus,
    pub them: CaptureStatus,
    pub stt: String,
    pub auto: bool,
    pub model: String,
    pub answer_mode: AnswerMode,
    pub busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Ready {
        version: String,
    },
    Status(Status),
    /// Signal level over the last ~100 ms, linear 0..1.
    Level {
        speaker: Speaker,
        rms: f32,
        peak: f32,
    },
    /// Voice activity changed for a speaker.
    Vad {
        speaker: Speaker,
        active: bool,
    },
    /// Hypothesis for an utterance still in progress; replaced by later partials and the final.
    Partial {
        speaker: Speaker,
        seg: u64,
        text: String,
    },
    Final {
        speaker: Speaker,
        seg: u64,
        /// Epoch ms of utterance start.
        t: u64,
        text: String,
    },
    AnswerStart {
        id: u64,
        trigger: String,
        question: String,
        /// "quick" (one-line hint) or "full".
        tier: String,
    },
    AnswerDelta {
        id: u64,
        text: String,
    },
    AnswerEnd {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Metrics {
        name: String,
        ms: f64,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","screenshot":true}"#).unwrap();
        assert!(matches!(c, Command::Ask { screenshot: true }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","answer_mode":"speculative"}"#).unwrap();
        assert!(matches!(c, Command::Set { answer_mode: Some(AnswerMode::Speculative), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"clear"}"#).unwrap();
        assert!(matches!(c, Command::Clear));
    }

    #[test]
    fn serializes_events() {
        let e = Event::Level { speaker: Speaker::Them, rms: 0.5, peak: 1.0 };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"ev":"level","speaker":"them","rms":0.5,"peak":1.0}"#);
    }
}
