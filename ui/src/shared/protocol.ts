// Mirror of core/crates/protocol (NDJSON over the core's stdio).

export type Speaker = "me" | "them";
export type AnswerMode = "confirmed" | "speculative";

export type Command =
  | { cmd: "ask"; screenshot: boolean }
  | { cmd: "set"; auto?: boolean; model?: string; answer_mode?: AnswerMode }
  | { cmd: "clear" }
  | { cmd: "shutdown" };

export interface CaptureStatus {
  state: "starting" | "running" | "error";
  source: string;
  error?: string;
}

export interface Status {
  me: CaptureStatus;
  them: CaptureStatus;
  stt: string;
  auto: boolean;
  model: string;
  answer_mode: AnswerMode;
  busy: boolean;
  recording_dir?: string;
}

export type CoreEvent =
  | { ev: "ready"; version: string }
  | ({ ev: "status" } & Status)
  | { ev: "level"; speaker: Speaker; rms: number; peak: number }
  | { ev: "vad"; speaker: Speaker; active: boolean }
  | { ev: "partial"; speaker: Speaker; seg: number; text: string }
  | { ev: "final"; speaker: Speaker; seg: number; t: number; text: string }
  | { ev: "answer_start"; id: number; trigger: string; question: string; tier: "quick" | "full" }
  | { ev: "answer_delta"; id: number; text: string }
  | { ev: "answer_end"; id: number; error?: string }
  | { ev: "metrics"; name: string; ms: number }
  | { ev: "error"; message: string }
  /** Emitted by the UI main process itself, not the core. */
  | { ev: "core_down"; message: string };

/** config.json as stored (`raw`) and with the core's defaults filled in (`effective`). */
export interface ConfigSnapshot {
  path: string;
  raw: Record<string, unknown>;
  effective: Record<string, unknown>;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface RendererApi {
  send(cmd: Command): void;
  hide(): void;
  onEvent(cb: (e: CoreEvent) => void): void;
  openSettings(): void;
  closeWindow(): void;
  loadConfig(): Promise<ConfigSnapshot>;
  /** Dotted keys ("vad.minSilenceMs") to values; written into config.json, then the core restarts. */
  saveConfig(patch: Record<string, unknown>): Promise<SaveResult>;
  listMics(): Promise<string[]>;
}
