//! Hysteresis segmenter over per-window speech probabilities. Pure logic, no I/O.

use std::collections::VecDeque;

use crate::WINDOW;

#[derive(Debug, Clone)]
pub struct SegmenterConfig {
    /// Probability above which a window counts as speech.
    pub threshold: f32,
    /// Probability below which a window counts as silence (hysteresis).
    pub neg_threshold: f32,
    /// Silence that ends an utterance.
    pub min_silence_ms: u32,
    /// Audio kept before the speech onset.
    pub pre_roll_ms: u32,
    /// Utterances with less speech than this are dropped (clicks, coughs).
    pub min_speech_ms: u32,
    /// Force a cut after this long (whisper works on ≤ 30 s windows).
    pub max_utterance_ms: u32,
    /// Trailing silence kept after the last speech window.
    pub post_pad_ms: u32,
    /// Silence after which a [`VadEvent::Pause`] snapshot is emitted so the final can be
    /// decoded speculatively (0 = off). Must be below `min_silence_ms` to have an effect.
    pub early_silence_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            neg_threshold: 0.35,
            min_silence_ms: 300,
            pre_roll_ms: 300,
            min_speech_ms: 250,
            max_utterance_ms: 20_000,
            post_pad_ms: 100,
            early_silence_ms: 0,
        }
    }
}

#[derive(Debug)]
pub struct Utterance {
    /// Stream sample index of the first sample.
    pub start_sample: u64,
    pub samples: Vec<f32>,
    /// Stream sample index just after the last speech window.
    pub speech_end_sample: u64,
    /// True when cut by `max_utterance_ms` rather than by silence.
    pub forced: bool,
}

#[derive(Debug)]
pub enum VadEvent {
    SpeechStart { start_sample: u64 },
    SpeechEnd(Utterance),
    /// `early_silence_ms` of silence: the utterance as it will be finalized if speech does not
    /// resume. A later `SpeechEnd` with the same `start_sample` and length carries the same samples.
    Pause(Utterance),
    /// Speech came back after a `Pause`: that snapshot is not the end of the utterance.
    Resume { start_sample: u64 },
    /// Speech ended but was too short to keep (cough, click).
    Discarded { start_sample: u64 },
}

fn ms_to_windows(ms: u32) -> usize {
    (ms as usize * 16).div_ceil(WINDOW)
}

pub struct Segmenter {
    cfg: SegmenterConfig,
    pending: Vec<f32>,
    /// Stream index of the next window start.
    pos: u64,
    pre_roll: VecDeque<Vec<f32>>,
    in_speech: bool,
    cur: Vec<f32>,
    cur_start: u64,
    speech_windows: usize,
    silence_windows: usize,
    /// Length of `cur` (samples) at the end of the last speech window.
    last_speech_len: usize,
    /// Length of `cur` at the most recent low-probability window (cut point for forced splits).
    last_pause_len: Option<usize>,
    /// A `Pause` was emitted and speech has not resumed since.
    paused: bool,
}

impl Segmenter {
    pub fn new(cfg: SegmenterConfig) -> Segmenter {
        Segmenter {
            cfg,
            pending: Vec::with_capacity(WINDOW),
            pos: 0,
            pre_roll: VecDeque::new(),
            in_speech: false,
            cur: Vec::new(),
            cur_start: 0,
            speech_windows: 0,
            silence_windows: 0,
            last_speech_len: 0,
            last_pause_len: None,
            paused: false,
        }
    }

    pub fn in_speech(&self) -> bool {
        self.in_speech
    }

    /// The utterance in progress: (start sample, audio so far). None outside speech.
    pub fn current(&self) -> Option<(u64, &[f32])> {
        self.in_speech.then_some((self.cur_start, self.cur.as_slice()))
    }

    /// Stream position (samples consumed into full windows).
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// Feeds samples; `prob` scores each 512-sample window.
    pub fn push<E>(
        &mut self,
        mut samples: &[f32],
        prob: &mut impl FnMut(&[f32]) -> Result<f32, E>,
        out: &mut Vec<VadEvent>,
    ) -> Result<(), E> {
        while !samples.is_empty() {
            let take = (WINDOW - self.pending.len()).min(samples.len());
            self.pending.extend_from_slice(&samples[..take]);
            samples = &samples[take..];
            if self.pending.len() == WINDOW {
                let window = std::mem::replace(&mut self.pending, Vec::with_capacity(WINDOW));
                let p = prob(&window)?;
                self.on_window(window, p, out);
                self.pos += WINDOW as u64;
            }
        }
        Ok(())
    }

    fn on_window(&mut self, w: Vec<f32>, p: f32, out: &mut Vec<VadEvent>) {
        if !self.in_speech {
            if p >= self.cfg.threshold {
                self.in_speech = true;
                self.cur.clear();
                let pre: usize = self.pre_roll.iter().map(|w| w.len()).sum();
                self.cur_start = self.pos - pre as u64;
                for pw in self.pre_roll.drain(..) {
                    self.cur.extend_from_slice(&pw);
                }
                self.cur.extend_from_slice(&w);
                self.speech_windows = 1;
                self.silence_windows = 0;
                self.last_speech_len = self.cur.len();
                self.last_pause_len = None;
                out.push(VadEvent::SpeechStart { start_sample: self.cur_start });
            } else {
                self.pre_roll.push_back(w);
                while self.pre_roll.len() > ms_to_windows(self.cfg.pre_roll_ms) {
                    self.pre_roll.pop_front();
                }
            }
            return;
        }

        self.cur.extend_from_slice(&w);
        if p >= self.cfg.threshold {
            self.speech_windows += 1;
            self.silence_windows = 0;
            self.last_speech_len = self.cur.len();
            if std::mem::take(&mut self.paused) {
                out.push(VadEvent::Resume { start_sample: self.cur_start });
            }
        } else if p < self.cfg.neg_threshold {
            self.silence_windows += 1;
            self.last_pause_len = Some(self.cur.len());
        }
        // Between the thresholds: neither speech nor silence (hysteresis).

        let early = ms_to_windows(self.cfg.early_silence_ms);
        if self.cfg.early_silence_ms > 0 && self.silence_windows == early && early < ms_to_windows(self.cfg.min_silence_ms) {
            if self.speech_windows >= ms_to_windows(self.cfg.min_speech_ms) {
                out.push(VadEvent::Pause(self.snapshot(false)));
                self.paused = true;
            }
        }
        if self.silence_windows >= ms_to_windows(self.cfg.min_silence_ms) {
            self.finish(false, out);
        } else if self.cur.len() >= self.cfg.max_utterance_ms as usize * 16 {
            if self.silence_windows > 0 {
                // Already trailing off: end normally instead of cutting.
                self.finish(false, out);
            } else {
                self.split_forced(out);
            }
        }
    }

    fn keep_len(&self) -> usize {
        (self.last_speech_len + self.cfg.post_pad_ms as usize * 16).min(self.cur.len())
    }

    fn snapshot(&self, forced: bool) -> Utterance {
        Utterance {
            start_sample: self.cur_start,
            speech_end_sample: self.cur_start + self.last_speech_len as u64,
            samples: self.cur[..self.keep_len()].to_vec(),
            forced,
        }
    }

    fn finish(&mut self, forced: bool, out: &mut Vec<VadEvent>) {
        let keep = if forced { self.cur.len() } else { self.keep_len() };
        let enough = self.speech_windows >= ms_to_windows(self.cfg.min_speech_ms);
        let mut samples = std::mem::take(&mut self.cur);
        samples.truncate(keep);
        if enough {
            out.push(VadEvent::SpeechEnd(Utterance {
                start_sample: self.cur_start,
                speech_end_sample: self.cur_start + self.last_speech_len as u64,
                samples,
                forced,
            }));
        } else {
            out.push(VadEvent::Discarded { start_sample: self.cur_start });
        }
        self.in_speech = false;
        self.paused = false;
        self.speech_windows = 0;
        self.silence_windows = 0;
        self.pre_roll.clear();
    }

    /// Cuts an over-long utterance at the latest pause (if in the last 5 s),
    /// and continues the remainder as a new utterance.
    fn split_forced(&mut self, out: &mut Vec<VadEvent>) {
        let min_cut = self.cur.len().saturating_sub(5 * 16_000);
        let cut = self.last_pause_len.filter(|&c| c >= min_cut && c > 0).unwrap_or(self.cur.len());
        let rest = self.cur.split_off(cut);
        let start = self.cur_start;
        let first = std::mem::take(&mut self.cur);
        out.push(VadEvent::SpeechEnd(Utterance {
            start_sample: start,
            speech_end_sample: start + first.len() as u64,
            samples: first,
            forced: true,
        }));
        self.cur_start = start + cut as u64;
        self.cur = rest;
        self.last_speech_len = self.cur.len();
        self.last_pause_len = None;
        self.speech_windows = ms_to_windows(self.cfg.min_speech_ms); // remainder is speech already
        self.silence_windows = 0;
        out.push(VadEvent::SpeechStart { start_sample: self.cur_start });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds windows with given probabilities (each window = 32 ms).
    fn run(cfg: SegmenterConfig, probs: &[f32]) -> Vec<VadEvent> {
        let mut seg = Segmenter::new(cfg);
        let mut out = Vec::new();
        let mut i = 0usize;
        let mut prob = |_: &[f32]| -> Result<f32, ()> {
            let p = probs[i];
            i += 1;
            Ok(p)
        };
        let audio = vec![0.0f32; probs.len() * WINDOW];
        seg.push(&audio, &mut prob, &mut out).unwrap();
        out
    }

    fn ends(ev: &[VadEvent]) -> Vec<&Utterance> {
        ev.iter().filter_map(|e| if let VadEvent::SpeechEnd(u) = e { Some(u) } else { None }).collect()
    }

    #[test]
    fn single_utterance_with_preroll_and_postpad() {
        // 20 silent, 30 speech (~960 ms), 20 silent
        let probs: Vec<f32> = [vec![0.0; 20], vec![0.9; 30], vec![0.0; 20]].concat();
        let ev = run(SegmenterConfig::default(), &probs);
        let u = ends(&ev);
        assert_eq!(u.len(), 1);
        let pre = ms_to_windows(300) * WINDOW;
        assert_eq!(u[0].start_sample, (20 * WINDOW - pre) as u64);
        assert_eq!(u[0].speech_end_sample, u[0].start_sample + (pre + 30 * WINDOW) as u64);
        assert_eq!(u[0].samples.len(), pre + 30 * WINDOW + 100 * 16);
        assert!(!u[0].forced);
    }

    #[test]
    fn short_blip_is_dropped() {
        let probs: Vec<f32> = [vec![0.0; 5], vec![0.9; 3], vec![0.0; 20]].concat();
        let ev = run(SegmenterConfig::default(), &probs);
        assert!(ends(&ev).is_empty());
        assert!(matches!(ev.last(), Some(VadEvent::Discarded { .. })));
    }

    #[test]
    fn short_pause_does_not_split() {
        // 5 silent windows = 160 ms < 300 ms
        let probs: Vec<f32> = [vec![0.9; 20], vec![0.0; 5], vec![0.9; 20], vec![0.0; 20]].concat();
        assert_eq!(ends(&run(SegmenterConfig::default(), &probs)).len(), 1);
    }

    #[test]
    fn hysteresis_band_is_not_silence() {
        let probs: Vec<f32> = [vec![0.9; 20], vec![0.4; 30], vec![0.9; 10], vec![0.0; 20]].concat();
        assert_eq!(ends(&run(SegmenterConfig::default(), &probs)).len(), 1);
    }

    #[test]
    fn pause_snapshot_matches_final() {
        let cfg = SegmenterConfig { early_silence_ms: 128, ..Default::default() };
        let probs: Vec<f32> = [vec![0.0; 5], vec![0.9; 30], vec![0.0; 20]].concat();
        let ev = run(cfg, &probs);
        let pause: Vec<&Utterance> = ev.iter().filter_map(|e| if let VadEvent::Pause(u) = e { Some(u) } else { None }).collect();
        let end = ends(&ev);
        assert_eq!((pause.len(), end.len()), (1, 1));
        assert_eq!((pause[0].start_sample, &pause[0].samples), (end[0].start_sample, &end[0].samples));
    }

    #[test]
    fn resumed_speech_changes_final() {
        let cfg = SegmenterConfig { early_silence_ms: 128, ..Default::default() };
        // pause of 6 windows (192 ms): Pause fires, then speech resumes before min_silence.
        let probs: Vec<f32> = [vec![0.9; 30], vec![0.0; 6], vec![0.9; 10], vec![0.0; 20]].concat();
        let ev = run(cfg, &probs);
        let pauses = ev.iter().filter(|e| matches!(e, VadEvent::Pause(_))).count();
        let end = ends(&ev);
        assert_eq!((pauses, end.len()), (2, 1));
        assert_eq!(ev.iter().filter(|e| matches!(e, VadEvent::Resume { .. })).count(), 1);
        let VadEvent::Pause(first) = ev.iter().find(|e| matches!(e, VadEvent::Pause(_))).unwrap() else { unreachable!() };
        assert_ne!(first.samples.len(), end[0].samples.len());
    }

    #[test]
    fn forced_split_at_pause() {
        let cfg = SegmenterConfig { max_utterance_ms: 2000, ..Default::default() };
        // ~1.3 s speech, short pause, then continuous speech past the cap
        let probs: Vec<f32> = [vec![0.9; 40], vec![0.1; 4], vec![0.9; 60], vec![0.0; 20]].concat();
        let ev = run(cfg, &probs);
        let u = ends(&ev);
        assert_eq!(u.len(), 2);
        assert!(u[0].forced);
        assert_eq!(u[1].start_sample, u[0].start_sample + u[0].samples.len() as u64);
    }
}
