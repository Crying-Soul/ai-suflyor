//! whisper.cpp speech-to-text via the prebuilt whisper.dll (CUDA build), through
//! a small C shim (`native/shim.c`) compiled against the matching headers.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicI32;

use anyhow::{Result, anyhow, bail};
use tracing::info;

#[repr(C)]
struct WsOpts {
    language: *const c_char,
    initial_prompt: *const c_char,
    n_threads: c_int,
    beam_size: c_int,
    single_segment: c_int,
    no_timestamps: c_int,
    temperature_inc: f32,
    no_speech_thold: f32,
    audio_ctx: c_int,
    abort_flag: *const AtomicI32,
    timeout_ms: u32,
}

/// `ws_full` return code when `timeout_ms` expired.
const WS_TIMED_OUT: c_int = -1000;

unsafe extern "C" {
    fn ws_load(dll_path: *const u16, cuda_dll: *const u16, verbose: c_int, err: *mut c_char, errlen: c_int) -> c_int;
    fn ws_system_info() -> *const c_char;
    fn ws_init(model: *const c_char, use_gpu: c_int, gpu_device: c_int, flash_attn: c_int) -> *mut c_void;
    fn ws_state_new(ctx: *mut c_void) -> *mut c_void;
    fn ws_state_free(state: *mut c_void);
    fn ws_free(ctx: *mut c_void);
    fn ws_full(ctx: *mut c_void, state: *mut c_void, samples: *const f32, n: c_int, o: *const WsOpts) -> c_int;
    fn ws_n_segments(state: *mut c_void) -> c_int;
    fn ws_segment_text(state: *mut c_void, i: c_int) -> *const c_char;
    fn ws_segment_no_speech(state: *mut c_void, i: c_int) -> f32;
    fn ws_segment_avg_logprob(ctx: *mut c_void, state: *mut c_void, i: c_int) -> f32;
    fn ws_lang(state: *mut c_void) -> *const c_char;
}

#[derive(Debug, Clone)]
pub struct ModelOptions {
    /// A CUDA backend (ggml-cuda.dll with its runtime) outside the whisper.dll directory.
    pub cuda_dll: Option<std::path::PathBuf>,
    pub use_gpu: bool,
    pub gpu_device: i32,
    pub flash_attn: bool,
    pub verbose: bool,
}

#[derive(Debug, Clone)]
pub struct DecodeOptions {
    /// None or "auto" = detect.
    pub language: Option<String>,
    pub initial_prompt: Option<String>,
    pub threads: i32,
    /// ≤ 1 = greedy.
    pub beam_size: i32,
    pub single_segment: bool,
    pub no_timestamps: bool,
    /// 0 disables temperature fallback (re-decodes on low confidence).
    pub temperature_inc: f32,
    pub no_speech_thold: f32,
    /// 0 = full 30 s encoder context; smaller is faster for short audio but may hurt accuracy.
    pub audio_ctx: i32,
    /// Abort the decode after this long (0 = no limit). Temperature fallback can loop for seconds on noise.
    pub timeout_ms: u32,
}

impl Default for DecodeOptions {
    fn default() -> Self {
        Self {
            language: None,
            initial_prompt: None,
            threads: 4,
            beam_size: 1,
            single_segment: false,
            no_timestamps: true,
            temperature_inc: 0.2,
            no_speech_thold: 0.6,
            audio_ctx: 0,
            timeout_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub text: String,
    pub no_speech_prob: f32,
    pub avg_logprob: f32,
}

#[derive(Debug, Clone)]
pub struct Transcription {
    pub segments: Vec<Segment>,
    pub language: String,
}

impl Transcription {
    pub fn text(&self) -> String {
        self.segments.iter().map(|s| s.text.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

/// Loaded model. Shared by all decoding states (one state per concurrent stream).
pub struct Whisper {
    ctx: *mut c_void,
}

// SAFETY: the whisper context holds immutable model weights; per-decode mutable
// data lives in whisper_state, which is used by one thread at a time.
unsafe impl Send for Whisper {}
unsafe impl Sync for Whisper {}

impl Drop for Whisper {
    fn drop(&mut self) {
        unsafe { ws_free(self.ctx) };
    }
}

impl Whisper {
    /// `dll`: path to whisper.dll; ggml*.dll and the CUDA runtime must sit next to it.
    pub fn load(dll: &Path, model: &Path, opts: &ModelOptions) -> Result<Arc<Whisper>> {
        if !dll.exists() {
            bail!("whisper.dll not found: {}", dll.display());
        }
        if !model.exists() {
            bail!("whisper model not found: {}", model.display());
        }
        // LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR requires an absolute path.
        let dll = std::path::absolute(dll)?;
        let model = std::path::absolute(model)?;
        let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
        let cuda = opts.cuda_dll.as_deref().map(|p| std::path::absolute(p).map(|p| wide(&p))).transpose()?;
        let dll_w = wide(&dll);
        let mut err = [0 as c_char; 256];
        let rc = unsafe {
            ws_load(dll_w.as_ptr(), cuda.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()), opts.verbose as c_int, err.as_mut_ptr(), err.len() as c_int)
        };
        if rc != 0 {
            let msg = unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned();
            bail!("load {}: {msg}", dll.display());
        }
        info!("whisper system info: {}", unsafe { CStr::from_ptr(ws_system_info()) }.to_string_lossy());
        let model_c = CString::new(model.to_string_lossy().as_bytes())?;
        let ctx = unsafe { ws_init(model_c.as_ptr(), opts.use_gpu as c_int, opts.gpu_device, opts.flash_attn as c_int) };
        if ctx.is_null() {
            bail!("whisper_init_from_file failed for {}", model.display());
        }
        Ok(Arc::new(Whisper { ctx }))
    }

    pub fn new_state(self: &Arc<Self>) -> Result<State> {
        let st = unsafe { ws_state_new(self.ctx) };
        if st.is_null() {
            bail!("whisper_init_state failed (out of GPU memory?)");
        }
        Ok(State { model: self.clone(), st })
    }
}

/// Decoding state (KV cache, mel buffers). One per stream.
pub struct State {
    model: Arc<Whisper>,
    st: *mut c_void,
}

// SAFETY: a state is only used through &mut self, i.e. by one thread at a time.
unsafe impl Send for State {}

impl Drop for State {
    fn drop(&mut self) {
        unsafe { ws_state_free(self.st) };
    }
}

impl State {
    /// Transcribes 16 kHz mono f32 audio. `abort` (non-zero) cancels the decode.
    pub fn transcribe(&mut self, samples: &[f32], o: &DecodeOptions, abort: Option<&AtomicI32>) -> Result<Transcription> {
        let lang = o.language.as_deref().map(CString::new).transpose()?;
        let prompt = o.initial_prompt.as_deref().filter(|p| !p.is_empty()).map(CString::new).transpose()?;
        let opts = WsOpts {
            language: lang.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            initial_prompt: prompt.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            n_threads: o.threads,
            beam_size: o.beam_size,
            single_segment: o.single_segment as c_int,
            no_timestamps: o.no_timestamps as c_int,
            temperature_inc: o.temperature_inc,
            no_speech_thold: o.no_speech_thold,
            audio_ctx: o.audio_ctx,
            abort_flag: abort.map_or(std::ptr::null(), |a| a as *const AtomicI32),
            timeout_ms: o.timeout_ms,
        };
        let rc = unsafe { ws_full(self.model.ctx, self.st, samples.as_ptr(), samples.len() as c_int, &opts) };
        if rc == WS_TIMED_OUT {
            bail!("whisper_full timed out after {} ms", o.timeout_ms);
        }
        if rc != 0 {
            return Err(anyhow!("whisper_full failed or aborted (rc {rc})"));
        }
        let n = unsafe { ws_n_segments(self.st) };
        let mut segments = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let text = unsafe { CStr::from_ptr(ws_segment_text(self.st, i)) }.to_string_lossy().into_owned();
            segments.push(Segment {
                text,
                no_speech_prob: unsafe { ws_segment_no_speech(self.st, i) },
                avg_logprob: unsafe { ws_segment_avg_logprob(self.model.ctx, self.st, i) },
            });
        }
        let language = unsafe { CStr::from_ptr(ws_lang(self.st)) }.to_string_lossy().into_owned();
        Ok(Transcription { segments, language })
    }
}
