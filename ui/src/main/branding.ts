// App customization: a custom name and icon in Task Manager.
// Task Manager shows the exe's FileDescription and icon resource, and a running exe cannot be rewritten.
// So we write a patched copy `<name>.exe` next to the original; the original, started by the shortcuts,
// rebuilds the copy when needed (a new version, an unapplied change) and hands over to it at every start.
// The core gets a copy `<name>.exe` next to suflyor-core.exe the same way: it is our child in Task Manager.
import { app, ipcMain, nativeImage } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { icoProblem, icoSizes, iconKind, nameProblem, PRESET_ICON, PRESETS, type Preset, presetById, pngProblem } from "../shared/branding";
import type { BrandInfo } from "../shared/protocol";
import { ico } from "../shared/png";
import type * as RE from "resedit";
import { isPackaged } from "./config";
import { resolveCoreExe } from "./core";
import { BrandError, patchExe } from "./exe-patch";
import { writeAtomic } from "./json-file";

// require, not import: esbuild would bundle resedit's .mjs entry, which loads its CJS build at run time
// through createRequire(import.meta.url), and import.meta is empty in our CJS bundle.
const ResEdit: typeof RE = require("resedit");

interface State {
  /** The custom name; null: the original name and icon. */
  name: string | null;
  /** A custom icon is stored in `iconFile()`. */
  icon: boolean;
  /** What the copy on disk was built from (`stamp`); differs after an update or a change. */
  built?: string;
  /** Names of earlier copies to delete once they no longer run. */
  old: string[];
  /** Why the last change failed; shown in Settings until the next change. */
  error?: string;
}

const exeDir = path.dirname(process.execPath);
/** The exe the installer made; in development, electron.exe. */
const ORIGINAL = path.join(exeDir, isPackaged ? `${app.getName()}.exe` : "electron.exe");
const stateDir = () => path.join(app.getPath("userData"), "branding");
const stateFile = () => path.join(stateDir(), "state.json");
const iconFile = () => path.join(stateDir(), "icon.ico");
const copyPath = (name: string) => path.join(exeDir, `${name}.exe`);
const CORE = resolveCoreExe(app.getAppPath(), isPackaged);
const coreCopy = (name: string) => path.join(path.dirname(CORE), `${name}.exe`);
/** [original, copy] of each exe a custom name renames; no core in development until it is built. */
const pairs = (name: string): [string, string][] => [[ORIGINAL, copyPath(name)], ...(fs.existsSync(CORE) ? [[CORE, coreCopy(name)] as [string, string]] : [])];
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const runningCopy = () => !same(process.execPath, ORIGINAL);
const log = (msg: string) => console.log(`[branding] ${msg}`);

/** Set when the last start could not apply a change: Settings opens on the section. */
let startError: string | null = null;

function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return { name: typeof s.name === "string" ? s.name : null, icon: s.icon === true, built: s.built, old: Array.isArray(s.old) ? s.old : [], error: s.error };
  } catch {
    return { name: null, icon: false, old: [] };
  }
}

function save(s: State): void {
  writeAtomic(stateFile(), JSON.stringify(s, null, 2));
}

/** The inputs of the copies: name, icon and the original exes (an update replaces them). */
function stamp(name: string, icon: Buffer | null): string {
  const hash = icon ? crypto.createHash("sha256").update(icon).digest("hex").slice(0, 16) : "-";
  const exes = pairs(name).map(([orig]) => {
    const st = fs.statSync(orig);
    return `${st.size}|${st.mtimeMs}`;
  });
  return [name, hash, ...exes].join("|");
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function message(e: unknown): string {
  if (e instanceof BrandError) return e.message;
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EPERM" || code === "EACCES") return `Нет прав на запись в папку программы (${exeDir}). Запустите программу от имени администратора или переустановите её для текущего пользователя.`;
  if (code === "EBUSY") return "Файл программы занят другим процессом. Закройте другие копии программы и повторите.";
  if (code === "ENOSPC") return "Недостаточно места на диске.";
  return `Не удалось: ${(e as Error).message ?? e}`;
}

const dropNew = (name: string) => {
  for (const [, copy] of pairs(name)) fs.rmSync(`${copy}.new`, { force: true });
};

/** Writes the copies for `name` as `<name>.exe.new`; `install` moves them in place. */
function build(name: string, icon: Buffer | null): void {
  try {
    for (const [orig, copy] of pairs(name)) fs.writeFileSync(`${copy}.new`, patchExe(ResEdit, fs.readFileSync(orig), name, icon));
  } catch (e) {
    dropNew(name);
    throw e;
  }
}

/** Moves each `<name>.exe.new` over `<name>.exe`; the old copy may still be exiting, so it retries for a few seconds. */
function install(name: string): void {
  for (const [, target] of pairs(name)) {
    if (!fs.existsSync(`${target}.new`)) continue;
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(`${target}.new`, target);
        break;
      } catch (e) {
        if (i >= 15) throw new BrandError(`Не удалось заменить ${target}: файл занят (программа ещё работает?) или нет прав. ${message(e)}`);
        sleep(200);
      }
    }
  }
}

/** Deletes copies of earlier names; one still running stays for the next start. */
function removeOld(s: State): void {
  s.old = s.old.filter((name) => {
    if (name === s.name) return false; // in use again
    if (same(copyPath(name), process.execPath)) return true;
    try {
      for (const file of [copyPath(name), coreCopy(name)]) {
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.new`, { force: true });
      }
      log(`removed ${name}.exe`);
      return false;
    } catch (e) {
      log(`cannot remove ${name}.exe yet: ${e}`);
      return true;
    }
  });
}

const storedIcon = (s: State) => (s.icon && fs.existsSync(iconFile()) ? fs.readFileSync(iconFile()) : null);

/**
 * Runs first, before the single-instance lock. In the original exe with a custom name it brings the copy
 * up to date and starts it; returns true when this process must exit. Any failure rolls back to the
 * original name and icon, and Settings shows why.
 */
export function handOver(): boolean {
  const s = load();
  if (runningCopy()) {
    log(`running as ${path.basename(process.execPath)}`);
    return false;
  }
  const before = s.old.length;
  removeOld(s);
  if (!s.name) {
    if (s.old.length !== before) save(s);
    return false;
  }
  const name = s.name;
  const target = copyPath(name);
  try {
    const icon = storedIcon(s);
    const want = stamp(name, icon);
    if (s.built !== want || pairs(name).some(([, c]) => !fs.existsSync(c) && !fs.existsSync(`${c}.new`))) {
      log(`building ${name}.exe (${s.built ? "the program was updated or changed" : "first start"})`);
      build(name, icon);
      s.built = want;
    }
    install(name);
    s.error = undefined;
    save(s);
  } catch (e) {
    startError = message(e);
    log(`cannot apply "${name}", back to the original: ${e}`);
    dropNew(name);
    save({ name: null, icon: false, old: [...s.old, name], error: startError });
    return false;
  }
  log(`starting ${name}.exe`);
  spawn(target, process.argv.slice(1), { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
  return true;
}

/** The core to run: the copy with the custom name, else the original. */
export function coreExe(): string {
  const name = load().name;
  return name && fs.existsSync(coreCopy(name)) ? coreCopy(name) : CORE;
}

/** The custom icon for the tray and windows; null: the app's mark. */
export function customIcon(): Electron.NativeImage | null {
  const s = load();
  if (!s.name || !s.icon || !fs.existsSync(iconFile())) return null;
  const img = nativeImage.createFromPath(iconFile());
  return img.isEmpty() ? null : img;
}

/** The custom name for the tray tooltip; null: the original. */
export const customName = (): string | null => load().name;

/** The failure of this start's hand-over, once (Settings opens on it). */
export function takeStartError(): string | null {
  const e = startError;
  startError = null;
  return e;
}

const windir = process.env.SystemRoot ?? "C:\\Windows";

/**
 * The preset's icon taken from its Windows program, as a cached .ico path. Newer builds keep the
 * program's resources in SystemResources/<exe>.mun, older ones in the exe itself.
 */
function presetIcon(p: Preset): string {
  const cached = path.join(stateDir(), "presets", `${p.id}.ico`);
  if (fs.existsSync(cached)) return cached;
  for (const file of [path.join(windir, "SystemResources", `${p.exe}.mun`), path.join(windir, "System32", p.exe)]) {
    if (!fs.existsSync(file)) continue;
    const res = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true }));
    // The first group is the one Explorer shows for the program.
    const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    if (!group) continue;
    const out = new ResEdit.Data.IconFile();
    out.icons = group.getIconItemsFromEntries(res.entries).map((data) => ({ data }));
    const b = Buffer.from(out.generate());
    const problem = icoProblem(b);
    if (problem) throw new BrandError(`${p.exe}: ${problem}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, b);
    return cached;
  }
  throw new BrandError(`В Windows нет значка ${p.exe}`);
}

/** Presets whose Windows program is here, with their icons. */
function presets(): BrandInfo["presets"] {
  return PRESETS.flatMap((p) => {
    try {
      return [{ id: p.id, name: p.name, icon: nativeImage.createFromPath(presetIcon(p)).toDataURL() }];
    } catch (e) {
      log(`preset ${p.id}: ${e}`);
      return [];
    }
  });
}

/** A picked icon file as .ico bytes, or a BrandError saying what is wrong with it. */
function readIcon(file: string): Buffer {
  if (file.startsWith(PRESET_ICON)) {
    const p = presetById(file.slice(PRESET_ICON.length));
    if (!p) throw new BrandError("Нет такого готового значка");
    return fs.readFileSync(presetIcon(p));
  }
  let b: Buffer;
  try {
    b = fs.readFileSync(file);
  } catch (e) {
    throw new BrandError(`Не удалось прочитать файл: ${(e as Error).message}`);
  }
  const kind = iconKind(b);
  if (kind === "ico") {
    const p = icoProblem(b);
    if (p) throw new BrandError(p);
    return b;
  }
  if (kind === "png") {
    const img = nativeImage.createFromBuffer(b);
    const { width, height } = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
    const p = pngProblem(b.length, width, height);
    if (p) throw new BrandError(p);
    return ico(icoSizes(width).map((size) => ({ size, png: img.resize({ width: size, height: size, quality: "best" }).toPNG() })));
  }
  throw new BrandError("Нужен файл .ico или .png");
}

async function info(): Promise<BrandInfo> {
  const s = load();
  const originalIcon = (await app.getFileIcon(ORIGINAL, { size: "large" })).toDataURL();
  const custom = s.icon && fs.existsSync(iconFile());
  const icon = custom ? nativeImage.createFromPath(iconFile()).toDataURL() : originalIcon;
  return { name: s.name, original: path.basename(ORIGINAL, ".exe"), icon, originalIcon, customIcon: custom, error: s.error ?? null, presets: presets() };
}

/** Quits and starts again through the original exe, which applies the state. */
function restart(): void {
  app.relaunch({ execPath: ORIGINAL, args: process.argv.slice(1) });
  app.quit();
}

/** `icon`: a picked file, null for the original icon, undefined to keep the current one. */
function apply(rawName: string, icon: string | null | undefined): { error: string } | undefined {
  const name = String(rawName).trim();
  log(`apply: name "${name}", icon ${icon === undefined ? "unchanged" : (icon ?? "original")}`);
  const s = load();
  try {
    const p = nameProblem(name);
    if (p) throw new BrandError(p);
    if (same(copyPath(name), ORIGINAL)) throw new BrandError("Это исходное имя: нажмите «Вернуть исходные».");
    if (same(coreCopy(name), CORE)) throw new BrandError("Это имя файла ядра программы. Выберите другое имя.");
    const ours = s.name === name || s.old.includes(name);
    if (!ours && pairs(name).some(([, c]) => fs.existsSync(c))) throw new BrandError("В папке программы уже есть файл с таким именем. Выберите другое имя.");
    const iconBytes = icon === undefined ? storedIcon(s) : icon === null ? null : readIcon(icon);
    build(name, iconBytes);
    if (iconBytes && icon) fs.writeFileSync(iconFile(), iconBytes);
    if (!iconBytes) fs.rmSync(iconFile(), { force: true });
    if (s.name && s.name !== name) s.old.push(s.name);
    s.old = s.old.filter((n) => n !== name);
    save({ name, icon: Boolean(iconBytes), built: stamp(name, iconBytes), old: s.old });
  } catch (e) {
    const error = message(e);
    log(`apply failed: ${e}`);
    return { error };
  }
  log("applied, restarting");
  restart();
  return undefined;
}

function reset(): void {
  const s = load();
  log(`reset (was "${s.name ?? "original"}")`);
  if (s.name) s.old.push(s.name);
  fs.rmSync(iconFile(), { force: true });
  save({ name: null, icon: false, old: s.old });
  if (s.name || runningCopy()) restart();
}

export function registerBrandingIpc(): void {
  ipcMain.handle("brand:info", info);
  ipcMain.handle("brand:check-icon", (_e, file: string) => {
    try {
      readIcon(String(file));
      log(`icon picked: ${file}`);
      return { url: nativeImage.createFromPath(String(file)).toDataURL() };
    } catch (e) {
      log(`icon rejected: ${file}: ${message(e)}`);
      return { error: message(e) };
    }
  });
  ipcMain.handle("brand:apply", (_e, name: string, icon: string | null | undefined) => apply(name, icon));
  ipcMain.handle("brand:reset", () => reset());
}
