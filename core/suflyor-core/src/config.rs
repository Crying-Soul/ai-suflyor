use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use protocol::AnswerMode;
use serde::{Deserialize, Serialize};

/// Shared config.json (the UI reads its own keys from the same file). camelCase keys.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub anthropic_api_key: String,
    pub model: String,
    pub alt_model: String,
    pub quick_model: String,
    pub effort: String,
    pub language: String,
    /// The user's own language (ISO 639-1): hint bullets, glosses and translations are in it.
    pub user_language: String,
    /// Translate the other side's speech into `user_language` from the start.
    pub translate: bool,
    pub user_context: String,
    pub auto_detect: bool,
    pub answer_mode: AnswerMode,
    pub two_tier: bool,
    pub llm: LlmConfig,
    pub claude_code: ClaudeCodeConfig,
    pub audio: AudioConfig,
    pub vad: VadConfig,
    pub stt: SttConfig,
    /// Terms passed to whisper as initial prompt (spelling hints: Kubernetes, PostgreSQL...).
    pub glossary: Vec<String>,
    pub debug: DebugConfig,
    /// Profile, call folders and their transcripts. Empty = `Documents\Suflyor` in the user's home.
    pub data_dir: String,
    /// Directory relative paths resolve against (the config file's directory).
    #[serde(skip)]
    pub base_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VadConfig {
    pub model: String,
    pub threshold: f32,
    pub neg_threshold: f32,
    pub min_silence_ms: u32,
    pub pre_roll_ms: u32,
    pub min_speech_ms: u32,
    pub max_utterance_ms: u32,
    /// Silence after which the final is decoded speculatively (0 = off); reused if speech does not resume.
    pub early_silence_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            model: "models/silero_vad.onnx".into(),
            threshold: 0.5,
            neg_threshold: 0.35,
            // 300 ms splits phrases at commas and whisper loses context; 500 ms keeps them whole.
            min_silence_ms: 500,
            pre_roll_ms: 300,
            min_speech_ms: 250,
            max_utterance_ms: 20_000,
            early_silence_ms: 250,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SttConfig {
    pub dll: String,
    pub model: String,
    /// The CUDA backend downloaded in Settings (ggml-cuda.dll, cudart, cublas). Unused when
    /// whisper.dll has ggml-cuda.dll next to it.
    pub cuda_dir: String,
    pub use_gpu: bool,
    pub gpu_device: i32,
    pub flash_attn: bool,
    pub threads: i32,
    pub beam_size: i32,
    pub temperature_inc: f32,
    pub no_speech_thold: f32,
    /// 0 = full context (best quality). Smaller is faster but truncates audio longer than ctx/50 s.
    pub audio_ctx: i32,
    /// Live partial text: re-decode the utterance in progress every N ms of new speech (0 = off).
    pub partial_ms: u32,
    pub verbose: bool,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            dll: "whisper/whisper.dll".into(),
            model: "whisper/ggml-large-v3-turbo.bin".into(),
            cuda_dir: "cuda".into(),
            use_gpu: true,
            gpu_device: 0,
            flash_attn: true,
            threads: 4,
            beam_size: 1,
            temperature_inc: 0.2,
            no_speech_thold: 0.6,
            audio_ctx: 0,
            partial_ms: 700,
            verbose: false,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LlmConfig {
    pub backend: Backend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    /// Messages API with `anthropicApiKey`.
    #[default]
    Api,
    /// Local `claude -p` with the user's own login.
    ClaudeCode,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeCodeConfig {
    /// argv prefix that starts Claude Code, e.g. ["claude"] or ["wsl.exe", "-e", "/path/to/claude"].
    pub command: Vec<String>,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        Self { command: vec!["claude".into()] }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioConfig {
    /// Substring of the capture device name; empty = default device.
    pub mic_device: String,
    /// "system" or "process:<exe name>", e.g. "process:chrome.exe".
    pub them_source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DebugConfig {
    /// Write 16 kHz WAV of both streams to `recordDir`.
    pub record_wav: bool,
    pub record_dir: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            anthropic_api_key: String::new(),
            model: "claude-sonnet-5-5".into(),
            alt_model: "claude-opus-5-5".into(),
            quick_model: "claude-haiku-5-5".into(),
            effort: "low".into(),
            language: "auto".into(),
            user_language: "ru".into(),
            translate: false,
            user_context: String::new(),
            auto_detect: true,
            answer_mode: AnswerMode::Confirmed,
            two_tier: true,
            llm: LlmConfig::default(),
            claude_code: ClaudeCodeConfig::default(),
            audio: AudioConfig::default(),
            vad: VadConfig::default(),
            stt: SttConfig::default(),
            glossary: Vec::new(),
            debug: DebugConfig::default(),
            data_dir: String::new(),
            base_dir: PathBuf::new(),
        }
    }
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self { mic_device: String::new(), them_source: "system".into() }
    }
}

impl Default for DebugConfig {
    fn default() -> Self {
        Self { record_wav: false, record_dir: "recordings".into() }
    }
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<(Config, Option<PathBuf>)> {
        let candidates: Vec<PathBuf> = match path {
            Some(p) => vec![p.to_path_buf()],
            None => {
                let mut v = vec![PathBuf::from("config.json")];
                if let Ok(exe) = std::env::current_exe()
                    && let Some(dir) = exe.parent()
                {
                    v.push(dir.join("config.json"));
                }
                v
            }
        };
        for p in candidates {
            if p.exists() {
                let raw = std::fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
                let mut cfg: Config = serde_json::from_str(&raw).with_context(|| format!("parse {}", p.display()))?;
                cfg.base_dir = std::path::absolute(&p)?.parent().map(Path::to_path_buf).unwrap_or_default();
                cfg.fill_data_dir();
                return Ok((cfg, Some(p)));
            }
        }
        let mut cfg = Config { base_dir: std::env::current_dir()?, ..Config::default() };
        cfg.fill_data_dir();
        Ok((cfg, None))
    }

    fn fill_data_dir(&mut self) {
        if self.data_dir.trim().is_empty() {
            let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
            self.data_dir = home.join("Documents").join("Suflyor").display().to_string();
        }
    }

    pub fn profile_dir(&self) -> PathBuf {
        self.path(&self.data_dir).join("profile")
    }

    /// Resolves a config path relative to the config file's directory.
    pub fn path(&self, p: &str) -> PathBuf {
        let p = Path::new(p);
        if p.is_absolute() {
            return p.to_path_buf();
        }
        let here = self.base_dir.join(p);
        if here.exists() {
            return here;
        }
        // Installed: config.json lives in %APPDATA%, the bundled whisper/ and models/ next to the exe.
        let bundled = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join(p)));
        bundled.filter(|b| b.exists()).unwrap_or(here)
    }
}
