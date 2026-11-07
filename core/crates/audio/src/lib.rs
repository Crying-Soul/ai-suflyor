//! WASAPI capture: microphone, system loopback, or per-process loopback.
//!
//! Every stream is captured at the device's native rate and channel count, then
//! downmixed and resampled (rubato) to 16 kHz mono f32, and delivered through a
//! lock-free ring buffer, so the capture thread never blocks on the consumer.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use tracing::{debug, error, info, warn};
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

pub const SAMPLE_RATE: u32 = 16_000;
/// Ring buffer capacity: 10 s of audio. The consumer drains every ~20 ms.
const RING_CAPACITY: usize = SAMPLE_RATE as usize * 10;
/// Loopback delivers no packets while nothing plays; pad silence once the gap exceeds this.
const GAP_FILL_THRESHOLD: usize = SAMPLE_RATE as usize / 10;

#[derive(Debug, Clone)]
pub enum Source {
    /// Default capture device, or the first whose name contains the given substring.
    Mic { device: Option<String> },
    /// Everything played on the default render device.
    SystemLoopback,
    /// Audio of one process tree (Windows 10 2004+), e.g. "chrome.exe".
    Process { name: String },
}

impl Source {
    /// Parses "system", "process:chrome.exe".
    pub fn parse_them(s: &str) -> Source {
        match s.split_once(':') {
            Some(("process", name)) if !name.is_empty() => Source::Process { name: name.to_string() },
            _ => Source::SystemLoopback,
        }
    }
}

pub struct Capture {
    pub consumer: rtrb::Consumer<f32>,
    /// Human-readable description of what is being captured.
    pub description: String,
    stop: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// True once the capture thread has died (device removed, etc.).
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Starts capturing on a dedicated thread. Returns once the stream is running
/// (or failed to start).
pub fn start(source: Source, name: &str) -> Result<Capture> {
    let (producer, consumer) = rtrb::RingBuffer::new(RING_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<String>>(1);

    let thread = {
        let stop = stop.clone();
        let failed = failed.clone();
        let name = name.to_string();
        std::thread::Builder::new().name(format!("capture-{name}")).spawn(move || {
            if let Err(e) = capture_thread(source, producer, &stop, &ready_tx) {
                error!("capture {name} stopped: {e:#}");
                failed.store(true, Ordering::Relaxed);
                // If we failed before signalling readiness, report the error to start().
                let _ = ready_tx.try_send(Err(e));
            }
        })?
    };

    let description = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| anyhow!("capture {name}: timed out starting"))??;
    info!("capture {name}: {description}");
    Ok(Capture { consumer, description, stop, failed, thread: Some(thread) })
}

fn capture_thread(source: Source, mut producer: rtrb::Producer<f32>, stop: &AtomicBool, ready: &std::sync::mpsc::SyncSender<Result<String>>) -> Result<()> {
    wasapi::initialize_mta().ok().context("CoInitializeEx")?;
    set_pro_audio_priority();

    let (mut client, description, fill_gaps) = open_client(&source)?;
    // Capture at the engine's native rate/channel count. WASAPI autoconvert is only
    // used for the sample type: its resampler produces garbage for large ratios
    // (e.g. a 192 kHz Focusrite loopback down to 16 kHz). Downmix + resample here.
    let (rate, channels) = match source {
        // Process loopback clients have no mix format; the engine converts to what we ask.
        Source::Process { .. } => (48_000usize, 2usize),
        _ => {
            let mix = client.get_mixformat().context("get_mixformat")?;
            (mix.get_samplespersec() as usize, mix.get_nchannels() as usize)
        }
    };
    let format = WaveFormat::new(32, 32, &SampleType::Float, rate, channels, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    client.initialize_client(&format, &Direction::Capture, &mode).context("initialize_client")?;
    let event = client.set_get_eventhandle().context("event handle")?;
    let capture = client.get_audiocaptureclient().context("capture client")?;
    let mut resampler = Downsampler::new(rate)?;
    client.start_stream().context("start_stream")?;
    let _ = ready.try_send(Ok(format!("{description} [{rate} Hz, {channels} ch]")));

    let frame_bytes = 4 * channels;
    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(rate * frame_bytes);
    let mut mono: Vec<f32> = Vec::with_capacity(rate);
    let mut out: Vec<f32> = Vec::with_capacity(SAMPLE_RATE as usize);
    let started = Instant::now();
    let mut emitted: usize = 0;
    let mut dropped: usize = 0;

    while !stop.load(Ordering::Relaxed) {
        // Wake at least every 20 ms so gap filling and stop checks stay timely.
        let _ = event.wait_for_event(20);

        loop {
            let frames = match capture.get_next_packet_size()? {
                Some(n) if n > 0 => n as usize,
                _ => break,
            };
            let before = bytes.len();
            let info = capture.read_from_device_to_deque(&mut bytes)?;
            if info.flags.silent {
                // The buffer content is undefined for silent packets.
                for b in bytes.range_mut(before..) {
                    *b = 0;
                }
            }
            if info.flags.data_discontinuity {
                debug!("data discontinuity ({frames} frames)");
            }
        }

        // Interleaved f32 frames -> mono (channel average).
        let n_frames = bytes.len() / frame_bytes;
        if n_frames > 0 {
            let (a, b) = bytes.as_slices();
            let mut iter = a.iter().chain(b.iter()).copied();
            let scale = 1.0 / channels as f32;
            for _ in 0..n_frames {
                let mut acc = 0.0f32;
                for _ in 0..channels {
                    let v = [iter.next().unwrap(), iter.next().unwrap(), iter.next().unwrap(), iter.next().unwrap()];
                    acc += f32::from_le_bytes(v);
                }
                mono.push(acc * scale);
            }
            bytes.drain(..n_frames * frame_bytes);
        }

        out.clear();
        resampler.process(&mut mono, &mut out)?;
        for &s in &out {
            if producer.push(s).is_err() {
                dropped += 1;
            }
        }
        emitted += out.len();

        if fill_gaps {
            // Keep the loopback timeline aligned with wall clock while nothing is playing.
            let expected = (started.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as usize;
            if expected > emitted + GAP_FILL_THRESHOLD {
                let pad = expected - emitted - GAP_FILL_THRESHOLD / 2;
                for _ in 0..pad {
                    if producer.push(0.0).is_err() {
                        dropped += 1;
                    }
                }
                emitted += pad;
            }
        }

        if dropped > 0 {
            warn!("ring buffer full, dropped {dropped} samples (consumer too slow)");
            dropped = 0;
        }
    }
    client.stop_stream()?;
    Ok(())
}

/// Mono downsampler to 16 kHz (FFT-based, fixed input chunks of ~20 ms).
enum Downsampler {
    Passthrough,
    Fft { r: Box<rubato::Fft<f32>>, buf: Vec<f32> },
}

impl Downsampler {
    fn new(rate: usize) -> Result<Downsampler> {
        if rate == SAMPLE_RATE as usize {
            return Ok(Downsampler::Passthrough);
        }
        let chunk = rate / 50;
        let r =
            rubato::Fft::<f32>::new(rate, SAMPLE_RATE as usize, chunk, 1, rubato::FixedSync::Input).map_err(|e| anyhow!("resampler {rate} -> 16000: {e}"))?;
        let buf = vec![0.0; rubato::Resampler::output_frames_max(&r)];
        Ok(Downsampler::Fft { r: Box::new(r), buf })
    }

    /// Consumes whole chunks from `input` (leaves the remainder) and appends output.
    fn process(&mut self, input: &mut Vec<f32>, output: &mut Vec<f32>) -> Result<()> {
        use rubato::Resampler;
        use rubato::audioadapter_buffers::direct::InterleavedSlice;
        match self {
            Downsampler::Passthrough => {
                output.extend_from_slice(input);
                input.clear();
            }
            Downsampler::Fft { r, buf } => {
                let mut off = 0;
                loop {
                    let need = r.input_frames_next();
                    if input.len() - off < need {
                        break;
                    }
                    let inp = InterleavedSlice::new(&input[off..off + need], 1, need).map_err(|e| anyhow!("{e}"))?;
                    let cap = buf.len();
                    let mut outp = InterleavedSlice::new_mut(&mut buf[..], 1, cap).map_err(|e| anyhow!("{e}"))?;
                    let (_, produced) = r.process_into_buffer(&inp, &mut outp, None).map_err(|e| anyhow!("resample: {e}"))?;
                    output.extend_from_slice(&buf[..produced]);
                    off += need;
                }
                input.drain(..off);
            }
        }
        Ok(())
    }
}

/// Returns (client, description, needs gap filling).
fn open_client(source: &Source) -> Result<(AudioClient, String, bool)> {
    let enumerator = wasapi::DeviceEnumerator::new()?;
    match source {
        Source::Mic { device } => {
            let dev = match device.as_deref().filter(|d| !d.is_empty()) {
                None => enumerator.get_default_device(&Direction::Capture)?,
                Some(want) => {
                    let coll = enumerator.get_device_collection(&Direction::Capture)?;
                    let want_lc = want.to_lowercase();
                    let mut found = None;
                    for i in 0..coll.get_nbr_devices()? {
                        let d = coll.get_device_at_index(i)?;
                        if d.get_friendlyname()?.to_lowercase().contains(&want_lc) {
                            found = Some(d);
                            break;
                        }
                    }
                    found.ok_or_else(|| anyhow!("no capture device matching {want:?}"))?
                }
            };
            let name = dev.get_friendlyname()?;
            Ok((dev.get_iaudioclient()?, format!("mic: {name}"), false))
        }
        Source::SystemLoopback => {
            let dev = enumerator.get_default_device(&Direction::Render)?;
            let name = dev.get_friendlyname()?;
            Ok((dev.get_iaudioclient()?, format!("system loopback: {name}"), true))
        }
        Source::Process { name } => {
            let pid = find_root_process(name)?;
            let client = AudioClient::new_application_loopback_client(pid, true)?;
            Ok((client, format!("process loopback: {name} (pid {pid})"), true))
        }
    }
}

/// Finds the root of a process tree by executable name (e.g. the browser process,
/// not its renderer/audio children), so include_tree captures all of it.
fn find_root_process(name: &str) -> Result<u32> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing())).context("sysinfo")?;
    let target = OsStr::new(name);
    let procs: Vec<_> = sys.processes_by_exact_name(target).collect();
    if procs.is_empty() {
        bail!("process {name} is not running");
    }
    let root = procs.iter().find(|p| p.parent().and_then(|pp| sys.process(pp)).map(|pp| pp.name() != target).unwrap_or(true)).unwrap_or(&procs[0]);
    Ok(root.pid().as_u32())
}

/// Registers the thread with MMCSS "Pro Audio" so capture is not starved under load.
fn set_pro_audio_priority() {
    use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
    use windows::core::w;
    let mut task_index = 0u32;
    // SAFETY: valid null-terminated wide string and out pointer.
    if let Err(e) = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) } {
        warn!("MMCSS registration failed: {e}");
    }
}

/// Lists capture device names (for config help).
pub fn list_mics() -> Result<Vec<String>> {
    wasapi::initialize_mta().ok()?;
    let enumerator = wasapi::DeviceEnumerator::new()?;
    let coll = enumerator.get_device_collection(&Direction::Capture)?;
    (0..coll.get_nbr_devices()?).map(|i| Ok(coll.get_device_at_index(i)?.get_friendlyname()?)).collect()
}
