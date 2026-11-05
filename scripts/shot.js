// Dev-only: renders the overlay and settings with demo data and saves PNGs (no core needed).
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const dist = path.resolve(__dirname, "../ui/dist");
const out = path.resolve(__dirname, "../recordings/shots");
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf8"));
const wp = { preload: path.join(dist, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = { ev: "status", me: { state: "running", source: "mic: Focusrite USB (2- Focusrite USB Audio) [48000 Hz, 2 ch]" }, them: { state: "running", source: "system loopback: Speakers [192000 Hz, 2 ch]" }, stt: "ready (gpu)", auto: true, model: "claude-sonnet-5-5", answer_mode: "confirmed", busy: false };
const T = 1000;
// Live phase: speech just started, then a partial with a settled prefix, then a question final.
const live = [
  status,
  { ev: "level", speaker: "them", rms: 0.1, peak: 0.4 }, { ev: "level", speaker: "me", rms: 0.01, peak: 0.03 },
  { ev: "final", speaker: "them", t: T, text: "А какой у вас опыт с Kubernetes и PostgreSQL в продакшене?", question: true },
  { ev: "final", speaker: "me", t: T + 5000, text: "Да, около четырёх лет, в основном на EKS.", question: false },
  { ev: "vad", speaker: "them", active: true, t: T + 9000 },
  { ev: "partial", speaker: "them", t: T + 9000, stable: "Расскажите, как работает", tail: "сборщик мусора в" },
  { ev: "vad", speaker: "me", active: true, t: T + 12000 },
];
const done = [
  { ev: "final", speaker: "them", t: T + 9000, text: "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?", question: true },
  { ev: "partial", speaker: "me", t: T + 12000, stable: "Сборщик мусора", tail: "в Go" },
  { ev: "answer_start", id: 1, turn: 1, trigger: "auto", question: "А какой у вас опыт с Kubernetes и PostgreSQL в продакшене?", q_t: T, tier: "quick" },
  { ev: "answer_delta", id: 1, text: "Четыре года на EKS: Helm, автоскейлинг, PostgreSQL через оператор." },
  { ev: "answer_start", id: 2, turn: 1, trigger: "auto", question: "А какой у вас опыт с Kubernetes и PostgreSQL в продакшене?", q_t: T, tier: "full" },
  { ev: "answer_delta", id: 2, text: "- Kubernetes: EKS, Helm, HPA\n- PostgreSQL: **CloudNativePG**, бэкапы в S3" },
  { ev: "answer_end", id: 2 },
  { ev: "answer_start", id: 4, turn: 3, trigger: "auto", question: "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?", q_t: T + 9000, tier: "quick" },
  { ev: "answer_delta", id: 4, text: "Конкурентный tri-color mark-and-sweep без поколений, паузы обычно до миллисекунды." },
  { ev: "answer_start", id: 5, turn: 3, trigger: "auto", question: "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?", q_t: T + 9000, tier: "full" },
  { ev: "answer_delta", id: 5, text: "- Go: не перемещает объекты, нет поколений, работает параллельно с программой.\n- Java: G1/ZGC с поколениями и уплотнением, больше настроек.\n- В Go главный рычаг: `GOGC` и `GOMEMLIMIT`." },
  { ev: "metrics", name: "answer_first_token_quick", ms: 840 },
  { ev: "metrics", name: "stt_decode", ms: 312 }, { ev: "metrics", name: "speech_end_to_final", ms: 712 },
];
async function shot(w, name) { await wait(700); fs.writeFileSync(path.join(out, name), (await w.webContents.capturePage()).toPNG()); }
const send = (ws, evs) => { for (const e of evs) for (const w of ws) w.webContents.send("core-event", e); };
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  ipcMain.handle("config:load", () => ({ path: "C:\\dev\\interviewer\\config.json", raw: cfg, effective: cfg }));
  ipcMain.handle("config:mics", () => ["Focusrite USB (2- Focusrite USB Audio)", "Microphone (Realtek High Definition Audio)"]);
  ipcMain.handle("config:save", () => ({ ok: true, path: "C:\\dev\\interviewer\\config.json" }));
  const tr = new BrowserWindow({ width: 420, height: 640, frame: false, show: false, backgroundColor: "#13151b", webPreferences: wp });
  const hi = new BrowserWindow({ width: 460, height: 560, frame: false, show: false, backgroundColor: "#13151b", webPreferences: wp });
  await tr.loadFile(path.join(dist, "transcript.html"));
  await hi.loadFile(path.join(dist, "hints.html"));
  await shot(tr, "transcript-empty.png");
  await shot(hi, "hints-empty.png");
  send([tr, hi], live);
  await shot(tr, "transcript-live.png");
  await shot(hi, "hints-listening.png");
  send([tr, hi], done);
  await wait(500);
  await shot(tr, "transcript-full.png");
  await shot(hi, "hints-full.png");
  const s = new BrowserWindow({ width: 820, height: 640, show: false, titleBarStyle: "hidden", backgroundColor: "#13151b", webPreferences: wp });
  await s.loadFile(path.join(dist, "settings.html"));
  await shot(s, "settings-context.png");
  for (const id of ["answers", "speech"]) {
    await s.webContents.executeJavaScript(`document.querySelector('[data-section="${id}"]').click()`);
    await shot(s, `settings-${id}.png`);
  }
  await s.webContents.executeJavaScript(`document.querySelector('#f-vad-minSilenceMs').value='450'; document.querySelector('#form').dispatchEvent(new Event('input'))`);
  await shot(s, "settings-dirty.png");
  app.quit();
});
