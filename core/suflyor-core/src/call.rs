//! The open call: its context goes into the prompt and the whisper glossary, its transcript and
//! answers are appended to `transcript.jsonl` / `answers.jsonl`, and closing it writes `summary.md`.
//! With no call open only the profile context is used and nothing is saved.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use protocol::Event;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::answer::Answerer;
use crate::config::Config;
use crate::{FinalSegment, Shared};
use crate::{brief, context};

/// One finished answer of one tier, as saved in `answers.jsonl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerRecord {
    pub turn: u64,
    pub tier: String,
    pub trigger: String,
    pub question: String,
    #[serde(default)]
    pub q_t: Option<u64>,
    pub model: String,
    pub text: String,
    /// Screenshot of this turn in `shots/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot: Option<String>,
    /// The user's rating: 1 good, -1 bad (`Command::Feedback`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<i8>,
}

/// Rows of the open call's `answers.jsonl` (non-empty lines, from 0) by live answer turn.
/// Turn ids restart with the core, so a saved `turn` is not unique in the file; the row is.
#[derive(Default)]
pub struct AnswerRows {
    /// Row the next appended answer gets.
    next: usize,
    by_turn: std::collections::HashMap<u64, Vec<usize>>,
}

const TRANSCRIPT: &str = "transcript.jsonl";
const ANSWERS: &str = "answers.jsonl";
const SUMMARY: &str = "summary.md";

fn append(file: &Path, v: &impl Serialize) {
    let r = (|| {
        let mut line = serde_json::to_vec(v)?;
        line.push(b'\n');
        std::fs::OpenOptions::new().create(true).append(true).open(file)?.write_all(&line)?;
        anyhow::Ok(())
    })();
    if let Err(e) = r {
        warn!("append {}: {e:#}", file.display());
    }
}

/// Lines that fail to parse (a torn last line after a crash) are skipped. A missing final newline
/// is added, so the next append starts a line of its own.
fn read_jsonl<T: DeserializeOwned>(file: &Path) -> Vec<T> {
    lines(file).iter().filter_map(|l| serde_json::from_str(l).map_err(|e| warn!("{}: {e}", file.display())).ok()).collect()
}

/// Non-empty lines of a jsonl file (see `read_jsonl` for the missing newline).
fn lines(file: &Path) -> Vec<String> {
    let Ok(s) = std::fs::read_to_string(file) else { return Vec::new() };
    if !s.is_empty() && !s.ends_with('\n') {
        let _ = std::fs::OpenOptions::new().append(true).open(file).and_then(|mut f| f.write_all(b"\n"));
    }
    s.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect()
}

pub fn save_final(shared: &Shared, seg: &FinalSegment) {
    if let Some(dir) = shared.call.lock().unwrap().as_ref() {
        append(&dir.join(TRANSCRIPT), seg);
    }
}

/// Saves the turn's screenshot in the open call; returns its file name.
pub fn save_shot(shared: &Shared, turn: u64, png: &[u8]) -> Option<String> {
    let dir = shared.call.lock().unwrap().as_ref()?.join("shots");
    let name = format!("{}-{turn}.png", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis());
    let r = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(&name), png));
    r.map_err(|e| warn!("save {}: {e}", dir.display())).ok()?;
    Some(name)
}

pub fn save_answer(shared: &Shared, rec: AnswerRecord) {
    // The call lock serializes appends and ratings, so row numbers stay true.
    if let Some(dir) = shared.call.lock().unwrap().as_ref() {
        let mut rows = shared.answer_rows.lock().unwrap();
        let row = rows.next;
        rows.next += 1;
        rows.by_turn.entry(rec.turn).or_default().push(row);
        append(&dir.join(ANSWERS), &rec);
    }
}

/// Non-empty lines of `answers.jsonl` with their row; a line that does not parse keeps its row.
fn read_answers(file: &Path) -> (usize, Vec<(usize, AnswerRecord)>) {
    let rows = lines(file);
    let recs = rows.iter().enumerate().filter_map(|(i, l)| serde_json::from_str(l).ok().map(|r| (i, r))).collect();
    (rows.len(), recs)
}

/// Saves the rating of live turn `turn` on its rows of the open call (write then rename).
pub fn set_feedback(shared: &Shared, turn: u64, value: Option<i8>) {
    let call = shared.call.lock().unwrap();
    let Some(dir) = call.as_ref() else { return };
    let Some(rows) = shared.answer_rows.lock().unwrap().by_turn.get(&turn).cloned() else {
        warn!("feedback: no saved answer of turn {turn}");
        return;
    };
    let file = dir.join(ANSWERS);
    let r = (|| {
        let mut out = String::new();
        for (i, mut line) in lines(&file).into_iter().enumerate() {
            if rows.contains(&i)
                && let Ok(serde_json::Value::Object(mut o)) = serde_json::from_str(&line)
            {
                match value {
                    Some(v) => o.insert("feedback".into(), v.into()),
                    None => o.remove("feedback"),
                };
                line = serde_json::Value::Object(o).to_string();
            }
            out.push_str(&line);
            out.push('\n');
        }
        let tmp = file.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(&tmp, &file)?;
        anyhow::Ok(())
    })();
    match r {
        Ok(()) => info!("feedback {value:?} on turn {turn}"),
        Err(e) => warn!("feedback on {}: {e:#}", file.display()),
    }
}

/// Assembles the context of `dir` (or the profile alone), hands it to the answerer and the STT
/// glossary, and tells the UI. A large context gets its brief for the quick tier (`brief.rs`):
/// from `brief.md` when it is current, else made in the background while the quick tier reads the
/// whole context.
pub fn apply(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer, dir: Option<&Path>) {
    // A brief still being made is for the context this call replaces: stop paying for it.
    if let Some(old) = BRIEF_TASK.lock().unwrap().take() {
        old.abort();
    }
    let a = context::assemble(&cfg.profile_dir(), dir, &cfg.user_context, &cfg.glossary);
    for w in &a.warnings {
        warn!("context: {w}");
    }
    info!("context: {} tokens, glossary: {}", a.tokens(), a.glossary.join(", "));
    *shared.glossary.write().unwrap() = a.glossary.clone();
    let mut ev = Event::Call {
        dir: dir.map(|d| d.display().to_string()),
        title: a.title.clone(),
        folder: a.folder.clone(),
        tokens: a.tokens(),
        parts: a.parts.clone(),
        warnings: a.warnings.clone(),
    };
    let place = dir.map(Path::to_path_buf).unwrap_or_else(|| cfg.profile_dir());
    let key = brief::key(&a.text);
    let cached = brief::cached(&place, &key);
    // A current brief (made here or by «Подготовить») lends its prepared answers to the full tier.
    // One built later, mid-call, does not: restarting the full tier would cut off an answer.
    let full = brief::with_prepared(&a.text, cached.as_deref());
    if let Some(p) = cached.as_deref().and_then(brief::prepared) {
        add_part(&mut ev, PREPARED_PART, p);
    }
    if !answerer.has_quick() || a.tokens() < brief::MIN_TOKENS {
        answerer.reconfigure(&a.text, &full, &full);
        let _ = shared.events.send(ev);
        return;
    }
    if let Some(b) = cached {
        answerer.reconfigure(&a.text, &full, &b);
        add_brief_part(&mut ev, &b, false);
        let _ = shared.events.send(ev);
        return;
    }
    answerer.reconfigure(&a.text, &full, &a.text);
    add_brief_part(&mut ev, "", true);
    let _ = shared.events.send(ev.clone());
    info!("brief: building for {}", place.display());
    let (shared, answerer, text) = (shared.clone(), answerer.clone(), a.text);
    let task = tokio::spawn(async move {
        let started = std::time::Instant::now();
        match answerer.brief(&text).await {
            Ok(b) if !b.is_empty() => {
                if let Err(e) = brief::store(&place, &key, &b) {
                    warn!("brief: cannot save in {}: {e}", place.display());
                }
                info!("brief: {} tokens in {} ms", context::tokens(&b), started.elapsed().as_millis());
                if answerer.set_brief(&key, &b) {
                    let mut ev = ev;
                    add_brief_part(&mut ev, &b, false);
                    let _ = shared.events.send(ev);
                }
            }
            Ok(_) => warn!("brief: empty reply"),
            Err(e) => {
                warn!("brief: {e:#}");
                let _ = shared.events.send(Event::Error { message: format!("досье: {e:#}") });
            }
        }
    });
    *BRIEF_TASK.lock().unwrap() = Some(task.abort_handle());
}

/// The brief being made in the background, if any.
static BRIEF_TASK: std::sync::Mutex<Option<tokio::task::AbortHandle>> = std::sync::Mutex::new(None);

/// The «Досье» row of the UI's context breakdown; `building` adds the note that it is on its way.
fn add_brief_part(ev: &mut Event, brief: &str, building: bool) {
    add_part(ev, BRIEF_PART, brief);
    if let Event::Call { warnings, .. } = ev {
        warnings.retain(|w| w != BRIEF_BUILDING);
        if building {
            warnings.push(BRIEF_BUILDING.into());
        }
    }
}

/// Adds (or replaces) the row `name` of the context breakdown.
fn add_part(ev: &mut Event, name: &str, text: &str) {
    if let Event::Call { parts, .. } = ev {
        parts.retain(|p| p.name != name);
        parts.push(protocol::ContextPart { name: name.into(), tokens: context::tokens(text), truncated: false });
    }
}

const BRIEF_PART: &str = "Досье для быстрой подсказки (brief.md)";
const PREPARED_PART: &str = "Заготовки ответов из досье (полная подсказка)";
const BRIEF_BUILDING: &str = "Досье собирается, пока быстрая подсказка читает весь контекст";

pub fn open(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer, dir: PathBuf) -> Result<()> {
    if !dir.is_dir() {
        bail!("no call directory {}", dir.display());
    }
    let segs: Vec<FinalSegment> = read_jsonl(&dir.join(TRANSCRIPT));
    let (rows, answers) = read_answers(&dir.join(ANSWERS));
    *shared.call.lock().unwrap() = Some(dir.clone());
    *shared.answer_rows.lock().unwrap() = AnswerRows { next: rows, by_turn: Default::default() };
    *shared.transcript.lock().unwrap() = segs.clone();
    Answerer::forget_notes(shared);
    // The `call` event goes first: the UI clears its windows when the call changes.
    apply(cfg, shared, answerer, Some(&dir));
    info!("call opened: {} ({} segments, {} answers)", dir.display(), segs.len(), answers.len());
    for s in segs {
        let _ = shared.events.send(Event::Final { speaker: s.speaker, t: s.t_ms, text: s.text, question: false });
    }
    replay(shared, answerer, answers);
    Ok(())
}

/// Saved answers as answer events, under fresh ids, turns kept together. A saved turn id comes back
/// in a later session of the same call, so a turn also ends where its quick and full pair is complete.
fn replay(shared: &Shared, answerer: &Answerer, answers: Vec<(usize, AnswerRecord)>) {
    let mut turns: BTreeMap<u64, (u64, Vec<String>)> = BTreeMap::new();
    for (row, r) in answers {
        let entry = turns.entry(r.turn).or_insert_with(|| (answerer.next_id(), Vec::new()));
        if entry.1.contains(&r.tier) {
            *entry = (answerer.next_id(), Vec::new());
        }
        entry.1.push(r.tier.clone());
        let turn = entry.0;
        shared.answer_rows.lock().unwrap().by_turn.entry(turn).or_default().push(row);
        let id = answerer.next_id();
        let ev = &shared.events;
        let _ = ev.send(Event::AnswerStart { id, turn, trigger: r.trigger, question: r.question, q_t: r.q_t, tier: r.tier });
        let _ = ev.send(Event::AnswerDelta { id, text: r.text });
        let _ = ev.send(Event::AnswerEnd { id, error: None, feedback: r.feedback });
    }
}

pub fn reload(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer) {
    let dir = shared.call.lock().unwrap().clone();
    apply(cfg, shared, answerer, dir.as_deref());
}

/// Stops saving, goes back to the profile context and writes the summary in the background.
pub fn close(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer) {
    let Some(dir) = shared.call.lock().unwrap().take() else { return };
    *shared.answer_rows.lock().unwrap() = AnswerRows::default();
    // The summary sees the call's own context (who they are, the vacancy), not just the profile.
    let context = context::assemble(&cfg.profile_dir(), Some(&dir), &cfg.user_context, &cfg.glossary).text;
    apply(cfg, shared, answerer, None);
    let segs = shared.transcript.lock().unwrap().clone();
    let hints: Vec<AnswerRecord> = read_jsonl(&dir.join(ANSWERS));
    let (shared, answerer) = (shared.clone(), answerer.clone());
    tokio::spawn(async move {
        let r = if segs.is_empty() {
            Err(anyhow::anyhow!("транскрипт пуст"))
        } else {
            answerer.summarize(&context, &segs, &hints).await.and_then(|s| Ok(std::fs::write(dir.join(SUMMARY), s + "\n")?))
        };
        if let Err(e) = &r {
            warn!("summary of {}: {e:#}", dir.display());
        }
        let _ = shared.events.send(Event::Summary { dir: dir.display().to_string(), ok: r.is_ok(), error: r.err().map(|e| format!("{e:#}")) });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Speaker;

    #[test]
    fn jsonl_round_trip_skips_torn_line() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join(TRANSCRIPT);
        let a = FinalSegment { speaker: Speaker::Them, t_ms: 5, end_ms: 9, text: "Почему Go?".into() };
        let b = FinalSegment { speaker: Speaker::Me, t_ms: 10, end_ms: 12, text: "Скорость.".into() };
        append(&f, &a);
        append(&f, &b);
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"{\"speaker\":\"me\",\"t_").unwrap();
        let back: Vec<FinalSegment> = read_jsonl(&f);
        assert_eq!(back.len(), 2);
        assert_eq!((back[0].t_ms, back[1].text.as_str()), (5, "Скорость."));
        append(&f, &a);
        assert_eq!(read_jsonl::<FinalSegment>(&f).len(), 3, "an append after a torn line stays readable");

        let r = AnswerRecord {
            turn: 1,
            tier: "full".into(),
            trigger: "auto".into(),
            question: "q".into(),
            q_t: Some(5),
            model: "m".into(),
            text: "**a**".into(),
            shot: None,
            feedback: None,
        };
        append(&dir.path().join(ANSWERS), &r);
        assert_eq!(read_jsonl::<AnswerRecord>(&dir.path().join(ANSWERS)), vec![r]);
        assert!(read_jsonl::<AnswerRecord>(&dir.path().join("missing.jsonl")).is_empty());
    }

    #[test]
    fn feedback_lands_on_the_rows_of_its_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (shared, _rx) = Shared::for_test();
        *shared.call.lock().unwrap() = Some(dir.path().to_path_buf());
        let rec = |turn: u64, tier: &str| AnswerRecord {
            turn,
            tier: tier.into(),
            trigger: "auto".into(),
            question: "q".into(),
            q_t: None,
            model: "m".into(),
            text: "a".into(),
            shot: None,
            feedback: None,
        };
        // An earlier session of the same call used turn 1 too.
        append(&dir.path().join(ANSWERS), &rec(1, "full"));
        std::fs::OpenOptions::new().append(true).open(dir.path().join(ANSWERS)).unwrap().write_all(b"{torn\n").unwrap();
        let (rows, old) = read_answers(&dir.path().join(ANSWERS));
        assert_eq!((rows, old.len()), (2, 1));
        *shared.answer_rows.lock().unwrap() = AnswerRows { next: rows, by_turn: Default::default() };
        save_answer(&shared, rec(1, "quick"));
        save_answer(&shared, rec(1, "full"));
        set_feedback(&shared, 1, Some(-1));
        let got: Vec<Option<i8>> = read_answers(&dir.path().join(ANSWERS)).1.into_iter().map(|(_, r)| r.feedback).collect();
        assert_eq!(got, vec![None, Some(-1), Some(-1)], "only this session's turn 1");
        assert!(std::fs::read_to_string(dir.path().join(ANSWERS)).unwrap().contains("{torn"), "a broken line is kept");
        set_feedback(&shared, 1, None);
        assert!(read_answers(&dir.path().join(ANSWERS)).1.iter().all(|(_, r)| r.feedback.is_none()));
    }
}
