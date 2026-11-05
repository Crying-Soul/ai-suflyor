// Mirror of core/crates/protocol (NDJSON over the core's stdio).

export type Speaker = "me" | "them";
export type AnswerMode = "confirmed" | "speculative";

export type Command =
  | { cmd: "ask"; screenshot: boolean; question?: string }
  | { cmd: "set"; auto?: boolean; model?: string; answer_mode?: AnswerMode }
  | { cmd: "clear" }
  | { cmd: "open_call"; dir: string }
  | { cmd: "reload_context" }
  | { cmd: "close_call" }
  | { cmd: "shutdown" };

export interface ContextPart {
  name: string;
  tokens: number;
  truncated: boolean;
}

/** The context in use; `dir` null = no call open, the profile alone. */
export interface CallInfo {
  dir: string | null;
  title: string;
  folder: string;
  tokens: number;
  parts: ContextPart[];
  warnings: string[];
}

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
  // `t` (epoch ms of the utterance start) keys one utterance across vad, partial and final.
  | { ev: "vad"; speaker: Speaker; active: boolean; t: number }
  /** Live hypothesis: `stable` agreed by two decodes in a row, `tail` may still change. */
  | { ev: "partial"; speaker: Speaker; t: number; stable: string; tail: string }
  /** Empty `text`: the utterance was dropped. `question`: "them" text that asks the user something. */
  | { ev: "final"; speaker: Speaker; t: number; text: string; question: boolean }
  /** `turn` is shared by the quick and full answers of one ask; `q_t` is the question's first utterance. */
  | { ev: "answer_start"; id: number; turn: number; trigger: string; question: string; q_t?: number; tier: "quick" | "full" }
  | { ev: "answer_delta"; id: number; text: string }
  | { ev: "answer_end"; id: number; error?: string }
  | { ev: "metrics"; name: string; ms: number }
  | { ev: "error"; message: string }
  | ({ ev: "call" } & CallInfo)
  | { ev: "summary"; dir: string; ok: boolean; error?: string }
  // Emitted by the UI main process itself, not the core:
  | { ev: "core_down"; message: string }
  /** A window sent "clear": every window drops its transcript and answers. */
  | { ev: "cleared" };

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
