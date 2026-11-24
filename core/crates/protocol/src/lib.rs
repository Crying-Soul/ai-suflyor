//! NDJSON protocol between the Electron UI and suflyor-core (one JSON object per line).
//! UI -> core: [`Command`] on stdin. core -> UI: [`Event`] on stdout. Logs go to stderr.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts")]
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

    /// Index into per-speaker arrays: me 0, them 1.
    pub fn idx(self) -> usize {
        self as usize
    }
}

/// When the core starts an automatic answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "lowercase")]
pub enum AnswerMode {
    /// Only after the end of the question is confirmed (silence + end-of-turn score).
    #[default]
    Confirmed,
    /// Start early on a likely end of turn; confirm or cancel later.
    Speculative,
}

/// What an ask is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    /// Answer the detected (or picked) question.
    #[default]
    Answer,
    /// Questions the user can ask the other side.
    Questions,
    /// Ways the user can continue the conversation now.
    Continue,
    /// The next part of the answer just given.
    More,
    /// The answer just given, said shorter.
    Shorter,
    /// The answer just given, in simpler words.
    Simpler,
    /// A concrete example for the answer just given.
    Example,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts", optional_fields = nullable)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Ask {
        #[serde(default)]
        #[ts(as = "Option<bool>")]
        screenshot: bool,
        /// Ask about this text instead of the detected question (a transcript row the user picked).
        #[serde(default)]
        question: Option<String>,
        #[serde(default)]
        #[ts(as = "Option<AskKind>")]
        kind: AskKind,
    },
    Set {
        #[serde(default)]
        auto: Option<bool>,
        #[serde(default)]
        answer_mode: Option<AnswerMode>,
        /// Translate the other side's speech into the user's language.
        #[serde(default)]
        translate: Option<bool>,
        /// Mute a source: its audio is replaced by silence before VAD, so nothing is transcribed.
        #[serde(default)]
        mute_me: Option<bool>,
        #[serde(default)]
        mute_them: Option<bool>,
    },
    /// Switches the full tier between `model` and `altModel`.
    ToggleModel,
    Clear,
    /// Opens a call directory (`<dataDir>/folders/<folder>/calls/<call>`): its context goes into the
    /// prompt, its saved transcript and answers are replayed, new ones are appended to it.
    OpenCall {
        dir: String,
    },
    /// Re-reads config.json and restarts the Claude side (models, effort, connection, two tiers,
    /// auto-answer, languages) without touching audio and speech recognition; the transcript stays.
    /// The UI keeps the API key encrypted, so it hands it over here (and in the env at spawn).
    ReloadLlm {
        #[serde(default)]
        anthropic_api_key: Option<String>,
        /// The key of the OpenAI-compatible provider (`llm.backend` = `openai`).
        #[serde(default)]
        llm_api_key: Option<String>,
    },
    /// Rebuilds the context after its files changed; the transcript stays.
    ReloadContext,
    /// Stops saving to the open call and writes its `summary.md`.
    CloseCall,
    /// Writes `summary.md` of a call that is not open, from its saved files («Повторить итог»).
    Summarize {
        dir: String,
    },
    /// The user's rating of answer turn `turn` in the open call: 1 good, -1 bad, null cleared.
    /// Saved as `feedback` on that turn's records in `answers.jsonl`.
    Feedback {
        turn: u64,
        #[serde(default)]
        value: Option<i8>,
    },
    Shutdown,
}

/// One piece of the assembled context, for the UI's breakdown.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "protocol.ts")]
pub struct ContextPart {
    pub name: String,
    pub tokens: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Default, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "lowercase")]
pub enum CaptureState {
    #[default]
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Default, TS)]
#[ts(export, export_to = "protocol.ts", optional_fields)]
pub struct CaptureStatus {
    pub state: CaptureState,
    /// Human-readable source, e.g. device name or "process chrome.exe (pid 1234)".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// State of the speech recognizer.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum SttState {
    Off,
    Loading,
    Ready { gpu: bool },
    Error { message: String },
}

/// Which Claude turn: the two answer tiers and the one-off sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// The one-line hint.
    Quick,
    /// The full answer.
    Full,
    Summary,
    Brief,
    Translate,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Quick => "quick",
            Tier::Full => "full",
            Tier::Summary => "summary",
            Tier::Brief => "brief",
            Tier::Translate => "translate",
        }
    }
}

/// What started an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    /// Auto-detect after the question's final.
    Auto,
    /// Auto-detect at the first pause (speculative mode).
    Early,
    /// The ask hotkey or button.
    Hotkey,
    /// A transcript row the user picked.
    Picked,
    /// «Экран + вопрос».
    Screen,
    /// «Мои вопросы».
    Questions,
    /// «Что сказать».
    Continue,
    /// «Продолжить ответ».
    More,
    /// «Короче».
    Shorter,
    /// «Проще».
    Simpler,
    /// «Пример».
    Example,
}

/// Why an answer ended without text, or what kind of failure an error is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "protocol.ts")]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// A newer ask replaced it.
    Cancelled,
    /// An early answer dropped because the other side kept talking.
    Retracted,
    /// No key, a rejected key, or a Claude Code login problem.
    Auth,
    /// HTTP 429.
    RateLimit,
    /// HTTP 5xx / 529.
    Overloaded,
    /// No answer in time.
    Timeout,
    /// No connection.
    Network,
    /// Claude declined to answer.
    Refused,
    /// No money or quota left on the provider's account (HTTP 402, `insufficient_quota`).
    Quota,
    Other,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "protocol.ts", optional_fields)]
pub struct Status {
    pub me: CaptureStatus,
    pub them: CaptureStatus,
    pub stt: SttState,
    pub auto: bool,
    pub model: String,
    pub answer_mode: AnswerMode,
    pub translate: bool,
    pub mute_me: bool,
    pub mute_them: bool,
    pub busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "protocol.ts", optional_fields)]
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
        trigger: Trigger,
        question: String,
        /// Start (`t`) of the first transcript utterance the question was taken from.
        #[serde(skip_serializing_if = "Option::is_none")]
        q_t: Option<u64>,
        /// Quick or full.
        tier: Tier,
    },
    AnswerDelta {
        id: u64,
        text: String,
    },
    AnswerEnd {
        id: u64,
        /// The raw cause of a failure, for the details fold.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// Set whenever `error` is.
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<ErrorKind>,
        /// The saved rating of a replayed answer (see `Command::Feedback`).
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<i8>,
    },
    Metrics {
        name: String,
        ms: f64,
    },
    /// Tokens of one finished Claude turn, for the per-call count in the UI.
    /// `tier`: quick, full, summary, brief, translate. `api`: billed per token (false: Claude Code
    /// subscription or a local model). `usd`: the price the provider reported (OpenRouter), if any.
    Usage {
        tier: Tier,
        model: String,
        api: bool,
        input: u64,
        cache_read: u64,
        cache_write: u64,
        output: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        usd: Option<f64>,
    },
    Error {
        message: String,
        /// A Claude failure: the UI words it by kind. None: `message` is already meant for the user.
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<ErrorKind>,
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
        assert!(matches!(serde_json::from_str(r#"{"cmd":"toggle_model"}"#).unwrap(), Command::ToggleModel));
        let c: Command = serde_json::from_str(r#"{"cmd":"summarize","dir":"d"}"#).unwrap();
        assert!(matches!(c, Command::Summarize { ref dir } if dir == "d"));
        let c: Command = serde_json::from_str(r#"{"cmd":"feedback","turn":3,"value":-1}"#).unwrap();
        assert!(matches!(c, Command::Feedback { turn: 3, value: Some(-1) }));
        let c: Command = serde_json::from_str(r#"{"cmd":"feedback","turn":3,"value":null}"#).unwrap();
        assert!(matches!(c, Command::Feedback { turn: 3, value: None }));
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","kind":"more"}"#).unwrap();
        assert!(matches!(c, Command::Ask { kind: AskKind::More, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"ask","kind":"shorter"}"#).unwrap();
        assert!(matches!(c, Command::Ask { kind: AskKind::Shorter, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","translate":true}"#).unwrap();
        assert!(matches!(c, Command::Set { translate: Some(true), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","mute_them":true}"#).unwrap();
        assert!(matches!(c, Command::Set { mute_me: None, mute_them: Some(true), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"set","answer_mode":"speculative"}"#).unwrap();
        assert!(matches!(c, Command::Set { answer_mode: Some(AnswerMode::Speculative), .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"clear"}"#).unwrap();
        assert!(matches!(c, Command::Clear));
        let c: Command = serde_json::from_str(r#"{"cmd":"open_call","dir":"C:\\x"}"#).unwrap();
        assert!(matches!(c, Command::OpenCall { ref dir } if dir == "C:\\x"));
        let c: Command = serde_json::from_str(r#"{"cmd":"reload_llm"}"#).unwrap();
        assert!(matches!(c, Command::ReloadLlm { anthropic_api_key: None, llm_api_key: None }));
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
        let e = Event::AnswerEnd { id: 1, error: Some("x".into()), kind: Some(ErrorKind::RateLimit), feedback: None };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"ev":"answer_end","id":1,"error":"x","kind":"rate_limit"}"#);
        let s = SttState::Ready { gpu: true };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"state":"ready","gpu":true}"#);
    }
}
