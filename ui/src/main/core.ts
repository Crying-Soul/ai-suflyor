import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Command, CoreEvent } from "../shared/protocol";

/** Supervises suflyor-core.exe: spawns it, parses NDJSON events, restarts it on crash. */
export class CoreProcess {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;
  private restartPending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  // Plain fields, not parameter properties: node's type stripping (npm test) does not support those.
  private exe: string;
  /** Read at every start: on a fresh install config.json appears only after the UI starts. */
  private args: () => string[];
  private cwd: string;
  private onEvent: (e: CoreEvent) => void;

  constructor(exe: string, args: () => string[], cwd: string, onEvent: (e: CoreEvent) => void) {
    this.exe = exe;
    this.args = args;
    this.cwd = cwd;
    this.onEvent = onEvent;
  }

  start(): void {
    if (this.proc) return; // one core at a time: a second one would fight over the mic
    this.clearRetry();
    if (!fs.existsSync(this.exe)) {
      this.onEvent({ ev: "core_down", message: `core not found: ${this.exe} (run: npm run core)` });
      return;
    }
    const args = this.args();
    console.log(`[core] spawn ${this.exe} ${args.join(" ")}`);
    const proc = spawn(this.exe, args, { cwd: this.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    const startedAt = Date.now();

    readline.createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line) as CoreEvent;
        this.onEvent(ev);
      } catch {
        console.warn(`[core] non-JSON stdout: ${line}`);
      }
    });
    readline.createInterface({ input: proc.stderr! }).on("line", (line) => console.log(`[core] ${line}`));
    // A write to a core that just died is EPIPE: without a handler it is an uncaught exception in main.
    proc.stdin!.on("error", (e) => console.warn(`[core] stdin: ${e.message}`));

    let gone = false;
    const down = (message: string) => {
      if (gone) return;
      gone = true;
      if (this.proc === proc) this.proc = null;
      if (this.stopping) return;
      // "ready" comes before the model loads, so only a run that stayed up resets the crash counter.
      if (Date.now() - startedAt > 30_000) this.restarts = 0;
      this.restarts++;
      this.onEvent({ ev: "core_down", message: this.restarts > 5 ? `${message}; gave up` : `${message}; restarting` });
      if (this.restarts <= 5) this.retryTimer = setTimeout(() => this.start(), 500 * this.restarts);
    };
    proc.on("exit", (code) => down(`core exited with code ${code}`));
    // Spawn failures (EACCES, a deleted exe) come as "error" and may never reach "exit".
    proc.on("error", (e) => {
      console.warn(`[core] ${e.message}`);
      if (proc.pid === undefined) down(`core failed to start: ${e.message}`);
    });
  }

  send(cmd: Command): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    else console.warn(`[core] not running, dropped ${cmd.cmd}`);
  }

  /** Stops the running core (if any) and starts it again (with the arguments as they are now).
   * Calls while a restart is under way join it. */
  restart(): void {
    if (this.restartPending) return;
    this.clearRetry();
    const p = this.proc;
    if (!p) {
      this.stopping = false;
      this.restarts = 0;
      this.start();
      return;
    }
    this.restartPending = true;
    this.stopping = true;
    p.once("exit", () => {
      if (!this.restartPending) return; // stop() came meanwhile
      this.restartPending = false;
      this.stopping = false;
      this.restarts = 0;
      this.start();
    });
    this.send({ cmd: "shutdown" });
    setTimeout(() => p.exitCode === null && p.kill(), 4000);
  }

  stop(): void {
    this.stopping = true;
    this.restartPending = false;
    this.clearRetry();
    if (!this.proc) return;
    this.send({ cmd: "shutdown" });
    const p = this.proc;
    setTimeout(() => p.exitCode === null && p.kill(), 1500);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** `stop`, resolved once the process is gone (at most ~1.5 s). */
  stopped(): Promise<void> {
    const p = this.proc;
    this.stop();
    if (!p || p.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => p.once("exit", () => resolve()));
  }
}

/** Dev: ../core/target/release/suflyor-core.exe; packaged: resources/suflyor-core.exe; override: SUFLYOR_CORE_PATH. */
export function resolveCoreExe(appPath: string, isPackaged: boolean): string {
  if (process.env.SUFLYOR_CORE_PATH) return process.env.SUFLYOR_CORE_PATH;
  if (isPackaged) return path.join(process.resourcesPath, "suflyor-core.exe");
  return path.resolve(appPath, "..", "core", "target", "release", "suflyor-core.exe");
}
