// «Готовность»: what is missing before a call, and the way to get it.
import { app, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { ReadyItem, SaveResult, Status } from "../shared/protocol";
import { PROVIDERS } from "../shared/providers";
import { apiKey, llmKey } from "./api-key";
import { readRaw } from "./config";
import type { CoreProcess } from "./core";
import { cuda } from "./cuda";
import { activeModel, cudaDir, getModel } from "./models-ipc";
import * as readiness from "./readiness";
import { openReady, wins } from "./windows";

export interface ReadyDeps {
  core: CoreProcess;
  saveConfig(patch: Record<string, unknown>): SaveResult;
  /** Why the core is not running, if it is not. */
  coreError(): string | null;
  lastStatus(): Status | null;
  logDir: string;
}

let d!: ReadyDeps;

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

/** The config changed: Claude Code is checked again. */
export function forgetClaudeCodeCheck(): void {
  claudeCodeOk = null;
}

const nvidia: Promise<boolean> = app
  .whenReady()
  .then(() => app.getGPUInfo("basic"))
  .then((i) => ((i as { gpuDevice?: { vendorId: number }[] }).gpuDevice ?? []).some((g) => g.vendorId === 0x10de))
  .catch(() => false);

export async function readyItems(): Promise<ReadyItem[]> {
  const raw = readRaw();
  const llm = (raw.llm ?? {}) as { backend?: string; provider?: string };
  const backend = llm.backend === "claude-code" || llm.backend === "openai" ? llm.backend : "api";
  const local = PROVIDERS.some((p) => p.id === llm.provider && p.local);
  return readiness.check({
    coreError: d.coreError(),
    modelExists: fs.existsSync(activeModel()),
    backend,
    apiKey: Boolean(apiKey() || process.env.ANTHROPIC_API_KEY),
    llmReady: local || Boolean(llmKey() || process.env.SUFLYOR_LLM_API_KEY),
    claudeCodeOk: backend === "claude-code" && (await checkClaudeCode()),
    nvidia: await nvidia,
    cudaInstalled: cuda.status(cudaDir()).state === "installed",
    status: d.lastStatus(),
  });
}

let readyTimer: NodeJS.Timeout | undefined;
/** Recomputes the list and sends it to whoever shows it (debounced: status events come in bursts). */
export function refreshReady(): void {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(async () => {
    const items = await readyItems();
    for (const w of [wins.ready, wins.overlays.transcript, wins.overlays.hints]) w?.webContents.send("ready:changed", items);
  }, 300);
}

/** Lists models with the key: free, and a wrong key answers 401 at once instead of at the first question. */
async function checkApiKey(key: string): Promise<"ok" | "rejected" | "offline"> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    return r.status === 401 || r.status === 403 ? "rejected" : "ok";
  } catch {
    return "offline";
  }
}

export function registerReadyIpc(deps: ReadyDeps): void {
  d = deps;
  ipcMain.on("core:restart", () => d.core.restart());
  ipcMain.handle("ready:list", readyItems);
  ipcMain.on("ready:open", openReady);
  ipcMain.handle("ready:apiKey", async (_e, key: string) => {
    const k = String(key).trim();
    if (!k.startsWith("sk-ant-")) return { ok: false, error: "Ключ API Anthropic начинается с sk-ant-." };
    const check = await checkApiKey(k);
    if (check === "rejected") return { ok: false, error: "Anthropic не принял ключ. Проверьте, что он скопирован целиком и не отозван." };
    const res = d.saveConfig({ anthropicApiKey: k, "llm.backend": "api" });
    return res.ok && check === "offline" ? { ...res, note: "Ключ сохранён, но проверить его не удалось: нет связи с api.anthropic.com." } : res;
  });
  ipcMain.handle("ready:claudeCode", async () => {
    const res = d.saveConfig({ "llm.backend": "claude-code" });
    if (!res.ok) return res;
    return (await checkClaudeCode()) ? res : { ok: false, error: "Команда claude не ответила. Установите Claude Code и войдите в аккаунт." };
  });
  ipcMain.on("ready:model", (_e, id: string) => void getModel(id));
  ipcMain.on("ready:logs", () => shell.openPath(d.logDir));
}
