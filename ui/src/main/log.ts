// Log files the user can send: everything main prints (core stderr included) goes to userData/logs/YYYY-MM-DD.log.
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

const KEEP_DAYS = 7;

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Deletes `*.log` files older than `keepDays`; returns the names removed. */
export function prune(dir: string, now = Date.now(), keepDays = KEEP_DAYS): string[] {
  const removed: string[] = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, name);
    if (name.endsWith(".log") && now - fs.statSync(file).mtimeMs > keepDays * 86_400_000) {
      fs.rmSync(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Tees console.log/warn/error into the day's file. */
export function startLogs(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  prune(dir);
  let open = "";
  let out: fs.WriteStream | null = null;
  const write = (level: string, args: unknown[]) => {
    const now = new Date();
    if (day(now) !== open) {
      out?.end();
      open = day(now);
      out = fs.createWriteStream(path.join(dir, `${open}.log`), { flags: "a" });
      out.on("error", () => (out = null)); // a full or locked disk must not crash the app
    }
    out?.write(`${now.toTimeString().slice(0, 8)} ${level} ${format(...args)}\n`);
  };
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      write(level === "log" ? "INFO" : level.toUpperCase(), args);
    };
  }
}
