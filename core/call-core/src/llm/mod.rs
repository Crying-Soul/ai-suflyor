//! Claude client: two backends behind one session type (docs/ARCHITECTURE.md §8).
//! A session keeps the conversation itself; each turn sends only the new transcript.

pub mod api;
pub mod claude_code;

use anyhow::Result;
use protocol::Speaker;

use crate::FinalSegment;

/// Streamed output of one turn.
pub enum Chunk {
    Text(String),
    /// Token usage of the finished turn (input = uncached part).
    Usage { input: u64, cache_read: u64, cache_write: u64, output: u64 },
}

pub enum Session {
    Api(api::ApiSession),
    Code(claude_code::CodeSession),
}

impl Session {
    /// Readies the session for `model`. Returns true when its history is empty (new session),
    /// so the caller must resend the whole transcript.
    pub async fn prepare(&mut self, model: &str) -> Result<bool> {
        match self {
            Session::Api(s) => Ok(s.prepare()),
            Session::Code(s) => s.prepare(model).await,
        }
    }

    /// Starts the backend ahead of the first question (claude-code: spawn + one short turn).
    pub async fn warm(&mut self, model: &str) -> Result<()> {
        match self {
            Session::Api(_) => Ok(()),
            Session::Code(s) => s.warm(model).await,
        }
    }

    pub async fn ask(&mut self, model: &str, text: String, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        match self {
            Session::Api(s) => s.ask(model, text, out).await,
            Session::Code(s) => s.ask(text, out).await,
        }
    }

    /// Called after an `ask` future was dropped mid-stream.
    pub async fn cancel(&mut self) {
        if let Session::Code(s) = self {
            s.interrupt().await;
        }
    }

    pub async fn reset(&mut self) {
        match self {
            Session::Api(s) => s.reset(),
            Session::Code(s) => s.reset().await,
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
Answer in the language of the question.";

const QUICK_SYSTEM: &str = "You are a silent assistant helping the user during a live call, often a job interview. \
You receive a live transcript in <transcript> blocks: lines starting with \"Q:\" are the other side, lines starting with \"A:\" are the user. \
It comes from speech recognition and may contain errors. \
Reply with one line of at most 15 words: the key point the user should say in answer to <question>. \
No preamble, no markdown. Answer in the language of the question.";

pub fn system_prompt(quick: bool, user_context: &str) -> String {
    let base = if quick { QUICK_SYSTEM } else { FULL_SYSTEM };
    if user_context.trim().is_empty() { base.to_string() } else { format!("{base}\n\nAbout the user:\n{}", user_context.trim()) }
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

/// User turn: the transcript since the previous turn, then the question.
pub fn turn_text(new: &[FinalSegment], question: &str) -> String {
    let mut t = String::new();
    if !new.is_empty() {
        t.push_str("<transcript>\n");
        t.push_str(&render(new));
        t.push_str("\n</transcript>\n");
    }
    if question.is_empty() {
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
        assert!(turn_text(&[], "").contains("No question yet"));
    }
}
