// Updates from GitHub Releases (electron-updater): `latest.yml` there names the installer and its sha512.
// On demand only, from the button in Settings → «Справка»; a downloaded update also installs on quit.
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState } from "../shared/protocol";

let state: UpdateState = { state: app.isPackaged ? "idle" : "dev", version: app.getVersion() };
let notify: (s: UpdateState) => void = () => undefined;

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  notify(state);
}

export function initUpdates(onChange: (s: UpdateState) => void): void {
  notify = onChange;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => set({ state: "checking", error: undefined }));
  autoUpdater.on("update-available", (i) => set({ state: "available", latest: i.version }));
  autoUpdater.on("update-not-available", () => set({ state: "latest" }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", percent: Math.floor(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", latest: i.version }));
  autoUpdater.on("error", (e) => set({ state: "error", error: e.message }));
}

export const updateState = (): UpdateState => state;

// The promises also reject on failure; the `error` event above already reports it.
export function check(): void {
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => undefined);
}

export function download(): void {
  autoUpdater.downloadUpdate().catch(() => undefined);
}

/** `stopCore` first: the installer cannot replace suflyor-core.exe while it runs. */
export async function install(stopCore: () => Promise<void>): Promise<void> {
  await stopCore();
  autoUpdater.quitAndInstall(true, true);
}
