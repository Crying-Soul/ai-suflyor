// config.json: where it is, reading it, and writing dotted keys into it.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Hotkeys } from "../shared/protocol";
import { DEFAULT_HOTKEYS } from "../shared/hotkeys";
import * as calls from "./calls";

/**
 * An installed build. Not `isPackaged`: Electron decides that by the exe's name, so the renamed
 * copy of electron.exe (Settings → Кастомизация) in dev would pass for an installed build.
 */
export const isPackaged = app.getAppPath().toLowerCase().startsWith(process.resourcesPath.toLowerCase());

/** Project root in dev (parent of ui/), the exe folder when packaged. */
export function rootDir(): string {
  return isPackaged ? path.dirname(app.getPath("exe")) : path.resolve(app.getAppPath(), "..");
}

function findConfig(): string | null {
  const candidates = [path.join(rootDir(), "config.json"), path.join(app.getPath("userData"), "config.json")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Where a new config.json goes when none exists yet (the install folder may be read-only). */
export function newConfigPath(): string {
  return isPackaged ? path.join(app.getPath("userData"), "config.json") : path.join(rootDir(), "config.json");
}

let file = findConfig();

/** The config.json in use; null until one exists. */
export const configPath = (): string | null => file;

/** The stored config as written (no defaults filled in). */
export const readRaw = (): Record<string, unknown> => (file ? calls.readJson(file) : {});

/** The core's arguments: the config it should read. */
export const coreArgs = () => (file ? ["--config", file] : []);

/** A config path as the core resolves it: against the config's folder. */
export const configRel = (p: string) => path.resolve(path.dirname(file ?? newConfigPath()), p);

export function loadHotkeys(): Hotkeys {
  return { ...DEFAULT_HOTKEYS, ...(readRaw().hotkeys as Partial<Hotkeys> | undefined) };
}

/** Writes dotted keys into the stored config, keeping every key the form does not know. */
export function writeConfig(patch: Record<string, unknown>): { ok: true; path: string } | { ok: false; error: string } {
  const target = file ?? newConfigPath();
  const raw = readRaw();
  calls.setDotted(raw, patch);
  try {
    calls.writeAtomic(target, JSON.stringify(raw, null, 2) + "\n");
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  file = target;
  return { ok: true, path: target };
}
