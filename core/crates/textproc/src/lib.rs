//! Static transcript cleanup: pure functions, no I/O. Applied to every STT result
//! before it reaches the UI or the LLM prompt (fewer tokens, fewer false triggers).

/// Whisper hallucinations on noise/silence (subtitle credits from its training data),
/// compared after normalization. Exact-match phrases:
const HALLUCINATIONS: &[&str] = &[
    "продолжение следует",
    "спасибо за просмотр",
    "thank you for watching",
    "thanks for watching",
    "you",
];
/// Substrings that never occur in real call speech but do in whisper credits.
const HALLUCINATION_MARKERS: &[&str] = &["dimatorzok", "редактор субтитров", "субтитры сделал", "субтитры создавал", "корректор а егорова"];

/// Pure hesitation sounds. Words with meaning ("ну", "типа", "like") are kept: removing them can change the sense.
const DISFLUENCIES: &[&str] = &["э", "ээ", "эээ", "эм", "эмм", "м", "мм", "ммм", "хм", "uh", "uhh", "um", "umm", "erm", "hmm", "mm", "mhm"];

/// Lowercase, punctuation to spaces, collapsed whitespace.
pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn is_hallucination(text: &str) -> bool {
    let n = normalize(text);
    n.is_empty() || HALLUCINATIONS.contains(&n.as_str()) || HALLUCINATION_MARKERS.iter().any(|m| n.contains(m))
}

fn word_key(w: &str) -> String {
    w.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Drops standalone hesitation tokens ("э,", "um...") and fixes the spacing left behind.
pub fn strip_disfluencies(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().filter(|w| !DISFLUENCIES.contains(&word_key(w).as_str())).collect();
    let mut out = words.join(" ");
    // "Э, как это работает" -> ", как это работает" is not possible: punctuation goes with the dropped token.
    if let Some(c) = out.chars().next() {
        if c.is_lowercase() && text.trim_start().chars().next().is_some_and(char::is_uppercase) {
            out = c.to_uppercase().chain(out.chars().skip(1)).collect();
        }
    }
    out
}

/// Collapses a word n-gram (1..=8 words) repeated 3+ times in a row to one occurrence:
/// whisper's decoder loops ("да да да да да", "и потом и потом и потом и потом").
/// Two repeats stay: people do say "да, да".
pub fn collapse_repeats(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let keys: Vec<String> = words.iter().map(|w| word_key(w)).collect();
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0;
    'outer: while i < words.len() {
        for n in 1..=8.min((words.len() - i) / 3) {
            let same = |a: usize, b: usize| (0..n).all(|k| !keys[a + k].is_empty() && keys[a + k] == keys[b + k]);
            let mut reps = 1;
            while i + (reps + 1) * n <= words.len() && same(i, i + reps * n) {
                reps += 1;
            }
            if reps >= 3 {
                // Keep the last copy: it carries the final punctuation.
                out.extend_from_slice(&words[i + (reps - 1) * n..i + reps * n]);
                i += reps * n;
                continue 'outer;
            }
        }
        out.push(words[i]);
        i += 1;
    }
    out.join(" ")
}

/// Rewrites words that match a glossary term case-insensitively to the glossary spelling
/// ("postgresql" -> "PostgreSQL"). Multi-word terms are matched as a whole.
pub fn apply_glossary(text: &str, glossary: &[String]) -> String {
    if glossary.is_empty() {
        return text.to_string();
    }
    let terms: Vec<(Vec<String>, Vec<&str>)> = glossary
        .iter()
        .map(|t| (t.split_whitespace().map(word_key).collect::<Vec<_>>(), t.split_whitespace().collect::<Vec<_>>()))
        .filter(|(k, _)| !k.is_empty() && k.iter().all(|w| !w.is_empty()))
        .collect();
    let words: Vec<&str> = text.split_whitespace().collect();
    let keys: Vec<String> = words.iter().map(|w| word_key(w)).collect();
    let mut out: Vec<String> = Vec::with_capacity(words.len());
    let mut i = 0;
    'outer: while i < words.len() {
        for (tk, tw) in &terms {
            if i + tk.len() <= words.len() && keys[i..i + tk.len()] == tk[..] {
                for (j, canon) in tw.iter().enumerate() {
                    out.push(replace_core(words[i + j], canon));
                }
                i += tk.len();
                continue 'outer;
            }
        }
        out.push(words[i].to_string());
        i += 1;
    }
    out.join(" ")
}

/// Replaces the alphanumeric core of `word` with the core of `canon`, keeping surrounding punctuation.
fn replace_core(word: &str, canon: &str) -> String {
    let start = word.find(|c: char| c.is_alphanumeric()).unwrap_or(0);
    let end = word.rfind(|c: char| c.is_alphanumeric()).map_or(word.len(), |i| i + word[i..].chars().next().unwrap().len_utf8());
    let canon_core: String = canon.chars().filter(|c| c.is_alphanumeric()).collect();
    // Only a pure case/punctuation difference is rewritten; this keeps "c++" and similar intact.
    if word[start..end].chars().filter(|c| c.is_alphanumeric()).count() != canon_core.chars().count() {
        return word.to_string();
    }
    format!("{}{}{}", &word[..start], canon.trim_matches(|c: char| !c.is_alphanumeric()), &word[end..])
}

/// Full cleanup pipeline for one STT result. Returns None when nothing meaningful is left.
pub fn clean(text: &str, glossary: &[String]) -> Option<String> {
    if is_hallucination(text) {
        return None;
    }
    let t = apply_glossary(&collapse_repeats(&strip_disfluencies(text)), glossary);
    if normalize(&t).is_empty() { None } else { Some(t) }
}

/// Share of `me`'s words found in `them` (0..1). Mic echo of the speakers reproduces
/// the other side's words, so a high value means `me` is an echo, not our own speech.
pub fn echo_overlap(me: &str, them: &str) -> f32 {
    let me_words: Vec<String> = normalize(me).split_whitespace().map(String::from).collect();
    if me_words.is_empty() {
        return 0.0;
    }
    let them_n = normalize(them);
    let them_words: std::collections::HashSet<&str> = them_n.split_whitespace().collect();
    me_words.iter().filter(|w| them_words.contains(w.as_str())).count() as f32 / me_words.len() as f32
}

/// True when `me` looks like an echo of `them`. Needs 3+ words: "да" or "хорошо" overlap by chance.
pub fn is_echo(me: &str, them: &str) -> bool {
    normalize(me).split_whitespace().count() >= 3 && echo_overlap(me, them) > 0.6
}

/// LocalAgreement-2 for live text: splits the current hypothesis `cur` into the word prefix the
/// previous hypothesis `prev` agrees with (stable, shown as settled) and the rest (may still change).
/// Words compare by [`word_key`], so "Go" and "Go?" agree.
pub fn split_stable(prev: &str, cur: &str) -> (String, String) {
    let prev: Vec<String> = prev.split_whitespace().map(word_key).collect();
    let words: Vec<&str> = cur.split_whitespace().collect();
    let n = words.iter().zip(&prev).take_while(|(w, k)| !k.is_empty() && word_key(w) == **k).count();
    (words[..n].join(" "), words[n..].join(" "))
}

/// Words that open a question or a request to talk ("Расскажите о себе.", "Walk me through...").
const QUESTION_STARTS: &[&str] = &[
    "как", "что", "почему", "зачем", "когда", "где", "куда", "откуда", "какой", "какая", "какое", "какие", "каким", "какого", "каком",
    "какую", "сколько", "кто", "чем", "чего", "чему", "расскажите", "расскажи", "объясните", "объясни", "опишите", "опиши",
    "приведите", "назовите", "перечислите", "сравните", "можете", "можешь", "могли", "правда", "а как", "а что", "а почему",
    "what", "why", "how", "when", "where", "which", "who", "whose", "can you", "could you", "would you", "will you", "do you",
    "did you", "have you", "are you", "is there", "is it", "tell me", "explain", "describe", "walk me", "give me",
];

/// Heuristic: does this "them" speech ask the user something? Whisper writes "?" for most
/// questions; requests ("Расскажите о себе.") are caught by their first words.
pub fn is_question(text: &str) -> bool {
    if text.trim_end().ends_with('?') {
        return true;
    }
    text.split(['.', '!', '?', ';'])
        .map(normalize)
        .filter(|s| !s.is_empty())
        .any(|s| QUESTION_STARTS.iter().any(|q| s == *q || s.starts_with(&format!("{q} "))) || s.contains(" ли "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hallucination_filter() {
        assert!(is_hallucination("Продолжение следует..."));
        assert!(is_hallucination("  "));
        assert!(is_hallucination("Thank you for watching!"));
        assert!(!is_hallucination("Продолжение следует обсуждать завтра"));
        assert!(is_hallucination("Редактор субтитров А.Семкин Корректор А.Егорова"));
        assert!(is_hallucination("Субтитры сделал DimaTorzok"));
    }

    #[test]
    fn disfluencies() {
        assert_eq!(strip_disfluencies("Э, как это работает?"), "Как это работает?");
        assert_eq!(strip_disfluencies("So, um, what is a mutex?"), "So, what is a mutex?");
        assert_eq!(strip_disfluencies("Ну, типа, это кэш"), "Ну, типа, это кэш");
        assert_eq!(strip_disfluencies("Эмм"), "");
    }

    #[test]
    fn repeats() {
        assert_eq!(collapse_repeats("да да да да да"), "да");
        assert_eq!(collapse_repeats("да, да"), "да, да");
        assert_eq!(collapse_repeats("и потом и потом и потом и потом всё"), "и потом всё");
        assert_eq!(collapse_repeats("Это очень очень очень важно."), "Это очень важно.");
        assert_eq!(collapse_repeats("one two three"), "one two three");
    }

    #[test]
    fn glossary() {
        let g = vec!["PostgreSQL".to_string(), "Kubernetes".to_string(), "Spring Boot".to_string()];
        assert_eq!(apply_glossary("а postgresql, или kubernetes?", &g), "а PostgreSQL, или Kubernetes?");
        assert_eq!(apply_glossary("на spring boot.", &g), "на Spring Boot.");
        assert_eq!(apply_glossary("на spring.", &g), "на spring.");
    }

    #[test]
    fn pipeline() {
        let g = vec!["Java".to_string()];
        assert_eq!(clean("Э, расскажите про java java java.", &g).as_deref(), Some("Расскажите про Java."));
        assert_eq!(clean("Продолжение следует...", &g), None);
        assert_eq!(clean("эм", &g), None);
    }

    #[test]
    fn questions() {
        assert!(is_question("Почему вы решили сменить работу?"));
        assert!(is_question("Расскажите о себе."));
        assert!(is_question("Хорошо. А как вы деплоили сервисы"));
        assert!(is_question("Tell me about your last project."));
        assert!(is_question("Знаете ли вы Rust"));
        assert!(!is_question("Хорошо, спасибо."));
        assert!(!is_question("Мы используем Kubernetes в продакшене."));
        assert!(!is_question("Somewhat interesting."));
    }

    #[test]
    fn stable_split() {
        assert_eq!(split_stable("", "как работает"), (String::new(), "как работает".into()));
        assert_eq!(split_stable("Как работает сбор", "Как работает сборщик мусора?"), ("Как работает".into(), "сборщик мусора?".into()));
        assert_eq!(split_stable("Почему Go", "Почему Go?"), ("Почему Go?".into(), String::new()));
        assert_eq!(split_stable("Какой у вас", "А какой у вас"), (String::new(), "А какой у вас".into()));
    }

    #[test]
    fn echo() {
        assert!(is_echo("расскажите про сборщик мусора", "Расскажите про сборщик мусора в Java?"));
        assert!(!is_echo("да", "да, конечно"));
        assert!(!is_echo("я работал с кафкой три года", "Расскажите про сборщик мусора в Java?"));
    }
}
