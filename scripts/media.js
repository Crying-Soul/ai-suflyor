// Dev-only: README media from mock events (no core needed). Writes .github/media/demo.gif (a question
// streams in, the answer streams out, then the themes switch) and themes.png (the hints in every theme).
// Run after `npm run build` in ui/: ui\node_modules\.bin\electron scripts\media.js
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { GIFEncoder, quantize, applyPalette } = require("../ui/node_modules/gifenc");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
const dist = path.resolve(__dirname, "../ui/dist");
const out = path.resolve(__dirname, "../.github/media");
const wp = { preload: path.join(dist, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 1000;
const Q = "Расскажите, как работает сборщик мусора в Go и чем он отличается от Java?";
const status = { ev: "status", me: { state: "running", source: "mic: Focusrite USB" }, them: { state: "running", source: "system loopback: Speakers" }, stt: "ready (gpu)", auto: true, model: "claude-sonnet-5-5", answer_mode: "confirmed", translate: false, mute_me: false, mute_them: false, busy: false };
const call = { ev: "call", dir: "C:\\Users\\me\\Documents\\Suflyor\\folders\\yandex\\calls\\2026-11-05-1200-sys", title: "Системный дизайн", folder: "Яндекс Маркет", tokens: 5320, parts: [], warnings: [] };
const QUICK = "Конкурентный tri-color mark-and-sweep без поколений, паузы обычно до миллисекунды.";
const FULL = ["- Go: не перемещает объекты, нет поколений, работает параллельно с программой.\n", "- Java: G1/ZGC с поколениями и уплотнением, больше настроек.\n", "- В Go главный рычаг: `GOGC` и `GOMEMLIMIT`."];

// Stage: the two overlays side by side on a dark backdrop, as they sit next to a call.
const PAD = 32, GAP = 24;
const TR = { w: 420, h: 600 }, HI = { w: 460, h: 600 };
const W = PAD * 2 + TR.w + GAP + HI.w, H = PAD * 2 + TR.h;
const BG = [17, 17, 19];

/** Windows hand back BGRA; gifenc and PNG output here take RGBA. */
function blit(dst, dw, img, x0, y0) {
  const { width, height } = img.getSize();
  const src = img.toBitmap();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = ((y0 + y) * dw + x0 + x) * 4;
    dst[d] = src[s + 2]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s]; dst[d + 3] = 255;
  }
}
function canvas(w, h) {
  const c = new Uint8Array(w * h * 4);
  for (let i = 0; i < c.length; i += 4) c.set([...BG, 255], i);
  return c;
}
function png(rgba, w, h, file) {
  const bgra = Buffer.from(rgba);
  for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
  fs.writeFileSync(path.join(out, file), nativeImage.createFromBitmap(bgra, { width: w, height: h }).toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  ipcMain.handle("ready:list", () => [{ id: "whisper", level: "required", ok: true, title: "", why: "" }]);
  ipcMain.handle("hotkeys:get", () => ({ ask: "CommandOrControl+Shift+Space", screenshotAsk: "CommandOrControl+Shift+S" }));
  ipcMain.handle("calls:current", () => null);
  const open = async (file, { w, h }) => {
    const win = new BrowserWindow({ width: w, height: h, frame: false, show: false, backgroundColor: "#0c0b0a", webPreferences: wp });
    await win.loadFile(path.join(dist, file), { query: { theme: "prompter" } });
    // A hidden window's compositor never runs CSS animations: entering cards would stay at opacity 0.
    await win.webContents.insertCSS("*, *::before, *::after { animation: none !important; transition: none !important; }");
    return win;
  };
  const tr = await open("transcript.html", TR);
  const hi = await open("hints.html", HI);
  const both = [tr, hi];
  const send = (ws, ...evs) => { for (const e of evs) for (const w of ws) w.webContents.send("core-event", e); };
  const ui = (m) => both.forEach((w) => w.webContents.send("ui", m));
  send(both, status, call);
  await wait(800);

  const gif = GIFEncoder();
  let last = null;
  let frames = 0;
  /** One frame shown for `ms`; an unchanged frame only extends the previous one. */
  const frame = async (ms) => {
    await wait(70);
    const c = canvas(W, H);
    blit(c, W, await tr.webContents.capturePage(), PAD, PAD);
    blit(c, W, await hi.webContents.capturePage(), PAD + TR.w + GAP, PAD);
    if (last && Buffer.compare(Buffer.from(last.c), Buffer.from(c)) === 0) return void (last.ms += ms);
    if (last) flush();
    last = { c, ms };
  };
  const flush = () => {
    const palette = quantize(last.c, 256);
    gif.writeFrame(applyPalette(last.c, palette), W, H, { palette, delay: last.ms });
    frames++;
  };

  await frame(1200);
  // The other side asks: the transcript fills word by word.
  send(both, { ev: "vad", speaker: "them", active: true, t: T }, { ev: "level", speaker: "them", rms: 0.12, peak: 0.4 });
  const words = Q.split(" ");
  for (let i = 1; i < words.length; i += 2) {
    send(both, { ev: "partial", speaker: "them", t: T, stable: words.slice(0, Math.max(0, i - 2)).join(" "), tail: words.slice(Math.max(0, i - 2), i + 1).join(" ") });
    await frame(140);
  }
  send(both, { ev: "vad", speaker: "them", active: false, t: T }, { ev: "final", speaker: "them", t: T, text: Q, question: true });
  await frame(700);
  // The quick line streams, then the full answer.
  send(both, { ev: "answer_start", id: 1, turn: 1, trigger: "auto", question: Q, q_t: T, tier: "quick" }, { ev: "metrics", name: "answer_first_token_quick", ms: 840 });
  const qw = QUICK.split(" ");
  for (let i = 0; i < qw.length; i += 2) {
    send(both, { ev: "answer_delta", id: 1, text: (i ? " " : "") + qw.slice(i, i + 2).join(" ") });
    await frame(110);
  }
  send(both, { ev: "answer_start", id: 2, turn: 1, trigger: "auto", question: Q, q_t: T, tier: "full" });
  for (const line of FULL) {
    send(both, { ev: "answer_delta", id: 2, text: line });
    await frame(380);
  }
  send(both, { ev: "answer_end", id: 2 });
  await frame(2400);

  // Themes: the same moment in each one, and a still of all four for the README.
  const THEMES = ["panel", "paper", "dusk", "prompter"];
  const still = canvas(PAD * 2 + HI.w * 4 + GAP * 3, PAD * 2 + HI.h);
  for (const [i, id] of THEMES.entries()) {
    ui({ kind: "theme", id });
    await frame(id === "prompter" ? 2000 : 1500);
    blit(still, PAD * 2 + HI.w * 4 + GAP * 3, await hi.webContents.capturePage(), PAD + [1, 2, 3, 0][i] * (HI.w + GAP), PAD);
  }
  flush();
  gif.finish();
  fs.writeFileSync(path.join(out, "demo.gif"), gif.bytes());
  png(still, PAD * 2 + HI.w * 4 + GAP * 3, PAD * 2 + HI.h, "themes.png");
  console.log(`demo.gif: ${frames} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB`);
  app.quit();
});
