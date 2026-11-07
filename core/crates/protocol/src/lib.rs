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

/// What an ask is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    /// Answer the detected (or picked) question.
    #[default]
    Answer,
    /// Questions the user can ask the other side.
    Questions,
    /// Ways the user can continue the conversation now.
    Continue,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Ask {
        #[serde(default)]
        screenshot: bool,
        /// Ask about this text instead of the detected question (a transcript row the user picked).
        #[serde(default)]
        question: Option<String>,
        #[serde(default)]
        kind: AskKind,
    },
    Set {
        #[serde(default)]
        auto: Option<bool>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        answer_mode: Option<AnswerMode>,
        /// Translate the other side's speech into the user's language.
        #[serde(default)]
        translate: Option<bool>,
    },
    Clear,
    /// Opens a call directory (`<dataDir>/folders/<folder>/calls/<call>`): its context goes into the
    /// prompt, its saved transcript and answers are replayed, new ones are appended to it.
    OpenCall {
        dir: String,
    },
    /// Rebuilds the context after its files changed; the transcript stays.
    ReloadContext,
    /// Stops saving to the open call and writes its `summary.md`.
    CloseCall,
    Shutdown,
}

/// One piece of the assembled context, for the UI's breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct ContextPart {
    pub name: String,
    pub tokens: u64,
    pub truncated: bool,
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
    pub translate: bool,
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
    /// Voice activity changed for a speaker. `t` (epoch ms of the utterance start) is the key that
    /// later `partial` and `final` events of the same utterance carry.
    Vad {
        speaker: Speaker,
        active: bool,
        t: u64,
    },
    /// Hypothesis for an utterance still in progress; replaced by later partials and the final.
    /// `stable` is the prefix two consecutive hypotheses agree on, `tail` the part that may change.
    Partial {
        speaker: Speaker,
        t: u64,
        stable: String,
        tail: String,
    },
    /// Final text of an utterance. Empty text: the utterance was dropped (noise, echo, too short).
    Final {
        speaker: Speaker,
        t: u64,
        text: String,
        /// "them" text that reads as a question to the user.
        question: bool,
    },
    AnswerStart {
        id: u64,
        /// Shared by the quick and full answers of one ask.
        turn: u64,
        trigger: String,
        question: String,
        /// Start (`t`) of the first transcript utterance the question was taken from.
        #[serde(skip_serializing_if = "Option::is_none")]
        q_t: Option<u64>,
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
    /// A screenshot goes with answer turn `turn`; `thumb` is a small JPEG data URL for the card.
    Screenshot {
        turn: u64,
        width: u32,
        height: u32,
        thumb: String,
    },
    /// Translation of the other side's utterances `ts` (their `t`), sent as one piece.
    Translation {
        ts: Vec<u64>,
        text: String,
    },
    /// The context now in use. `dir` is null when no call is open (profile only).
    Call {
        dir: Option<String>,
        title: String,
        folder: String,
        tokens: u64,
        parts: Vec<ContextPart>,
        warnings: Vec<String>,
    },
    /// `summary.md` of a closed call was written (or failed).
    Summary {
        dir: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","screenshot":true}"#).unwrap();
        assert!(matches!(c, Command::Ask { screenshot: true, question: None, kind: AskKind::Answer }));
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","question":"Почему Go?"}"#).unwrap();
        assert!(matches!(c, Command::Ask { screenshot: false, question: Some(ref q), kind: AskKind::Answer } if q == "Почему Go?"));
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","kind":"questions"}"#).unwrap();
        assert!(matches!(c, Command::Ask { kind: AskKind::Questions, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","kind":"continue"}"#).unwrap();
        assert!(matches!(c, Command::Ask { kind: AskKind::Continue, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","translate":true}"#).unwrap();
        assert!(matches!(c, Command::Set { translate: Some(true), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","answer_mode":"speculative"}"#).unwrap();
        assert!(matches!(c, Command::Set { answer_mode: Some(AnswerMode::Speculative), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"clear"}"#).unwrap();
        assert!(matches!(c, Command::Clear));
        let c: Command = serde_json::from_str(r#"{"cmd":"open_call","dir":"C:\\x"}"#).unwrap();
        assert!(matches!(c, Command::OpenCall { ref dir } if dir == "C:\\x"));
        let c: Command = serde_json::from_str(r#"{"cmd":"close_call"}"#).unwrap();
        assert!(matches!(c, Command::CloseCall));
    }

    #[test]
    fn serializes_events() {
        let e = Event::Level { speaker: Speaker::Them, rms: 0.5, peak: 1.0 };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"ev":"level","speaker":"them","rms":0.5,"peak":1.0}"#);
        let e = Event::Partial { speaker: Speaker::Me, t: 7, stable: "a b".into(), tail: "c".into() };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"ev":"partial","speaker":"me","t":7,"stable":"a b","tail":"c"}"#);
        let e = Event::Call { dir: None, title: String::new(), folder: String::new(), tokens: 3, parts: vec![], warnings: vec![] };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"ev":"call","dir":null,"title":"","folder":"","tokens":3,"parts":[],"warnings":[]}"#);
    }
}
