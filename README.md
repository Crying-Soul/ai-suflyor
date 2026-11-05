# Call Assistant

Live call assistant for Windows. A Rust core (`core/`, `call-core.exe`) handles audio capture, the speech pipeline and Claude. A thin Electron UI (`ui/`) shows two overlay windows (live transcript, Claude's hints) and handles hotkeys. They talk over NDJSON on the core's stdio.

Architecture and roadmap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

- [x] Phase 1: core, protocol, Electron thin client, WASAPI capture (mic + system or per-process loopback), level meters, WAV recording
- [x] Phase 2: Silero VAD + whisper FFI (CUDA), final transcripts, latency metrics, decode watchdog
- [x] Phase 3: streaming STT (partials), text processing (`textproc`: hallucinations, repeat loops, hesitations, glossary case, echo dedup)
- [x] Phase 4: Claude client (API key or local Claude Code login), two-tier answers, cancel on a new question. Not done yet: cache prewarm, frozen transcript blocks
- [~] Phase 5: auto-answer in confirmed mode (question heuristic + 250 ms settle, one answer per question). Speculative mode still uses the confirmed path
- [x] UI: separate transcript and hints windows, live rows from speech start with a stable/changing split, question marks, answer history, Russian UI
- [x] Call folders with layered context, saved transcripts and summaries; whisper model manager; in-call window modes
- [x] Phase 6: «Экран + вопрос» sends the foreground window to Claude (code and tasks on screen), unchanged screens not resent; capture-leak fixes and a privacy self-test. OCR dropped: Claude reads the image
- [ ] Phase 7: rolling summary, NSIS installer

## Build and run (PowerShell)

```powershell
# one-time
powershell -ExecutionPolicy Bypass -File scripts\get-whisper.ps1 -Cuda   # whisper.cpp DLLs + model -> .\whisper
copy config.example.json config.json                                     # set anthropicApiKey (userContext and glossary move to «Обо мне» on first run)

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
- Context per call: the chip in the transcript bar opens «Звонки». «Обо мне» (CV, stack) is shared by every call; a folder holds a company or project (vacancy, notes); a call holds its own notes. Each takes notes, a whisper glossary and md/txt/pdf files. «Начать звонок» puts that context into the prompt and saves the transcript, answers and, on «Завершить звонок», a summary that later calls of the folder see. Data lives in `dataDir` (default `Documents\Call Assistant`). `call-core.exe --print-context <call dir>` prints the exact prompt.
- Whisper models: Settings → «Распознавание» downloads, resumes, checks and switches models.
- `vad.minSilenceMs` (default 500): the pause that ends a phrase. Lower is faster, but phrases get cut at commas.
- `vad.earlySilenceMs` (default 250, "them" only): after this much silence the final is decoded speculatively and reused if speech does not resume. It saves about 250 ms per phrase; 0 turns it off.
- Claude connection (`llm.backend`): `api` uses `anthropicApiKey` (or `ANTHROPIC_API_KEY`). `claude-code` uses your Claude Code login and subscription limits, with no key. Install Claude Code natively (`irm https://claude.ai/install.ps1 | iex`, then `claude login`) and keep `claudeCode.command` = `["claude"]`. Or run it from WSL: `["wsl.exe", "-e", "/path/to/claude"]`.
- Settings: the slider button in the transcript window opens a settings window that edits `config.json` (only the changed keys) and restarts the core. Defaults come from `call-core.exe --print-config`.
- `debug.recordWav: true` writes 16 kHz WAV of both streams to `recordings/`.
- The `CALL_CORE_PATH` environment variable overrides the core binary path.
- Installer: `cd ui; npm run dist` (NSIS, bundles `call-core.exe` and the whisper DLLs).

## Testing without a call

- `cargo run --release -p stt --example transcribe -- ..\whisper\whisper.dll ..\whisper\ggml-large-v3-turbo.bin testdata\mid_k8s.wav ru` transcribes a 16 kHz mono WAV. The `PROMPT`, `AUDIO_CTX` and `BEAM` environment variables override decoding options.
- `cargo run --release -p audio --example loopback_probe -- out.wav 10` prints the render device mix format and records native loopback.
- UI screenshots without the core: `cd ui; npm run build; npx electron ..\scripts\shot.js` writes PNGs to `recordings/shots/`.
- UI unit tests: `cd ui; npm test` (the answer Markdown parser).
- End-to-end: `scripts\e2e.ps1` plays `core/testdata/*.wav` through the speakers while the core runs. Or play Windows TTS (`System.Speech`, voice "Microsoft Irina Desktop") while the core runs, so the loopback hears it as "them". Save `.ps1` files with Russian text as **UTF-8 with BOM**, otherwise Windows PowerShell 5 reads them as cp1251 and speaks mojibake.

## Hotkeys

| Keys | Action |
|---|---|
| Ctrl+Shift+Space | Ask Claude about the latest question |
| Ctrl+Shift+S | Screenshot of the active window + ask (code, a task on a shared screen) |
| Ctrl+Shift+A | Toggle auto-answer |
| Ctrl+Shift+H | Hide or show both windows |
| Ctrl+Alt+M | «У камеры»: hints as a strip at the top centre, near the camera |
| Ctrl+Alt+X | Clicks pass through the overlays (again to undo) |
| Ctrl+Alt+O | Opacity 100 / 80 / 60 % (idle overlays fade further after 8 s) |
| Ctrl+Alt+PageUp / PageDown | Older / newer answer |
| Ctrl+Alt+C | Copy the answer on show |
| Ctrl+Alt+= / Ctrl+Alt+- | Larger / smaller text |

Ctrl+Shift+S and Ctrl+Shift+A are also Teams shortcuts; if you use Teams, rebind them in Settings → «Горячие клавиши». The overlays never take keyboard focus.

All windows are excluded from screen sharing, recording and screenshots (`setContentProtection`, Windows 10 2004+); Settings → «Приватность» shows a capture to prove it. Not covered: a camera pointed at the screen, capture cards, the OS file-picker dialog. Use headphones, otherwise the mic picks up the other side. Recording calls may require the other participants' consent, depending on jurisdiction and platform rules.
