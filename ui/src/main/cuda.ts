// The CUDA backend for whisper (NVIDIA): ~1.1 GB of DLLs the installer leaves out.
// Taken from the whisper.cpp release the bundled whisper.dll comes from (core/crates/stt/native/include/VERSION):
// a mismatched ggml-cuda.dll would not load.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fetchFile, pack } from "./pack";

const ZIP_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip";
const ZIP = "whisper-cuda.zip";
/** What ggml-cuda.dll needs; the rest of the archive duplicates the bundled DLLs. */
const FILES = ["ggml-cuda.dll", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"];

export const cuda = pack({
  info: { id: "cuda", label: "CUDA для Whisper", sizeMb: 653, note: "Распознавание на видеокарте NVIDIA, в несколько раз быстрее. Без неё Whisper работает на процессоре." },
  files: FILES,
  progress: [ZIP, `${ZIP}.part`],
  async install(dir, job) {
    const zip = path.join(dir, ZIP);
    await fetchFile(ZIP_URL, zip, job);
    const tmp = path.join(dir, "unpack");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    // Windows' own bsdtar reads zip; a tar earlier in PATH (Git's) may not.
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await promisify(execFile)(tar, ["-xf", zip, "-C", tmp, ...FILES.map((f) => `Release/${f}`)]);
    for (const f of FILES) fs.renameSync(path.join(tmp, "Release", f), path.join(dir, f));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  },
});
