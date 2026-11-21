//! The open call: its context goes into the prompt and the whisper glossary, its transcript and
//! answers are appended to `transcript.jsonl` / `answers.jsonl`, and closing it writes `summary.md`.
//! With no call open only the profile context is used and nothing is saved.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use protocol::{Event, Tier, Trigger};
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
    /// Unique in the call; ratings in `feedback.jsonl` refer to it. Records written before ids
    /// existed have none and are known by their row (`row-<n>`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    /// The live turn when it was written. Turn ids restart with the core, so not unique in the file.
    pub turn: u64,
    pub tier: Tier,
    pub trigger: Trigger,
    pub question: String,
    #[serde(default)]
    pub q_t: Option<u64>,
    pub model: String,
    pub text: String,
    /// Screenshot of this turn in `shots/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot: Option<String>,
    /// The user's rating: 1 good, -1 bad. Read from `feedback.jsonl`; older versions wrote it here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<i8>,
}

/// The saved answer ids of each live turn of the open call (a quick and a full one, usually).
pub type AnswerIds = HashMap<u64, Vec<String>>;

/// One rating in `feedback.jsonl`; the last line for an id wins, `value: null` clears it.
#[derive(Serialize, Deserialize)]
struct Rating {
    id: String,
    value: Option<i8>,
}

const TRANSCRIPT: &str = "transcript.jsonl";
const ANSWERS: &str = "answers.jsonl";
const FEEDBACK: &str = "feedback.jsonl";
const SUMMARY: &str = "summary.md";
/// Left in a call that was open at quit: its summary is written at the next start.
const SUMMARY_PENDING: &str = ".summary-pending";

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
pub fn save_shot(shared: &Shared, turn: u64, image: &[u8]) -> Option<String> {
    let dir = shared.call.lock().unwrap().as_ref()?.join("shots");
    let name = format!("{}-{turn}.{}", crate::now_ms(), crate::screen::EXTENSION);
    let r = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(&name), image));
    r.map_err(|e| warn!("save {}: {e}", dir.display())).ok()?;
    Some(name)
}

pub fn save_answer(shared: &Shared, mut rec: AnswerRecord) {
    if let Some(dir) = shared.call.lock().unwrap().as_ref() {
        rec.id = format!("{}-{}-{}", crate::now_ms(), rec.turn, rec.tier.as_str());
        shared.answer_ids.lock().unwrap().entry(rec.turn).or_default().push(rec.id.clone());
        append(&dir.join(ANSWERS), &rec);
    }
}

/// The saved answers of a call with their ratings applied; records without an id get their row's.
fn read_answers(dir: &Path) -> Vec<AnswerRecord> {
    let mut ratings: HashMap<String, Option<i8>> = HashMap::new();
    for r in read_jsonl::<Rating>(&dir.join(FEEDBACK)) {
        ratings.insert(r.id, r.value);
    }
    lines(&dir.join(ANSWERS))
        .iter()
        .enumerate()
        .filter_map(|(row, l)| {
            let mut r: AnswerRecord = serde_json::from_str(l).ok()?;
            if r.id.is_empty() {
                r.id = format!("row-{row}");
            }
            if let Some(v) = ratings.get(&r.id) {
                r.feedback = *v;
            }
            Some(r)
        })
        .collect()
}

/// Saves the rating of live turn `turn` for its answers in the open call.
pub fn set_feedback(shared: &Shared, turn: u64, value: Option<i8>) {
    let call = shared.call.lock().unwrap();
    let Some(dir) = call.as_ref() else { return };
    let Some(ids) = shared.answer_ids.lock().unwrap().get(&turn).cloned() else {
        warn!("feedback: no saved answer of turn {turn}");
        return;
    };
    for id in ids {
        append(&dir.join(FEEDBACK), &Rating { id, value });
    }
    info!("feedback {value:?} on turn {turn}");
}

/// Assembles the context of `dir` (or the profile alone), hands it to the answerer and the STT
/// glossary, and tells the UI. A large context gets its brief for the quick tier (`brief.rs`):
/// from `brief.md` when it is current, else made in the background while the quick tier reads the
/// whole context.
pub fn apply(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer, dir: Option<&Path>) {
    // A brief still being made is for the context this call replaces: stop paying for it.
    let old = BRIEF_TASK.lock().unwrap().take();
    if let Some(old) = old {
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
    let call_open = dir.is_some();
    if !answerer.has_quick() || a.tokens() < brief::MIN_TOKENS {
        answerer.reconfigure(&a.text, &full, &full, call_open);
        let _ = shared.events.send(ev);
        return;
    }
    if let Some(b) = cached {
        answerer.reconfigure(&a.text, &full, &b, call_open);
        add_brief_part(&mut ev, &b, false);
        let _ = shared.events.send(ev);
        return;
    }
    answerer.reconfigure(&a.text, &full, &a.text, call_open);
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
                let _ = shared.events.send(Event::Error { message: format!("досье: {e:#}"), kind: Some(crate::llm::error_kind(&e)) });
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
    // Another call still open: it ends here, with its summary, as if «Завершить звонок» was pressed.
    let prev = shared.call.lock().unwrap().clone().filter(|p| *p != dir);
    if let Some(prev) = prev {
        info!("call {} replaced: writing its summary", prev.display());
        summarize(cfg, shared, answerer, prev);
    }
    let was_open = shared.call.lock().unwrap().is_some();
    let unsaved = if was_open { Vec::new() } else { shared.transcript.lock().unwrap().clone() };
    let segs = adopt(&dir, unsaved);
    let answers = read_answers(&dir);
    let _ = std::fs::remove_file(dir.join(SUMMARY_PENDING)); // it is open again: it ends the normal way
    *shared.call.lock().unwrap() = Some(dir.clone());
    shared.answer_ids.lock().unwrap().clear();
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

/// The transcript a call opens with. A new call started mid-conversation keeps what was said
/// before it (`unsaved`: the transcript in memory while no call was open), written into its file.
fn adopt(dir: &Path, unsaved: Vec<FinalSegment>) -> Vec<FinalSegment> {
    let saved: Vec<FinalSegment> = read_jsonl(&dir.join(TRANSCRIPT));
    if !saved.is_empty() || unsaved.is_empty() {
        return saved;
    }
    info!("call {}: keeping {} segments said before it started", dir.display(), unsaved.len());
    for s in &unsaved {
        append(&dir.join(TRANSCRIPT), s);
    }
    unsaved
}

/// Saved answers as answer events, under fresh ids, turns kept together. A saved turn id comes back
/// in a later session of the same call, so a turn also ends where its quick and full pair is complete.
fn replay(shared: &Shared, answerer: &Answerer, answers: Vec<AnswerRecord>) {
    let mut turns: BTreeMap<u64, (u64, Vec<Tier>)> = BTreeMap::new();
    for r in answers {
        let entry = turns.entry(r.turn).or_insert_with(|| (answerer.next_id(), Vec::new()));
        if entry.1.contains(&r.tier) {
            *entry = (answerer.next_id(), Vec::new());
        }
        entry.1.push(r.tier);
        let turn = entry.0;
        shared.answer_ids.lock().unwrap().entry(turn).or_default().push(r.id);
        let id = answerer.next_id();
        let ev = &shared.events;
        let _ = ev.send(Event::AnswerStart { id, turn, trigger: r.trigger, question: r.question, q_t: r.q_t, tier: r.tier });
        let _ = ev.send(Event::AnswerDelta { id, text: r.text });
        let _ = ev.send(Event::AnswerEnd { id, error: None, kind: None, feedback: r.feedback });
    }
}

pub fn reload(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer) {
    let dir = shared.call.lock().unwrap().clone();
    apply(cfg, shared, answerer, dir.as_deref());
}

/// Stops saving, goes back to the profile context and writes the summary in the background.
pub fn close(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer) {
    let Some(dir) = shared.call.lock().unwrap().take() else { return };
    shared.answer_ids.lock().unwrap().clear();
    apply(cfg, shared, answerer, None);
    summarize(cfg, shared, answerer, dir);
}

/// Writes `summary.md` of a call in the background, from its saved files: «Очистить» empties only the
/// transcript in memory, and a call closed in an earlier session («Повторить итог») has none.
pub fn summarize(cfg: &Config, shared: &Arc<Shared>, answerer: &Answerer, dir: PathBuf) {
    // The summary sees the call's own context (who they are, the vacancy), not just the profile.
    let context = context::assemble(&cfg.profile_dir(), Some(&dir), &cfg.user_context, &cfg.glossary).text;
    let segs: Vec<FinalSegment> = read_jsonl(&dir.join(TRANSCRIPT));
    let hints = read_answers(&dir);
    let (shared, answerer) = (shared.clone(), answerer.clone());
    tokio::spawn(async move {
        let r = if segs.is_empty() {
            Err(anyhow::anyhow!("транскрипт пуст"))
        } else {
            answerer.summarize(&context, &segs, &hints).await.and_then(|s| Ok(std::fs::write(dir.join(SUMMARY), s + "\n")?))
        };
        // Tried once: a failure is shown, and «Повторить итог» tries again.
        let _ = std::fs::remove_file(dir.join(SUMMARY_PENDING));
        if let Err(e) = &r {
            warn!("summary of {}: {e:#}", dir.display());
        }
        let _ = shared.events.send(Event::Summary { dir: dir.display().to_string(), ok: r.is_ok(), error: r.err().map(|e| format!("{e:#}")) });
    });
}

/// At quit: the open call gets its summary at the next start (`pending_summaries`) instead of
/// holding up the quit for the full model.
pub fn defer_summary(shared: &Shared) {
    // Taken before the file is read: the lock is not held over disk I/O.
    let dir = shared.call.lock().unwrap().take();
    if let Some(dir) = dir.filter(|d| !lines(&d.join(TRANSCRIPT)).is_empty()) {
        match std::fs::write(dir.join(SUMMARY_PENDING), "") {
            Ok(()) => info!("call {} left open: summary at the next start", dir.display()),
            Err(e) => warn!("{}: {e}", dir.join(SUMMARY_PENDING).display()),
        }
    }
}

/// Calls left open at an earlier quit (`<dataDir>/folders/*/calls/*/.summary-pending`).
pub fn pending_summaries(cfg: &Config) -> Vec<PathBuf> {
    let subdirs = |d: PathBuf| std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect::<Vec<_>>();
    subdirs(cfg.path(&cfg.data_dir).join("folders")).into_iter().flat_map(|f| subdirs(f.join("calls"))).filter(|c| c.join(SUMMARY_PENDING).exists()).collect()
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
            id: "x".into(),
            turn: 1,
            tier: Tier::Full,
            trigger: Trigger::Auto,
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
    fn feedback_lands_on_the_answers_of_its_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (shared, _rx) = Shared::for_test();
        *shared.call.lock().unwrap() = Some(dir.path().to_path_buf());
        let rec = |turn: u64, tier: Tier| AnswerRecord {
            id: String::new(),
            turn,
            tier,
            trigger: Trigger::Auto,
            question: "q".into(),
            q_t: None,
            model: "m".into(),
            text: "a".into(),
            shot: None,
            feedback: None,
        };
        // An earlier version: no id, the rating inline. Its session used turn 1 too.
        let old = AnswerRecord { feedback: Some(1), ..rec(1, Tier::Full) };
        append(&dir.path().join(ANSWERS), &old);
        std::fs::OpenOptions::new().append(true).open(dir.path().join(ANSWERS)).unwrap().write_all(b"{torn\n").unwrap();
        save_answer(&shared, rec(1, Tier::Quick));
        save_answer(&shared, rec(1, Tier::Full));
        set_feedback(&shared, 1, Some(-1));
        let got: Vec<(String, Option<i8>)> = read_answers(dir.path()).into_iter().map(|r| (r.id, r.feedback)).collect();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], ("row-0".to_string(), Some(1)), "the old rating stays, the old record gets its row id");
        assert!(got[1..].iter().all(|(id, f)| !id.is_empty() && *f == Some(-1)), "only this session's turn 1: {got:?}");
        set_feedback(&shared, 1, None);
        assert!(read_answers(dir.path())[1..].iter().all(|r| r.feedback.is_none()));
        assert!(std::fs::read_to_string(dir.path().join(ANSWERS)).unwrap().contains("{torn"), "a broken line is kept");
    }

    #[test]
    fn a_new_call_keeps_what_was_said_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let seg = |t: u64, text: &str| FinalSegment { speaker: Speaker::Them, t_ms: t, end_ms: t + 1, text: text.into() };
        assert!(adopt(dir.path(), Vec::new()).is_empty());
        let got = adopt(dir.path(), vec![seg(1, "Привет"), seg(5, "Расскажите о себе")]);
        assert_eq!(got.len(), 2);
        assert_eq!(read_jsonl::<FinalSegment>(&dir.path().join(TRANSCRIPT)).len(), 2, "written to the call");
        // A call that already has a transcript (resumed) keeps its own, unmixed.
        let got = adopt(dir.path(), vec![seg(9, "Чужое")]);
        assert_eq!(got.iter().map(|s| s.t_ms).collect::<Vec<_>>(), vec![1, 5]);
    }

    #[test]
    fn an_open_call_is_summarized_at_the_next_start() {
        let data = tempfile::tempdir().unwrap();
        let call = data.path().join("folders").join("acme").join("calls").join("c1");
        std::fs::create_dir_all(&call).unwrap();
        let cfg = Config { data_dir: data.path().display().to_string(), ..Config::default() };
        let (shared, _rx) = Shared::for_test();
        *shared.call.lock().unwrap() = Some(call.clone());
        defer_summary(&shared);
        assert!(pending_summaries(&cfg).is_empty(), "nothing said in the call: nothing to summarize");
        append(&call.join(TRANSCRIPT), &FinalSegment { speaker: Speaker::Them, t_ms: 1, end_ms: 2, text: "Привет".into() });
        *shared.call.lock().unwrap() = Some(call.clone());
        defer_summary(&shared);
        assert_eq!(pending_summaries(&cfg), vec![call]);
        assert!(shared.call.lock().unwrap().is_none());
    }
}
