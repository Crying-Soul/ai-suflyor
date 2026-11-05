//! cargo run --release -p stt --example transcribe -- <whisper.dll> <model.bin> <file.wav> [lang]
//! WAV must be 16 kHz mono.
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();
    let a: Vec<String> = std::env::args().collect();
    let (dll, model, wav) = (&a[1], &a[2], &a[3]);
    let lang = a.get(4).cloned();
    let mut r = hound::WavReader::open(wav)?;
    let spec = r.spec();
    anyhow::ensure!(spec.sample_rate == 16000 && spec.channels == 1, "need 16 kHz mono, got {spec:?}");
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    let t = Instant::now();
    let w = stt::Whisper::load(dll.as_ref(), model.as_ref(), &stt::ModelOptions { use_gpu: true, gpu_device: 0, flash_attn: true, verbose: false })?;
    let mut st = w.new_state()?;
    eprintln!("load: {:?}", t.elapsed());
    let opts = stt::DecodeOptions {
        language: lang,
        initial_prompt: std::env::var("PROMPT").ok(),
        audio_ctx: std::env::var("AUDIO_CTX").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
        beam_size: std::env::var("BEAM").ok().and_then(|v| v.parse().ok()).unwrap_or(1),
        ..Default::default()
    };
    // warm-up (CUDA kernels), then measure
    st.transcribe(&vec![0.0; 16000], &opts, None)?;
    for i in 0..3 {
        let t = Instant::now();
        let tr = st.transcribe(&samples, &opts, None)?;
        eprintln!("run {i}: {:?} for {:.2} s audio", t.elapsed(), samples.len() as f32 / 16000.0);
        if i == 0 {
            for s in &tr.segments {
                println!("[ns {:.2} lp {:.2}] {}", s.no_speech_prob, s.avg_logprob, s.text);
            }
            println!("lang: {}", tr.language);
        }
    }
    Ok(())
}
