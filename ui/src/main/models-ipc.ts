// IPC of the whisper models and the CUDA pack: download, select, remove.
import { app, ipcMain, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { SaveResult } from "../shared/protocol";
import { configPath, isPackaged, configRel, newConfigPath, readRaw, rootDir } from "./config";
import type { CoreProcess } from "./core";
import { cuda } from "./cuda";
import * as models from "./models";
import { wins } from "./windows";

export interface ModelsDeps {
  core: CoreProcess;
  saveConfig(patch: Record<string, unknown>): SaveResult;
  refreshReady(): void;
}

let d!: ModelsDeps;

/** Where downloaded whisper models go: whisper/ in dev (next to whisper.dll), userData when installed. */
const modelsDir = () => (isPackaged ? path.join(app.getPath("userData"), "whisper-models") : path.join(rootDir(), "whisper"));

/** stt.model as an absolute path (relative ones resolve against the config's folder, as in the core). */
export function activeModel(): string {
  const p = (readRaw().stt as { model?: string } | undefined)?.model || "whisper/ggml-large-v3-turbo.bin";
  return configRel(p);
}

/** The CUDA backend: next to whisper.dll in dev (get-whisper.ps1 -Cuda), else stt.cudaDir. */
export function cudaDir(): string {
  const stt = (readRaw().stt ?? {}) as { dll?: string; cudaDir?: string };
  const beside = path.dirname(configRel(stt.dll || "whisper/whisper.dll"));
  return fs.existsSync(path.join(beside, "ggml-cuda.dll")) ? beside : configRel(stt.cudaDir || "cuda");
}

const PACKS = {
  cuda: { pack: cuda, dir: cudaDir },
};
type PackId = keyof typeof PACKS;

export function registerModelsIpc(deps: ModelsDeps): void {
  d = deps;
  models.useFetch(net.fetch as typeof fetch);
  const changed = modelsChanged;
  ipcMain.handle("pack:status", (_e, id: PackId) => PACKS[id].pack.status(PACKS[id].dir()));
  // Not awaited, like the whisper download: progress arrives as models:changed.
  ipcMain.handle("pack:download", (_e, id: PackId) => {
    const { pack, dir } = PACKS[id];
    // The core picks the CUDA backend up when it starts.
    void pack.download(dir(), changed).then(() => id === "cuda" && pack.status(dir()).state === "installed" && d.core.restart());
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
  const rel = path.relative(path.dirname(configPath() ?? newConfigPath()), file);
  return d.saveConfig({ "stt.model": rel.startsWith("..") || path.isAbsolute(rel) ? file : rel.replaceAll("\\", "/") });
}

/** Downloads a whisper model and, when none in use works yet, selects it: a first model need not be picked by hand. */
export async function getModel(id: string): Promise<void> {
  await models.download(modelsDir(), id, modelsChanged);
  if (!fs.existsSync(activeModel()) && fs.existsSync(path.join(modelsDir(), models.fileOf(id)))) useModel(id);
}

function modelsChanged(): void {
  wins.settings?.webContents.send("models:changed");
  wins.ready?.webContents.send("models:changed");
  d.refreshReady();
}

