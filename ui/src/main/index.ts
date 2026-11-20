import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, shell } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallInfo, Command, PrivacyReport, ConfigSnapshot, CoreEvent, ReadyItem, SaveResult, Status, HotkeyAction } from "../shared/protocol";
import { isTheme } from "../shared/protocol";
import { DEFAULT_HOTKEYS } from "../shared/hotkeys";
import * as readiness from "./readiness";
import { cuda } from "./cuda";
import * as update from "./update";
import { createTray } from "./tray";
import { startLogs } from "./log";
import { CoreProcess, resolveCoreExe } from "./core";
import { configPath, coreArgs, loadHotkeys, newConfigPath, readRaw, rootDir, writeConfig } from "./config";
import { migrateContext, registerCallsIpc } from "./calls-ipc";
import { activeModel, cudaDir, getModel, registerModelsIpc } from "./models-ipc";
import { createOverlay, openCalls, openReady, openSettings, sendUi, setTheme, toggleClickThrough, togglePreset, toggleWindows, wins, zoom } from "./windows";

const overlays = wins.overlays;
/** Why the core is not running (core_down), cleared by its `ready`. */
let coreError: string | null = null;
let lastStatus: Status | null = null;
/** The context in use, from the core's last `call` event; its call is reopened after a core restart. */
let lastCall: CallInfo | null = null;
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
  if (e.ev === "call" || e.ev === "summary") targets.push(wins.calls ?? undefined);
  for (const w of targets) w?.webContents.send("core-event", e);
}

/** Opening a call replays its transcript and answers: the windows drop what they show first. */
function openCall(dir: string): void {
  emit({ ev: "cleared" });
  core.send({ cmd: "open_call", dir });
}

const coreExe = resolveCoreExe(app.getAppPath(), app.isPackaged);
const core = new CoreProcess(coreExe, coreArgs, rootDir(), emit);

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
  rateUp: () => sendUi(overlays.hints, { kind: "rate", value: 1 }),
  rateDown: () => sendUi(overlays.hints, { kind: "rate", value: -1 }),
  zoomIn: () => zoom(0.1),
  zoomOut: () => zoom(-0.1),
  myQuestions: () => core.send({ cmd: "ask", screenshot: false, kind: "questions" }),
  continueTalk: () => core.send({ cmd: "ask", screenshot: false, kind: "continue" }),
  moreAnswer: () => core.send({ cmd: "ask", screenshot: false, kind: "more" }),
  translate: () => core.send({ cmd: "set", translate: !(lastStatus?.translate ?? false) }),
};

/** Actions whose keys did not register (taken by another app, or not a valid accelerator): shown in Settings. */
let failedHotkeys: HotkeyAction[] = [];

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hotkeys = loadHotkeys();
  // Button tooltips show the keys in effect.
  for (const w of Object.values(overlays)) sendUi(w, { kind: "hotkeys" });
  failedHotkeys = [];
  for (const k of Object.keys(actions) as HotkeyAction[]) {
    try {
      if (globalShortcut.register(hotkeys[k], actions[k])) continue;
      console.warn(`[hotkey] failed to register ${hotkeys[k]}`);
    } catch (e) {
      console.warn(`[hotkey] invalid accelerator ${hotkeys[k]}: ${e}`);
    }
    failedHotkeys.push(k);
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
  const raw = readRaw();
  let effective: Record<string, unknown> = {};
  try {
    effective = JSON.parse((await runCore(["--print-config", ...coreArgs()])).stdout);
  } catch (e) {
    console.warn(`[settings] core --print-config failed: ${e}`);
  }
  effective.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys as object | undefined) };
  return { path: configPath() ?? newConfigPath(), raw, effective };
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
  const raw = readRaw().dataDir;
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

function registerUpdateIpc(): void {
  update.initUpdates((s) => wins.settings?.webContents.send("update:changed", s));
  ipcMain.handle("update:state", () => update.updateState());
  ipcMain.on("update:check", () => update.check());
  ipcMain.on("update:download", () => update.download());
  ipcMain.on("update:install", () => void update.install(() => core.stopped()));
}

// ---------- «Готовность»: what is missing, and the way to get it ----------

/** `claude --version` through the configured command; null = not checked since the config changed. */
let claudeCodeOk: boolean | null = null;
async function checkClaudeCode(): Promise<boolean> {
  if (claudeCodeOk !== null) return claudeCodeOk;
  const cmd = ((readRaw().claudeCode as { command?: string[] } | undefined)?.command ?? ["claude"]).filter(Boolean);
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
  const raw = readRaw();
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
    for (const w of [wins.ready, overlays.transcript, overlays.hints]) w?.webContents.send("ready:changed", items);
  }, 300);
}

function registerReadyIpc(): void {
  ipcMain.on("core:restart", () => core.restart());
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
    ["Настройки", wins.settings],
    ["Звонки", wins.calls],
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

// Renamed from CallAssistant: window state, logs and downloaded models move to the new userData once.
// Per file: Electron has created userData itself by now.
for (const name of ["call-assistant-ui", "CallAssistant"]) {
  for (const f of ["windows.json", "logs", "whisper-models"]) moveOnce(path.join(app.getPath("appData"), name, f), path.join(app.getPath("userData"), f));
}
// A second copy would add a second tray and core and fight over the hotkeys and config.json.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  for (const w of Object.values(overlays)) w.showInactive();
});

// Pages never navigate: a file dropped on a window would load with the preload and its `api`.
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
});

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
  ipcMain.handle("hotkeys:failed", () => failedHotkeys);
  ipcMain.handle("config:audio-apps", async () => (await runCore(["--list-audio-apps"])).stdout.split(/\r?\n/).filter(Boolean));
  ipcMain.on("theme:set", (_e, id: unknown) => isTheme(id) && setTheme(id));
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle("config:load", loadConfig);
  ipcMain.handle("config:save", (_e, patch: Record<string, unknown>) => saveConfig(patch));
  ipcMain.handle("config:mics", async () => (await runCore(["--list-mics"])).stdout.split(/\r?\n/).filter(Boolean));
  registerCallsIpc({ core, runCore, dataDir: () => dataDir, lastCall: () => lastCall });
  registerModelsIpc({ core, saveConfig, refreshReady });
  registerUpdateIpc();
  registerReadyIpc();
  ipcMain.handle("privacy:test", privacyTest);
  ipcMain.on("logs:open", () => shell.openPath(logDir));
  const replay = (w: BrowserWindow) => {
    if (lastStatus) w.webContents.send("core-event", { ev: "status", ...lastStatus });
    if (lastCall) w.webContents.send("core-event", { ev: "call", ...lastCall });
  };
  createOverlay("transcript", replay);
  createOverlay("hints", replay);
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
    restartCore: () => core.restart(),
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
