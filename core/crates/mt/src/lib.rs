//! Local machine translation: Opus-MT (Marian) through ONNX Runtime on the CPU.
//! No network and no tokens; the GPU stays with whisper. The model directory holds the
//! Hugging Face ONNX export (`Xenova/opus-mt-en-ru`): `tokenizer.json`, `config.json` and
//! `onnx/{encoder,decoder}_model_quantized.onnx`.

use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use ort::environment::Environment;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use tokenizers::Tokenizer;

/// Files of a model directory, relative to it: what a download must fetch.
pub const FILES: [&str; 4] = ["config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_quantized.onnx"];

/// Longest output of one sentence, in tokens.
const MAX_OUT: usize = 256;

pub struct Translator {
    encoder: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    /// First decoder token (Marian starts from the pad token).
    start: i64,
    eos: i64,
    pad: i64,
}

impl Translator {
    /// `env`: the process's ONNX Runtime environment (`vad::env()`), shared rather than built twice.
    pub fn load(env: &Environment, dir: &Path) -> Result<Translator> {
        for f in FILES {
            if !dir.join(f).is_file() {
                bail!("нет файла {}", dir.join(f).display());
            }
        }
        let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json"))?)?;
        let id = |k: &str| cfg[k].as_i64().ok_or_else(|| anyhow!("config.json: no {k}"));
        let tokenizer = tokenizer(&std::fs::read_to_string(dir.join("tokenizer.json"))?)?;
        Ok(Translator {
            encoder: session(env, &dir.join(FILES[2]))?,
            decoder: session(env, &dir.join(FILES[3]))?,
            tokenizer,
            start: id("decoder_start_token_id")?,
            eos: id("eos_token_id")?,
            pad: id("pad_token_id")?,
        })
    }

    /// Translates `text` sentence by sentence: Marian degrades on long multi-sentence input.
    pub fn translate(&mut self, text: &str) -> Result<String> {
        let mut out = Vec::new();
        for s in sentences(text) {
            out.push(self.sentence(s)?);
        }
        Ok(out.join(" "))
    }

    fn sentence(&mut self, text: &str) -> Result<String> {
        let enc = self.tokenizer.encode(text, true).map_err(|e| anyhow!("tokenize: {e}"))?;
        let src: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        let n = src.len();
        let mask = vec![1i64; n];
        let hidden = {
            let outs = self.encoder.run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, n], src.clone()))?,
                "attention_mask" => Tensor::from_array(([1usize, n], mask.clone()))?,
            ])?;
            let (shape, h) = outs["last_hidden_state"].try_extract_tensor::<f32>()?;
            (shape.iter().map(|&d| d as usize).collect::<Vec<_>>(), h.to_vec())
        };
        // shortcut: no KV cache, the decoder reruns on the whole prefix (O(n²)); fine for spoken sentences,
        // switch to decoder_model_merged with past_key_values if lines run long.
        let mut ids = vec![self.start];
        let limit = (3 * n).clamp(8, MAX_OUT);
        while ids.len() <= limit {
            let outs = self.decoder.run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, ids.len()], ids.clone()))?,
                "encoder_hidden_states" => Tensor::from_array((hidden.0.clone(), hidden.1.clone()))?,
                "encoder_attention_mask" => Tensor::from_array(([1usize, n], mask.clone()))?,
            ])?;
            let (shape, logits) = outs["logits"].try_extract_tensor::<f32>()?;
            let vocab = shape[2] as usize;
            let last = &logits[logits.len() - vocab..];
            let next = argmax(last, self.pad as usize) as i64;
            if next == self.eos {
                break;
            }
            ids.push(next);
        }
        let ids: Vec<u32> = ids[1..].iter().map(|&i| i as u32).collect();
        self.tokenizer.decode(&ids, true).map_err(|e| anyhow!("detokenize: {e}"))
    }
}

/// The export writes `{"type": "Precompiled", "precompiled_charsmap": null}`, which the Rust crate
/// cannot parse; without a charsmap that normalizer does nothing, so it is dropped.
fn tokenizer(json: &str) -> Result<Tokenizer> {
    let mut v: serde_json::Value = serde_json::from_str(json)?;
    if v["normalizer"]["type"] == "Precompiled" && v["normalizer"]["precompiled_charsmap"].is_null() {
        v["normalizer"] = serde_json::Value::Null;
    }
    v.to_string().parse().map_err(|e| anyhow!("tokenizer.json: {e}"))
}

fn session(env: &Environment, model: &Path) -> Result<Session> {
    let e = |e: ort::Error<ort::session::builder::SessionBuilder>| anyhow!("ort session builder: {e}");
    // Four of the 12 threads: whisper runs on the GPU, the VAD needs one.
    Session::builder(env)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(e)?
        .with_intra_threads(4)
        .map_err(e)?
        .commit_from_file(model)
        .with_context(|| format!("load {}", model.display()))
}

/// Index of the largest logit, never `banned` (the pad token Marian must not emit).
fn argmax(logits: &[f32], banned: usize) -> usize {
    logits.iter().enumerate().filter(|(i, _)| *i != banned).max_by(|a, b| a.1.total_cmp(b.1)).map_or(0, |(i, _)| i)
}

/// Sentences of `text`: split after `.`, `?`, `!` followed by a space. Empty pieces dropped.
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    for i in 0..b.len() {
        if matches!(b[i], b'.' | b'?' | b'!') && b.get(i + 1) == Some(&b' ') {
            out.push(text[start..=i].trim());
            start = i + 1;
        }
    }
    out.push(text[start..].trim());
    out.retain(|s| !s.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_sentences() {
        assert_eq!(sentences("Hi there. How are you? Fine!"), ["Hi there.", "How are you?", "Fine!"]);
        assert_eq!(sentences("Version 1.5 works"), ["Version 1.5 works"]);
        assert!(sentences("  ").is_empty());
    }

    #[test]
    fn argmax_skips_banned() {
        assert_eq!(argmax(&[0.1, 5.0, 0.3], 1), 2);
        assert_eq!(argmax(&[0.1, 5.0, 0.3], 9), 1);
    }

    /// Needs the model in `models/opus-mt-en-ru` (Settings → «Ответы» → «Скачать»).
    #[test]
    #[ignore]
    fn translates_with_the_real_model() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../models/opus-mt-en-ru");
        let env = ort::init().with_name("mt-test").build().unwrap();
        let mut t = Translator::load(&env, &dir).unwrap();
        t.translate("Warm up.").unwrap();
        for text in ["How did you scale the service?", "Tell me about a time you disagreed with your team. What did you do?"] {
            let started = std::time::Instant::now();
            let ru = t.translate(text).unwrap();
            println!("{} ms: {text} -> {ru}", started.elapsed().as_millis());
            assert!(ru.chars().any(|c| ('а'..='я').contains(&c.to_lowercase().next().unwrap())), "{ru}");
        }
    }
}
