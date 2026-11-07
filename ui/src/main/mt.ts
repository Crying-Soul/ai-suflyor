// The local translation model (Opus-MT en→ru, ONNX): status and a resumable download of its files.
import fs from "node:fs";
import path from "node:path";
import type { ModelInfo } from "../shared/protocol";
import { fetchPart, type Job } from "./models";

const BASE = "https://huggingface.co/Xenova/opus-mt-en-ru/resolve/main";
/** Same list as `mt::FILES` in the core. */
const FILES = ["config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_quantized.onnx"];
const INFO = { id: "opus-mt-en-ru", label: "Opus-MT, английский → русский", sizeMb: 112, note: "Перевод речи собеседника на процессоре, без интернета и токенов." };

let job: Job | null = null;
let error: string | undefined;

const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

export function status(dir: string): ModelInfo {
  const files = FILES.map((f) => path.join(dir, f));
  const done = files.every((f) => fs.existsSync(f));
  const onDisk = files.reduce((n, f) => n + size(f) + size(`${f}.part`), 0);
  const state: ModelInfo["state"] = job ? "downloading" : done ? "installed" : onDisk ? "partial" : "absent";
  return { ...INFO, state, received: onDisk, total: INFO.sizeMb * 1024 * 1024, active: done, error };
}

/** Fetches the missing files one by one into `.part` (3 tries each, resumed), then renames them. */
export async function download(dir: string, progress: () => void): Promise<void> {
  if (job) return;
  const current: Job = { controller: new AbortController(), received: 0, total: 0 };
  job = current;
  error = undefined;
  const ticker = setInterval(progress, 200);
  progress();
  try {
    for (const name of FILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (let attempt = 1; ; attempt++) {
        try {
          await fetchPart(`${BASE}/${name}`, `${file}.part`, current, 0);
          fs.renameSync(`${file}.part`, file);
          break;
        } catch (e) {
          if (current.controller.signal.aborted || attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  } catch (e) {
    // Cancelled: no error, the .part files stay for a resume.
    if (!current.controller.signal.aborted) error = e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(ticker);
    job = null;
    progress();
  }
}

export function cancel(): void {
  job?.controller.abort();
}
