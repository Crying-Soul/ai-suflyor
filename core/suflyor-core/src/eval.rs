//! `eval <dir>`: answer quality offline. `<dir>` holds a data directory (`profile/`,
//! `folders/<folder>/calls/<call>/`) and `questions.jsonl`. Every question goes through both tiers
//! with the prompts a live call would get, fixed checks run on the answers, and with `--judge` a
//! strong model scores them. Results go to a jsonl file; `--baseline <old.jsonl>` prints that run's
//! summary next to this one, so a prompt change is compared with the run before it.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use protocol::{Speaker, Tier};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::Config;
use crate::llm;
use crate::{FinalSegment, answer, brief, context};

/// One question of the set.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Case {
    pub id: String,
    /// behavioral, theory, coding, system_design, about, salary, small_talk
    pub kind: String,
    pub question: String,
    /// Earlier lines of the call, "Q: …" (the other side) or "A: …" (the user).
    #[serde(default)]
    pub transcript: Vec<String>,
}

/// Fixed, model-free checks of one answer pair.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct Checks {
    pub spoken_words: usize,
    pub bullets: usize,
    pub quick_words: usize,
    /// The spoken paragraph is in the language of the question.
    pub language: bool,
    /// Numbers of two or more digits in the answer that are in neither the context nor the call.
    pub unknown_numbers: Vec<String>,
    pub pass: bool,
}

/// Scores of the judge model, 1 to 5 (5 best), and whether it found invented experience.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Judge {
    pub correct: f64,
    pub uses_context: f64,
    pub speakable: f64,
    pub consistent: f64,
    pub invented: bool,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Outcome {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub quick: String,
    pub full: String,
    pub checks: Checks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<Judge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The text outside fenced code blocks.
fn prose(s: &str) -> String {
    let mut out = String::new();
    let mut code = false;
    for line in s.lines() {
        if line.trim_start().starts_with("```") {
            code = !code;
        } else if !code {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn is_bullet(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("- ")
        || t.starts_with("* ")
        || t.starts_with("• ")
        || t.split_once(". ").is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// The spoken paragraph (prose before the first blank line or bullet) and the bullet count.
fn split_answer(full: &str) -> (String, usize) {
    let p = prose(full);
    let spoken: Vec<&str> = p.lines().skip_while(|l| l.trim().is_empty()).take_while(|l| !l.trim().is_empty() && !is_bullet(l)).collect();
    (spoken.join(" "), p.lines().filter(|l| is_bullet(l)).count())
}

fn words(s: &str) -> usize {
    s.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

/// Mostly Cyrillic letters.
fn cyrillic(s: &str) -> bool {
    let (mut cy, mut all) = (0, 0);
    for c in s.chars().filter(|c| c.is_alphabetic()) {
        all += 1;
        if ('\u{400}'..='\u{4ff}').contains(&c) {
            cy += 1;
        }
    }
    all > 0 && cy * 2 > all
}

/// Runs of two or more digits ("120", "2019"); one digit is too common to mean a made-up fact.
fn numbers(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in s.split(|c: char| !c.is_ascii_digit()).filter(|n| n.len() >= 2) {
        if !out.iter().any(|o| o == n) {
            out.push(n.to_string());
        }
    }
    out
}

/// `known`: the context and the call the model saw.
pub fn check(kind: &str, question: &str, quick: &str, full: &str, known: &str) -> Checks {
    let (spoken, bullets) = split_answer(full);
    let spoken_words = words(&spoken);
    let quick_words = words(quick);
    let language = cyrillic(&spoken) == cyrillic(question);
    let unknown_numbers: Vec<String> = numbers(&prose(full)).into_iter().chain(numbers(quick)).filter(|n| !known.contains(n.as_str())).collect();
    let (min, max) = if kind == "small_talk" { (1, 40) } else { (20, 110) };
    let pass = (min..=max).contains(&spoken_words)
        && bullets <= if kind == "small_talk" { 0 } else { 3 }
        && (1..=15).contains(&quick_words)
        && language
        && unknown_numbers.is_empty();
    Checks { spoken_words, bullets, quick_words, language, unknown_numbers, pass }
}

const JUDGE_SYSTEM: &str = "You grade hints that an assistant gave a job candidate during a live interview. \
The candidate's materials (profile, vacancy, call notes) come first, then the question, the one-line quick hint and the full hint. \
The full hint opens with a paragraph the candidate says aloud, then follow-up bullets. Score each from 1 (bad) to 5 (excellent): \
correct: technically right and actually answers the question; \
uses_context: uses the candidate's real experience and the vacancy where the question calls for it, and stays out of personal stories for pure theory; \
speakable: short first-person sentences one can say aloud as is, key point first, the right length; \
consistent: the quick hint and the first sentence of the full hint make the same point. \
invented: true if either hint claims experience, projects, numbers or facts about the candidate that the materials do not support. \
Reply with one JSON object and nothing else: \
{\"correct\":n,\"uses_context\":n,\"speakable\":n,\"consistent\":n,\"invented\":bool,\"note\":\"one short sentence on the main flaw\"}";

/// The first JSON object in `s` (models sometimes wrap it in a code fence).
fn parse_judge(s: &str) -> Result<Judge> {
    let (a, b) = (s.find('{'), s.rfind('}'));
    let (Some(a), Some(b)) = (a, b) else { bail!("no JSON in the judge reply: {s}") };
    serde_json::from_str(&s[a..=b]).with_context(|| format!("judge reply: {s}"))
}

/// The one call in `dir/folders/*/calls/*` (the first by name).
fn find_call(dir: &Path) -> Option<PathBuf> {
    let sub = |d: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
        v.sort();
        v
    };
    sub(&dir.join("folders")).iter().flat_map(|f| sub(&f.join("calls"))).next()
}

/// The transcript of a case: its lines, then the question from the other side.
fn segments(case: &Case) -> Vec<FinalSegment> {
    let mut segs = Vec::new();
    for (i, line) in case.transcript.iter().enumerate() {
        let (speaker, text) = match line.split_once(": ") {
            Some(("A", t)) => (Speaker::Me, t),
            Some(("Q", t)) => (Speaker::Them, t),
            _ => (Speaker::Them, line.as_str()),
        };
        let t_ms = i as u64 * 10_000;
        segs.push(FinalSegment { speaker, t_ms, end_ms: t_ms + 5_000, text: text.to_string() });
    }
    let t_ms = case.transcript.len() as u64 * 10_000;
    segs.push(FinalSegment { speaker: Speaker::Them, t_ms, end_ms: t_ms + 5_000, text: case.question.clone() });
    segs
}

async fn one_turn(cfg: &Config, tier: Tier, system: String, model: &str, text: String) -> Result<String> {
    answer::one_shot(cfg, tier, system, model, text, &mut |_| {}).await
}

/// Mean scores and counts of a run, one line.
pub fn summary(rows: &[Outcome]) -> String {
    let pass = rows.iter().filter(|r| r.checks.pass).count();
    let numbers = rows.iter().filter(|r| !r.checks.unknown_numbers.is_empty()).count();
    let errors = rows.iter().filter(|r| r.error.is_some()).count();
    let mut s = format!("{} вопросов: проверки {pass}/{}, неизвестные числа {numbers}, ошибки {errors}", rows.len(), rows.len());
    let judged: Vec<&Judge> = rows.iter().filter_map(|r| r.judge.as_ref()).collect();
    if !judged.is_empty() {
        let m = |f: fn(&Judge) -> f64| judged.iter().map(|j| f(j)).sum::<f64>() / judged.len() as f64;
        let invented = judged.iter().filter(|j| j.invented).count();
        s.push_str(&format!(
            "; судья ({}): верность {:.2}, контекст {:.2}, устность {:.2}, согласованность {:.2}, выдумки {invented}",
            judged.len(),
            m(|j| j.correct),
            m(|j| j.uses_context),
            m(|j| j.speakable),
            m(|j| j.consistent)
        ));
    }
    s
}

pub fn read_run(file: &Path) -> Result<Vec<Outcome>> {
    let s = std::fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
    Ok(s.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str(l).ok()).collect())
}

/// Runs the set in `dir`; returns the results file.
pub async fn run(cfg: &Config, dir: &Path, out: Option<PathBuf>, judge: bool, baseline: Option<PathBuf>) -> Result<PathBuf> {
    let cases: Vec<Case> = std::fs::read_to_string(dir.join("questions.jsonl"))
        .with_context(|| format!("read {}", dir.join("questions.jsonl").display()))?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()
        .context("questions.jsonl")?;
    let call = find_call(dir);
    let a = context::assemble(&dir.join("profile"), call.as_deref(), "", &[]);
    // The prompts `call::apply` would give a live call over this context.
    let place = call.clone().unwrap_or_else(|| dir.join("profile"));
    let cached = brief::cached(&place, &brief::key(&a.text));
    let full_ctx = brief::with_prepared(&a.text, cached.as_deref());
    let quick_ctx = match &cached {
        Some(b) if cfg.two_tier && a.tokens() >= brief::MIN_TOKENS => b.clone(),
        _ => full_ctx.clone(),
    };
    info!("eval: {} questions, context {} tokens, brief {}", cases.len(), a.tokens(), if cached.is_some() { "yes" } else { "no" });
    let out = out.unwrap_or_else(|| {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        dir.join("runs").join(format!("{secs}.jsonl"))
    });
    if let Some(p) = out.parent() {
        std::fs::create_dir_all(p)?;
    }
    let _ = std::fs::write(&out, "");
    let mut rows = Vec::new();
    for case in &cases {
        let segs = segments(case);
        let turn = llm::turn_text(&segs, &case.question, llm::Screen::None);
        let known = format!("{full_ctx}\n{turn}");
        let quick = one_turn(cfg, Tier::Quick, llm::system_prompt(true, &quick_ctx, &cfg.user_language), &cfg.quick_model, turn.clone());
        let full = one_turn(cfg, Tier::Full, llm::system_prompt(false, &full_ctx, &cfg.user_language), &cfg.model, turn.clone());
        let (quick, full) = tokio::join!(quick, full);
        let error = [&quick, &full].iter().find_map(|r| r.as_ref().err().map(|e| format!("{e:#}")));
        let (quick, full) = (quick.unwrap_or_default(), full.unwrap_or_default());
        let checks = check(&case.kind, &case.question, &quick, &full, &known);
        let mut row = Outcome { id: case.id.clone(), kind: case.kind.clone(), question: case.question.clone(), quick, full, checks, judge: None, error };
        if judge && row.error.is_none() {
            let text = format!(
                "<materials>\n{}\n</materials>\n<call>\n{}\n</call>\n<quick_hint>\n{}\n</quick_hint>\n<full_hint>\n{}\n</full_hint>\nGrade the hints.",
                full_ctx.trim(),
                llm::render(&segs),
                row.quick,
                row.full
            );
            match one_turn(cfg, Tier::Full, JUDGE_SYSTEM.to_string(), &cfg.alt_model, text).await.and_then(|r| parse_judge(&r)) {
                Ok(j) => row.judge = Some(j),
                Err(e) => warn!("eval {}: judge: {e:#}", case.id),
            }
        }
        info!("eval {} [{}]: checks {}, {} words", row.id, row.kind, if row.checks.pass { "ok" } else { "FAIL" }, row.checks.spoken_words);
        let mut line = serde_json::to_string(&row)?;
        line.push('\n');
        std::fs::OpenOptions::new().append(true).open(&out)?.write_all(line.as_bytes())?;
        rows.push(row);
    }
    eprintln!("этот прогон: {}", summary(&rows));
    if let Some(b) = baseline {
        eprintln!("прошлый:     {}", summary(&read_run(&b)?));
    }
    eprintln!("результаты: {}", out.display());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_measure_the_spoken_part() {
        let full = "В биллинге p99 был 800 миллисекунд. Я нашёл N+1 в расчёте тарифов и переписал его на батч-запрос. \
Добавил кэш в Redis для справочников. Через две недели p99 стал 120 миллисекунд, жалобы ушли.\n\n\
- Как нашли? → Профилировали pprof.\n- Почему Redis? → Уже был в стеке.\n\n```go\nx := 12345\n```";
        let c = check("behavioral", "Расскажите о сложной задаче?", "Биллинг: p99 800 → 120 мс", full, "p99 800 мс, стало 120");
        assert_eq!((c.bullets, c.language, c.unknown_numbers.clone()), (2, true, vec![]), "{c:?}");
        assert!(c.spoken_words >= 20 && c.pass, "{c:?}");
        // A number the materials do not have, in English for a Russian question, no quick line.
        let c = check("theory", "Что такое мьютекс?", "", "A mutex guards shared data; we cut latency by 37 percent with it.", "");
        assert_eq!(c.unknown_numbers, vec!["37"]);
        assert!(!c.language && !c.pass);
        // Small talk: short, no bullets.
        assert!(check("small_talk", "Как дела?", "Всё хорошо, спасибо", "Всё хорошо, спасибо! Рад познакомиться.", "").pass);
        assert!(!check("small_talk", "Как дела?", "Хорошо", "Хорошо.\n\n- лишний пункт", "").pass);
    }

    #[test]
    fn judge_reply_and_summary() {
        let j = parse_judge("```json\n{\"correct\":4,\"uses_context\":5,\"speakable\":3,\"consistent\":4,\"invented\":false,\"note\":\"long\"}\n```").unwrap();
        assert_eq!((j.correct, j.invented), (4.0, false));
        assert!(parse_judge("no").is_err());
        let row = |pass: bool, judge: Option<Judge>| Outcome {
            id: "x".into(),
            kind: "theory".into(),
            question: "q".into(),
            quick: String::new(),
            full: String::new(),
            checks: Checks { pass, ..Default::default() },
            judge,
            error: None,
        };
        let s = summary(&[row(true, Some(j.clone())), row(false, Some(Judge { invented: true, ..j }))]);
        assert!(s.starts_with("2 вопросов: проверки 1/2") && s.contains("верность 4.00") && s.contains("выдумки 1"), "{s}");
    }

    #[test]
    fn case_transcript_becomes_segments() {
        let c = Case {
            id: "a".into(), kind: "theory".into(), question: "Почему?".into(), transcript: vec!["Q: Привет.".into(), "A: Здравствуйте.".into()]
        };
        assert_eq!(llm::render(&segments(&c)), "Q: Привет.\nA: Здравствуйте.\nQ: Почему?");
    }

    #[test]
    fn the_shipped_set_parses() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/eval");
        let cases: Vec<Case> = std::fs::read_to_string(dir.join("questions.jsonl"))
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(cases.len() >= 30);
        let call = find_call(&dir).expect("a call in the set");
        assert!(context::assemble(&dir.join("profile"), Some(&call), "", &[]).text.contains("stage=\"tech\""));
    }
}
