//! «Досье»: a short brief of a large context for the quick tier.
//! The full tier reads the whole context from its cached system prompt; the quick tier must answer
//! within a second, so it gets this brief instead. It is written once by the full model and kept in
//! `brief.md` next to the call, keyed by a hash of the context: the user may edit it, and the edit
//! stays until the materials change.

use std::path::Path;

pub const FILE: &str = "brief.md";

/// A smaller context goes to the quick tier as is: a brief would save little.
pub const MIN_TOKENS: u64 = 8_000;

pub const SYSTEM: &str = "You prepare a brief for an assistant that helps the user live during a call, often a job interview. \
The materials follow: <about_user> and documents about the user, the company, earlier calls and this call. \
Condense them into at most 4000 tokens of markdown, in the user's language ({user_language}), technical terms in English. Sections: \
the user's stack and level; each project as a short STAR story with the real numbers; strengths and weak spots; \
the role, the company and the people; likely questions with the best answer the materials support. \
Keep exact numbers, names and versions. Never add facts that are not in the materials. No preamble.";

/// FNV-1a of the context: stable across builds (std's hasher is not), enough to spot a change.
pub fn key(context: &str) -> String {
    let h = context.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

fn header(key: &str) -> String {
    format!("<!-- source: {key} -->")
}

/// The stored brief, if it was made from this very context.
pub fn cached(dir: &Path, key: &str) -> Option<String> {
    let s = std::fs::read_to_string(dir.join(FILE)).ok()?;
    let (first, body) = s.split_once('\n')?;
    (first.trim() == header(key) && !body.trim().is_empty()).then(|| body.trim().to_string())
}

pub fn store(dir: &Path, key: &str, body: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(FILE), format!("{}\n{}\n", header(key), body.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_while_the_context_is_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let k = key("context v1");
        assert!(cached(dir.path(), &k).is_none());
        store(dir.path(), &k, "## Стек\nGo, Kubernetes").unwrap();
        assert_eq!(cached(dir.path(), &k).as_deref(), Some("## Стек\nGo, Kubernetes"));
        // A hand edit keeps the header: still valid.
        let edited = std::fs::read_to_string(dir.path().join(FILE)).unwrap().replace("Go,", "Go 1.23,");
        std::fs::write(dir.path().join(FILE), edited).unwrap();
        assert_eq!(cached(dir.path(), &k).as_deref(), Some("## Стек\nGo 1.23, Kubernetes"));
        // New materials: rebuilt.
        assert!(cached(dir.path(), &key("context v2")).is_none());
        assert_ne!(key("a"), key("b"));
    }
}
