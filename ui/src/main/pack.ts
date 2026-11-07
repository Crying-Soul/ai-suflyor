// Optional downloads that are not whisper models: the translation model and the CUDA backend.
// Each is a set of files in one directory, installed or not, with one resumable download at a time.
import fs from "node:fs";
import path from "node:path";
import type { ModelInfo } from "../shared/protocol";
import { fetchPart, type Job } from "./models";

export interface PackSpec {
  info: Pick<ModelInfo, "id" | "label" | "sizeMb" | "note">;
  /** Present = installed. Relative to the pack's directory. */
  files: string[];
  /** Files whose size shows how far a stopped download got. */
  progress: string[];
  /** Fetches what is missing and lays the files out; resumes from what is on disk. */
  install(dir: string, job: Job): Promise<void>;
}

export interface Pack {
  status(dir: string): ModelInfo;
  download(dir: string, progress: () => void): Promise<void>;
  cancel(): void;
}

const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

export function pack(spec: PackSpec): Pack {
  let job: Job | null = null;
  let error: string | undefined;
  return {
    status(dir) {
      const done = spec.files.every((f) => fs.existsSync(path.join(dir, f)));
      const onDisk = spec.progress.reduce((n, f) => n + size(path.join(dir, f)), 0);
      const state: ModelInfo["state"] = job ? "downloading" : done ? "installed" : onDisk ? "partial" : "absent";
      return { ...spec.info, state, received: onDisk, total: spec.info.sizeMb * 1024 * 1024, active: done, error };
    },
    async download(dir, progress) {
      if (job) return;
      const current: Job = { controller: new AbortController(), received: 0, total: 0 };
      job = current;
      error = undefined;
      const ticker = setInterval(progress, 200);
      progress();
      try {
        fs.mkdirSync(dir, { recursive: true });
        await spec.install(dir, current);
      } catch (e) {
        // Cancelled: no error, the .part files stay for a resume.
        if (!current.controller.signal.aborted) error = e instanceof Error ? e.message : String(e);
      } finally {
        clearInterval(ticker);
        job = null;
        progress();
      }
    },
    cancel() {
      job?.controller.abort();
    },
  };
}

/** `url` into `file` through `file.part` (3 tries, resumed), unless `file` is there already. */
export async function fetchFile(url: string, file: string, job: Job): Promise<void> {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchPart(url, `${file}.part`, job, 0);
      fs.renameSync(`${file}.part`, file);
      return;
    } catch (e) {
      if (job.controller.signal.aborted || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
