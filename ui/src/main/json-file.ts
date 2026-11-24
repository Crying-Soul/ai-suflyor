// JSON and text files on disk: read leniently, write atomically, patch by dotted keys.
import fs from "node:fs";
import path from "node:path";

export function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Writes dotted keys ("stt.model") into `raw`, creating the objects on the way. */
export function setDotted(raw: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    // "__proto__.x" would write into Object.prototype.
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    let obj = raw;
    for (const part of parts.slice(0, -1)) {
      if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  }
}

/** Write then rename: a crash mid-write never leaves a truncated file. */
export function writeAtomic(p: string, data: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, data);
  fs.renameSync(`${p}.tmp`, p);
}
