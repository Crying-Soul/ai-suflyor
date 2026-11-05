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
const demo = [
  status,
  { ev: "level", speaker: "them", rms: 0.1, peak: 0.4 }, { ev: "level", speaker: "me", rms: 0.01, peak: 0.03 },
  { ev: "vad", speaker: "them", active: true },
  { ev: "final", speaker: "them", seg: 1, t: 0, text: "А какой у вас опыт с Kubernetes и PostgreSQL в продакшене?" },
  { ev: "final", speaker: "me", seg: 2, t: 0, text: "Да, около четырёх лет, в основном на EKS." },
  { ev: "final", speaker: "them", seg: 3, t: 0, text: "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?" },
  { ev: "partial", speaker: "me", seg: 4, text: "Сборщик мусора в Go" },
  { ev: "answer_start", id: 1, trigger: "auto", question: "Как работает сборщик мусора в Go?", tier: "quick" },
  { ev: "answer_delta", id: 1, text: "Конкурентный tri-color mark-and-sweep без поколений, паузы обычно до миллисекунды." },
  { ev: "answer_start", id: 2, trigger: "auto", question: "Как работает сборщик мусора в Go и чем он отличается от Java?", tier: "full" },
  { ev: "answer_delta", id: 2, text: "- Go: не перемещает объекты, нет поколений, работает параллельно с программой.\n- Java: G1/ZGC с поколениями и уплотнением, больше настроек.\n- В Go главный рычаг: GOGC и GOMEMLIMIT." },
  { ev: "metrics", name: "stt_decode", ms: 312 }, { ev: "metrics", name: "speech_end_to_final", ms: 712 },
];
async function shot(w, name) { await wait(700); fs.writeFileSync(path.join(out, name), (await w.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  ipcMain.handle("config:load", () => ({ path: "C:\\dev\\interviewer\\config.json", raw: cfg, effective: cfg }));
  ipcMain.handle("config:mics", () => ["Focusrite USB (2- Focusrite USB Audio)", "Microphone (Realtek High Definition Audio)"]);
  ipcMain.handle("config:save", () => ({ ok: true, path: "C:\\dev\\interviewer\\config.json" }));
  const o = new BrowserWindow({ width: 460, height: 720, frame: false, transparent: true, show: false, webPreferences: wp });
  await o.loadFile(path.join(dist, "index.html"));
  await shot(o, "overlay-empty.png");
  for (const e of demo) o.webContents.send("core-event", e);
  await wait(2000);
  await shot(o, "overlay-full.png");
  console.log("auto:", await o.webContents.executeJavaScript(`(() => { const b = document.getElementById('btn-auto'); return b.getAttribute('aria-checked') + ' ' + getComputedStyle(b, '::before').backgroundColor; })()`));
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
