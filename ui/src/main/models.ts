// Whisper models from Hugging Face (ggerganov/whisper.cpp): catalog, resumable download, checks.
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ModelInfo } from "../shared/protocol";

const BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const TREE = "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main";

/** Sizes are approximate (the download checks the real one); notes compare on an 8 GB GPU. */
export const CATALOG: Omit<ModelInfo, "state" | "received" | "total" | "active" | "error">[] = [
  { id: "large-v3-turbo", label: "Large v3 Turbo", sizeMb: 1620, note: "Лучшее соотношение: почти как Large v3, в разы быстрее. По умолчанию." },
  { id: "large-v3-turbo-q8_0", label: "Large v3 Turbo, q8", sizeMb: 874, note: "Та же точность, вдвое меньше памяти." },
  { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo, q5", sizeMb: 574, note: "Для слабых GPU, точность чуть ниже." },
  { id: "large-v3", label: "Large v3", sizeMb: 3100, note: "Самая точная и самая медленная. Нужен мощный GPU." },
  { id: "large-v3-q5_0", label: "Large v3, q5", sizeMb: 1080, note: "Large v3 в меньшей памяти." },
  { id: "medium", label: "Medium", sizeMb: 1530, note: "Заметно хуже на русском, чем Turbo." },
  { id: "medium-q5_0", label: "Medium, q5", sizeMb: 539, note: "Компромисс для CPU." },
  { id: "small", label: "Small", sizeMb: 488, note: "Быстрая на CPU, ошибается в терминах." },
  { id: "base", label: "Base", sizeMb: 148, note: "Только проверить, что всё работает." },
];

export const fileOf = (id: string) => `ggml-${id}.bin`;

export interface Job {
  controller: AbortController;
  received: number;
  total: number;
}
/** Electron passes net.fetch: Chromium's stack follows the system proxy and falls back IPv6 to IPv4. */
let fetch: typeof globalThis.fetch = globalThis.fetch;
export function useFetch(f: typeof globalThis.fetch): void {
  fetch = f;
}

const jobs = new Map<string, Job>();
const errors = new Map<string, string>();

const sameFile = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function list(dir: string, activeModel: string): ModelInfo[] {
  return CATALOG.map((m) => {
    const file = path.join(dir, fileOf(m.id));
    const job = jobs.get(m.id);
    const part = fs.existsSync(`${file}.part`) ? fs.statSync(`${file}.part`).size : 0;
    const state: ModelInfo["state"] = job ? "downloading" : fs.existsSync(file) ? "installed" : part ? "partial" : "absent";
    return { ...m, state, received: job?.received ?? part, total: job?.total ?? 0, active: sameFile(file, activeModel), error: errors.get(m.id) };
  });
}

/** Size and sha256 of the file from the repo listing (LFS metadata); null fields if it is missing. */
async function expected(id: string, signal: AbortSignal): Promise<{ size: number; sha256: string | null }> {
  const r = await fetch(TREE, { signal });
  if (!r.ok) throw new Error(`список моделей: HTTP ${r.status}`);
  const files = (await r.json()) as { path: string; size?: number; lfs?: { oid?: string; size?: number } }[];
  const f = files.find((x) => x.path === fileOf(id));
  const oid = f?.lfs?.oid ?? "";
  return { size: f?.lfs?.size ?? f?.size ?? 0, sha256: /^[0-9a-f]{64}$/.test(oid) ? oid : null };
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Thrown when the finished file is wrong: retrying the same bytes would not help. */
class BadFile extends Error {}

/** One request: appends to `<file>.part` from where it ends (Range), to the end of the file. */
export async function fetchPart(url: string, part: string, job: Job, totalHint: number): Promise<void> {
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (totalHint && start === totalHint) return;
  const res = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: job.controller.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (res.status !== 206) start = 0; // the server ignored Range: start over
  job.received = start;
  job.total = totalHint || start + Number(res.headers.get("content-length") ?? 0);
  const ws = fs.createWriteStream(part, { flags: start ? "a" : "w" });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      job.received += chunk.length;
      if (!ws.write(chunk)) await once(ws, "drain");
    }
  } finally {
    await new Promise<void>((resolve) => ws.end(() => resolve()));
  }
}

/**
 * Downloads into `<file>.part`, resuming it after a dropped connection (3 tries) or a cancel,
 * then checks the size and the sha256 and renames. `progress` is called ~5 times a second.
 */
export async function download(dir: string, id: string, progress: () => void): Promise<void> {
  if (jobs.has(id) || !CATALOG.some((m) => m.id === id)) return;
  const file = path.join(dir, fileOf(id));
  const part = `${file}.part`;
  const job: Job = { controller: new AbortController(), received: 0, total: 0 };
  jobs.set(id, job);
  errors.delete(id);
  const ticker = setInterval(progress, 200);
  progress();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const url = `${BASE}/${fileOf(id)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const want = await expected(id, job.controller.signal);
        await fetchPart(url, part, job, want.size);
        const size = fs.statSync(part).size;
        if (job.total && size !== job.total) throw new Error(`получено ${size} из ${job.total} байт`);
        if (want.sha256 && (await sha256(part)) !== want.sha256) {
          fs.rmSync(part, { force: true }); // a corrupt file must not be resumed
          throw new BadFile("контрольная сумма не совпала, файл удалён");
        }
        fs.renameSync(part, file);
        return;
      } catch (e) {
        if (job.controller.signal.aborted || e instanceof BadFile || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  } catch (e) {
    // Cancelled: no error, the .part stays for a resume.
    if (!job.controller.signal.aborted) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      errors.set(id, `${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ""}`);
    }
  } finally {
    clearInterval(ticker);
    jobs.delete(id);
    progress();
  }
}

export function cancel(id: string): void {
  jobs.get(id)?.controller.abort();
}

export function remove(dir: string, id: string, activeModel: string): void {
  const file = path.join(dir, fileOf(id));
  if (sameFile(file, activeModel)) throw new Error("эта модель сейчас используется");
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.part`, { force: true });
  errors.delete(id);
}
