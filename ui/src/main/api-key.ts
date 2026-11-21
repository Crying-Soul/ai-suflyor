// The Anthropic API key, stored in config.json encrypted with the Windows login (Electron safeStorage,
// DPAPI). The core never reads it from the file: it gets it in its environment and with `reload_llm`.
import { safeStorage } from "electron";
import { readRaw, writeConfig } from "./config";

const ENCRYPTED = "anthropicApiKeyEnc";

/** The key in use: the encrypted one, else a plain one (written by hand or by an older version). */
export function apiKey(): string {
  const raw = readRaw();
  const enc = raw[ENCRYPTED];
  if (typeof enc === "string" && enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch (e) {
      // Another Windows user or machine: the key has to be entered again.
      console.warn(`[api-key] cannot decrypt: ${e}`);
      return "";
    }
  }
  return typeof raw.anthropicApiKey === "string" ? raw.anthropicApiKey : "";
}

/** The config patch that stores `key`: encrypted, the plain field removed. */
export function keyPatch(key: string): Record<string, unknown> {
  if (!key) return { [ENCRYPTED]: undefined, anthropicApiKey: undefined };
  if (!safeStorage.isEncryptionAvailable()) return { anthropicApiKey: key };
  return { [ENCRYPTED]: safeStorage.encryptString(key).toString("base64"), anthropicApiKey: undefined };
}

/** A plain key left in config.json gets encrypted once. */
export function encryptStoredKey(): void {
  const plain = readRaw().anthropicApiKey;
  if (typeof plain === "string" && plain && safeStorage.isEncryptionAvailable()) writeConfig(keyPatch(plain));
}

/** The environment the core runs with: the key, if there is one. */
export function coreEnv(): NodeJS.ProcessEnv {
  const key = apiKey();
  return key ? { ...process.env, ANTHROPIC_API_KEY: key } : process.env;
}
