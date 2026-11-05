# Call Assistant

Live call assistant for Windows. A Rust core (`core/`, `call-core.exe`) handles audio capture, the speech pipeline and Claude. A thin Electron overlay (`ui/`) shows the window and handles hotkeys. They talk over NDJSON on the core's stdio.

Architecture and roadmap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

- [x] Phase 1: core, protocol, Electron thin client, WASAPI capture (mic + system or per-process loopback), level meters, WAV recording
- [x] Phase 2: Silero VAD + whisper FFI (CUDA), final transcripts, latency metrics, decode watchdog
- [x] Phase 3: streaming STT (partials), text processing (`textproc`: hallucinations, repeat loops, hesitations, glossary case, echo dedup)
- [x] Phase 4: Claude client (API key or local Claude Code login), two-tier answers, cancel on a new question. Not done yet: cache prewarm, frozen transcript blocks
- [~] Phase 5: auto-answer in confirmed mode (question heuristic + 250 ms settle, one answer per question). Speculative mode still uses the confirmed path
- [ ] Phase 6: screenshots + Windows OCR
- [ ] Phase 7: rolling summary, NSIS installer

## Build and run (PowerShell)

```powershell
# one-time
powershell -ExecutionPolicy Bypass -File scripts\get-whisper.ps1 -Cuda   # whisper.cpp DLLs + model -> .\whisper
copy config.example.json config.json                                     # set anthropicApiKey, userContext

# core
cargo build --release --manifest-path core\Cargo.toml

# UI (spawns core\target\release\call-core.exe)
cd ui
npm install
npm start
```

Useful:

- `core\target\release\call-core.exe --list-mics` lists microphone names for `audio.micDevice`, which matches on a substring.
- `audio.themSource`: `"system"` (all system audio) or `"process:chrome.exe"` (one app only, Windows 10 2004+).
- `glossary`: terms passed to whisper as a spelling hint (Kubernetes, PostgreSQL…).
- `vad.minSilenceMs` (default 500): the pause that ends a phrase. Lower is faster, but phrases get cut at commas.
- `vad.earlySilenceMs` (default 250, "them" only): after this much silence the final is decoded speculatively and reused if speech does not resume. It saves about 250 ms per phrase; 0 turns it off.
- Claude connection (`llm.backend`): `api` uses `anthropicApiKey` (or `ANTHROPIC_API_KEY`). `claude-code` uses your Claude Code login and subscription limits, with no key. Install Claude Code natively (`irm https://claude.ai/install.ps1 | iex`, then `claude login`) and keep `claudeCode.command` = `["claude"]`. Or run it from WSL: `["wsl.exe", "-e", "/path/to/claude"]`.
- Settings: the slider button in the overlay opens a settings window that edits `config.json` (only the changed keys) and restarts the core. Defaults come from `call-core.exe --print-config`.
- `debug.recordWav: true` writes 16 kHz WAV of both streams to `recordings/`.
- The `CALL_CORE_PATH` environment variable overrides the core binary path.
- Installer: `cd ui; npm run dist` (NSIS, bundles `call-core.exe` and the whisper DLLs).

## Testing without a call

- `cargo run --release -p stt --example transcribe -- ..\whisper\whisper.dll ..\whisper\ggml-large-v3-turbo.bin testdata\mid_k8s.wav ru` transcribes a 16 kHz mono WAV. The `PROMPT`, `AUDIO_CTX` and `BEAM` environment variables override decoding options.
- `cargo run --release -p audio --example loopback_probe -- out.wav 10` prints the render device mix format and records native loopback.
- End-to-end: play Windows TTS (`System.Speech`, voice "Microsoft Irina Desktop") while the core runs, so the loopback hears it as "them". Save `.ps1` files with Russian text as **UTF-8 with BOM**, otherwise Windows PowerShell 5 reads them as cp1251 and speaks mojibake.

## Hotkeys

| Keys | Action |
|---|---|
| Ctrl+Shift+Space | Ask Claude about the latest question |
| Ctrl+Shift+S | Screenshot + ask |
| Ctrl+Shift+A | Toggle auto-answer |
| Ctrl+Shift+H | Hide or show the overlay |

The overlay is excluded from screen sharing and screenshots (`setContentProtection`). Use headphones, otherwise the mic picks up the other side. Recording calls may require the other participants' consent, depending on jurisdiction and platform rules.
