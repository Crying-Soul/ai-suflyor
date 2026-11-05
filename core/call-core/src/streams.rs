//! Per-speaker supervisor threads: keep a capture running (retrying on failure),
//! drain its ring buffer, publish signal levels, and optionally record WAV.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Result;
use audio::{Capture, SAMPLE_RATE, Source};
use protocol::{CaptureState, CaptureStatus, Event, Speaker};
use tracing::{error, info, warn};
use vad::{Segmenter, SegmenterConfig, Silero, Utterance, VadEvent};

use crate::Shared;
use crate::config::Config;
use crate::stt_worker::{Job, SttQueue};

#[derive(Clone)]
struct VadSetup {
    model: PathBuf,
    seg: SegmenterConfig,
    partial_ms: usize,
}

const RETRY_DELAY: Duration = Duration::from_secs(3);
const LEVEL_WINDOW: usize = SAMPLE_RATE as usize / 10; // 100 ms
/// First live partial once the utterance (300 ms pre-roll included) is 0.8 s long: ~0.5 s of
/// speech is the least whisper turns into words; shorter gives empty or invented text.
const FIRST_PARTIAL: usize = SAMPLE_RATE as usize * 8 / 10;

pub struct StreamSet {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl StreamSet {
    pub fn start(cfg: &Config, shared: Arc<Shared>, queue: Arc<SttQueue>, record_dir: Option<PathBuf>) -> Result<StreamSet> {
        let vad = VadSetup {
            model: cfg.path(&cfg.vad.model),
            seg: SegmenterConfig {
                threshold: cfg.vad.threshold,
                neg_threshold: cfg.vad.neg_threshold,
                min_silence_ms: cfg.vad.min_silence_ms,
                pre_roll_ms: cfg.vad.pre_roll_ms,
                min_speech_ms: cfg.vad.min_speech_ms,
                max_utterance_ms: cfg.vad.max_utterance_ms,
                early_silence_ms: cfg.vad.early_silence_ms,
                ..Default::default()
            },
            partial_ms: cfg.stt.partial_ms as usize,
        };
        let stop = Arc::new(AtomicBool::new(false));
        if let Some(d) = &record_dir {
            std::fs::create_dir_all(d)?;
        }
        let stamp = timestamp();
        let mic_device = Some(cfg.audio.mic_device.clone()).filter(|d| !d.is_empty());
        let sources = [
            (Speaker::Me, Source::Mic { device: mic_device }),
            (Speaker::Them, Source::parse_them(&cfg.audio.them_source)),
        ];
        let mut threads = Vec::new();
        for (speaker, source) in sources {
            let wav = record_dir.as_ref().map(|d| d.join(format!("{stamp}-{}.wav", speaker.as_str())));
            let (stop, shared, queue, mut vad) = (stop.clone(), shared.clone(), queue.clone(), vad.clone());
            if speaker == Speaker::Me {
                // Only the question is latency-critical; "me" speculation would compete for the GPU.
                vad.seg.early_silence_ms = 0;
            }
            threads.push(
                std::thread::Builder::new()
                    .name(format!("stream-{}", speaker.as_str()))
                    .spawn(move || supervise(speaker, source, shared, queue, vad, wav, &stop))?,
            );
        }
        Ok(StreamSet { stop, threads })
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        for t in self.threads {
            let _ = t.join();
        }
    }
}

fn set_capture_status(shared: &Shared, speaker: Speaker, st: CaptureStatus) {
    shared.update_status(|s| match speaker {
        Speaker::Me => s.me = st,
        Speaker::Them => s.them = st,
    });
}

fn supervise(
    speaker: Speaker,
    source: Source,
    shared: Arc<Shared>,
    queue: Arc<SttQueue>,
    vad: VadSetup,
    wav: Option<PathBuf>,
    stop: &AtomicBool,
) {
    let mut writer = wav.and_then(|p| {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        match hound::WavWriter::create(&p, spec) {
            Ok(w) => {
                info!("recording {} to {}", speaker.as_str(), p.display());
                Some(w)
            }
            Err(e) => {
                warn!("cannot create {}: {e}", p.display());
                None
            }
        }
    });

    while !stop.load(Ordering::Relaxed) {
        let capture = match audio::start(source.clone(), speaker.as_str()) {
            Ok(c) => c,
            Err(e) => {
                set_capture_status(&shared, speaker, CaptureStatus {
                    state: CaptureState::Error,
                    source: format!("{source:?}"),
                    error: Some(format!("{e:#}")),
                });
                sleep_unless_stopped(RETRY_DELAY, stop);
                continue;
            }
        };
        set_capture_status(&shared, speaker, CaptureStatus {
            state: CaptureState::Running,
            source: capture.description.clone(),
            error: None,
        });
        let silero = match Silero::new(&vad.model) {
            Ok(s) => Some(s),
            Err(e) => {
                error!("VAD disabled for {}: {e:#}", speaker.as_str());
                None
            }
        };
        drain(speaker, capture, &shared, &queue, silero, &vad.seg, vad.partial_ms, writer.as_mut(), stop);
        if !stop.load(Ordering::Relaxed) {
            set_capture_status(&shared, speaker, CaptureStatus {
                state: CaptureState::Error,
                source: format!("{source:?}"),
                error: Some("capture stopped, restarting".into()),
            });
            sleep_unless_stopped(RETRY_DELAY, stop);
        }
    }
    if let Some(w) = writer {
        let _ = w.finalize();
    }
}

/// Runs until the capture fails or stop is requested.
#[allow(clippy::too_many_arguments)]
fn drain(
    speaker: Speaker,
    mut capture: Capture,
    shared: &Shared,
    queue: &SttQueue,
    mut silero: Option<Silero>,
    seg_cfg: &SegmenterConfig,
    partial_ms: usize,
    mut writer: Option<&mut hound::WavWriter<std::io::BufWriter<std::fs::File>>>,
    stop: &AtomicBool,
) {
    // Timeline of this capture: sample index 0 = capture start.
    let epoch_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut segmenter = Segmenter::new(seg_cfg.clone());
    let mut events = Vec::new();
    let mut vad_ms = 0.0f64;
    let mut vad_windows = 0u32;
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    let mut count = 0usize;
    let mut last_flush = Instant::now();
    // (utterance start, its length at the last partial job).
    let mut partial_at: Option<(u64, usize)> = None;

    while !stop.load(Ordering::Relaxed) && !capture.failed() {
        let n = capture.consumer.slots();
        if n == 0 {
            // The capture thread pushes every ≤ 20 ms; a short poll keeps VAD (and end-of-speech) latency low.
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let Ok(chunk) = capture.consumer.read_chunk(n) else { continue };
        let (a, b) = chunk.as_slices();

        if let Some(sil) = silero.as_mut() {
            let t = Instant::now();
            let pos_before = segmenter.position();
            let mut prob = |w: &[f32]| sil.prob(w);
            let res = segmenter.push(a, &mut prob, &mut events).and_then(|_| segmenter.push(b, &mut prob, &mut events));
            vad_ms += t.elapsed().as_secs_f64() * 1000.0;
            vad_windows += ((segmenter.position() - pos_before) / vad::WINDOW as u64) as u32;
            if let Err(e) = res {
                error!("VAD failed for {}, disabling: {e}", speaker.as_str());
                silero = None;
            }
            let pos = segmenter.position();
            // Utterance key shared by the vad, partial and final events: epoch ms of its start.
            let t_of = |start_sample: u64| epoch_ms + start_sample / 16;
            for ev in events.drain(..) {
                match ev {
                    VadEvent::SpeechStart { start_sample } => {
                        set_speaking(shared, speaker, true);
                        let _ = shared.events.send(Event::Vad { speaker, active: true, t: t_of(start_sample) });
                    }
                    VadEvent::Discarded { start_sample } => {
                        set_speaking(shared, speaker, false);
                        let t = t_of(start_sample);
                        let _ = shared.events.send(Event::Vad { speaker, active: false, t });
                        // The UI shows a row from speech start on; an empty final removes it.
                        let _ = shared.events.send(Event::Final { speaker, t, text: String::new(), question: false });
                    }
                    VadEvent::SpeechEnd(_) | VadEvent::Pause(_) => {
                        let (utt, speculative) = match ev {
                            VadEvent::SpeechEnd(u) => {
                                // A forced split (max utterance length) happens mid-speech.
                                set_speaking(shared, speaker, u.forced);
                                let _ = shared.events.send(Event::Vad { speaker, active: false, t: t_of(u.start_sample) });
                                (u, false)
                            }
                            VadEvent::Pause(u) => (u, true),
                            _ => unreachable!(),
                        };
                        let behind_ms = (pos.saturating_sub(utt.speech_end_sample)) / 16;
                        let now = Instant::now();
                        queue.push(Job {
                            speaker,
                            t_ms: t_of(utt.start_sample),
                            speech_end: now.checked_sub(Duration::from_millis(behind_ms)).unwrap_or(now),
                            queued: now,
                            utt,
                            speculative,
                            partial: false,
                        });
                    }
                }
            }
            // Live text: re-decode the utterance in progress every `partial_ms` of new audio.
            if partial_ms > 0 {
                if let Some((start, cur)) = segmenter.current() {
                    let last = partial_at.filter(|(s, _)| *s == start).map_or(0, |(_, n)| n);
                    if cur.len() >= FIRST_PARTIAL && cur.len() >= last + partial_ms * 16 {
                        partial_at = Some((start, cur.len()));
                        let now = Instant::now();
                        queue.push(Job {
                            speaker,
                            t_ms: t_of(start),
                            speech_end: now,
                            queued: now,
                            utt: Utterance { start_sample: start, samples: cur.to_vec(), speech_end_sample: pos, forced: false },
                            speculative: false,
                            partial: true,
                        });
                    }
                }
            }
            if vad_windows >= 300 {
                // ~10 s of audio: report average VAD cost per 32 ms window.
                let _ = shared.events.send(Event::Metrics { name: "vad_window".into(), ms: vad_ms / vad_windows as f64 });
                (vad_ms, vad_windows) = (0.0, 0);
            }
        }
        for &s in a.iter().chain(b.iter()) {
            sum_sq += (s as f64) * (s as f64);
            peak = peak.max(s.abs());
            count += 1;
            if count == LEVEL_WINDOW {
                let rms = (sum_sq / count as f64).sqrt() as f32;
                let _ = shared.events.send(Event::Level { speaker, rms, peak });
                (sum_sq, peak, count) = (0.0, 0.0, 0);
            }
            if let Some(w) = writer.as_deref_mut() {
                let _ = w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            }
        }
        chunk.commit_all();

        if last_flush.elapsed() > Duration::from_secs(1) {
            if let Some(w) = writer.as_deref_mut() {
                let _ = w.flush(); // keeps the WAV header valid if we get killed
            }
            last_flush = Instant::now();
        }
    }
}

fn set_speaking(shared: &Shared, speaker: Speaker, active: bool) {
    if speaker == Speaker::Them {
        shared.them_speaking.store(active, Ordering::Relaxed);
    }
}

fn sleep_unless_stopped(d: Duration, stop: &AtomicBool) {
    let until = Instant::now() + d;
    while Instant::now() < until && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("{secs}")
}
