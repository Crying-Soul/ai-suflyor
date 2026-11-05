//! Single STT worker: owns the whisper model (one GPU context, one state per
//! speaker) and turns utterances into final transcript segments.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use protocol::{Event, Speaker};
use stt::{DecodeOptions, ModelOptions, State, Whisper};
use tracing::{error, info, warn};
use vad::Utterance;

use crate::Shared;
use crate::config::Config;

pub struct Job {
    pub speaker: Speaker,
    pub utt: Utterance,
    /// Epoch ms of the utterance start.
    pub t_ms: u64,
    /// Wall-clock instant of the last speech sample (for latency metrics).
    pub speech_end: Instant,
    pub queued: Instant,
    /// Decode ahead of the confirmed end of speech; the result is kept until the final arrives.
    pub speculative: bool,
    /// Utterance still in progress: decoded fast for live text, never stored.
    pub partial: bool,
}

/// Two-lane queue: "them" is served before "me" (the question matters more than our own speech).
#[derive(Default)]
pub struct SttQueue {
    lanes: Mutex<(VecDeque<Job>, VecDeque<Job>, bool)>,
    cv: Condvar,
}

impl SttQueue {
    pub fn push(&self, job: Job) {
        let mut l = self.lanes.lock().unwrap();
        let lane = match job.speaker {
            Speaker::Them => &mut l.0,
            Speaker::Me => &mut l.1,
        };
        // Only the newest partial matters; any real job supersedes pending speculative/partial ones.
        if job.partial {
            lane.retain(|j| !j.partial);
        } else {
            lane.retain(|j| !j.speculative && !j.partial);
        }
        lane.push_back(job);
        self.cv.notify_one();
    }

    pub fn close(&self) {
        self.lanes.lock().unwrap().2 = true;
        self.cv.notify_all();
    }

    fn pop(&self) -> Option<Job> {
        let mut l = self.lanes.lock().unwrap();
        loop {
            // Finals and speculative decodes first ("them" before "me"), partials only when idle.
            let (them, me, _) = &mut *l;
            for want_partial in [false, true] {
                for lane in [&mut *them, &mut *me] {
                    if let Some(i) = lane.iter().position(|j| j.partial == want_partial) {
                        return lane.remove(i);
                    }
                }
            }
            if l.2 {
                return None;
            }
            l = self.cv.wait(l).unwrap();
        }
    }
}

pub fn spawn(cfg: &Config, shared: Arc<Shared>, queue: Arc<SttQueue>) -> std::io::Result<JoinHandle<()>> {
    let cfg = cfg.clone();
    std::thread::Builder::new().name("stt".into()).spawn(move || {
        if let Err(e) = run(&cfg, &shared, &queue) {
            error!("stt worker: {e:#}");
            shared.update_status(|s| s.stt = format!("error: {e:#}"));
            // Drain so producers never block on a dead worker.
            while queue.pop().is_some() {}
        }
    })
}

fn run(cfg: &Config, shared: &Shared, queue: &SttQueue) -> anyhow::Result<()> {
    shared.update_status(|s| s.stt = "loading".into());
    let t = Instant::now();
    let model = Whisper::load(
        &cfg.path(&cfg.stt.dll),
        &cfg.path(&cfg.stt.model),
        &ModelOptions { use_gpu: cfg.stt.use_gpu, gpu_device: cfg.stt.gpu_device, flash_attn: cfg.stt.flash_attn, verbose: cfg.stt.verbose },
    )?;
    let mut states: [State; 2] = [model.new_state()?, model.new_state()?];
    let base = DecodeOptions {
        language: Some(cfg.language.clone()).filter(|l| !l.is_empty() && l != "auto"),
        threads: cfg.stt.threads,
        beam_size: cfg.stt.beam_size,
        temperature_inc: cfg.stt.temperature_inc,
        no_speech_thold: cfg.stt.no_speech_thold,
        audio_ctx: cfg.stt.audio_ctx,
        ..Default::default()
    };
    // Warm-up: first decode initializes CUDA kernels (~100+ ms extra).
    for st in states.iter_mut() {
        st.transcribe(&vec![0.0; 16_000], &base, None)?;
    }
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;
    info!("whisper ready in {load_ms:.0} ms");
    let _ = shared.events.send(Event::Metrics { name: "stt_load".into(), ms: load_ms });
    shared.update_status(|s| s.stt = if cfg.stt.use_gpu { "ready (gpu)".into() } else { "ready (cpu)".into() });

    let glossary = cfg.glossary.join(", ");
    let mut last_text: [String; 2] = Default::default();
    let mut next_seg: u64 = 1;
    // Per speaker: the utterance (start sample) whose partials are on screen, and its seg id.
    let mut open: [Option<(u64, u64)>; 2] = [None, None];
    // Per speaker: stream sample up to which audio is finalized; older partials are stale.
    let mut finalized_upto: [u64; 2] = [0, 0];
    // Per speaker: ((start_sample, len), text or None if dropped, decode ms) of the last speculative decode.
    let mut spec: [Option<((u64, usize), Option<String>, f64)>; 2] = Default::default();

    while let Some(job) = queue.pop() {
        let idx = match job.speaker {
            Speaker::Me => 0,
            Speaker::Them => 1,
        };
        let wait_ms = job.queued.elapsed().as_secs_f64() * 1000.0;
        let start = job.utt.start_sample;
        if job.partial && start < finalized_upto[idx] {
            continue;
        }

        // Context: glossary (spelling) + tail of this speaker's previous utterance (continuity).
        let tail: String = {
            let chars: Vec<char> = last_text[idx].chars().collect();
            chars[chars.len().saturating_sub(200)..].iter().collect()
        };
        let prompt = match (glossary.is_empty(), tail.is_empty()) {
            (true, true) => None,
            (false, true) => Some(format!("{glossary}.")),
            (true, false) => Some(tail),
            (false, false) => Some(format!("{glossary}. {tail}")),
        };
        // Speculative decode at the first pause; reused if the confirmed end has the same audio.
        let key = (start, job.utt.samples.len());
        let cached = if job.partial { None } else { spec[idx].take().filter(|(k, ..)| !job.speculative && *k == key) };
        let (raw, decode_ms) = match cached {
            Some((_, text, ms)) => {
                info!("[{}] speculative decode reused", job.speaker.as_str());
                (text, ms)
            }
            None => {
                // whisper ignores < 1 s of audio; pad short utterances with silence.
                let mut samples = job.utt.samples;
                if samples.len() < 17_600 {
                    samples.resize(17_600, 0.0);
                }
                // Normal decodes take ≤ 0.5 s even for 20 s of audio; anything far beyond is a
                // temperature-fallback loop on noise. The shim aborts it so the queue keeps moving.
                let timeout_ms = 1000 + samples.len() as u32 / 160;
                let opts = if job.partial {
                    // Partials: one segment, no temperature fallback. A shortened audio_ctx was tried and
                    // loops on Russian ("-p-p-p...", 700+ ms), so the encoder keeps full context.
                    DecodeOptions { initial_prompt: prompt, timeout_ms: 1000, single_segment: true, temperature_inc: 0.0, ..base.clone() }
                } else {
                    DecodeOptions { initial_prompt: prompt, timeout_ms, ..base.clone() }
                };
                let t = Instant::now();
                let text = match states[idx].transcribe(&samples, &opts, None) {
                    Ok(tr) => Some(
                        tr.segments
                            .iter()
                            .filter(|s| !(s.no_speech_prob > cfg.stt.no_speech_thold && s.avg_logprob < -1.0))
                            .filter(|s| s.avg_logprob > -1.5)
                            .map(|s| s.text.trim())
                            .filter(|t| !t.is_empty())
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    Err(e) => {
                        warn!("transcribe {} ({:.1}s audio): {e:#}", job.speaker.as_str(), samples.len() as f32 / 16000.0);
                        None
                    }
                };
                (text, t.elapsed().as_secs_f64() * 1000.0)
            }
        };
        if job.speculative {
            spec[idx] = Some((key, raw, decode_ms));
            continue;
        }
        let mut text = raw.as_deref().and_then(|t| textproc::clean(t, &cfg.glossary));

        if job.partial {
            if let Some(text) = text {
                let seg = match open[idx] {
                    Some((s, id)) if s == start => id,
                    _ => {
                        next_seg += 1;
                        open[idx] = Some((start, next_seg - 1));
                        next_seg - 1
                    }
                };
                let _ = shared.events.send(Event::Partial { speaker: job.speaker, seg, text });
                let _ = shared.events.send(Event::Metrics { name: "stt_partial".into(), ms: decode_ms });
            }
            continue;
        }

        finalized_upto[idx] = start + key.1 as u64;
        if text.is_none() {
            info!("[{}] dropped: {raw:?}", job.speaker.as_str());
        }
        // Without headphones the mic hears the speakers: drop "me" text that repeats recent "them" speech.
        if let (Speaker::Me, Some(t)) = (job.speaker, &text) {
            let transcript = shared.transcript.lock().unwrap();
            let echo = transcript
                .iter()
                .rev()
                .take_while(|f| job.t_ms.abs_diff(f.t_ms) < 20_000)
                .any(|f| f.speaker == Speaker::Them && textproc::is_echo(t, &f.text));
            if echo {
                info!("[me] echo dropped: {t}");
                text = None;
            }
        }
        let shown = open[idx].take().filter(|(s, _)| *s == start).map(|(_, id)| id);
        let Some(text) = text else {
            // Empty final removes the partial line from the UI.
            if let Some(seg) = shown {
                let _ = shared.events.send(Event::Final { speaker: job.speaker, seg, t: job.t_ms, text: String::new() });
            }
            continue;
        };
        let seg = shown.unwrap_or_else(|| {
            next_seg += 1;
            next_seg - 1
        });
        let _ = shared.events.send(Event::Final { speaker: job.speaker, seg, t: job.t_ms, text: text.clone() });
        let end_to_final = job.speech_end.elapsed().as_secs_f64() * 1000.0;
        for (name, ms) in [("stt_decode", decode_ms), ("stt_queue_wait", wait_ms), ("speech_end_to_final", end_to_final)] {
            let _ = shared.events.send(Event::Metrics { name: name.into(), ms });
        }
        info!(
            "[{}] {:.1}s audio, decode {decode_ms:.0} ms, end->final {end_to_final:.0} ms: {text}",
            job.speaker.as_str(),
            key.1 as f32 / 16000.0
        );
        shared.transcript.lock().unwrap().push(crate::FinalSegment {
            speaker: job.speaker,
            t_ms: job.t_ms,
            end_ms: job.t_ms + (job.utt.speech_end_sample - start) / 16,
            text: text.clone(),
        });
        last_text[idx] = text;
        if job.speaker == Speaker::Them {
            if let Some(a) = shared.answerer.get() {
                a.on_them_final();
            }
        }
    }
    Ok(())
}

