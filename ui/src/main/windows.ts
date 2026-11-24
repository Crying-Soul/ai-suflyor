// The app's windows: the two overlays (positions, presets, zoom, theme survive restarts) and the normal windows.
import { app, BrowserWindow, screen, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ThemeId, UiMessage } from "../shared/protocol";
import { toTheme } from "../shared/protocol";
import { customIcon } from "./branding";
import { markImage } from "./tray";

export type OverlayName = "transcript" | "hints";

/** Every open window; null/absent when closed. */
export const wins: {
  overlays: Partial<Record<OverlayName, BrowserWindow>>;
  settings: BrowserWindow | null;
  calls: BrowserWindow | null;
  ready: BrowserWindow | null;
} = { overlays: {}, settings: null, calls: null, ready: null };
const overlays = wins.overlays;

/** Per theme: the window background before the page paints and the native caption buttons (each theme's paper and ink in sRGB). */
const CHROME: Record<ThemeId, { paper: string; symbol: string }> = {
  graphite: { paper: "#161618", symbol: "#f2f1ee" },
  night: { paper: "#000000", symbol: "#e9e8e4" },
  day: { paper: "#f6f5f1", symbol: "#16161a" },
  contrast: { paper: "#000000", symbol: "#ffffff" },
};
const paper = () => CHROME[win.theme].paper;
const titleBar = () => ({ color: paper(), symbolColor: CHROME[win.theme].symbol, height: 40 });

/** The taskbar and Alt+Tab icon of the normal windows (overlays stay out of both). */
let icon: Electron.NativeImage | undefined;
const windowIcon = () => (icon ??= customIcon() ?? markImage([[32, 1], [64, 2]]));

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
  theme: ThemeId;
}

function loadState(): WinState {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {}
  // The first version stored {transcript, hints} only: that is the normal preset.
  const normal = (raw.normal ?? { transcript: raw.transcript, hints: raw.hints }) as WinState["normal"];
  return { preset: raw.preset === "camera" ? "camera" : "normal", normal, camera: (raw.camera ?? {}) as WinState["camera"], zoom: Number(raw.zoom) || 1, theme: toTheme(raw.theme) };
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

/** Loads a page with the theme in its URL, so it paints in that theme from the first frame. */
function load(w: BrowserWindow, page: string, hash?: string): void {
  void w.loadFile(path.join(__dirname, `${page}.html`), { query: { theme: win.theme }, hash });
}

export function setTheme(id: ThemeId): void {
  win.theme = id;
  saveState();
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(paper());
    // Only the normal windows have native caption buttons; overlays are frameless.
    if (w === wins.settings || w === wins.calls || w === wins.ready) w.setTitleBarOverlay(titleBar());
    sendUi(w, { kind: "theme", id });
  }
}

/** `replay` sends a reloaded page what it missed (the last status and call). */
export function createOverlay(name: OverlayName, replay: (w: BrowserWindow) => void): void {
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
    backgroundColor: paper(),
    alwaysOnTop: true,
    show: false,
    title: name === "transcript" ? "Транскрипт" : "Подсказки",
    webPreferences: webPreferences(),
  });
  w.setAlwaysOnTop(true, "screen-saver");
  // Hides the overlay from screen sharing and screenshots (WDA_EXCLUDEFROMCAPTURE).
  w.setContentProtection(true);
  load(w, name);
  w.once("ready-to-show", () => w.showInactive());
  // Replay the last status after a renderer (re)load.
  w.webContents.on("did-finish-load", () => {
    w.webContents.setZoomFactor(win.zoom);
    sendUi(w);
    replay(w);
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

export function sendUi(w: BrowserWindow | undefined, m?: UiMessage): void {
  w?.webContents.send("ui", m ?? { kind: "mode", mini: win.preset === "camera", clickThrough });
}

export function togglePreset(): void {
  win.preset = win.preset === "camera" ? "normal" : "camera";
  for (const [name, w] of Object.entries(overlays) as [OverlayName, BrowserWindow][]) {
    w.setMinimumSize(320, win.preset === "camera" && name === "hints" ? 120 : 260);
    w.setBounds(boundsFor(name, win.preset));
    sendUi(w);
  }
  saveState();
}

export function toggleClickThrough(): void {
  clickThrough = !clickThrough;
  for (const w of Object.values(overlays)) {
    w.setIgnoreMouseEvents(clickThrough, { forward: true });
    sendUi(w);
  }
}

export function zoom(delta: number): void {
  win.zoom = Math.round(Math.min(1.6, Math.max(0.7, win.zoom + delta)) * 10) / 10;
  for (const w of Object.values(overlays)) w.webContents.setZoomFactor(win.zoom);
  saveState();
}

/** Brings back a normal window, minimized too (Win+D): with no taskbar button the tray is the only way back. */
function raise(w: BrowserWindow): void {
  if (w.isMinimized()) w.restore();
  w.focus();
}

/** `section`: the Settings section to show ("guide" is the in-app guide). */
export function openSettings(section?: string): void {
  if (wins.settings) {
    if (section) sendUi(wins.settings, { kind: "section", id: section });
    raise(wins.settings);
    return;
  }
  wins.settings = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    title: "Настройки",
    backgroundColor: paper(),
    // No taskbar button: a full-screen share shows the taskbar. No minimize: there would be no button to restore from.
    skipTaskbar: true,
    minimizable: false,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBar(),
    icon: windowIcon(),
    show: false,
    webPreferences: webPreferences(),
  });
  wins.settings.once("ready-to-show", () => wins.settings?.show());
  // Settings show the API key and the user context: keep them out of screen sharing too.
  wins.settings.setContentProtection(true);
  load(wins.settings, "settings", section);
  wins.settings.on("closed", () => (wins.settings = null));
}

export function openCalls(): void {
  if (wins.calls) {
    raise(wins.calls);
    return;
  }
  wins.calls = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "Звонки",
    backgroundColor: paper(),
    skipTaskbar: true,
    minimizable: false,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBar(),
    icon: windowIcon(),
    show: false,
    webPreferences: webPreferences(),
  });
  wins.calls.once("ready-to-show", () => wins.calls?.show());
  // CVs, notes and transcripts: never in a screen share.
  wins.calls.setContentProtection(true);
  load(wins.calls, "calls");
  wins.calls.on("closed", () => (wins.calls = null));
}

/** Hides both overlays if any is visible, otherwise shows both. */
export function toggleWindows(): void {
  const all = Object.values(overlays);
  const anyVisible = all.some((w) => w.isVisible());
  for (const w of all) {
    if (anyVisible) w.hide();
    else w.showInactive();
  }
}

export function openReady(): void {
  if (wins.ready) {
    raise(wins.ready);
    return;
  }
  wins.ready = new BrowserWindow({
    width: 600,
    height: 680,
    minWidth: 480,
    minHeight: 420,
    title: "Проверка готовности",
    backgroundColor: paper(),
    skipTaskbar: true,
    minimizable: false,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBar(),
    icon: windowIcon(),
    show: false,
    webPreferences: webPreferences(),
  });
  wins.ready.once("ready-to-show", () => wins.ready?.show());
  wins.ready.setContentProtection(true);
  load(wins.ready, "ready");
  wins.ready.on("closed", () => (wins.ready = null));
}

