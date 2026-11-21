//! Single STT worker: owns the whisper model (one GPU context, one state per
//! speaker) and turns utterances into final transcript segments.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use protocol::{Event, Speaker, SttState};
use stt::{DecodeOptions, ModelOptions, State, Whisper};
use tracing::{debug, error, info, warn};
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
    /// Non-zero aborts the partial being decoded: a final (the question) must not wait up to 1 s for it.
    abort: AtomicI32,
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
        if !job.partial {
            self.abort.store(1, Ordering::Relaxed);
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
                        // Under the lock: a final pushed after this pop aborts the partial, one before it was served first.
                        self.abort.store(0, Ordering::Relaxed);
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
            shared.update_status(|s| s.stt = SttState::Error { message: format!("{e:#}") });
            // Drain so producers never block on a dead worker.
            while queue.pop().is_some() {}
        }
    })
}

/// ((utterance t, len), text or None if dropped, decode ms) of a speculative decode.
type Speculative = ((u64, usize), Option<String>, f64);

fn run(cfg: &Config, shared: &Shared, queue: &SttQueue) -> anyhow::Result<()> {
    shared.update_status(|s| s.stt = SttState::Loading);
    let t = Instant::now();
    let dll = cfg.path(&cfg.stt.dll);
    let model = Whisper::load(
        &dll,
        &cfg.path(&cfg.stt.model),
        &ModelOptions {
            cuda_dll: cuda_dll(cfg, &dll),
            use_gpu: cfg.stt.use_gpu,
            gpu_device: cfg.stt.gpu_device,
            flash_attn: cfg.stt.flash_attn,
            verbose: cfg.stt.verbose,
        },
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
    shared.update_status(|s| s.stt = SttState::Ready { gpu: cfg.stt.use_gpu });

    // Per speaker: the text of its last final (whisper prompt context).
    let mut last_text: [String; 2] = Default::default();
    // Per speaker: (utterance t, text) of the last partial shown, for the stable/tail split.
    let mut last_partial: [(u64, String); 2] = Default::default();
    // When the last "them" partial was shown: an older one is not live speech the mic could echo.
    let mut them_partial_at: Option<Instant> = None;
    // Per speaker: epoch ms up to which audio is finalized; older partials are stale. Epoch ms, not
    // stream samples: a restarted capture counts samples from 0 again, epoch ms keep growing.
    let mut finalized_upto: [u64; 2] = [0, 0];
    // Per speaker: the last speculative decode.
    let mut spec: [Option<Speculative>; 2] = Default::default();
    // Language whisper detected on the last full decode. With `language: auto`, partials reuse it:
    // detection on < 1 s of audio guesses wrong (Russian speech came out as Japanese).
    let mut lang: Option<String> = None;

    while let Some(job) = queue.pop() {
        let idx = match job.speaker {
            Speaker::Me => 0,
            Speaker::Them => 1,
        };
        let (speaker, t) = (job.speaker, job.t_ms);
        let wait_ms = job.queued.elapsed().as_secs_f64() * 1000.0;
        let start = job.utt.start_sample;
        if job.partial && t < finalized_upto[idx] {
            continue;
        }
        // Speculative decode at the first pause; reused if the confirmed end has the same audio.
        let key = (t, job.utt.samples.len());
        let cached = if job.partial { None } else { spec[idx].take().filter(|(k, ..)| !job.speculative && *k == key) };
        let (raw, decode_ms) = match cached {
            Some((_, text, ms)) => {
                info!("[{}] speculative decode reused", speaker.as_str());
                (text, ms)
            }
            None => {
                let t0 = Instant::now();
                // Read per job: opening a call swaps the glossary without reloading whisper.
                let glossary = shared.glossary.read().unwrap().join(", ");
                let mut opts = DecodeOptions { initial_prompt: whisper_prompt(&glossary, &last_text[idx]), ..base.clone() };
                if job.partial && opts.language.is_none() {
                    opts.language = lang.clone();
                }
                let abort = job.partial.then_some(&queue.abort);
                let out = decode(&mut states[idx], job.utt.samples, opts, abort, cfg.stt.no_speech_thold, speaker);
                if let (Some((_, l)), false) = (&out, job.partial) {
                    lang = Some(l.clone()).filter(|l| !l.is_empty());
                }
                (out.map(|(text, _)| text), t0.elapsed().as_secs_f64() * 1000.0)
            }
        };
        let mut text = raw.as_deref().and_then(|t| textproc::clean(t, &shared.glossary.read().unwrap()));

        if job.partial || job.speculative {
            if job.speculative {
                spec[idx] = Some((key, raw, decode_ms));
            }
            let Some(text) = text else { continue };
            if job.speculative
                && speaker == Speaker::Them
                && let Some(a) = shared.answerer()
            {
                a.on_them_early(crate::FinalSegment { speaker, t_ms: t, end_ms: t + (job.utt.speech_end_sample - start) / 16, text: text.clone() });
            }
            // Echo partials would flash the other side's words on our row until the final drops them.
            if speaker == Speaker::Me && is_echo(shared, t, &text, live_partial(&last_partial[1].1, them_partial_at)) {
                continue;
            }
            // A speculative decode is the final unless speech resumes: show all of it as settled.
            let prev = if job.speculative { text.as_str() } else { Some(&last_partial[idx]).filter(|(pt, _)| *pt == t).map_or("", |(_, s)| s) };
            let (stable, tail) = textproc::split_stable(prev, &text);
            let _ = shared.events.send(Event::Partial { speaker, t, stable, tail });
            if job.partial {
                let _ = shared.events.send(Event::Metrics { name: "stt_partial".into(), ms: decode_ms });
            }
            if speaker == Speaker::Them {
                them_partial_at = Some(Instant::now());
            }
            last_partial[idx] = (t, text);
            continue;
        }

        finalized_upto[idx] = t + key.1 as u64 / 16;
        if text.is_none() {
            info!("[{}] dropped: {raw:?}", speaker.as_str());
        }
        // Without headphones the mic hears the speakers: drop "me" text that repeats recent "them" speech.
        if let (Speaker::Me, Some(tx)) = (speaker, &text)
            && is_echo(shared, t, tx, live_partial(&last_partial[1].1, them_partial_at))
        {
            info!("[me] echo dropped: {tx}");
            text = None;
        }
        // An empty final removes the utterance's row from the UI.
        let text = text.unwrap_or_default();
        let question = speaker == Speaker::Them && !text.is_empty() && textproc::is_question(&text);
        let _ = shared.events.send(Event::Final { speaker, t, text: text.clone(), question });
        if text.is_empty() {
            continue;
        }
        let end_to_final = job.speech_end.elapsed().as_secs_f64() * 1000.0;
        for (name, ms) in [("stt_decode", decode_ms), ("stt_queue_wait", wait_ms), ("speech_end_to_final", end_to_final)] {
            let _ = shared.events.send(Event::Metrics { name: name.into(), ms });
        }
        info!("[{}] {:.1}s audio, decode {decode_ms:.0} ms, end->final {end_to_final:.0} ms: {text}", speaker.as_str(), key.1 as f32 / 16000.0);
        let seg = crate::FinalSegment { speaker, t_ms: t, end_ms: t + (job.utt.speech_end_sample - start) / 16, text: text.clone() };
        crate::call::save_final(shared, &seg);
        shared.transcript.lock().unwrap().push(seg);
        // The translator skips speech already in the user's language (the detected language, or the configured one).
        if speaker == Speaker::Them
            && shared.status.lock().unwrap().translate
            && let Some(tr) = shared.translator()
        {
            tr.push(t, text.clone(), lang.as_deref().or(base.language.as_deref()));
        }
        last_text[idx] = text;
        if speaker == Speaker::Them
            && let Some(a) = shared.answerer()
        {
            a.on_them_final();
        }
    }
    Ok(())
}

/// A "them" partial younger than this can still be echoed by the mic.
const PARTIAL_ECHO_MS: u128 = 5_000;

/// The last "them" partial while it is recent, else "".
fn live_partial(text: &str, at: Option<Instant>) -> &str {
    if at.is_some_and(|at| at.elapsed().as_millis() < PARTIAL_ECHO_MS) { text } else { "" }
}

/// True when "me" text at `t` repeats "them" speech of the last 20 s (or their live partial).
fn is_echo(shared: &Shared, t: u64, text: &str, them_partial: &str) -> bool {
    if !them_partial.is_empty() && textproc::is_echo(text, them_partial) {
        return true;
    }
    let transcript = shared.transcript.lock().unwrap();
    transcript.iter().rev().take_while(|f| t.abs_diff(f.t_ms) < 20_000).any(|f| f.speaker == Speaker::Them && textproc::is_echo(text, &f.text))
}

/// Whisper initial prompt: the glossary (spelling) + the tail of the speaker's previous utterance (continuity).
fn whisper_prompt(glossary: &str, last: &str) -> Option<String> {
    let chars: Vec<char> = last.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(200)..].iter().collect();
    match (glossary.is_empty(), tail.is_empty()) {
        (true, true) => None,
        (false, true) => Some(format!("{glossary}.")),
        (true, false) => Some(tail),
        (false, false) => Some(format!("{glossary}. {tail}")),
    }
}

/// One whisper decode: (confident segments joined, possibly empty; detected language). None on failure.
/// `abort`: given for partials only; a final arriving in the queue cancels them.
fn decode(
    state: &mut State,
    mut samples: Vec<f32>,
    opts: DecodeOptions,
    abort: Option<&AtomicI32>,
    no_speech_thold: f32,
    speaker: Speaker,
) -> Option<(String, String)> {
    let partial = abort.is_some();
    // whisper ignores < 1 s of audio; pad short utterances with silence.
    if samples.len() < 17_600 {
        samples.resize(17_600, 0.0);
    }
    let opts = if partial {
        // Partials: one segment, no temperature fallback. A shortened audio_ctx was tried and
        // loops on Russian ("-p-p-p...", 700+ ms), so the encoder keeps full context.
        DecodeOptions { timeout_ms: 1000, single_segment: true, temperature_inc: 0.0, ..opts }
    } else {
        // Normal decodes take ≤ 0.5 s even for 20 s of audio; anything far beyond is a
        // temperature-fallback loop on noise. The shim aborts it so the queue keeps moving.
        DecodeOptions { timeout_ms: 1000 + samples.len() as u32 / 160, ..opts }
    };
    match state.transcribe(&samples, &opts, abort) {
        Ok(tr) => Some((
            tr.segments
                .iter()
                .filter(|s| !(s.no_speech_prob > no_speech_thold && s.avg_logprob < -1.0))
                .filter(|s| s.avg_logprob > -1.5)
                .map(|s| s.text.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            tr.language,
        )),
        Err(_) if abort.is_some_and(|a| a.load(Ordering::Relaxed) != 0) => {
            debug!("[{}] partial aborted for a final", speaker.as_str());
            None
        }
        Err(e) => {
            warn!("transcribe {} ({:.1}s audio): {e:#}", speaker.as_str(), samples.len() as f32 / 16000.0);
            None
        }
    }
}

/// The CUDA backend downloaded in Settings (`stt.cudaDir`), unless whisper.dll ships its own.
fn cuda_dll(cfg: &Config, whisper_dll: &std::path::Path) -> Option<std::path::PathBuf> {
    const CUDA_DLL: &str = "ggml-cuda.dll";
    let downloaded = cfg.path(&cfg.stt.cuda_dir).join(CUDA_DLL);
    (cfg.stt.use_gpu && !whisper_dll.parent()?.join(CUDA_DLL).exists() && downloaded.exists()).then_some(downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(speaker: Speaker, partial: bool) -> Job {
        let now = Instant::now();
        Job {
            speaker,
            utt: Utterance { start_sample: 0, samples: vec![], speech_end_sample: 0, forced: false },
            t_ms: 0,
            speech_end: now,
            queued: now,
            speculative: false,
            partial,
        }
    }

    #[test]
    fn final_aborts_the_partial_in_progress() {
        let q = SttQueue::default();
        q.push(job(Speaker::Me, true));
        let p = q.pop().unwrap();
        assert!(p.partial);
        assert_eq!(q.abort.load(Ordering::Relaxed), 0, "a popped partial starts unaborted");
        q.push(job(Speaker::Me, true));
        assert_eq!(q.abort.load(Ordering::Relaxed), 0, "a newer partial does not abort");
        q.push(job(Speaker::Them, false));
        assert_eq!(q.abort.load(Ordering::Relaxed), 1, "a final aborts it");
        // The final is served before the waiting partial.
        assert!(!q.pop().unwrap().partial);
        assert!(q.pop().unwrap().partial);
    }

    #[test]
    fn whisper_prompt_joins_glossary_and_the_last_words() {
        assert_eq!(whisper_prompt("", ""), None);
        assert_eq!(whisper_prompt("Go, gRPC", "").as_deref(), Some("Go, gRPC."));
        assert_eq!(whisper_prompt("", "привет").as_deref(), Some("привет"));
        assert_eq!(whisper_prompt("Go", "привет").as_deref(), Some("Go. привет"));
        let long = "я".repeat(250);
        assert_eq!(whisper_prompt("", &long).unwrap().chars().count(), 200, "only the tail, cut on a char boundary");
    }

    #[test]
    fn echo_of_their_recent_speech_or_live_partial() {
        let (shared, _rx) = Shared::for_test();
        let them = |t_ms: u64, text: &str| crate::FinalSegment { speaker: Speaker::Them, t_ms, end_ms: t_ms + 1000, text: text.into() };
        shared.transcript.lock().unwrap().push(them(10_000, "Расскажите про свой последний проект"));
        assert!(is_echo(&shared, 12_000, "Расскажите про свой последний проект", ""));
        assert!(!is_echo(&shared, 40_000, "Расскажите про свой последний проект", ""), "older than 20 s: the user may repeat it");
        assert!(!is_echo(&shared, 12_000, "Я делал платёжный шлюз на Go", ""));
        assert!(is_echo(&shared, 40_000, "какой у вас опыт с кафкой", "Какой у вас опыт с Кафкой"), "their partial, not yet final");

        assert_eq!(live_partial("x", Some(Instant::now())), "x");
        assert_eq!(live_partial("x", None), "");
        let old = Instant::now().checked_sub(std::time::Duration::from_millis(PARTIAL_ECHO_MS as u64 + 1));
        if old.is_some() {
            assert_eq!(live_partial("x", old), "", "a stale partial is no longer echoed");
        }
    }
}
