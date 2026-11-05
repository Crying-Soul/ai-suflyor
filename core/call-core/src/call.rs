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
use crate::context;
use crate::{FinalSegment, Shared};

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
    let Ok(s) = std::fs::read_to_string(file) else { return Vec::new() };
    if !s.is_empty() && !s.ends_with('\n') {
        let _ = std::fs::OpenOptions::new().append(true).open(file).and_then(|mut f| f.write_all(b"\n"));
    }
    s.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str(l).map_err(|e| warn!("{}: {e}", file.display())).ok()).collect()
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
    if let Some(dir) = shared.call.lock().unwrap().as_ref() {
        append(&dir.join(ANSWERS), &rec);
    }
}

/// Assembles the context of `dir` (or the profile alone), hands it to the answerer and the STT
/// glossary, and tells the UI. Returns the assembled text.
pub fn apply(cfg: &Config, shared: &Shared, answerer: &Answerer, dir: Option<&Path>) -> String {
    let a = context::assemble(&cfg.profile_dir(), dir, &cfg.user_context, &cfg.glossary);
    for w in &a.warnings {
        warn!("context: {w}");
    }
    info!("context: {} tokens, glossary: {}", a.tokens(), a.glossary.join(", "));
    *shared.glossary.write().unwrap() = a.glossary.clone();
    answerer.reconfigure(&a.text);
    let _ = shared.events.send(Event::Call {
        dir: dir.map(|d| d.display().to_string()),
        title: a.title.clone(),
        folder: a.folder.clone(),
        tokens: a.tokens(),
        parts: a.parts.clone(),
        warnings: a.warnings.clone(),
    });
    a.text
}

pub fn open(cfg: &Config, shared: &Shared, answerer: &Answerer, dir: PathBuf) -> Result<()> {
    if !dir.is_dir() {
        bail!("no call directory {}", dir.display());
    }
    let segs: Vec<FinalSegment> = read_jsonl(&dir.join(TRANSCRIPT));
    let answers: Vec<AnswerRecord> = read_jsonl(&dir.join(ANSWERS));
    *shared.call.lock().unwrap() = Some(dir.clone());
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

/// Saved answers as answer events, under fresh ids, turns kept together.
fn replay(shared: &Shared, answerer: &Answerer, answers: Vec<AnswerRecord>) {
    let mut turns: BTreeMap<u64, u64> = BTreeMap::new();
    for r in answers {
        let turn = *turns.entry(r.turn).or_insert_with(|| answerer.next_id());
        let id = answerer.next_id();
        let ev = &shared.events;
        let _ = ev.send(Event::AnswerStart { id, turn, trigger: r.trigger, question: r.question, q_t: r.q_t, tier: r.tier });
        let _ = ev.send(Event::AnswerDelta { id, text: r.text });
        let _ = ev.send(Event::AnswerEnd { id, error: None });
    }
}

pub fn reload(cfg: &Config, shared: &Shared, answerer: &Answerer) {
    let dir = shared.call.lock().unwrap().clone();
    apply(cfg, shared, answerer, dir.as_deref());
}

/// Stops saving, goes back to the profile context and writes the summary in the background.
pub fn close(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer) {
    let Some(dir) = shared.call.lock().unwrap().take() else { return };
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

        let r = AnswerRecord { turn: 1, tier: "full".into(), trigger: "auto".into(), question: "q".into(), q_t: Some(5), model: "m".into(), text: "**a**".into(), shot: None };
        append(&dir.path().join(ANSWERS), &r);
        assert_eq!(read_jsonl::<AnswerRecord>(&dir.path().join(ANSWERS)), vec![r]);
        assert!(read_jsonl::<AnswerRecord>(&dir.path().join("missing.jsonl")).is_empty());
    }
}
