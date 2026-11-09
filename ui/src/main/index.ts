import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, net, screen, shell, type Rectangle } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallInfo, Command, PrivacyReport, ConfigSnapshot, CoreEvent, NodePatch, ReadyItem, SaveResult, Status, UiMessage, Hotkeys, HotkeyAction } from "../shared/protocol";
import * as calls from "./calls";
import * as models from "./models";
import * as readiness from "./readiness";
import { cuda } from "./cuda";
import * as update from "./update";
import { createTray } from "./tray";
import { startLogs } from "./log";
import { CoreProcess, resolveCoreExe } from "./core";


const DEFAULT_HOTKEYS: Hotkeys = {
  ask: "CommandOrControl+Shift+Space",
  screenshotAsk: "CommandOrControl+Shift+S",
  toggleWindow: "CommandOrControl+Shift+H",
  toggleAuto: "CommandOrControl+Shift+A",
  // In-call keys live under Ctrl+Alt: Ctrl+Shift combos collide with call apps (Teams answers on Ctrl+Shift+S/A).
  clickThrough: "CommandOrControl+Alt+X",
  cameraMode: "CommandOrControl+Alt+M",
  prevAnswer: "CommandOrControl+Alt+PageUp",
  nextAnswer: "CommandOrControl+Alt+PageDown",
  copyAnswer: "CommandOrControl+Alt+C",
  zoomIn: "CommandOrControl+Alt+=",
  zoomOut: "CommandOrControl+Alt+-",
  myQuestions: "CommandOrControl+Alt+Q",
  continueTalk: "CommandOrControl+Alt+W",
  translate: "CommandOrControl+Alt+T",
  moreAnswer: "CommandOrControl+Alt+E",
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
let readyWin: BrowserWindow | null = null;
/** Why the core is not running (core_down), cleared by its `ready`. */
let coreError: string | null = null;
let callsWin: BrowserWindow | null = null;
let lastStatus: Status | null = null;
/** The context in use, from the core's last `call` event; its call is reopened after a core restart. */
let lastCall: CallInfo | null = null;
let configPath = findConfig();
/** <dataDir> with the profile and the call folders; the core's effective value. */
let dataDir = "";
let tray: ReturnType<typeof createTray> | null = null;

function emit(e: CoreEvent): void {
  if (e.ev === "status") lastStatus = e;
  if (e.ev === "ready" || e.ev === "core_down") coreError = e.ev === "core_down" ? e.message : null;
  if (e.ev === "status" || e.ev === "ready" || e.ev === "core_down") refreshReady();
  if (e.ev === "call") {
    lastCall = e;
    tray?.setCall(e.dir ? e.title : null);
  }
  // A restarted core knows nothing of the open call: open it again (its transcript is replayed).
  if (e.ev === "ready" && lastCall?.dir) openCall(lastCall.dir);
  // A muted source stays muted across a core restart (a settings change must not start listening).
  if (e.ev === "ready" && (lastStatus?.mute_me || lastStatus?.mute_them)) core.send({ cmd: "set", mute_me: lastStatus.mute_me, mute_them: lastStatus.mute_them });
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
const core = new CoreProcess(coreExe, coreArgs, rootDir(), emit);

function webPreferences(): Electron.WebPreferences {
  return { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

// ---------- overlay windows: positions survive restarts ----------

const stateFile = () => path.join(app.getPath("userData"), "windows.json");

/** Two position presets (at the desk, by the camera) and the text zoom. */
type Preset = "normal" | "camera";
interface WinState {
  preset: Preset;
  normal: Partial<Record<OverlayName, Rectangle>>;
  camera: Partial<Record<OverlayName, Rectangle>>;
  zoom: number;
}

function loadState(): WinState {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {}
  // The first version stored {transcript, hints} only: that is the normal preset.
  const normal = (raw.normal ?? { transcript: raw.transcript, hints: raw.hints }) as WinState["normal"];
  return { preset: raw.preset === "camera" ? "camera" : "normal", normal, camera: (raw.camera ?? {}) as WinState["camera"], zoom: Number(raw.zoom) || 1 };
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
    // Not in the taskbar or Alt+Tab, where a share or a recording could show its preview.
    skipTaskbar: true,
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
}

// ---------- in-call comfort: presets, click-through, zoom ----------

let clickThrough = false;

function sendUi(w: BrowserWindow | undefined, m?: UiMessage): void {
  w?.webContents.send("ui", m ?? { kind: "mode", mini: win.preset === "camera", clickThrough });
}

function togglePreset(): void {
  win.preset = win.preset === "camera" ? "normal" : "camera";
  for (const [name, w] of Object.entries(overlays) as [OverlayName, BrowserWindow][]) {
    w.setMinimumSize(320, win.preset === "camera" && name === "hints" ? 120 : 260);
    w.setBounds(boundsFor(name, win.preset));
    sendUi(w);
  }
  saveState();
}

function toggleClickThrough(): void {
  clickThrough = !clickThrough;
  for (const w of Object.values(overlays)) {
    w.setIgnoreMouseEvents(clickThrough, { forward: true });
    sendUi(w);
  }
}

function zoom(delta: number): void {
  win.zoom = Math.round(Math.min(1.6, Math.max(0.7, win.zoom + delta)) * 10) / 10;
  for (const w of Object.values(overlays)) w.webContents.setZoomFactor(win.zoom);
  saveState();
}

/** `section`: the Settings section to show ("guide" is the in-app guide). */
function openSettings(section?: string): void {
  if (settingsWin) {
    if (section) sendUi(settingsWin, { kind: "section", id: section });
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
  settingsWin.loadFile(path.join(__dirname, "settings.html"), section ? { hash: section } : undefined);
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

/** What each hotkey does; the overlay buttons run the same through `ui:action`. */
const actions: Record<HotkeyAction, () => void> = {
  ask: () => core.send({ cmd: "ask", screenshot: false }),
  screenshotAsk: () => (sendUi(overlays.hints, { kind: "looking" }), core.send({ cmd: "ask", screenshot: true })),
  toggleWindow: () => toggleWindows(),
  toggleAuto: () => core.send({ cmd: "set", auto: !(lastStatus?.auto ?? true) }),
  clickThrough: () => toggleClickThrough(),
  cameraMode: () => togglePreset(),
  prevAnswer: () => sendUi(overlays.hints, { kind: "nav", dir: -1 }),
  nextAnswer: () => sendUi(overlays.hints, { kind: "nav", dir: 1 }),
  copyAnswer: () => sendUi(overlays.hints, { kind: "copy" }),
  zoomIn: () => zoom(0.1),
  zoomOut: () => zoom(-0.1),
  myQuestions: () => core.send({ cmd: "ask", screenshot: false, kind: "questions" }),
  continueTalk: () => core.send({ cmd: "ask", screenshot: false, kind: "continue" }),
  moreAnswer: () => core.send({ cmd: "ask", screenshot: false, kind: "more" }),
  translate: () => core.send({ cmd: "set", translate: !(lastStatus?.translate ?? false) }),
};

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hotkeys = loadHotkeys();
  const map = (Object.keys(actions) as HotkeyAction[]).map((k) => [hotkeys[k], actions[k]] as const);
  // Button tooltips show the keys in effect.
  for (const w of Object.values(overlays)) sendUi(w, { kind: "hotkeys" });
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
    claudeCodeOk = null;
    refreshReady();
    registerHotkeys();
    core.restart();
    resolveDataDir();
  }
  return res;
}

const DATA_DIR = "Suflyor";

/** Renames `from` to `to` when only `from` exists. True when `to` is there to use. */
function moveOnce(from: string, to: string): boolean {
  if (fs.existsSync(to)) return true;
  if (!fs.existsSync(from)) return false;
  try {
    fs.renameSync(from, to);
    return true;
  } catch (e) {
    console.warn(`move ${from} -> ${to}: ${e}`);
    return false;
  }
}

/** Pins dataDir to the real Documents folder once: it may be redirected (F:\Documents, OneDrive),
 *  which the core's %USERPROFILE%\Documents default does not know. */
function pinDataDir(): void {
  const docs = app.getPath("documents");
  const dir = path.join(docs, DATA_DIR);
  const raw = readRaw(configPath).dataDir;
  // Renamed from «Call Assistant»: the old default folder moves once; a folder the user chose stays.
  const old = path.join(docs, "Call Assistant");
  if (raw && path.resolve(String(raw)).toLowerCase() !== old.toLowerCase()) return;
  if (raw || fs.existsSync(old)) {
    // Not moved (open in Explorer, say): keep using the old folder.
    if (!moveOnce(old, dir)) return void (raw || writeConfig({ dataDir: old }));
  }
  writeConfig({ dataDir: dir });
}

/** The core's effective dataDir (it fills in the default), relative paths against the config's folder. */
async function resolveDataDir(): Promise<void> {
  const cfg = await loadConfig();
  const dir = String(cfg.effective.dataDir ?? "") || path.join(app.getPath("documents"), DATA_DIR);
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

/** A config path as the core resolves it: against the config's folder. */
const configRel = (p: string) => path.resolve(path.dirname(configPath ?? newConfigPath()), p);

/** stt.model as an absolute path (relative ones resolve against the config's folder, as in the core). */
function activeModel(): string {
  const p = (readRaw(configPath).stt as { model?: string } | undefined)?.model || "whisper/ggml-large-v3-turbo.bin";
  return configRel(p);
}

/** The CUDA backend: next to whisper.dll in dev (get-whisper.ps1 -Cuda), else stt.cudaDir. */
function cudaDir(): string {
  const stt = (readRaw(configPath).stt ?? {}) as { dll?: string; cudaDir?: string };
  const beside = path.dirname(configRel(stt.dll || "whisper/whisper.dll"));
  return fs.existsSync(path.join(beside, "ggml-cuda.dll")) ? beside : configRel(stt.cudaDir || "cuda");
}

const PACKS = {
  cuda: { pack: cuda, dir: cudaDir },
};
type PackId = keyof typeof PACKS;

function registerUpdateIpc(): void {
  update.initUpdates((s) => settingsWin?.webContents.send("update:changed", s));
  ipcMain.handle("update:state", () => update.updateState());
  ipcMain.on("update:check", () => update.check());
  ipcMain.on("update:download", () => update.download());
  ipcMain.on("update:install", () => void update.install(() => core.stopped()));
}

function registerModelsIpc(): void {
  models.useFetch(net.fetch as typeof fetch);
  const changed = modelsChanged;
  ipcMain.handle("pack:status", (_e, id: PackId) => PACKS[id].pack.status(PACKS[id].dir()));
  // Not awaited, like the whisper download: progress arrives as models:changed.
  ipcMain.handle("pack:download", (_e, id: PackId) => {
    const { pack, dir } = PACKS[id];
    // The core picks the CUDA backend up when it starts.
    void pack.download(dir(), changed).then(() => id === "cuda" && pack.status(dir()).state === "installed" && core.restart());
  });
  ipcMain.on("pack:cancel", (_e, id: PackId) => PACKS[id].pack.cancel());
  ipcMain.handle("models:list", () => models.list(modelsDir(), activeModel()));
  // Not awaited: the download outlives the request; progress arrives as models:changed.
  ipcMain.handle("models:download", (_e, id: string) => void getModel(id));
  ipcMain.on("models:cancel", (_e, id: string) => models.cancel(id));
  ipcMain.handle("models:remove", (_e, id: string) => models.remove(modelsDir(), id, activeModel()));
  ipcMain.handle("models:use", (_e, id: string) => useModel(id));
}

/** Points stt.model at a downloaded model (relative to the config when it is inside its folder). */
function useModel(id: string): SaveResult {
  const file = path.join(modelsDir(), models.fileOf(id));
  if (!fs.existsSync(file)) return { ok: false, error: "модель не скачана" };
  const rel = path.relative(path.dirname(configPath ?? newConfigPath()), file);
  return saveConfig({ "stt.model": rel.startsWith("..") || path.isAbsolute(rel) ? file : rel.replaceAll("\\", "/") });
}

/** Downloads a whisper model and, when none in use works yet, selects it: a first model need not be picked by hand. */
async function getModel(id: string): Promise<void> {
  await models.download(modelsDir(), id, modelsChanged);
  if (!fs.existsSync(activeModel()) && fs.existsSync(path.join(modelsDir(), models.fileOf(id)))) useModel(id);
}

function modelsChanged(): void {
  settingsWin?.webContents.send("models:changed");
  readyWin?.webContents.send("models:changed");
  refreshReady();
}

// ---------- «Готовность»: what is missing, and the way to get it ----------

/** `claude --version` through the configured command; null = not checked since the config changed. */
let claudeCodeOk: boolean | null = null;
async function checkClaudeCode(): Promise<boolean> {
  if (claudeCodeOk !== null) return claudeCodeOk;
  const cmd = ((readRaw(configPath).claudeCode as { command?: string[] } | undefined)?.command ?? ["claude"]).filter(Boolean);
  claudeCodeOk = await promisify(execFile)(cmd[0] ?? "claude", [...cmd.slice(1), "--version"], { timeout: 10_000, windowsHide: true }).then(
    () => true,
    () => false,
  );
  return claudeCodeOk;
}

const nvidia: Promise<boolean> = app
  .whenReady()
  .then(() => app.getGPUInfo("basic"))
  .then((i) => ((i as { gpuDevice?: { vendorId: number }[] }).gpuDevice ?? []).some((d) => d.vendorId === 0x10de))
  .catch(() => false);

async function readyItems(): Promise<ReadyItem[]> {
  const raw = readRaw(configPath);
  const backend = (raw.llm as { backend?: string } | undefined)?.backend === "claude-code" ? "claude-code" : "api";
  return readiness.check({
    coreError,
    modelExists: fs.existsSync(activeModel()),
    backend,
    apiKey: Boolean(raw.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
    claudeCodeOk: backend === "claude-code" && (await checkClaudeCode()),
    nvidia: await nvidia,
    cudaInstalled: cuda.status(cudaDir()).state === "installed",
    status: lastStatus,
  });
}

let readyTimer: NodeJS.Timeout | undefined;
/** Recomputes the list and sends it to whoever shows it (debounced: status events come in bursts). */
function refreshReady(): void {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(async () => {
    const items = await readyItems();
    for (const w of [readyWin, overlays.transcript, overlays.hints]) w?.webContents.send("ready:changed", items);
  }, 300);
}

function openReady(): void {
  if (readyWin) {
    readyWin.focus();
    return;
  }
  readyWin = new BrowserWindow({
    width: 600,
    height: 680,
    minWidth: 480,
    minHeight: 420,
    title: "Подготовка к работе",
    backgroundColor: PAPER,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: PAPER, symbolColor: "#e8e5df", height: 40 },
    webPreferences: webPreferences(),
  });
  readyWin.setContentProtection(true);
  readyWin.loadFile(path.join(__dirname, "ready.html"));
  readyWin.on("closed", () => (readyWin = null));
}

function registerReadyIpc(): void {
  ipcMain.handle("ready:list", readyItems);
  ipcMain.on("ready:open", openReady);
  ipcMain.handle("ready:apiKey", (_e, key: string) => {
    const k = String(key).trim();
    if (!k.startsWith("sk-ant-")) return { ok: false, error: "Ключ API Anthropic начинается с sk-ant-." };
    return saveConfig({ anthropicApiKey: k, "llm.backend": "api" });
  });
  ipcMain.handle("ready:claudeCode", async () => {
    const res = saveConfig({ "llm.backend": "claude-code" });
    if (!res.ok) return res;
    return (await checkClaudeCode()) ? res : { ok: false, error: "Команда claude не ответила. Установите Claude Code и войдите в аккаунт." };
  });
  ipcMain.on("ready:model", (_e, id: string) => void getModel(id));
  ipcMain.on("ready:logs", () => shell.openPath(logDir));
}

// ---------- capture protection: check it applied, and let the user see it ----------

const hwnd = (w: BrowserWindow) => w.getNativeWindowHandle().readBigUInt64LE(0).toString();

/** WDA_EXCLUDEFROMCAPTURE needs Windows 10 2004 (build 19041); older builds show a black box. */
const osHidesWindows = () => process.platform !== "win32" || Number(os.release().split(".")[2] ?? 0) >= 19041;

function ourWindows(): [string, BrowserWindow][] {
  const all: [string, BrowserWindow | null | undefined][] = [
    ["Транскрипт", overlays.transcript],
    ["Подсказки", overlays.hints],
    ["Настройки", settingsWin],
    ["Звонки", callsWin],
  ];
  return all.filter((e): e is [string, BrowserWindow] => Boolean(e[1]));
}

/** Display affinity of each window, read by the core (0x11 = hidden from capture). */
async function affinities(): Promise<{ name: string; hidden: boolean }[]> {
  const wins = ourWindows();
  const { stdout } = await runCore(["--check-affinity", ...wins.map(([, w]) => hwnd(w))]);
  const lines = stdout.trim().split(/\r?\n/);
  return wins.map(([name], i) => ({ name, hidden: /\s0x11$/.test(lines[i] ?? "") }));
}

/** Once after start: a window that is not hidden from capture is said loudly. */
async function checkProtection(): Promise<void> {
  if (!osHidesWindows()) emit({ ev: "error", message: "Windows старше 10 2004: в демонстрации экрана окна видны чёрными прямоугольниками" });
  try {
    const bad = (await affinities()).filter((w) => !w.hidden);
    if (bad.length) emit({ ev: "error", message: `Окно может попасть в демонстрацию экрана: ${bad.map((w) => w.name).join(", ")}` });
  } catch (e) {
    console.warn(`[privacy] affinity check failed: ${e}`);
  }
}

/** Captures the display with the overlays the way other apps do, so the user sees they are absent. */
async function privacyTest(): Promise<PrivacyReport> {
  for (const w of Object.values(overlays)) if (!w.isVisible()) w.showInactive();
  await new Promise((r) => setTimeout(r, 300));
  const anchor = overlays.hints ?? overlays.transcript;
  const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
  const r = screen.dipToScreenRect(null, display.bounds);
  const file = path.join(app.getPath("temp"), `suflyor-privacy-${Date.now()}.png`);
  try {
    await runCore(["--snap", file, "--rect", `${r.x},${r.y},${r.width},${r.height}`]);
    const image = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
    return { image, windows: await affinities(), osOk: osHidesWindows() };
  } finally {
    fs.rmSync(file, { force: true });
  }
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

// Renamed from CallAssistant: window state, logs and downloaded models move to the new userData once.
// Per file: Electron has created userData itself by now.
for (const name of ["call-assistant-ui", "CallAssistant"]) {
  for (const f of ["windows.json", "logs", "whisper-models"]) moveOnce(path.join(app.getPath("appData"), name, f), path.join(app.getPath("userData"), f));
}
const logDir = path.join(app.getPath("userData"), "logs");
startLogs(logDir);

app.whenReady().then(() => {
  ipcMain.on("core-cmd", (_e, cmd: Command) => {
    if (cmd.cmd === "open_call") return openCall(cmd.dir);
    core.send(cmd);
    if (cmd.cmd === "clear") emit({ ev: "cleared" });
  });
  ipcMain.on("hide", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.on("settings:open", (_e, section?: string) => openSettings(typeof section === "string" ? section : undefined));
  ipcMain.on("ui:copy", (_e, text: string) => clipboard.writeText(text));
  ipcMain.on("ui:action", (_e, a: HotkeyAction) => Object.hasOwn(actions, a) && actions[a]());
  ipcMain.handle("hotkeys:get", loadHotkeys);
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle("config:load", loadConfig);
  ipcMain.handle("config:save", (_e, patch: Record<string, unknown>) => saveConfig(patch));
  ipcMain.handle("config:mics", async () => (await runCore(["--list-mics"])).stdout.split(/\r?\n/).filter(Boolean));
  registerCallsIpc();
  registerModelsIpc();
  registerUpdateIpc();
  registerReadyIpc();
  ipcMain.handle("privacy:test", privacyTest);
  ipcMain.on("logs:open", () => shell.openPath(logDir));
  createOverlay("transcript");
  createOverlay("hints");
  tray = createTray({
    toggleWindows,
    openCalls,
    openSettings,
    togglePreset,
    toggleClickThrough,
    openReady,
    checkUpdates: () => {
      openSettings("guide");
      update.check();
    },
    quit: () => app.quit(),
  });
  setTimeout(checkProtection, 3000);
  registerHotkeys();
  // The core reads the migrated profile, so it starts after the migration.
  pinDataDir();
  resolveDataDir()
    .then(migrateContext)
    .finally(() => core.start());
  // A fresh install has no model and no Claude: say so at once, with the way to fix it.
  void readyItems().then((items) => {
    const missing = items.filter((i) => !i.ok).map((i) => i.id);
    if (missing.length) console.log(`[ready] missing: ${missing.join(", ")}`);
    if (readiness.blocking(items)) openReady();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core.stop();
});

app.on("window-all-closed", () => app.quit());
