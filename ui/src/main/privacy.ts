// Capture protection: check that Windows hides our windows from screen capture, and let the user see it.
import { app, type BrowserWindow, ipcMain, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreEvent, PrivacyReport } from "../shared/protocol";
import { wins } from "./windows";
import type { RunCore } from "./calls-ipc";

const overlays = wins.overlays;

const hwnd = (w: BrowserWindow) => w.getNativeWindowHandle().readBigUInt64LE(0).toString();

/** WDA_EXCLUDEFROMCAPTURE needs Windows 10 2004 (build 19041); older builds show a black box. */
const osHidesWindows = () => process.platform !== "win32" || Number(os.release().split(".")[2] ?? 0) >= 19041;

function ourWindows(): [string, BrowserWindow][] {
  const all: [string, BrowserWindow | null | undefined][] = [
    ["Транскрипт", overlays.transcript],
    ["Подсказки", overlays.hints],
    ["Настройки", wins.settings],
    ["Звонки", wins.calls],
    ["Проверка готовности", wins.ready],
  ];
  return all.filter((e): e is [string, BrowserWindow] => Boolean(e[1]));
}

/** Display affinity of each window, read by the core (0x11 = hidden from capture). */
async function affinities(runCore: RunCore): Promise<{ name: string; hidden: boolean }[]> {
  const list = ourWindows();
  // Overlays open only after «Проверка готовности»; the core refuses check-affinity without windows.
  if (!list.length) return [];
  const { stdout } = await runCore(["check-affinity", ...list.map(([, w]) => hwnd(w))]);
  const lines = stdout.trim().split(/\r?\n/);
  return list.map(([name], i) => ({ name, hidden: /\s0x11$/.test(lines[i] ?? "") }));
}

/** Once after start: a window that is not hidden from capture is said loudly. */
export async function checkProtection(runCore: RunCore, emit: (e: CoreEvent) => void): Promise<void> {
  if (!osHidesWindows()) emit({ ev: "error", message: "Windows старше 10 2004: в демонстрации экрана окна видны чёрными прямоугольниками" });
  try {
    const bad = (await affinities(runCore)).filter((w) => !w.hidden);
    if (bad.length) emit({ ev: "error", message: `Окно может попасть в демонстрацию экрана: ${bad.map((w) => w.name).join(", ")}` });
  } catch (e) {
    console.warn(`[privacy] affinity check failed: ${e}`);
  }
}

/** Captures the display with the overlays the way other apps do, so the user sees they are absent. */
async function privacyTest(runCore: RunCore): Promise<PrivacyReport> {
  for (const w of Object.values(overlays)) if (!w.isVisible()) w.showInactive();
  await new Promise((r) => setTimeout(r, 300));
  const anchor = overlays.hints ?? overlays.transcript;
  const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
  const r = screen.dipToScreenRect(null, display.bounds);
  // The core writes the picture as it would send it to Claude (lossless WebP).
  const file = path.join(app.getPath("temp"), `suflyor-privacy-${Date.now()}.webp`);
  try {
    await runCore(["snap", file, "--rect", `${r.x},${r.y},${r.width},${r.height}`]);
    const image = `data:image/webp;base64,${fs.readFileSync(file).toString("base64")}`;
    return { image, windows: await affinities(runCore), osOk: osHidesWindows() };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function registerPrivacyIpc(runCore: RunCore): void {
  ipcMain.handle("privacy:test", () => privacyTest(runCore));
}
