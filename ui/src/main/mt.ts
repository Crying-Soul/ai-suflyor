// The local translation model (Opus-MT en→ru, ONNX), fetched file by file from Hugging Face.
import path from "node:path";
import { fetchFile, pack } from "./pack";

const BASE = "https://huggingface.co/Xenova/opus-mt-en-ru/resolve/main";
/** Same list as `mt::FILES` in the core. */
const FILES = ["config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_quantized.onnx"];

export const mt = pack({
  info: { id: "mt", label: "Opus-MT, английский → русский", sizeMb: 112, note: "Перевод речи собеседника на процессоре, без интернета и токенов." },
  files: FILES,
  progress: FILES.flatMap((f) => [f, `${f}.part`]),
  async install(dir, job) {
    for (const f of FILES) await fetchFile(`${BASE}/${f}`, path.join(dir, f), job);
  },
});
