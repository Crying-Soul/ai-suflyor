//! Silero VAD (ONNX Runtime) and a speech segmenter that turns a 16 kHz stream
//! into utterances.

mod segmenter;

pub use segmenter::{Segmenter, SegmenterConfig, Utterance, VadEvent};

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Context, Result, anyhow};
use ort::environment::Environment;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use tracing::info;

/// Samples per VAD window at 16 kHz (32 ms), fixed by the Silero model.
pub const WINDOW: usize = 512;
/// Silero v5+ expects the last 64 samples of the previous window prepended.
const CONTEXT: usize = 64;
const STATE_LEN: usize = 2 * 1 * 128;

/// The process-wide ONNX Runtime environment; other ONNX models (translation) share it.
pub fn env() -> Result<&'static Environment> {
    static ENV: OnceLock<Environment> = OnceLock::new();
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let e = ort::init().with_name("call-core").build().map_err(|e| anyhow!("ort init: {e}"))?;
    Ok(ENV.get_or_init(|| e))
}

pub struct Silero {
    session: Session,
    state: Vec<f32>,
    context: [f32; CONTEXT],
    input: Vec<f32>,
}

impl Silero {
    pub fn new(model: &Path) -> Result<Silero> {
        let e = |e: ort::Error<ort::session::builder::SessionBuilder>| anyhow!("ort session builder: {e}");
        let session = Session::builder(env()?)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(e)?
            .with_intra_threads(1)
            .map_err(e)?
            .with_inter_threads(1)
            .map_err(e)?
            .commit_from_file(model)
            .with_context(|| format!("load VAD model {}", model.display()))?;
        let names: Vec<&str> = session.inputs().iter().map(|o| o.name()).collect();
        info!("silero inputs: {names:?}");
        Ok(Silero { session, state: vec![0.0; STATE_LEN], context: [0.0; CONTEXT], input: Vec::with_capacity(CONTEXT + WINDOW) })
    }

    pub fn reset(&mut self) {
        self.state.iter_mut().for_each(|s| *s = 0.0);
        self.context = [0.0; CONTEXT];
    }

    /// Speech probability for one 512-sample window.
    pub fn prob(&mut self, window: &[f32]) -> Result<f32> {
        debug_assert_eq!(window.len(), WINDOW);
        self.input.clear();
        self.input.extend_from_slice(&self.context);
        self.input.extend_from_slice(window);
        self.context.copy_from_slice(&window[WINDOW - CONTEXT..]);

        let input = Tensor::from_array(([1usize, CONTEXT + WINDOW], self.input.clone()))?;
        let state = Tensor::from_array(([2usize, 1, 128], std::mem::take(&mut self.state)))?;
        let sr = Tensor::from_array(([1usize], vec![16000i64]))?;
        let outputs = self.session.run(ort::inputs!["input" => input, "state" => state, "sr" => sr])?;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>()?;
        let (_, new_state) = outputs[1].try_extract_tensor::<f32>()?;
        let p = prob[0];
        self.state = new_state.to_vec();
        Ok(p)
    }
}
