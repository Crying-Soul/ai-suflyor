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

  constructor(
    private exe: string,
    /** Read at every start: on a fresh install config.json appears only after the UI starts. */
    private args: () => string[],
    private cwd: string,
    private onEvent: (e: CoreEvent) => void,
  ) {}

  start(): void {
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

    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.stopping) return;
      // "ready" comes before the model loads, so only a run that stayed up resets the crash counter.
      if (Date.now() - startedAt > 30_000) this.restarts = 0;
      this.restarts++;
      const message = `core exited with code ${code}`;
      this.onEvent({ ev: "core_down", message: this.restarts > 5 ? `${message}; gave up` : `${message}; restarting` });
      if (this.restarts <= 5) setTimeout(() => this.start(), 500 * this.restarts);
    });
  }

  send(cmd: Command): void {
    this.proc?.stdin?.write(JSON.stringify(cmd) + "\n");
  }

  /** Stops the running core (if any) and starts it again (with the arguments as they are now). */
  restart(): void {
    const p = this.proc;
    if (!p) {
      this.stopping = false;
      this.restarts = 0;
      this.start();
      return;
    }
    this.stopping = true;
    p.once("exit", () => {
      this.stopping = false;
      this.restarts = 0;
      this.start();
    });
    this.send({ cmd: "shutdown" });
    setTimeout(() => p.exitCode === null && p.kill(), 4000);
  }

  stop(): void {
    this.stopping = true;
    if (!this.proc) return;
    this.send({ cmd: "shutdown" });
    const p = this.proc;
    setTimeout(() => p.kill(), 1500);
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
