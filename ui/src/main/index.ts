import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import type { CallInfo, Command, ConfigSnapshot, CoreEvent, SaveResult, Status, HotkeyAction } from "../shared/protocol";
import { applyPlan, isTheme } from "../shared/protocol";
import { DEFAULT_HOTKEYS } from "../shared/hotkeys";
import * as update from "./update";
import { createTray } from "./tray";
import { startLogs } from "./log";
import { CoreProcess, resolveCoreExe } from "./core";
import { apiKey, coreEnv, encryptStoredKey, llmKey, secretPatch } from "./api-key";
import { configPath, coreArgs, loadHotkeys, newConfigPath, readRaw, rootDir, writeConfig } from "./config";
import { migrateContext, registerCallsIpc } from "./calls-ipc";
import { markStarted } from "./calls";
import { registerModelsIpc } from "./models-ipc";
import { checkProtection, registerPrivacyIpc } from "./privacy";
import * as readiness from "./readiness";
import { forgetClaudeCodeCheck, readyItems, refreshReady, registerReadyIpc } from "./ready-ipc";
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
  try {
    markStarted(dir);
  } catch (e) {
    console.warn(`[calls] start time of ${dir}: ${e}`);
  }
  emit({ ev: "cleared" });
  core.send({ cmd: "open_call", dir });
}

const coreExe = resolveCoreExe(app.getAppPath(), app.isPackaged);
const core = new CoreProcess(coreExe, coreArgs, rootDir(), emit, coreEnv);

/** What each hotkey does; the overlay buttons run the same through `ui:action`. */
/** Asks the core for an answer; the hints window says «Спрашиваю…» at once. */
function ask(cmd: Extract<Command, { cmd: "ask" }>): void {
  sendUi(overlays.hints, { kind: "asking" });
  core.send(cmd);
}

const actions: Record<HotkeyAction, () => void> = {
  ask: () => ask({ cmd: "ask", screenshot: false }),
  screenshotAsk: () => {
    sendUi(overlays.hints, { kind: "looking" });
    core.send({ cmd: "ask", screenshot: true });
  },
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
  myQuestions: () => ask({ cmd: "ask", screenshot: false, kind: "questions" }),
  continueTalk: () => ask({ cmd: "ask", screenshot: false, kind: "continue" }),
  moreAnswer: () => ask({ cmd: "ask", screenshot: false, kind: "more" }),
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
    execFile(coreExe, args, { cwd: rootDir(), env: coreEnv(), windowsHide: true, timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
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
  // The core prints only whether a key is set; the form shows the key itself.
  effective.anthropicApiKey = apiKey();
  effective.llm = { ...(effective.llm as object | undefined), apiKey: llmKey() };
  return { path: configPath() ?? newConfigPath(), raw, effective };
}

function saveConfig(patch: Record<string, unknown>): SaveResult {
  const plan = applyPlan(Object.keys(patch), core.running());
  const res = writeConfig(secretPatch(patch));
  if (!res.ok) return res;
  registerHotkeys();
  // Hotkeys live in main only: changing them must not restart the core and cut off an answer.
  if (plan === "hotkeys") return res;
  forgetClaudeCodeCheck();
  refreshReady();
  // Claude settings apply in place: audio and speech recognition go on, the open call stays.
  if (plan === "live") {
    core.send({ cmd: "reload_llm", anthropic_api_key: apiKey() || null, llm_api_key: llmKey() || null });
    return { ...res, live: true };
  }
  core.restart();
  resolveDataDir();
  return res;
}

/** The core's effective dataDir (it fills in the default), relative paths against the config's folder. */
async function resolveDataDir(): Promise<void> {
  const cfg = await loadConfig();
  const dir = String(cfg.effective.dataDir ?? "") || path.join(app.getPath("documents"), "Suflyor");
  dataDir = path.resolve(path.dirname(cfg.path), dir);
}

function registerUpdateIpc(): void {
  update.initUpdates((s) => wins.settings?.webContents.send("update:changed", s));
  ipcMain.handle("update:state", () => update.updateState());
  ipcMain.on("update:check", () => update.check());
  ipcMain.on("update:download", () => update.download());
  ipcMain.on("update:install", () => void update.install(() => core.stopped()));
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
  registerReadyIpc({ core, saveConfig, coreError: () => coreError, lastStatus: () => lastStatus, logDir });
  registerPrivacyIpc(runCore);
  ipcMain.on("logs:open", () => shell.openPath(logDir));
  const replay = (w: BrowserWindow) => {
    if (lastStatus) w.webContents.send("core-event", { ev: "status", ...lastStatus });
    if (lastCall) w.webContents.send("core-event", { ev: "call", ...lastCall });
  };
  const overlaysOn = () => {
    if (overlays.transcript) return;
    createOverlay("transcript", replay);
    createOverlay("hints", replay);
  };
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
  setTimeout(() => void checkProtection(runCore, emit), 3000);
  registerHotkeys();
  encryptStoredKey();
  // The core reads the migrated profile, so it starts after the migration.
  resolveDataDir()
    .then(migrateContext)
    .finally(() => core.start());
  // A fresh install has no model and no Claude: «Проверка готовности» alone first, the overlays after it.
  void readyItems().then((items) => {
    const missing = items.filter((i) => !i.ok).map((i) => i.id);
    if (missing.length) console.log(`[ready] missing: ${missing.join(", ")}`);
    if (!readiness.blocking(items)) return overlaysOn();
    openReady();
    wins.ready?.once("closed", overlaysOn);
  }, overlaysOn);
});

// Quitting with a call open does not wait for its summary: the core leaves the call marked, and
// writes the summary at the next start (call::defer_summary).
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core.stop();
});

app.on("window-all-closed", () => app.quit());
