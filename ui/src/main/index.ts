import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Command, ConfigSnapshot, CoreEvent, SaveResult, Status } from "../shared/protocol";
import { CoreProcess, resolveCoreExe } from "./core";

interface Hotkeys {
  ask: string;
  screenshotAsk: string;
  toggleWindow: string;
  toggleAuto: string;
}

const DEFAULT_HOTKEYS: Hotkeys = {
  ask: "CommandOrControl+Shift+Space",
  screenshotAsk: "CommandOrControl+Shift+S",
  toggleWindow: "CommandOrControl+Shift+H",
  toggleAuto: "CommandOrControl+Shift+A",
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

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let lastStatus: Status | null = null;
let configPath = findConfig();

function emit(e: CoreEvent): void {
  if (e.ev === "status") lastStatus = e;
  win?.webContents.send("core-event", e);
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    x: 40,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // Hides the overlay from screen sharing and screenshots (WDA_EXCLUDEFROMCAPTURE).
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "index.html"));
  // Replay the last status after a renderer reload.
  win.webContents.on("did-finish-load", () => lastStatus && emit({ ev: "status", ...lastStatus }));
  win.on("closed", () => (win = null));
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
    title: "Settings",
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

function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hotkeys = loadHotkeys();
  const map: [string, () => void][] = [
    [hotkeys.ask, () => core.send({ cmd: "ask", screenshot: false })],
    [hotkeys.screenshotAsk, () => core.send({ cmd: "ask", screenshot: true })],
    [hotkeys.toggleWindow, toggleWindow],
    [hotkeys.toggleAuto, () => core.send({ cmd: "set", auto: !(lastStatus?.auto ?? true) })],
  ];
  for (const [accel, fn] of map) {
    try {
      if (!globalShortcut.register(accel, fn)) console.warn(`[hotkey] failed to register ${accel}`);
    } catch (e) {
      console.warn(`[hotkey] invalid accelerator ${accel}: ${e}`);
    }
  }
}

/** Runs the core with extra arguments and returns its stdout. */
function runCore(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(coreExe, args, { cwd: rootDir(), windowsHide: true, timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

async function loadConfig(): Promise<ConfigSnapshot> {
  const raw = readRaw(configPath);
  let effective: Record<string, unknown> = {};
  try {
    effective = JSON.parse(await runCore(["--print-config", ...coreArgs()]));
  } catch (e) {
    console.warn(`[settings] core --print-config failed: ${e}`);
  }
  effective.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys as object | undefined) };
  return { path: configPath ?? newConfigPath(), raw, effective };
}

/** Writes dotted keys into the stored config, keeping every key the form does not know. */
function saveConfig(patch: Record<string, unknown>): SaveResult {
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
  registerHotkeys();
  core.restart(coreArgs());
  return { ok: true, path: target };
}

app.whenReady().then(() => {
  ipcMain.on("core-cmd", (_e, cmd: Command) => core.send(cmd));
  ipcMain.on("hide", () => win?.hide());
  ipcMain.on("settings:open", openSettings);
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle("config:load", loadConfig);
  ipcMain.handle("config:save", (_e, patch: Record<string, unknown>) => saveConfig(patch));
  ipcMain.handle("config:mics", async () => (await runCore(["--list-mics"])).split(/\r?\n/).filter(Boolean));
  createWindow();
  registerHotkeys();
  core.start();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core.stop();
});

app.on("window-all-closed", () => app.quit());
