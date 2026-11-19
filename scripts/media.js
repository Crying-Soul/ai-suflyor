// Dev-only: README media from mock events (no core needed). Each scene opens fresh windows, streams
// core events into them, captures frames and writes .github/media/<scene>.gif with a caption strip.
// Run after `npm run build` in ui/: ui\node_modules\.bin\electron scripts\media.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { GIFEncoder, quantize, applyPalette } = require("../ui/node_modules/gifenc");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
const dist = path.resolve(__dirname, "../ui/dist");
const out = path.resolve(__dirname, "../.github/media");
const wp = { preload: path.join(dist, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 1000;
const status = (translate = false) => ({ ev: "status", me: { state: "running", source: "mic: Focusrite USB" }, them: { state: "running", source: "system loopback: Speakers" }, stt: "ready (gpu)", auto: true, model: "claude-sonnet-5-5", answer_mode: "confirmed", translate, mute_me: false, mute_them: false, busy: false });
const call = { ev: "call", dir: "C:\\Users\\me\\Documents\\Suflyor\\folders\\yandex\\calls\\2026-11-05-1200-sys", title: "Системный дизайн", folder: "Яндекс Маркет", tokens: 5320, parts: [], warnings: [] };

const PAD = 28, GAP = 20, CAP = 52;
const BG = [17, 17, 19];
const NO_MOTION = "*, *::before, *::after { animation: none !important; transition: none !important; }";

/** Windows hand back BGRA; gifenc takes RGBA. */
function blit(dst, dw, img, x0, y0) {
  const { width, height } = img.getSize();
  const src = img.toBitmap();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = ((y0 + y) * dw + x0 + x) * 4;
    dst[d] = src[s + 2]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s]; dst[d + 3] = 255;
  }
}

async function page(file, w, h) {
  const win = new BrowserWindow({ width: w, height: h, frame: false, show: false, backgroundColor: "#0c0b0a", webPreferences: wp });
  await win.loadFile(path.join(dist, file), { query: { theme: "prompter" } });
  // A hidden window's compositor never runs CSS animations: entering cards would stay at opacity 0.
  await win.webContents.insertCSS(NO_MOTION);
  return win;
}
async function html(body, w, h) {
  const win = new BrowserWindow({ width: w, height: h, frame: false, show: false, backgroundColor: "#111113", webPreferences: { sandbox: true } });
  // A temp file, not a data: URL: long data URLs fail to load (ERR_FAILED).
  const file = path.join(require("os").tmpdir(), `suflyor-media-${w}x${h}-${Date.now()}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0">${body}`);
  await win.loadFile(file);
  fs.rmSync(file);
  return win;
}

/**
 * A scene: windows laid out left to right, a caption under them, frames into one GIF.
 * `panes`: [{win, w, h}]. Returns helpers to send events, set the caption and add frames.
 */
async function scene(name, panes) {
  const H = PAD * 2 + Math.max(...panes.map((p) => p.h)) + CAP;
  const W = PAD * 2 + panes.reduce((s, p) => s + p.w, 0) + GAP * (panes.length - 1);
  const cap = await html(`<div id="c" style="height:${CAP}px;display:flex;align-items:center;gap:12px;padding:0 ${PAD}px;background:#111113;color:#ecebe8;font:500 15px/1.3 'Segoe UI',sans-serif"></div>`, W, CAP);
  const gif = GIFEncoder();
  let last = null;
  const flush = () => {
    const palette = quantize(last.c, 256);
    gif.writeFrame(applyPalette(last.c, palette), W, H, { palette, delay: last.ms });
  };
  return {
    async caption(step, text) {
      const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
      await cap.webContents.executeJavaScript(`document.getElementById("c").innerHTML = ${JSON.stringify(`<b style="flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#f0b44c;color:#1a1408;font-size:13px">${step}</b><span>${esc(text)}</span>`)}`);
    },
    /** One frame shown for `ms`; an unchanged frame only extends the previous one. */
    async frame(ms) {
      await wait(70);
      const c = new Uint8Array(W * H * 4);
      for (let i = 0; i < c.length; i += 4) c.set([...BG, 255], i);
      let x = PAD;
      for (const p of panes) {
        blit(c, W, await p.win.webContents.capturePage(), x, PAD);
        x += p.w + GAP;
      }
      blit(c, W, await cap.webContents.capturePage(), 0, H - CAP - PAD / 2);
      if (last && Buffer.compare(Buffer.from(last.c), Buffer.from(c)) === 0) return void (last.ms += ms);
      if (last) flush();
      last = { c, ms };
    },
    finish() {
      flush();
      gif.finish();
      fs.writeFileSync(path.join(out, `${name}.gif`), gif.bytes());
      console.log(`${name}.gif: ${(gif.bytes().length / 1e6).toFixed(1)} MB`);
      // Windows stay until quit: a new window right after destroy() can land on the dying renderer and fail with ERR_FAILED.
    },
  };
}

const send = (ws, ...evs) => { for (const e of evs) for (const w of ws) w.webContents.send("core-event", e); };

/** Speech streaming into the transcript: a partial grows two words at a time, then the final. */
async function speak(s, ws, speaker, t, text, question, ms = 140) {
  send(ws, { ev: "vad", speaker, active: true, t }, { ev: "level", speaker, rms: 0.12, peak: 0.4 });
  const words = text.split(" ");
  for (let i = 1; i < words.length; i += 2) {
    const k = Math.max(0, i - 2);
    send(ws, { ev: "partial", speaker, t, stable: words.slice(0, k).join(" "), tail: words.slice(k, i + 1).join(" ") });
    await s.frame(ms);
  }
  send(ws, { ev: "vad", speaker, active: false, t }, { ev: "level", speaker, rms: 0, peak: 0 }, { ev: "final", speaker, t, text, question });
}

/** An answer: the quick line streams in pairs of words, then the full answer line by line. */
async function answer(s, ws, { turn, trigger, question, q_t, quick, full }) {
  send(ws, { ev: "answer_start", id: turn * 10, turn, trigger, question, q_t, tier: "quick" }, { ev: "metrics", name: "answer_first_token_quick", ms: 840 });
  const qw = quick.split(" ");
  for (let i = 0; i < qw.length; i += 2) {
    send(ws, { ev: "answer_delta", id: turn * 10, text: (i ? " " : "") + qw.slice(i, i + 2).join(" ") });
    await s.frame(110);
  }
  send(ws, { ev: "answer_start", id: turn * 10 + 1, turn, trigger, question, q_t, tier: "full" });
  for (const line of full) {
    send(ws, { ev: "answer_delta", id: turn * 10 + 1, text: line });
    await s.frame(420);
  }
  send(ws, { ev: "answer_end", id: turn * 10 + 1 });
}

const TR = { w: 420, h: 600 }, HI = { w: 460, h: 600 };

async function workflow() {
  const tr = await page("transcript.html", TR.w, TR.h), hi = await page("hints.html", HI.w, HI.h);
  const ws = [tr, hi];
  send(ws, status(), call);
  const s = await scene("workflow", [{ win: tr, ...TR }, { win: hi, ...HI }]);
  await s.caption(1, "Собеседник говорит: Whisper распознаёт речь на вашей видеокарте, слово за словом");
  await s.frame(900);
  const Q = "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?";
  await speak(s, ws, "them", T, Q, true);
  await s.caption(2, "Вопрос пойман: через секунду приходит короткий ответ, следом подробный");
  await s.frame(900);
  await answer(s, ws, {
    turn: 1, trigger: "auto", question: Q, q_t: T,
    quick: "Конкурентный tri-color mark-and-sweep без поколений, паузы обычно до миллисекунды.",
    full: ["- Go: не перемещает объекты, нет поколений, работает параллельно с программой.\n", "- Java: G1/ZGC с поколениями и уплотнением, больше настроек.\n", "- В Go главный рычаг: `GOGC` и `GOMEMLIMIT`."],
  });
  await s.frame(1600);
  await s.caption(3, "Вы отвечаете своими словами: ваша речь тоже попадает в транскрипт");
  await speak(s, ws, "me", T + 9000, "В Go сборщик конкурентный и без поколений, поэтому паузы короткие, а настраивается он через GOGC и GOMEMLIMIT.", false, 160);
  await s.frame(2600);
  s.finish();
}

async function screen() {
  const SH = { w: 560, h: 600 };
  const code = `<div style="height:600px;box-sizing:border-box;padding:18px 22px;background:#1e1f24;color:#d7dae0;font:14px/1.6 Consolas,monospace">
<div style="font:600 15px 'Segoe UI',sans-serif;color:#fff;margin-bottom:6px">Задача 2. Шардирование заказов</div>
<div style="font:13px/1.5 'Segoe UI',sans-serif;color:#a4a9b3;margin-bottom:14px">Заказы раскладываются по шардам. Что сломается, когда шардов станет больше?</div>
<pre style="margin:0;white-space:pre-wrap"><span style="color:#c586c0">type</span> Router <span style="color:#c586c0">struct</span> {
    shards []*sql.DB
}

<span style="color:#c586c0">func</span> (r *Router) <span style="color:#dcdcaa">ShardFor</span>(userID <span style="color:#4ec9b0">uint64</span>) *sql.DB {
    i := userID % <span style="color:#dcdcaa">uint64</span>(<span style="color:#dcdcaa">len</span>(r.shards))
    <span style="color:#c586c0">return</span> r.shards[i]
}

<span style="color:#c586c0">func</span> (r *Router) <span style="color:#dcdcaa">AddShard</span>(db *sql.DB) {
    r.shards = <span style="color:#dcdcaa">append</span>(r.shards, db)
}</pre></div>`;
  const sh = await html(code, SH.w, SH.h), hi = await page("hints.html", HI.w, HI.h);
  send([hi], status(), call);
  const s = await scene("screen", [{ win: sh, ...SH }, { win: hi, ...HI }]);
  await s.caption(1, "Интервьюер показывает задачу на общем экране");
  await s.frame(1800);
  await s.caption(2, "Ctrl+Shift+S: снимок активного окна уходит в Claude вместе с последним вопросом");
  hi.webContents.send("ui", { kind: "looking" });
  await s.frame(1200);
  const thumb = (await sh.webContents.capturePage()).resize({ width: 320 }).toDataURL();
  send([hi], { ev: "screenshot", turn: 1, width: SH.w, height: SH.h, thumb });
  await s.frame(600);
  await s.caption(3, "Разбор задачи: что не так и как исправить");
  await answer(s, [hi], {
    turn: 1, trigger: "screen", question: "", q_t: T,
    quick: "Ошибка: hash % n ломает раскладку при добавлении шарда, почти все ключи переедут.",
    full: ["- Добавили шард: `userID % len` меняется у ~всех пользователей.\n", "- Исправить: consistent hashing или таблица маршрутизации user → shard.\n", "- Переезд данных тогда O(k/n), а не всей базы."],
  });
  await s.frame(3000);
  s.finish();
}

async function english() {
  const tr = await page("transcript.html", TR.w, TR.h), hi = await page("hints.html", HI.w, HI.h);
  const ws = [tr, hi];
  send(ws, status(true), call);
  const s = await scene("english", [{ win: tr, ...TR }, { win: hi, ...HI }]);
  await s.caption(1, "Собеседование на английском: речь распознаётся как есть");
  await s.frame(900);
  const Q = "How would you design a rate limiter for a public API with millions of users?";
  await speak(s, ws, "them", T, Q, true);
  await s.caption(2, "Перевод на русский через Claude Haiku, термины остаются по-английски");
  send(ws, { ev: "translation", ts: [T], text: "Как бы вы спроектировали rate limiter для публичного API с миллионами пользователей?" });
  await s.frame(1400);
  await s.caption(3, "Подсказка приходит на русском, как и на обычном собеседовании");
  await answer(s, ws, {
    turn: 1, trigger: "auto", question: Q, q_t: T,
    quick: "Token bucket на пользователя в Redis, проверка атомарным Lua-скриптом на шлюзе.",
    full: ["- Ключ: user_id или API key, лимиты по тарифу.\n", "- Redis Cluster, INCR + EXPIRE или Lua для token bucket.\n", "- Ответ 429 с `Retry-After`, локальный кэш на шлюзе от горячих ключей."],
  });
  await s.frame(3000);
  s.finish();
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  ipcMain.handle("ready:list", () => [{ id: "whisper", level: "required", ok: true, title: "", why: "" }]);
  ipcMain.handle("hotkeys:get", () => ({ ask: "CommandOrControl+Shift+Space", screenshotAsk: "CommandOrControl+Shift+S" }));
  ipcMain.handle("calls:current", () => null);
  // SCENES=screen,english renders only those.
  const only = process.env.SCENES?.split(",");
  for (const [name, run] of Object.entries({ workflow, screen, english })) if (!only || only.includes(name)) await run();
  app.quit();
});
