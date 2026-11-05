//! Prints the default render device mix format and records N seconds of loopback
//! in that native format (no autoconvert) to the given WAV.
//! cargo run --release -p audio --example loopback_probe -- out.wav 12
use std::collections::VecDeque;
use wasapi::*;

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let secs: f32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(10.0);
    initialize_mta().ok()?;
    let en = DeviceEnumerator::new()?;
    let dev = en.get_default_device(&Direction::Render)?;
    let mut client = dev.get_iaudioclient()?;
    let mix = client.get_mixformat()?;
    println!("device: {}", dev.get_friendlyname()?);
    println!("mix format: {mix:?}");
    let ch = mix.get_nchannels() as usize;
    let rate = mix.get_samplespersec();
    let bits = mix.get_bitspersample();
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, rate as usize, ch, None);
    client.initialize_client(&fmt, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
    let ev = client.set_get_eventhandle()?;
    let cap = client.get_audiocaptureclient()?;
    client.start_stream()?;
    let mut q = VecDeque::new();
    let mut w = hound::WavWriter::create(&a[1], hound::WavSpec { channels: ch as u16, sample_rate: rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float })?;
    let t = std::time::Instant::now();
    let (mut packets, mut silent, mut frames) = (0, 0, 0usize);
    while t.elapsed().as_secs_f32() < secs {
        let _ = ev.wait_for_event(50);
        while let Some(n) = cap.get_next_packet_size()? { if n == 0 { break; }
            let info = cap.read_from_device_to_deque(&mut q)?;
            packets += 1; frames += n as usize; if info.flags.silent { silent += 1; }
        }
        while q.len() >= 4 { let b = [q.pop_front().unwrap(), q.pop_front().unwrap(), q.pop_front().unwrap(), q.pop_front().unwrap()]; w.write_sample(f32::from_le_bytes(b))?; }
    }
    w.finalize()?;
    println!("bits {bits}, packets {packets}, silent {silent}, frames {frames} ({:.2} s of audio in {:.2} s)", frames as f32 / rate as f32, t.elapsed().as_secs_f32());
    Ok(())
}
