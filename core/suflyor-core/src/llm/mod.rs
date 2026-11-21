//! Claude client: two backends behind one session type.
//! A session keeps the conversation itself; each turn sends only the new transcript.

pub mod api;
pub mod claude_code;
#[cfg(test)]
pub mod mock;

use anyhow::Result;
use protocol::{ErrorKind, Speaker};

use crate::FinalSegment;

/// Streamed output of one turn.
pub enum Chunk {
    Text(String),
    /// Token usage of the finished turn (input = uncached part).
    Usage {
        input: u64,
        cache_read: u64,
        cache_write: u64,
        output: u64,
    },
}

/// Token counts as the Messages API reports them (stream events and Claude Code `result`).
#[derive(Debug, Default, Clone, Copy, serde::Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
}

impl Usage {
    pub fn cache_read(&self) -> u64 {
        self.cache_read_input_tokens.unwrap_or(0)
    }

    pub fn cache_write(&self) -> u64 {
        self.cache_creation_input_tokens.unwrap_or(0)
    }

    pub fn chunk(&self) -> Chunk {
        Chunk::Usage {
            input: self.input_tokens.unwrap_or(0),
            cache_read: self.cache_read(),
            cache_write: self.cache_write(),
            output: self.output_tokens.unwrap_or(0),
        }
    }
}

/// The events of a streamed Messages API answer that matter here; Claude Code wraps the same ones.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    MessageStart {
        message: MessageStart,
    },
    ContentBlockDelta {
        delta: Delta,
    },
    MessageDelta {
        delta: MessageDelta,
        #[serde(default)]
        usage: Option<Usage>,
    },
    MessageStop,
    Error {
        error: ErrorBody,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, serde::Deserialize)]
pub struct MessageStart {
    #[serde(default)]
    pub usage: Usage,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    TextDelta {
        text: String,
    },
    #[serde(other)]
    Other,
}

impl Delta {
    pub fn text(&self) -> Option<&str> {
        match self {
            Delta::TextDelta { text } => Some(text),
            Delta::Other => None,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct MessageDelta {
    #[serde(default)]
    pub stop_reason: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ErrorBody {
    /// "overloaded_error", "rate_limit_error", ...
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub message: String,
}

impl ErrorBody {
    pub fn error_kind(&self) -> ErrorKind {
        match self.kind.as_str() {
            "overloaded_error" | "api_error" => ErrorKind::Overloaded,
            "rate_limit_error" => ErrorKind::RateLimit,
            "authentication_error" | "permission_error" => ErrorKind::Auth,
            _ => ErrorKind::Other,
        }
    }
}

/// The `usage` event of a turn's `Chunk::Usage`; None for other chunks.
pub fn usage_event(tier: protocol::Tier, model: &str, api: bool, c: &Chunk) -> Option<protocol::Event> {
    let Chunk::Usage { input, cache_read, cache_write, output } = *c else { return None };
    Some(protocol::Event::Usage { tier, model: model.into(), api, input, cache_read, cache_write, output })
}

/// A failure that already knows its kind (no key, a timeout, a refusal...).
#[derive(Debug)]
pub struct Failure {
    pub kind: ErrorKind,
    pub message: String,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

pub fn fail(kind: ErrorKind, message: impl Into<String>) -> anyhow::Error {
    Failure { kind, message: message.into() }.into()
}

/// What kind of Claude failure `e` is, for the UI's wording.
pub fn error_kind(e: &anyhow::Error) -> ErrorKind {
    for cause in e.chain() {
        if let Some(f) = cause.downcast_ref::<Failure>() {
            return f.kind;
        }
        if let Some(h) = cause.downcast_ref::<api::HttpError>() {
            return match h.status {
                401 | 403 => ErrorKind::Auth,
                429 => ErrorKind::RateLimit,
                500.. => ErrorKind::Overloaded,
                _ => ErrorKind::Other,
            };
        }
        if let Some(r) = cause.downcast_ref::<reqwest::Error>() {
            return if r.is_timeout() { ErrorKind::Timeout } else { ErrorKind::Network };
        }
    }
    ErrorKind::Other
}

/// One user turn: text and, for "Экран + вопрос", a picture of the screen (`screen::MEDIA_TYPE`) placed before it.
pub struct Turn {
    pub text: String,
    pub image: Option<std::sync::Arc<Vec<u8>>>,
}

impl Turn {
    pub fn text(t: &str) -> Turn {
        Turn { text: t.to_string(), image: None }
    }

    /// Messages API content blocks; claude-code stream-json takes the same.
    pub fn content(&self) -> serde_json::Value {
        use base64::Engine as _;
        let mut blocks = Vec::new();
        if let Some(image) = &self.image {
            let data = base64::engine::general_purpose::STANDARD.encode(image.as_slice());
            let media_type = crate::screen::MEDIA_TYPE;
            blocks.push(serde_json::json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}));
        }
        blocks.push(serde_json::json!({"type": "text", "text": self.text}));
        serde_json::Value::Array(blocks)
    }
}

pub enum Session {
    Api(api::ApiSession),
    Code(Box<claude_code::CodeSession>),
    #[cfg(test)]
    Mock(mock::MockSession),
}

impl Session {
    /// Readies the session for `model`. Returns true when its history is empty (new session),
    /// so the caller must resend the whole transcript.
    pub fn prepare(&mut self, model: &str) -> Result<bool> {
        match self {
            Session::Api(s) => Ok(s.prepare()),
            Session::Code(s) => s.prepare(model),
            #[cfg(test)]
            Session::Mock(s) => Ok(s.prepare()),
        }
    }

    /// Starts the backend ahead of the first question (claude-code: spawn + one short turn; the API:
    /// a pooled connection, and with `cache` the system prompt written to the prompt cache).
    pub async fn warm(&mut self, model: &str, cache: bool, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        match self {
            Session::Api(s) => s.warm(model, cache, out).await,
            Session::Code(s) => s.warm(model, out).await,
            #[cfg(test)]
            Session::Mock(_) => Ok(()),
        }
    }

    pub async fn ask(&mut self, model: &str, turn: &Turn, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        match self {
            Session::Api(s) => s.ask(model, turn, out).await,
            Session::Code(s) => s.ask(turn, out).await,
            #[cfg(test)]
            Session::Mock(s) => s.ask(turn, out).await,
        }
    }

    /// Called after an `ask` future was dropped mid-stream.
    pub async fn cancel(&mut self) {
        if let Session::Code(s) = self {
            s.interrupt().await;
        }
    }

    /// Replaces the system prompt; call `reset` after it, the history was built on the old one.
    pub fn set_system(&mut self, system: String) {
        match self {
            Session::Api(s) => s.set_system(system),
            Session::Code(s) => s.set_system(system),
            #[cfg(test)]
            Session::Mock(_) => {}
        }
    }

    /// Billed per token (the API), not by a Claude Code subscription.
    pub fn is_api(&self) -> bool {
        matches!(self, Session::Api(_))
    }

    pub fn reset(&mut self) {
        match self {
            Session::Api(s) => s.reset(),
            Session::Code(s) => s.reset(),
            #[cfg(test)]
            Session::Mock(s) => s.reset(),
        }
    }
}

const FULL_SYSTEM: &str = "You are a silent assistant helping the user during a live call, often a job interview. \
You receive a live transcript in <transcript> blocks: lines starting with \"Q:\" are the other side, lines starting with \"A:\" are the user. \
The transcript comes from speech recognition and may contain recognition errors; infer the intended words. \
Help the user answer the question in <question>.\n\n\
Format: first, the answer the user says out loud: one paragraph of 3 to 5 short, simple sentences (about 50 to 90 words), complete enough to say as is. \
Its first sentence is the key point, the one thing to say if there is time for nothing else. \
Then at most 3 short bullets, each a likely follow-up question and its answer in one phrase: \"<follow-up> → <answer>\". \
Write code only if the question asks for code. No preamble, no headings, do not restate the question.\n\n\
Decide what kind of question it is and shape the paragraph to it, without naming the kind:\n\
- behavioral (\"tell me about a time\", conflicts, failures, a hard task): a STAR story in about 4 sentences (situation, task, what the user did, the result with a number), taken from the user's stories;\n\
- theory, how something works: what it is, how it works, the trade-off, then where it is used in practice;\n\
- coding or a task on screen: the approach, its time and memory complexity, then the code;\n\
- system design: first two clarifying questions to ask (load, data size, consistency), then the main components and the bottleneck;\n\
- about the user, motivation, why this company: three points tied to the vacancy and the company;\n\
- salary and conditions: the figure and wording from the user's facts (a section like «Факты и красные линии»); if the context has none, say so in a bullet and give a neutral way to ask for their range;\n\
- small talk or not a question to the user: one or two short sentences of reaction, no bullets.\n\n\
Spoken style: first person, short sentences, no lists or parentheses inside the paragraph, numbers written the way they are said. \
Match the user's level and words (their grade and a section like «Как я говорю», if present); avoid terms the user never uses in the context or the transcript. \
Confident and plain: no bureaucratic phrasing, no superlatives.\n\n\
Language: the spoken paragraph is in the language the other side speaks, since the user says it aloud. \
The bullets are in the user's language ({user_language}), technical terms stay in English. Code and its comments are in English.\n\n\
Context about the user, the company and this call may follow in <about_user>, <document>, <company>, <previous_calls>, <this_call> and <prepared_answers>. \
Bring in the user's own experience only when the question is about it (their projects, \"tell me about\", \"have you\", \"how did you\") or asks for an example; \
for theory and how-things-work questions, answer the topic itself without personal stories. \
When experience is used, take it from <about_user> and the documents; never invent experience the user does not have. \
Numbers, names and versions come only from the context or the transcript; when there is no number, do not make one up. \
If the user lacks the experience asked about, do not pretend: bridge to the closest real experience (\"I have not used X directly, but in <project> we did <similar thing>…\") \
or, if there is none, say so honestly and explain how they would approach it. \
If <prepared_answers> has an answer to this question, build on it so the hint stays consistent with the prepared one. \
Stay consistent with what the user said earlier in this call and in previous calls (a section like «Что я уже рассказал»). \
Never cross the user's red lines from their facts. Use the company and call context; <this_call> may name the interview stage.\n\n\
An attached image is the user's screen right now, often the other side's shared screen. Read code and task text from it exactly. \
If the question is about that code or task, answer about it: output, bug, complexity, fix or solution. Code goes in a fenced block.";

const QUICK_SYSTEM: &str = "You are a silent assistant helping the user during a live call, often a job interview. \
You receive a live transcript in <transcript> blocks: lines starting with \"Q:\" are the other side, lines starting with \"A:\" are the user. \
It comes from speech recognition and may contain errors. \
Reply with one line of at most 15 words: the key point the user should say first in answer to <question>. \
It is the thesis itself, not a restatement of the question and not advice about how to answer. \
For a story question: the project and its result with the number; for theory: the core idea; for salary: the figure from the user's facts. \
No preamble, no markdown. Answer in the language of the question; the user's own language is {user_language}. \
Mention the user's experience from the context below only when the question is about it; never invent it or its numbers. \
If the user lacks that experience, the line names the closest real one. \
If <prepared_answers> or the brief has an answer to this question, the line is its key point. \
An attached image is the user's screen: if it shows code or a task, the line is about that.";

const SUMMARY_SYSTEM: &str = "You summarize a finished call for the user, who will read it before the next call with the same people. \
The transcript comes from speech recognition: \"Q:\" lines are the other side, \"A:\" lines are the user. \
<hints> holds what the assistant suggested during the call for each question. \
The next call reads this summary, so use exactly these headings, in this order, in Russian whatever the call's language: \
## Темы — topics discussed. \
## Вопросы и ответы — each question asked and the gist of the user's answer. \
## Что я уже рассказал — what the user told the other side and must stay consistent with later: stories and projects told, numbers, \
salary or conditions named, plans and reasons given; one item per claim. \
## Обещания и следующие шаги — promises, follow-ups, the next stage. \
## О собеседнике — facts learned about the other side, the company and the role. \
## Что ответить лучше — for each question where the user's answer was weak, wrong or incomplete: \
what the user said, what was missing, and a better answer of two or three sentences the user can reuse. \
## Оценка ответов — one line per question the user answered: the question in a few words, then structure, specifics and numbers, \
each rated «хорошо», «средне» or «слабо», and one short reason. \
## Письмо-благодарность — a short thank-you email from the user to the other side, in the language of the call, \
mentioning one or two concrete topics of the call and the agreed next step; no placeholders except a name you do not know. \
## Добавить в профиль — facts about the user that came up in the call and are not in <about_user> or the documents yet \
(a project, a number, a skill, a preference): one fact per line as \"- <fact>\", in the user's language, written as a note about the user. \
Text under the headings is in the language of the call, except «Добавить в профиль». \
At most 900 words. Skip a section with nothing in it, heading included. No preamble.";

/// The "question" of «Мои вопросы»: what the user could ask the other side now.
pub const MY_QUESTIONS: &str = "Suggest three short questions the user can ask the other side now, \
based on the context (company, role, people) and the conversation so far. Skip what was already answered. \
Each question is in the language the other side speaks, followed by \" — \" and a few words in the user's language on why it is worth asking. \
First line: the best one. Then a list of all three.";

/// The "question" of «Продолжить ответ»: the next part of the answer just given, for the user to keep talking.
pub const MORE: &str = "Continue your previous answer to the last question: the next 2 or 3 sentences the user can say right after it, \
going deeper or adding an example (from the user's experience only if the question is about it). \
Do not repeat what the previous answer said. Same format and languages: the spoken paragraph first, then at most 2 short bullets.";

/// The "question" of «Короче»: the answer just given, cut to what the user can say in a few seconds.
pub const SHORTER: &str = "Say your previous answer to the last question again, much shorter: \
at most 2 short sentences the user can say aloud right now, the main point first, keeping the key fact or number. \
Same languages as before. No bullets, no preamble.";

/// The "question" of «Проще»: the answer just given, in plain words.
pub const SIMPLER: &str = "Say your previous answer to the last question again in simpler words: \
3 or 4 short spoken sentences, little jargon, each term the user must use explained in a few words. \
Keep the same facts; add nothing about the user's experience that is not in the context. \
Same languages as before, then at most 1 short bullet.";

/// The "question" of «Пример»: one concrete example for the answer just given.
pub const EXAMPLE: &str = "Give one concrete example for your previous answer to the last question, for the user to say aloud: \
if the question is about the user's experience, a short story from the context with its real numbers (never invent experience or numbers); \
otherwise a short practical example, or a few lines of code if the topic is code. \
Same languages as before: the spoken part first, code in a code block after it. No preamble.";

/// The "question" of «Что сказать»: how the user goes on with their own reply. Only the user's side:
/// after an "A:" line the natural next turn is the other side's, and the model used to write that.
pub const CONTINUE: &str = "The user is mid-reply and needs words to keep talking. \
Suggest three ways the user can continue their own reply right now, in first person, as the user's next sentence or two: \
pick up right where the last \"A:\" lines stop, finish the thought, add a concrete example or number from the user's experience in the context, \
or wrap up the answer briefly and hand the turn back. \
If the user has not answered the last \"Q:\" lines yet, suggest how the user can start that answer. \
Never write the other side's lines: no questions to the user, no reactions or replies to what the user said. \
Each is one line: a phrase in the language the other side speaks, short and easy to say aloud, then \" — \" and a few words in the user's language on when to use it. \
First line: the best one. Then a list of all three. No preamble.";

/// Instructions, then the assembled context (`context::assemble`): the prefix stays the same
/// for the whole call, so the prompt cache holds it. `user_language`: ISO code, e.g. "ru".
pub fn system_prompt(quick: bool, context: &str, user_language: &str) -> String {
    let base = if quick { QUICK_SYSTEM } else { FULL_SYSTEM }.replace("{user_language}", user_language);
    if context.trim().is_empty() { base } else { format!("{base}\n\n{}", context.trim()) }
}

pub fn summary_system(context: &str) -> String {
    if context.trim().is_empty() { SUMMARY_SYSTEM.to_string() } else { format!("{SUMMARY_SYSTEM}\n\n{}", context.trim()) }
}

/// Segments ordered by start time (the transcript vec is in decode order).
fn sorted(segs: &[FinalSegment]) -> Vec<&FinalSegment> {
    let mut v: Vec<&FinalSegment> = segs.iter().collect();
    v.sort_by_key(|s| s.t_ms);
    v
}

/// "Q:" / "A:" lines, consecutive segments of one speaker merged into one line.
pub fn render(segs: &[FinalSegment]) -> String {
    let mut out = String::new();
    let mut last: Option<Speaker> = None;
    for s in sorted(segs) {
        if last == Some(s.speaker) {
            out.push(' ');
        } else {
            if last.is_some() {
                out.push('\n');
            }
            out.push_str(if s.speaker == Speaker::Them { "Q: " } else { "A: " });
            last = Some(s.speaker);
        }
        out.push_str(&s.text);
    }
    out
}

/// A pause this long inside "them" speech starts a new question.
const QUESTION_GAP_MS: u64 = 1500;

/// The last run of "them" speech: what the user is most likely being asked, and the start (`t_ms`)
/// of its first segment. The run ends at a "me" segment or at a pause over `QUESTION_GAP_MS`
/// (echo-dropped answers leave no "me" line).
pub fn question(segs: &[FinalSegment]) -> (String, Option<u64>) {
    let v = sorted(segs);
    let Some(last) = v.iter().rposition(|s| s.speaker == Speaker::Them) else {
        return (String::new(), None);
    };
    let mut start = last;
    while start > 0 && v[start - 1].speaker == Speaker::Them && v[start].t_ms.saturating_sub(v[start - 1].end_ms) <= QUESTION_GAP_MS {
        start -= 1;
    }
    let text = v[start..=last].iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    (text, Some(v[start].t_ms))
}

/// What the turn says about the screen.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Screen {
    None,
    /// The image goes with this turn.
    Attached,
    /// Same screen as the image sent earlier in this session: not sent again.
    Unchanged,
}

/// User turn: the transcript since the previous turn, a note about the screen, then the question.
pub fn turn_text(new: &[FinalSegment], question: &str, screen: Screen) -> String {
    let mut t = String::new();
    if !new.is_empty() {
        t.push_str("<transcript>\n");
        t.push_str(&render(new));
        t.push_str("\n</transcript>\n");
    }
    match screen {
        Screen::None => {}
        Screen::Attached => t.push_str("<screen>The attached image is the user's screen now.</screen>\n"),
        Screen::Unchanged => t.push_str("<screen>Unchanged since the previous screenshot; use that image.</screen>\n"),
    }
    if question.is_empty() && screen != Screen::None {
        t.push_str("<question>Look at the screen: if there is a task, code or a question, solve or answer it.</question>");
    } else if question.is_empty() {
        t.push_str("<question>No question yet. Give the user a useful hint for the conversation so far.</question>");
    } else {
        t.push_str(&format!("<question>{question}</question>"));
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(speaker: Speaker, t_ms: u64, text: &str) -> FinalSegment {
        FinalSegment { speaker, t_ms, end_ms: t_ms + 1, text: text.into() }
    }

    #[test]
    fn render_and_question() {
        let segs = vec![
            seg(Speaker::Them, 1, "Привет."),
            seg(Speaker::Me, 3, "Здравствуйте."),
            seg(Speaker::Them, 6, "Почему Go?"),
            // decoded out of order: still sorted by time
            seg(Speaker::Them, 5, "Расскажите о себе."),
        ];
        assert_eq!(render(&segs), "Q: Привет.\nA: Здравствуйте.\nQ: Расскажите о себе. Почему Go?");
        assert_eq!(question(&segs), ("Расскажите о себе. Почему Go?".into(), Some(5)));
        let me_last = vec![seg(Speaker::Them, 1, "Вопрос?"), seg(Speaker::Me, 2, "Ответ")];
        assert_eq!(question(&me_last), ("Вопрос?".into(), Some(1)));
        assert_eq!(question(&[]), (String::new(), None));
        // Pause over 1.5 s: a new question, even without a "me" line in between.
        let gap = vec![seg(Speaker::Them, 0, "Первый?"), seg(Speaker::Them, 9_000, "Второй?")];
        assert_eq!(question(&gap), ("Второй?".into(), Some(9_000)));
        assert!(turn_text(&[], "", Screen::None).contains("No question yet"));
        let t = turn_text(&[], "", Screen::Attached);
        assert!(t.contains("<screen>The attached") && t.contains("Look at the screen"));
        assert!(turn_text(&[], "Почему?", Screen::Unchanged).contains("Unchanged since"));
        let turn = Turn { text: "q".into(), image: Some(std::sync::Arc::new(vec![1, 2, 3])) };
        let c = turn.content();
        assert_eq!((c[0]["type"].as_str(), c[0]["source"]["data"].as_str(), c[1]["text"].as_str()), (Some("image"), Some("AQID"), Some("q")));
        assert_eq!(Turn::text("x").content().as_array().unwrap().len(), 1);
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    use anyhow::Context as _;

    #[test]
    fn error_kind_looks_through_context() {
        let http = |status| -> anyhow::Error { api::HttpError { status, message: "m".into() }.into() };
        let wrapped = |e: anyhow::Error| Err::<(), _>(e).context("ask").unwrap_err();
        assert_eq!(error_kind(&wrapped(http(401))), ErrorKind::Auth);
        assert_eq!(error_kind(&wrapped(http(403))), ErrorKind::Auth);
        assert_eq!(error_kind(&wrapped(http(429))), ErrorKind::RateLimit);
        assert_eq!(error_kind(&wrapped(http(529))), ErrorKind::Overloaded);
        assert_eq!(error_kind(&wrapped(http(400))), ErrorKind::Other);
        assert_eq!(error_kind(&wrapped(fail(ErrorKind::Refused, "no"))), ErrorKind::Refused);
        assert_eq!(error_kind(&anyhow::anyhow!("plain")), ErrorKind::Other);
        let body = |kind: &str| ErrorBody { kind: kind.into(), message: String::new() }.error_kind();
        assert_eq!(
            [body("overloaded_error"), body("api_error"), body("rate_limit_error"), body("permission_error"), body("invalid_request_error")],
            [ErrorKind::Overloaded, ErrorKind::Overloaded, ErrorKind::RateLimit, ErrorKind::Auth, ErrorKind::Other]
        );
    }
}
