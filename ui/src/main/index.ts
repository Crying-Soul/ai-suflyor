import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, net, screen, shell, type Rectangle } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CallInfo, Command, ConfigSnapshot, CoreEvent, NodePatch, SaveResult, Status, UiMessage } from "../shared/protocol";
import * as calls from "./calls";
import * as models from "./models";
import { CoreProcess, resolveCoreExe } from "./core";

interface Hotkeys {
  ask: string;
  screenshotAsk: string;
  toggleWindow: string;
  toggleAuto: string;
  clickThrough: string;
  cameraMode: string;
  opacity: string;
  prevAnswer: string;
  nextAnswer: string;
  copyAnswer: string;
  zoomIn: string;
  zoomOut: string;
}

const DEFAULT_HOTKEYS: Hotkeys = {
  ask: "CommandOrControl+Shift+Space",
  screenshotAsk: "CommandOrControl+Shift+S",
  toggleWindow: "CommandOrControl+Shift+H",
  toggleAuto: "CommandOrControl+Shift+A",
  // In-call keys live under Ctrl+Alt: Ctrl+Shift combos collide with call apps (Teams answers on Ctrl+Shift+S/A).
  clickThrough: "CommandOrControl+Alt+X",
  cameraMode: "CommandOrControl+Alt+M",
  opacity: "CommandOrControl+Alt+O",
  prevAnswer: "CommandOrControl+Alt+PageUp",
  nextAnswer: "CommandOrControl+Alt+PageDown",
  copyAnswer: "CommandOrControl+Alt+C",
  zoomIn: "CommandOrControl+Alt+=",
  zoomOut: "CommandOrControl+Alt+-",
};

/** Window background before the page paints (Dusk paper, approximated in sRGB). */
const PAPER = "#13151b";

/** Project root in dev (parent of ui/), the exe folder when packaged. */
function rootDir(): string {
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.resolve(app.getAppPath(), "..");
}

function findConfig(): string | null {
  const candidates = [path.join(rootDir(), "config.json"), path.join(app.getPath("userData"), "config.json")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Where a new config.json goes when none exists yet (the install folder may be read-only). */
function newConfigPath(): string {
  return app.isPackaged ? path.join(app.getPath("userData"), "config.json") : path.join(rootDir(), "config.json");
}

function readRaw(p: string | null): Record<string, unknown> {
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

type OverlayName = "transcript" | "hints";

const overlays: Partial<Record<OverlayName, BrowserWindow>> = {};
let settingsWin: BrowserWindow | null = null;
let callsWin: BrowserWindow | null = null;
let lastStatus: Status | null = null;
/** The context in use, from the core's last `call` event; its call is reopened after a core restart. */
let lastCall: CallInfo | null = null;
let configPath = findConfig();
/** <dataDir> with the profile and the call folders; the core's effective value. */
let dataDir = "";

function emit(e: CoreEvent): void {
  if (e.ev === "status") lastStatus = e;
  if (e.ev === "call") lastCall = e;
  if ((e.ev === "vad" && e.active) || e.ev === "partial" || (e.ev === "final" && e.text) || e.ev === "answer_start" || e.ev === "answer_delta") activity();
  // A restarted core knows nothing of the open call: open it again (its transcript is replayed).
  if (e.ev === "ready" && lastCall?.dir) openCall(lastCall.dir);
  // Level meters live in the transcript window only; ~20 events/s need not reach the hints.
  const targets: (BrowserWindow | undefined)[] = e.ev === "level" ? [overlays.transcript] : Object.values(overlays);
  if (e.ev === "call" || e.ev === "summary") targets.push(callsWin ?? undefined);
  for (const w of targets) w?.webContents.send("core-event", e);
}

/** Opening a call replays its transcript and answers: the windows drop what they show first. */
function openCall(dir: string): void {
  emit({ ev: "cleared" });
  core.send({ cmd: "open_call", dir });
}

function loadHotkeys(): Hotkeys {
  return { ...DEFAULT_HOTKEYS, ...(readRaw(configPath).hotkeys as Partial<Hotkeys> | undefined) };
}

const coreExe = resolveCoreExe(app.getAppPath(), app.isPackaged);
const coreArgs = () => (configPath ? ["--config", configPath] : []);
const core = new CoreProcess(coreExe, coreArgs(), rootDir(), emit);

function webPreferences(): Electron.WebPreferences {
  return { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

// ---------- overlay windows: positions survive restarts ----------

const stateFile = () => path.join(app.getPath("userData"), "windows.json");

/** Two position presets (at the desk, by the camera), the chosen opacity and the text zoom. */
type Preset = "normal" | "camera";
interface WinState {
  preset: Preset;
  normal: Partial<Record<OverlayName, Rectangle>>;
  camera: Partial<Record<OverlayName, Rectangle>>;
  opacity: number;
  zoom: number;
}

function loadState(): WinState {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {}
  // The first version stored {transcript, hints} only: that is the normal preset.
  const normal = (raw.normal ?? { transcript: raw.transcript, hints: raw.hints }) as WinState["normal"];
  return { preset: raw.preset === "camera" ? "camera" : "normal", normal, camera: (raw.camera ?? {}) as WinState["camera"], opacity: Number(raw.opacity) || 1, zoom: Number(raw.zoom) || 1 };
}

const win = loadState();
let saveTimer: NodeJS.Timeout | undefined;
function saveState(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(win));
    } catch (e) {
      console.warn(`[windows] cannot save positions: ${e}`);
    }
  }, 500);
}

/** A saved rectangle is usable only if a good part of it is on a connected display. */
function onScreen(r: Rectangle | undefined): r is Rectangle {
  return Boolean(r) && screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(r!.x + r!.width, a.x + a.width) - Math.max(r!.x, a.x);
    const h = Math.min(r!.y + r!.height, a.y + a.height) - Math.max(r!.y, a.y);
    return w >= 120 && h >= 80;
  });
}

/** By the camera the hints shrink to a strip at the top centre of their display: eyes stay near the lens. */
function cameraStrip(): Rectangle {
  const near = overlays.hints ? screen.getDisplayMatching(overlays.hints.getBounds()) : screen.getPrimaryDisplay();
  const a = near.workArea;
  const width = Math.min(640, a.width - 40);
  return { x: Math.round(a.x + (a.width - width) / 2), y: a.y + 8, width, height: 168 };
}

function boundsFor(name: OverlayName, preset: Preset): Rectangle {
  const saved = win[preset][name];
  if (onScreen(saved)) return saved;
  if (preset === "camera") return name === "hints" ? cameraStrip() : boundsFor(name, "normal");
  return defaultBounds(name);
}

function defaultBounds(name: OverlayName): Rectangle {
  const a = screen.getPrimaryDisplay().workArea;
  return name === "transcript"
    ? { x: a.x + 40, y: a.y + 40, width: 420, height: Math.min(640, a.height - 80) }
    : { x: a.x + a.width - 500, y: a.y + 40, width: 460, height: Math.min(560, a.height - 80) };
}

function createOverlay(name: OverlayName): void {
  const mini = win.preset === "camera" && name === "hints";
  const w = new BrowserWindow({
    ...boundsFor(name, win.preset),
    minWidth: 320,
    minHeight: mini ? 120 : 260,
    frame: false,
    // Clicks work, but the keyboard stays in the call app: typing in chat is never stolen.
    focusable: false,
    // Opaque: a transparent frameless window loses edge resizing on Windows.
    backgroundColor: PAPER,
    alwaysOnTop: true,
    show: false,
    title: name === "transcript" ? "Транскрипт" : "Подсказки",
    webPreferences: webPreferences(),
  });
  w.setAlwaysOnTop(true, "screen-saver");
  // Hides the overlay from screen sharing and screenshots (WDA_EXCLUDEFROMCAPTURE).
  w.setContentProtection(true);
  w.loadFile(path.join(__dirname, `${name}.html`));
  w.once("ready-to-show", () => w.showInactive());
  // Replay the last status after a renderer (re)load.
  w.webContents.on("did-finish-load", () => {
    w.webContents.setZoomFactor(win.zoom);
    sendUi(w);
    if (lastStatus) w.webContents.send("core-event", { ev: "status", ...lastStatus });
    if (lastCall) w.webContents.send("core-event", { ev: "call", ...lastCall });
  });
  const save = () => {
    win[win.preset][name] = w.getBounds();
    saveState();
  };
  w.on("moved", save);
  w.on("resized", save);
  w.on("closed", () => delete overlays[name]);
  overlays[name] = w;
  applyOpacity();
}

// ---------- in-call comfort: presets, click-through, opacity and idle dimming, zoom ----------

let clickThrough = false;
let dimmed = false;
let idleTimer: NodeJS.Timeout | undefined;
/** No speech and no answer for this long: the overlays fade to IDLE_DIM of their opacity. */
const IDLE_MS = 8000;
const IDLE_DIM = 0.45;

function sendUi(w: BrowserWindow | undefined, m?: UiMessage): void {
  w?.webContents.send("ui", m ?? { kind: "mode", mini: win.preset === "camera", clickThrough });
}

function applyOpacity(): void {
  for (const w of Object.values(overlays)) w.setOpacity(win.opacity * (dimmed ? IDLE_DIM : 1));
}

function activity(): void {
  if (dimmed) {
    dimmed = false;
    applyOpacity();
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    dimmed = true;
    applyOpacity();
  }, IDLE_MS);
}

function togglePreset(): void {
  win.preset = win.preset === "camera" ? "normal" : "camera";
  for (const [name, w] of Object.entries(overlays) as [OverlayName, BrowserWindow][]) {
    w.setMinimumSize(320, win.preset === "camera" && name === "hints" ? 120 : 260);
    w.setBounds(boundsFor(name, win.preset));
    sendUi(w);
  }
  saveState();
  activity();
}

function toggleClickThrough(): void {
  clickThrough = !clickThrough;
  for (const w of Object.values(overlays)) {
    w.setIgnoreMouseEvents(clickThrough, { forward: true });
    sendUi(w);
  }
}

function cycleOpacity(): void {
  const steps = [1, 0.8, 0.6];
  win.opacity = steps[(steps.indexOf(win.opacity) + 1) % steps.length] ?? 1;
  dimmed = false;
  applyOpacity();
  saveState();
  activity();
}

function zoom(delta: number): void {
  win.zoom = Math.round(Math.min(1.6, Math.max(0.7, win.zoom + delta)) * 10) / 10;
  for (const w of Object.values(overlays)) w.webContents.setZoomFactor(win.zoom);
  saveState();
}

function openSettings(): void {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    title: "Настройки",
    backgroundColor: PAPER,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: PAPER, symbolColor: "#e8e5df", height: 40 },
    alwaysOnTop: true,
    webPreferences: webPreferences(),
  });
  // Settings show the API key and the user context: keep them out of screen sharing too.
  settingsWin.setContentProtection(true);
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

function openCalls(): void {
  if (callsWin) {
    callsWin.focus();
    return;
  }
  callsWin = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "Звонки",
    backgroundColor: PAPER,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: PAPER, symbolColor: "#e8e5df", height: 40 },
    webPreferences: webPreferences(),
  });
  // CVs, notes and transcripts: never in a screen share.
  callsWin.setContentProtection(true);
  callsWin.loadFile(path.join(__dirname, "calls.html"));
  callsWin.on("closed", () => (callsWin = null));
}

/** Hides both overlays if any is visible, otherwise shows both. */
function toggleWindows(): void {
  const all = Object.values(overlays);
  const anyVisible = all.some((w) => w.isVisible());
  for (const w of all) {
    if (anyVisible) w.hide();
    else w.showInactive();
  }
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hotkeys = loadHotkeys();
  const map: [string, () => void][] = [
    [hotkeys.ask, () => core.send({ cmd: "ask", screenshot: false })],
    [hotkeys.screenshotAsk, () => core.send({ cmd: "ask", screenshot: true })],
    [hotkeys.toggleWindow, toggleWindows],
    [hotkeys.toggleAuto, () => core.send({ cmd: "set", auto: !(lastStatus?.auto ?? true) })],
    [hotkeys.clickThrough, toggleClickThrough],
    [hotkeys.cameraMode, togglePreset],
    [hotkeys.opacity, cycleOpacity],
    [hotkeys.prevAnswer, () => (activity(), sendUi(overlays.hints, { kind: "nav", dir: -1 }))],
    [hotkeys.nextAnswer, () => (activity(), sendUi(overlays.hints, { kind: "nav", dir: 1 }))],
    [hotkeys.copyAnswer, () => sendUi(overlays.hints, { kind: "copy" })],
    [hotkeys.zoomIn, () => zoom(0.1)],
    [hotkeys.zoomOut, () => zoom(-0.1)],
  ];
  for (const [accel, fn] of map) {
    try {
      if (!globalShortcut.register(accel, fn)) console.warn(`[hotkey] failed to register ${accel}`);
    } catch (e) {
      console.warn(`[hotkey] invalid accelerator ${accel}: ${e}`);
    }
  }
}

/** Runs the core with extra arguments and returns its stdout (and stderr). */
function runCore(args: string[], timeout = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) =>
    execFile(coreExe, args, { cwd: rootDir(), windowsHide: true, timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim().split("\n").pop() || String(err))) : resolve({ stdout, stderr }),
    ),
  );
}

async function loadConfig(): Promise<ConfigSnapshot> {
  const raw = readRaw(configPath);
  let effective: Record<string, unknown> = {};
  try {
    effective = JSON.parse((await runCore(["--print-config", ...coreArgs()])).stdout);
  } catch (e) {
    console.warn(`[settings] core --print-config failed: ${e}`);
  }
  effective.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys as object | undefined) };
  return { path: configPath ?? newConfigPath(), raw, effective };
}

/** Writes dotted keys into the stored config, keeping every key the form does not know. */
function writeConfig(patch: Record<string, unknown>): SaveResult {
  const target = configPath ?? newConfigPath();
  const raw = readRaw(configPath);
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    let obj = raw;
    for (const part of parts.slice(0, -1)) {
      if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write then rename, so a crash mid-write never leaves a truncated config.json.
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(raw, null, 2) + "\n");
    fs.renameSync(`${target}.tmp`, target);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  configPath = target;
  return { ok: true, path: target };
}

function saveConfig(patch: Record<string, unknown>): SaveResult {
  const res = writeConfig(patch);
  if (res.ok) {
    registerHotkeys();
    core.restart(coreArgs());
    resolveDataDir();
  }
  return res;
}

/** Pins dataDir to the real Documents folder once: it may be redirected (F:\Documents, OneDrive),
 *  which the core's %USERPROFILE%\Documents default does not know. */
function pinDataDir(): void {
  if (!readRaw(configPath).dataDir) writeConfig({ dataDir: path.join(app.getPath("documents"), "Call Assistant") });
}

/** The core's effective dataDir (it fills in the default), relative paths against the config's folder. */
async function resolveDataDir(): Promise<void> {
  const cfg = await loadConfig();
  const dir = String(cfg.effective.dataDir ?? "") || path.join(app.getPath("documents"), "Call Assistant");
  dataDir = path.resolve(path.dirname(cfg.path), dir);
}

/** userContext and glossary used to live in config.json; the profile node holds them now. */
function migrateContext(): void {
  const raw = readRaw(configPath);
  const ctx = typeof raw.userContext === "string" ? raw.userContext : "";
  const glossary = Array.isArray(raw.glossary) ? raw.glossary.map(String) : [];
  try {
    if (calls.migrate(dataDir, ctx, glossary)) writeConfig({ userContext: "", glossary: [] });
  } catch (e) {
    console.warn(`[calls] migration failed: ${e}`);
  }
}

/** After the context of a node changed: rebuild the prompt if that node is part of it. */
function contextChanged(dir: string): void {
  const open = lastCall?.dir;
  const inUse = calls.kindOf(dataDir, dir) === "profile" || (open && (open === dir || open.startsWith(dir + path.sep)));
  if (inUse) core.send({ cmd: "reload_context" });
}

async function addFiles(dir: string, paths?: string[]): Promise<void> {
  if (!paths?.length) {
    const r = await dialog.showOpenDialog(callsWin ?? BrowserWindow.getFocusedWindow()!, {
      title: "Файлы контекста",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Документы", extensions: ["md", "txt", "pdf"] }],
    });
    if (r.canceled) return;
    paths = r.filePaths;
  }
  const failed: string[] = [];
  for (const pdf of calls.addFiles(dataDir, dir, paths)) {
    await runCore(["--extract", pdf], 120_000).catch((e) => failed.push(`${path.basename(pdf)}: ${e.message}`));
  }
  contextChanged(dir);
  if (failed.length) throw new Error(`Текст не извлечён. ${failed.join("; ")}`);
}

async function fileText(dir: string, name: string): Promise<string> {
  const p = calls.filePath(dataDir, dir, name);
  if (path.extname(p).toLowerCase() !== ".pdf") return fs.readFileSync(p, "utf8");
  return (await runCore(["--extract", p], 120_000)).stdout;
}

async function removeNode(dir: string): Promise<void> {
  if (calls.kindOf(dataDir, dir) === "profile") throw new Error("профиль не удаляется");
  const open = lastCall?.dir;
  if (open && (open === dir || open.startsWith(dir + path.sep))) throw new Error("сначала завершите звонок");
  await shell.trashItem(dir);
}

/** Where downloaded whisper models go: whisper/ in dev (next to whisper.dll), userData when installed. */
const modelsDir = () => (app.isPackaged ? path.join(app.getPath("userData"), "whisper-models") : path.join(rootDir(), "whisper"));

/** stt.model as an absolute path (relative ones resolve against the config's folder, as in the core). */
function activeModel(): string {
  const p = (readRaw(configPath).stt as { model?: string } | undefined)?.model || "whisper/ggml-large-v3-turbo.bin";
  return path.resolve(path.dirname(configPath ?? newConfigPath()), p);
}

function registerModelsIpc(): void {
  models.useFetch(net.fetch as typeof fetch);
  const changed = () => settingsWin?.webContents.send("models:changed");
  ipcMain.handle("models:list", () => models.list(modelsDir(), activeModel()));
  // Not awaited: the download outlives the request; progress arrives as models:changed.
  ipcMain.handle("models:download", (_e, id: string) => void models.download(modelsDir(), id, changed));
  ipcMain.on("models:cancel", (_e, id: string) => models.cancel(id));
  ipcMain.handle("models:remove", (_e, id: string) => models.remove(modelsDir(), id, activeModel()));
  ipcMain.handle("models:use", (_e, id: string) => {
    const file = path.join(modelsDir(), models.fileOf(id));
    if (!fs.existsSync(file)) return { ok: false, error: "модель не скачана" };
    const rel = path.relative(path.dirname(configPath ?? newConfigPath()), file);
    return saveConfig({ "stt.model": rel.startsWith("..") || path.isAbsolute(rel) ? file : rel.replaceAll("\\", "/") });
  });
}

function registerCallsIpc(): void {
  ipcMain.on("calls:open", openCalls);
  ipcMain.handle("calls:tree", () => calls.tree(dataDir));
  ipcMain.handle("calls:node", (_e, dir: string) => calls.node(dataDir, dir));
  ipcMain.handle("calls:save", (_e, dir: string, patch: NodePatch) => {
    calls.save(dataDir, dir, patch);
    contextChanged(dir);
  });
  ipcMain.handle("calls:create-folder", (_e, title: string) => calls.createFolder(dataDir, title));
  ipcMain.handle("calls:create-call", (_e, folder: string, title: string) => calls.createCall(dataDir, folder, title));
  ipcMain.handle("calls:add-files", (_e, dir: string, paths?: string[]) => addFiles(dir, paths));
  ipcMain.handle("calls:file-text", (_e, dir: string, name: string) => fileText(dir, name));
  ipcMain.handle("calls:remove-file", (_e, dir: string, name: string) => {
    calls.removeFile(dataDir, dir, name);
    contextChanged(dir);
  });
  ipcMain.handle("calls:remove", (_e, dir: string) => removeNode(dir));
  ipcMain.handle("calls:preview", async (_e, dir: string | null) => {
    const { stdout, stderr } = await runCore(["--print-context", dir ?? "", ...coreArgs()], 120_000);
    return `${stderr.trim()}\n\n${stdout.trim()}`;
  });
  ipcMain.on("calls:reveal", (_e, dir: string) => shell.openPath(dir));
  ipcMain.handle("calls:current", () => lastCall);
}

app.whenReady().then(() => {
  ipcMain.on("core-cmd", (_e, cmd: Command) => {
    if (cmd.cmd === "open_call") return openCall(cmd.dir);
    core.send(cmd);
    if (cmd.cmd === "clear") emit({ ev: "cleared" });
  });
  ipcMain.on("hide", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.on("settings:open", openSettings);
  ipcMain.on("ui:active", activity);
  ipcMain.on("ui:copy", (_e, text: string) => clipboard.writeText(text));
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle("config:load", loadConfig);
  ipcMain.handle("config:save", (_e, patch: Record<string, unknown>) => saveConfig(patch));
  ipcMain.handle("config:mics", async () => (await runCore(["--list-mics"])).stdout.split(/\r?\n/).filter(Boolean));
  registerCallsIpc();
  registerModelsIpc();
  createOverlay("transcript");
  createOverlay("hints");
  activity();
  registerHotkeys();
  // The core reads the migrated profile, so it starts after the migration.
  pinDataDir();
  resolveDataDir()
    .then(migrateContext)
    .finally(() => core.start());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core.stop();
});

app.on("window-all-closed", () => app.quit());
