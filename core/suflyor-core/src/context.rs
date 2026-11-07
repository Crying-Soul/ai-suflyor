//! Per-call context (docs/ARCHITECTURE.md §6a). Three nodes of one shape: the profile (shared by
//! every call), a folder (a company or project) and a call (one round). Each node is a directory
//! with `context.md`, `meta.json` (`{title, glossary}`) and `files/` (md, txt, pdf).
//! The assembled text goes into the system prompt, stable parts first, so the prompt cache holds.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use protocol::ContextPart as Part;
use serde::{Deserialize, Serialize};
use tracing::warn;

/// Rough tokens for a text: Cyrillic runs ~2.5–3 characters a token, Latin ~4. Errs high.
pub fn tokens(s: &str) -> u64 {
    (s.chars().count() as u64).div_ceil(3)
}

/// One document may take at most this many tokens; the rest is cut and the UI warned.
const DOC_TOKENS: u64 = 60_000;
/// The whole context (documents, notes, earlier summaries) stays under this.
const TOTAL_TOKENS: u64 = 150_000;
/// Earlier calls of the folder whose summaries go into the context.
const PREVIOUS_CALLS: usize = 3;
/// Whisper reads ~224 tokens of prompt; the glossary takes at most this many characters of it.
const GLOSSARY_CHARS: usize = 600;

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Meta {
    pub title: String,
    pub glossary: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Node {
    pub dir: PathBuf,
    pub meta: Meta,
    /// context.md
    pub notes: String,
    /// (file name, text) of every readable file in files/, sorted by name.
    pub files: Vec<(String, String)>,
}

impl Node {
    /// A missing directory or file reads as empty: a new node has nothing yet.
    pub fn load(dir: &Path) -> Node {
        let meta = std::fs::read_to_string(dir.join("meta.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).map_err(|e| warn!("{}: {e}", dir.join("meta.json").display())).ok())
            .unwrap_or_default();
        let notes = std::fs::read_to_string(dir.join("context.md")).unwrap_or_default();
        let mut files = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir.join("files")) {
            let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            paths.sort();
            for p in paths {
                match file_text(&p) {
                    Ok(Some(t)) => files.push((p.file_name().unwrap().to_string_lossy().into_owned(), t)),
                    Ok(None) => {}
                    Err(e) => warn!("{}: {e:#}", p.display()),
                }
            }
        }
        Node { dir: dir.to_path_buf(), meta, notes, files }
    }

    fn title(&self) -> String {
        if self.meta.title.trim().is_empty() {
            self.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            self.meta.title.trim().to_string()
        }
    }
}

/// Text of a context file: md/txt as is, pdf through a cached extraction. Other types are skipped.
fn file_text(path: &Path) -> Result<Option<String>> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "md" | "txt" => Ok(Some(std::fs::read_to_string(path)?)),
        "pdf" => pdf_text(path).map(Some),
        _ => Ok(None),
    }
}

/// `files/.text/<name>.txt` next to a PDF. It is rebuilt only when missing or older than the PDF,
/// so a hand-corrected extraction survives.
pub fn pdf_cache(pdf: &Path) -> PathBuf {
    let name = pdf.file_name().unwrap_or_default().to_string_lossy();
    pdf.parent().unwrap_or(Path::new(".")).join(".text").join(format!("{name}.txt"))
}

pub fn pdf_text(pdf: &Path) -> Result<String> {
    let cache = pdf_cache(pdf);
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    if let (Some(c), Some(p)) = (modified(&cache), modified(pdf))
        && c >= p
    {
        return Ok(std::fs::read_to_string(&cache)?);
    }
    let bytes = std::fs::read(pdf).with_context(|| format!("read {}", pdf.display()))?;
    // pdf-extract panics on some malformed fonts; a bad file must not take the core down.
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
        .map_err(|_| anyhow::anyhow!("PDF parser crashed on {}", pdf.display()))?
        .with_context(|| format!("extract text from {}", pdf.display()))?;
    let text = tidy(&text);
    std::fs::create_dir_all(cache.parent().unwrap())?;
    std::fs::write(&cache, &text)?;
    Ok(text)
}

/// PDF text comes with ragged spacing: trim lines, keep at most one blank line in a row.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.lines().map(str::trim_end) {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

#[derive(Debug, Default)]
pub struct Assembled {
    /// The block appended to the system prompt.
    pub text: String,
    pub glossary: Vec<String>,
    pub parts: Vec<Part>,
    pub warnings: Vec<String>,
    pub title: String,
    pub folder: String,
}

impl Assembled {
    pub fn tokens(&self) -> u64 {
        tokens(&self.text)
    }

    /// Adds `<tag attrs>body</tag>`, cut to the per-document and the total budget.
    fn push(&mut self, name: String, tag: &str, attrs: &str, body: &str) {
        let body = body.trim();
        if body.is_empty() {
            return;
        }
        let left = TOTAL_TOKENS.saturating_sub(self.tokens());
        let cap = DOC_TOKENS.min(left);
        if cap < 200 {
            self.warnings.push(format!("{name}: не поместилось, контекст уже {TOTAL_TOKENS} токенов"));
            self.parts.push(Part { name, tokens: 0, truncated: true });
            return;
        }
        let (body, truncated) = cut(body, cap);
        if truncated {
            self.warnings.push(format!("{name}: обрезано до ~{cap} токенов"));
        }
        let open = if attrs.is_empty() { format!("<{tag}>") } else { format!("<{tag} {attrs}>") };
        self.text.push_str(&format!("{open}\n{body}\n</{tag}>\n\n"));
        self.parts.push(Part { name, tokens: tokens(&body), truncated });
    }

    /// `label`: how the UI names the node; `source`: the same in the prompt. Without notes the tag
    /// still carries the node's title, so the model knows the company even from documents alone.
    fn push_node(&mut self, node: &Node, label: &str, source: &str, tag: &str, attrs: &str) {
        let notes = if node.notes.trim().is_empty() { node.title() } else { node.notes.clone() };
        self.push(format!("{label}: context.md"), tag, attrs, &notes);
        for (name, text) in &node.files {
            self.push(format!("{label}: {name}"), "document", &format!("source=\"{source}\" name=\"{}\"", attr(name)), text);
        }
    }
}

fn attr(s: &str) -> String {
    s.replace('"', "'")
}

/// Cuts `s` to about `max` tokens at a line break, with a marker saying how much was dropped.
fn cut(s: &str, max: u64) -> (String, bool) {
    if tokens(s) <= max {
        return (s.to_string(), false);
    }
    let keep_chars = (max * 3) as usize;
    let mut end = s.char_indices().nth(keep_chars).map_or(s.len(), |(i, _)| i);
    if let Some(nl) = s[..end].rfind('\n').filter(|&nl| nl > end / 2) {
        end = nl;
    }
    let dropped = s[end..].chars().count();
    (format!("{}\n[обрезано: ещё {dropped} символов]", &s[..end]), true)
}

/// The folder of a call: `<folder>/calls/<call>`.
pub fn folder_of(call: &Path) -> Option<&Path> {
    call.parent().filter(|p| p.file_name().is_some_and(|n| n == "calls")).and_then(Path::parent)
}

/// Summaries of the calls in the same folder that sort before this one (names start with the
/// date), newest first.
fn previous_summaries(call: &Path) -> Vec<(String, String)> {
    let Some(calls) = call.parent() else { return Vec::new() };
    let me = call.file_name().unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(calls)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n < me)).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs.iter()
        .rev()
        .filter_map(|d| {
            let s = std::fs::read_to_string(d.join("summary.md")).ok()?;
            Some((Node::load(d).title(), s))
        })
        .take(PREVIOUS_CALLS)
        .collect()
}

/// Profile, then folder, earlier calls and this call: the order changes least to most often.
/// `fallback_about` is the old config `userContext`, used while no profile exists.
pub fn assemble(profile_dir: &Path, call: Option<&Path>, fallback_about: &str, base_glossary: &[String]) -> Assembled {
    let mut a = Assembled::default();
    let profile = Node::load(profile_dir);
    let about = if profile.notes.trim().is_empty() { fallback_about } else { profile.notes.as_str() };
    a.push("Обо мне: context.md".into(), "about_user", "", about);
    for (name, text) in &profile.files {
        a.push(format!("Обо мне: {name}"), "document", &format!("source=\"profile\" name=\"{}\"", attr(name)), text);
    }
    let mut glossaries = vec![profile.meta.glossary.clone()];

    if let Some(call) = call {
        let node = Node::load(call);
        a.title = node.title();
        if let Some(folder) = folder_of(call) {
            let f = Node::load(folder);
            a.folder = f.title();
            a.push_node(&f, "Папка", "company", "company", &format!("name=\"{}\"", attr(&a.folder)));
            let prev = previous_summaries(call);
            if !prev.is_empty() {
                let body = prev.iter().map(|(t, s)| format!("## {t}\n{}", s.trim())).collect::<Vec<_>>().join("\n\n");
                a.push("Прошлые звонки".into(), "previous_calls", "", &body);
            }
            glossaries.insert(0, f.meta.glossary.clone());
        }
        let title = format!("title=\"{}\"", attr(&a.title));
        a.push_node(&node, "Звонок", "call", "this_call", &title);
        glossaries.insert(0, node.meta.glossary.clone());
    }
    glossaries.push(base_glossary.to_vec());
    a.glossary = merge_glossary(&glossaries);
    a
}

/// Highest priority first; case-insensitive dedupe; cut to what whisper's prompt can hold.
fn merge_glossary(lists: &[Vec<String>]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut len = 0;
    for term in lists.iter().flatten().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        if out.iter().any(|o| o.eq_ignore_ascii_case(term) || o.to_lowercase() == term.to_lowercase()) {
            continue;
        }
        if len + term.len() + 2 > GLOSSARY_CHARS {
            break;
        }
        len += term.len() + 2;
        out.push(term.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn layers_in_order_with_previous_calls() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        write(&r.join("profile/context.md"), "Бэкенд на Go, 6 лет.");
        write(&r.join("profile/meta.json"), r#"{"glossary":["Go","Kafka"]}"#);
        let folder = r.join("folders/yandex");
        write(&folder.join("meta.json"), r#"{"title":"Яндекс","glossary":["YDB","kafka"]}"#);
        write(&folder.join("files/vacancy.md"), "Senior Go в Маркет.");
        write(&folder.join("files/logo.png"), "x");
        write(&folder.join("calls/2026-11-01-1000-hr/summary.md"), "HR: спросили про зарплату.");
        write(&folder.join("calls/2026-11-03-1000-tech/summary.md"), "Тех: шардирование.");
        write(&folder.join("calls/2026-11-09-1000-final/summary.md"), "из будущего");
        let call = folder.join("calls/2026-11-05-1200-sys");
        write(&call.join("meta.json"), r#"{"title":"Системный дизайн"}"#);
        write(&call.join("context.md"), "Интервьюер: Анна.");

        let a = assemble(&r.join("profile"), Some(&call), "старый userContext", &["Redis".into()]);
        let pos = |s: &str| a.text.find(s).unwrap_or_else(|| panic!("{s} missing in\n{}", a.text));
        assert!(pos("<about_user>") < pos("<company name=\"Яндекс\">"));
        assert!(pos("Senior Go") < pos("<previous_calls>"));
        assert!(pos("Тех: шардирование") < pos("HR: спросили"), "newest earlier call first");
        assert!(!a.text.contains("из будущего"), "later calls stay out");
        assert!(pos("<previous_calls>") < pos("<this_call title=\"Системный дизайн\">"));
        assert!(!a.text.contains("старый userContext"));
        assert!(!a.text.contains("logo.png"));
        assert_eq!(a.glossary, vec!["YDB", "kafka", "Go", "Redis"]);
        assert_eq!((a.title.as_str(), a.folder.as_str()), ("Системный дизайн", "Яндекс"));
    }

    #[test]
    fn no_profile_uses_fallback_and_no_call() {
        let root = tempfile::tempdir().unwrap();
        let a = assemble(&root.path().join("profile"), None, "I write Go.", &[]);
        assert_eq!(a.text, "<about_user>\nI write Go.\n</about_user>\n\n");
        assert!(assemble(&root.path().join("profile"), None, "", &[]).text.is_empty());
    }

    #[test]
    fn budgets_cut_and_warn() {
        let big = "строка текста\n".repeat(20_000); // ~94k tokens, over DOC_TOKENS
        let (c, t) = cut(&big, 1_000);
        assert!(t && tokens(&c) <= 1_020 && c.ends_with("символов]"));
        let root = tempfile::tempdir().unwrap();
        let p = root.path().join("profile");
        for i in 0..6 {
            write(&p.join(format!("files/doc{i}.txt")), &big);
        }
        let a = assemble(&p, None, "", &[]);
        assert!(a.tokens() <= TOTAL_TOKENS + 200);
        assert!(a.parts.iter().filter(|p| p.truncated).count() >= 4);
        assert!(a.warnings.iter().any(|w| w.contains("не поместилось")));
    }

    #[test]
    fn pdf_cache_kept_when_newer() {
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("files/cv.pdf");
        write(&pdf, "not a real pdf");
        // A hand-written extraction newer than the PDF wins; the broken PDF is never parsed.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&pdf_cache(&pdf), "Исправленный текст резюме");
        assert_eq!(pdf_text(&pdf).unwrap(), "Исправленный текст резюме");
        std::fs::remove_file(pdf_cache(&pdf)).unwrap();
        assert!(pdf_text(&pdf).is_err());
    }

    #[test]
    fn folder_of_call() {
        assert_eq!(folder_of(Path::new("/d/folders/x/calls/c")), Some(Path::new("/d/folders/x")));
        assert_eq!(folder_of(Path::new("/d/elsewhere/c")), None);
    }
}
