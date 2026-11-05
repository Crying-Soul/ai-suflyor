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
const callEv = { ev: "call", dir: "C:\\Users\\me\\Documents\\Call Assistant\\folders\\yandex\\calls\\2026-11-05-1200-sys", title: "Системный дизайн", folder: "Яндекс Маркет", tokens: 5320, parts: [], warnings: [] };
const live = [
  status,
  callEv,
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
  const M = (id, label, sizeMb, note, state, extra = {}) => ({ id, label, sizeMb, note, state, received: 0, total: 0, active: false, ...extra });
  ipcMain.handle("models:list", () => [
    M("large-v3-turbo", "Large v3 Turbo", 1620, "Лучшее соотношение: почти как Large v3, в разы быстрее. По умолчанию.", "installed", { active: true }),
    M("large-v3-turbo-q8_0", "Large v3 Turbo, q8", 874, "Та же точность, вдвое меньше памяти.", "downloading", { received: 380e6, total: 874e6 }),
    M("large-v3-turbo-q5_0", "Large v3 Turbo, q5", 574, "Для слабых GPU, точность чуть ниже.", "partial", { received: 120e6 }),
    M("large-v3", "Large v3", 3100, "Самая точная и самая медленная. Нужен мощный GPU.", "absent", { error: "получено 1200 из 3100 байт" }),
    M("small", "Small", 488, "Быстрая на CPU, ошибается в терминах.", "installed"),
    M("base", "Base", 148, "Только проверить, что всё работает.", "absent"),
  ]);
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
  // A question with no answer: the transcript's apricot strip shows after 1.5 s.
  send([tr, hi], [{ ev: "vad", speaker: "them", active: true, t: T + 15000 }, { ev: "final", speaker: "them", t: T + 15000, text: "А как вы бы спроектировали rate limiter?", question: true }]);
  await wait(1800);
  await shot(tr, "transcript-owed.png");
  // «У камеры»: the hints as a strip; then click-through on the transcript.
  hi.setSize(640, 168);
  hi.webContents.send("ui", { kind: "mode", mini: true, clickThrough: false });
  await shot(hi, "hints-mini.png");
  hi.setSize(460, 560);
  hi.webContents.send("ui", { kind: "mode", mini: false, clickThrough: false });
  hi.webContents.send("ui", { kind: "nav", dir: -1 });
  await shot(hi, "hints-nav.png");
  hi.webContents.send("ui", { kind: "nav", dir: 1 });
  tr.webContents.send("ui", { kind: "mode", mini: false, clickThrough: true });
  await shot(tr, "transcript-through.png");
  tr.webContents.send("ui", { kind: "mode", mini: false, clickThrough: false });
  await shot(hi, "hints-caught.png");
  const s = new BrowserWindow({ width: 820, height: 640, show: false, titleBarStyle: "hidden", backgroundColor: "#13151b", webPreferences: wp });
  await s.loadFile(path.join(dist, "settings.html"));
  await shot(s, "settings-context.png");
  for (const id of ["answers", "speech", "stt"]) {
    await s.webContents.executeJavaScript(`document.querySelector('[data-section="${id}"]').click()`);
    await shot(s, `settings-${id}.png`);
  }
  await s.webContents.executeJavaScript(`document.querySelector('#f-vad-minSilenceMs').value='450'; document.querySelector('#form').dispatchEvent(new Event('input'))`);
  await shot(s, "settings-dirty.png");

  // «Звонки» with mock storage.
  const D = "C:\\Users\\me\\Documents\\Call Assistant";
  const Y = `${D}\\folders\\yandex`;
  const tree = {
    dataDir: D,
    profile: `${D}\\profile`,
    folders: [
      { dir: Y, title: "Яндекс Маркет", calls: [{ dir: callEv.dir, title: "Системный дизайн", hasSummary: false }, { dir: `${Y}\\calls\\2026-11-01-1000-hr`, title: "HR-скрининг", hasSummary: true }] },
      { dir: `${D}\\folders\\ozon`, title: "Ozon, платформа", calls: [] },
    ],
  };
  const nodes = {
    [tree.profile]: { dir: tree.profile, kind: "profile", title: "Обо мне", context: "Backend на Go, 6 лет. Ozon: шардирование PostgreSQL, Kafka, 40k RPS.\nТинькофф: платёжный шлюз, p99 12 мс.", glossary: ["Go", "Kafka", "PostgreSQL"], files: [{ name: "cv.pdf", size: 44686, tokens: 1840 }] },
    [callEv.dir]: {
      dir: callEv.dir, kind: "call", title: "Системный дизайн", started: "2026-11-05T09:00:00Z", context: "Интервьюер: Анна, тимлид склада.\nСпросить про on-call и релизный цикл.", glossary: ["YDB"], files: [], summary: "", answers: 2,
      transcript: [{ speaker: "them", t: 1, text: "Как бы вы шардировали заказы?" }, { speaker: "me", t: 2, text: "По user_id, с отдельной таблицей маршрутизации." }],
    },
    [`${Y}\\calls\\2026-11-01-1000-hr`]: { dir: `${Y}\\calls\\2026-11-01-1000-hr`, kind: "call", title: "HR-скрининг", started: "2026-11-01T07:00:00Z", context: "", glossary: [], files: [], answers: 4, transcript: [{ speaker: "them", t: 1, text: "Какие у вас ожидания по зарплате?" }], summary: "## Темы\n- Мотивация, переезд не нужен.\n\n## Вопросы и ответы\n- **Зарплата:** назвал 450k, готов обсуждать.\n\n## Договорённости\n- Техсекция на следующей неделе." },
  };
  let current = null;
  ipcMain.handle("calls:tree", () => tree);
  ipcMain.handle("calls:node", (_e, dir) => nodes[dir] ?? { dir, kind: "folder", title: "Яндекс Маркет", context: "", glossary: ["YDB"], files: [{ name: "vacancy.md", size: 1200, tokens: 410 }] });
  ipcMain.handle("calls:current", () => current);
  ipcMain.handle("calls:preview", () => "≈5320 токенов. Глоссарий: YDB, Go, Kafka\n\n<about_user>\nBackend на Go, 6 лет.\n</about_user>");
  const c = new BrowserWindow({ width: 1040, height: 720, show: false, titleBarStyle: "hidden", backgroundColor: "#13151b", webPreferences: wp });
  await c.loadFile(path.join(dist, "calls.html"));
  await shot(c, "calls-profile.png");
  await c.webContents.executeJavaScript(`document.querySelector('[data-dir$="2026-11-01-1000-hr"]').click()`);
  await shot(c, "calls-summary.png");
  c.webContents.send("core-event", callEv);
  await c.webContents.executeJavaScript(`document.querySelector('[data-dir$="2026-11-05-1200-sys"]').click()`);
  await shot(c, "calls-live.png");
  await c.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Предпросмотр контекста').click()`);
  await shot(c, "calls-preview.png");
  app.quit();
});
