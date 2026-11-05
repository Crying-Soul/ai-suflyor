//! Claude client: two backends behind one session type (docs/ARCHITECTURE.md §8).
//! A session keeps the conversation itself; each turn sends only the new transcript.

pub mod api;
pub mod claude_code;
#[cfg(test)]
pub mod mock;

use anyhow::Result;
use protocol::Speaker;

use crate::FinalSegment;

/// Streamed output of one turn.
pub enum Chunk {
    Text(String),
    /// Token usage of the finished turn (input = uncached part).
    Usage { input: u64, cache_read: u64, cache_write: u64, output: u64 },
}

/// One user turn: text and, for "Экран + вопрос", a PNG of the screen placed before it.
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
        if let Some(png) = &self.image {
            let data = base64::engine::general_purpose::STANDARD.encode(png.as_slice());
            blocks.push(serde_json::json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}));
        }
        blocks.push(serde_json::json!({"type": "text", "text": self.text}));
        serde_json::Value::Array(blocks)
    }
}

pub enum Session {
    Api(api::ApiSession),
    Code(claude_code::CodeSession),
    #[cfg(test)]
    Mock(mock::MockSession),
}

impl Session {
    /// Readies the session for `model`. Returns true when its history is empty (new session),
    /// so the caller must resend the whole transcript.
    pub async fn prepare(&mut self, model: &str) -> Result<bool> {
        match self {
            Session::Api(s) => Ok(s.prepare()),
            Session::Code(s) => s.prepare(model).await,
            #[cfg(test)]
            Session::Mock(s) => Ok(s.prepare()),
        }
    }

    /// Starts the backend ahead of the first question (claude-code: spawn + one short turn).
    pub async fn warm(&mut self, model: &str) -> Result<()> {
        match self {
            Session::Api(_) => Ok(()),
            Session::Code(s) => s.warm(model).await,
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

    pub async fn reset(&mut self) {
        match self {
            Session::Api(s) => s.reset(),
            Session::Code(s) => s.reset().await,
            #[cfg(test)]
            Session::Mock(s) => s.reset(),
        }
    }
}

const FULL_SYSTEM: &str = "You are a silent assistant helping the user during a live call, often a job interview. \
You receive a live transcript in <transcript> blocks: lines starting with \"Q:\" are the other side, lines starting with \"A:\" are the user. \
The transcript comes from speech recognition and may contain recognition errors; infer the intended words. \
Help the user answer the question in <question>.\n\n\
Format: the first line is a short answer the user can say out loud, at most 20 words. \
Then at most 5 short bullets with the key points, facts or numbers. \
Write code only if the question asks for code. No preamble, no headings, do not restate the question. \
Answer in the language of the question.\n\n\
Context about the user, the company and this call may follow in <about_user>, <document>, <company>, <previous_calls> and <this_call>. \
Answer from the user's real experience in <about_user> and the documents; never invent experience they do not have. \
Stay consistent with what the user said earlier in this call and in previous calls. Use the company and call context.\n\n\
An attached image is the user's screen right now, often the other side's shared screen. Read code and task text from it exactly. \
If the question is about that code or task, answer about it: output, bug, complexity, fix or solution. Code goes in a fenced block.";

const QUICK_SYSTEM: &str = "You are a silent assistant helping the user during a live call, often a job interview. \
You receive a live transcript in <transcript> blocks: lines starting with \"Q:\" are the other side, lines starting with \"A:\" are the user. \
It comes from speech recognition and may contain errors. \
Reply with one line of at most 15 words: the key point the user should say in answer to <question>. \
No preamble, no markdown. Answer in the language of the question. \
Base it on the user's real experience from the context below, if any. \
An attached image is the user's screen: if it shows code or a task, the line is about that.";

const SUMMARY_SYSTEM: &str = "You summarize a finished call for the user, who will read it before the next call with the same people. \
The transcript comes from speech recognition: \"Q:\" lines are the other side, \"A:\" lines are the user. \
Write markdown in the language of the call, at most 300 words, with these sections: \
topics discussed; questions asked and how the user answered them; promises and follow-ups; facts learned about the other side. \
Skip a section with nothing in it. No preamble.";

/// Instructions, then the assembled context (`context::assemble`): the prefix stays the same
/// for the whole call, so the prompt cache holds it.
pub fn system_prompt(quick: bool, context: &str) -> String {
    let base = if quick { QUICK_SYSTEM } else { FULL_SYSTEM };
    if context.trim().is_empty() { base.to_string() } else { format!("{base}\n\n{}", context.trim()) }
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
