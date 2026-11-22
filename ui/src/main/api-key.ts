// API keys, stored in config.json encrypted with the Windows login (Electron safeStorage, DPAPI): the
// Anthropic key and the key of the OpenAI-compatible provider (`llm.backend` = "openai"). The core never
// reads them from the file: it gets them in its environment and with `reload_llm`.
import { safeStorage } from "electron";
import { readRaw, writeConfig } from "./config";

interface Secret {
  /** Dotted config key of the plain value (what the settings form edits). */
  field: string;
  /** Top-level config key of the encrypted value. */
  enc: string;
  /** The core's environment variable. */
  env: string;
}

const ANTHROPIC: Secret = { field: "anthropicApiKey", enc: "anthropicApiKeyEnc", env: "ANTHROPIC_API_KEY" };
const LLM: Secret = { field: "llm.apiKey", enc: "llmApiKeyEnc", env: "SUFLYOR_LLM_API_KEY" };
const SECRETS = [ANTHROPIC, LLM];


function plain(raw: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), raw);
}

/** The key in use: the encrypted one, else a plain one (written by hand or by an older version). */
function read(s: Secret): string {
  const raw = readRaw();
  const enc = raw[s.enc];
  if (typeof enc === "string" && enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch (e) {
      // Another Windows user or machine: the key has to be entered again.
      console.warn(`[api-key] cannot decrypt ${s.enc}: ${e}`);
      return "";
    }
  }
  const p = plain(raw, s.field);
  return typeof p === "string" ? p : "";
}

/** The config patch that stores `key`: encrypted, the plain field removed. */
function patchFor(s: Secret, key: string): Record<string, unknown> {
  if (!key) return { [s.enc]: undefined, [s.field]: undefined };
  if (!safeStorage.isEncryptionAvailable()) return { [s.field]: key };
  return { [s.enc]: safeStorage.encryptString(key).toString("base64"), [s.field]: undefined };
}

export const apiKey = (): string => read(ANTHROPIC);
export const llmKey = (): string => read(LLM);

/** A settings patch with its secret fields swapped for their encrypted form. */
export function secretPatch(patch: Record<string, unknown>): Record<string, unknown> {
  let out = { ...patch };
  for (const s of SECRETS) {
    if (!(s.field in patch)) continue;
    const { [s.field]: value, ...rest } = out;
    out = { ...rest, ...patchFor(s, String(value ?? "").trim()) };
  }
  return out;
}

/** Plain keys left in config.json get encrypted once. */
export function encryptStoredKey(): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const raw = readRaw();
  for (const s of SECRETS) {
    const p = plain(raw, s.field);
    if (typeof p === "string" && p) writeConfig(patchFor(s, p));
  }
}

/** The environment the core runs with: the keys there are. */
export function coreEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const s of SECRETS) {
    const key = read(s);
    if (key) env[s.env] = key;
  }
  return env;
}
