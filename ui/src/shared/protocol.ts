// Mirror of core/crates/protocol (NDJSON over the core's stdio).

export type Speaker = "me" | "them";
export type AnswerMode = "confirmed" | "speculative";
/** What an ask is for: answer the question, suggest questions to ask, or ways to continue. */
export type AskKind = "answer" | "questions" | "continue" | "more";

export type Command =
  | { cmd: "ask"; screenshot: boolean; question?: string; kind?: AskKind }
  | { cmd: "set"; auto?: boolean; model?: string; answer_mode?: AnswerMode; translate?: boolean; mute_me?: boolean; mute_them?: boolean }
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
  translate: boolean;
  mute_me: boolean;
  mute_them: boolean;
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
  /** The screen that goes with answer turn `turn`; `thumb` is a small JPEG data URL. */
  | { ev: "screenshot"; turn: number; width: number; height: number; thumb: string }
  /** Translation of the other side's utterances `ts` (their `t`), as one piece. */
  | { ev: "translation"; ts: number[]; text: string }
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

export type NodeKind = "profile" | "folder" | "call";

export interface CallsTree {
  dataDir: string;
  profile: string;
  folders: { dir: string; title: string; calls: { dir: string; title: string; hasSummary: boolean }[] }[];
}

export interface NodeFile {
  name: string;
  size: number;
  /** null: a PDF whose text is not extracted yet. */
  tokens: number | null;
}

export interface TranscriptLine {
  speaker: Speaker;
  t: number;
  text: string;
}

/** One context node as the «Звонки» window edits it. Call-only fields are absent on the others. */
export interface NodeData {
  dir: string;
  kind: NodeKind;
  title: string;
  context: string;
  glossary: string[];
  files: NodeFile[];
  started?: string;
  summary?: string;
  transcript?: TranscriptLine[];
  answers?: number;
}

export interface NodePatch {
  title: string;
  context: string;
  glossary: string[];
}

export interface CallsApi {
  tree(): Promise<CallsTree>;
  node(dir: string): Promise<NodeData>;
  save(dir: string, patch: NodePatch): Promise<void>;
  createFolder(title: string): Promise<string>;
  createCall(folder: string, title: string): Promise<string>;
  /** No paths: a file dialog asks. */
  addFiles(dir: string, paths?: string[]): Promise<void>;
  fileText(dir: string, name: string): Promise<string>;
  removeFile(dir: string, name: string): Promise<void>;
  /** Moves a folder or a call to the recycle bin. */
  remove(dir: string): Promise<void>;
  /** The system prompt the core would build for this call (null: the profile alone). */
  preview(dir: string | null): Promise<string>;
  reveal(dir: string): void;
  /** The last `call` event, so a freshly opened window knows the open call. */
  current(): Promise<CallInfo | null>;
}

export interface ModelInfo {
  id: string;
  label: string;
  sizeMb: number;
  note: string;
  state: "installed" | "partial" | "absent" | "downloading";
  /** Bytes on disk or downloaded so far; `total` is known while downloading. */
  received: number;
  total: number;
  /** stt.model points at it. */
  active: boolean;
  error?: string;
}

/** One line of «Готовность»: something the app needs, whether it is there, and what fixes it. */
export interface ReadyItem {
  id: "core" | "whisper" | "cuda" | "claude" | "audio";
  /** required: nothing works without it; recommended: works, but worse; optional: one feature. */
  level: "required" | "recommended" | "optional";
  ok: boolean;
  title: string;
  why: string;
  problem?: string;
  /** whisper: the catalog id to offer. */
  model?: string;
  /** claude: the backend in config. */
  backend?: "api" | "claude-code";
}

export interface ReadyApi {
  list(): Promise<ReadyItem[]>;
  open(): void;
  /** Saves the key and switches the backend to it (the core restarts). */
  useApiKey(key: string): Promise<SaveResult>;
  /** Switches to Claude Code and checks that `claude --version` answers. */
  useClaudeCode(): Promise<SaveResult>;
  /** Downloads and selects the whisper model. */
  getModel(id: string): void;
  openLogs(): void;
  onChange(cb: (items: ReadyItem[]) => void): void;
}

/** An update from GitHub Releases. "dev": not installed, nothing to update. */
export interface UpdateState {
  state: "dev" | "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  /** The running version. */
  version: string;
  latest?: string;
  percent?: number;
  error?: string;
}

export interface UpdateApi {
  state(): Promise<UpdateState>;
  check(): void;
  download(): void;
  install(): void;
  onChange(cb: (s: UpdateState) => void): void;
}

/** Optional downloads: the translation model and the CUDA backend. Changes arrive through `ModelsApi.onChange`. */
export type PackId = "cuda";
export interface PacksApi {
  status(id: PackId): Promise<ModelInfo>;
  download(id: PackId): Promise<void>;
  cancel(id: PackId): void;
}

export interface ModelsApi {
  list(): Promise<ModelInfo[]>;
  download(id: string): Promise<void>;
  cancel(id: string): void;
  remove(id: string): Promise<void>;
  /** Writes stt.model and restarts the core. */
  use(id: string): Promise<SaveResult>;
  /** Called when a download moves or ends: list() again. */
  onChange(cb: () => void): void;
}

/** Global hotkeys by action; every action also has a button in an overlay (`data-action`). */
export type HotkeyAction =
  | "ask"
  | "screenshotAsk"
  | "toggleWindow"
  | "toggleAuto"
  | "clickThrough"
  | "cameraMode"
  | "prevAnswer"
  | "nextAnswer"
  | "copyAnswer"
  | "zoomIn"
  | "zoomOut"
  | "myQuestions"
  | "continueTalk"
  | "translate"
  | "moreAnswer";
export type Hotkeys = Record<HotkeyAction, string>;

/** Main -> overlay messages that are not core events: window mode and hotkey actions. */
export type UiMessage =
  | { kind: "mode"; mini: boolean; clickThrough: boolean }
  /** Show an older (-1) or newer (1) answer. */
  | { kind: "nav"; dir: -1 | 1 }
  /** Copy the answer on show. */
  | { kind: "copy" }
  /** The screen hotkey was pressed: a capture and an answer are coming. */
  | { kind: "looking" }
  /** Settings: show this section (the guide is "guide"). */
  | { kind: "section"; id: string }
  /** The hotkeys changed: re-read them for the button tooltips. */
  | { kind: "hotkeys" };

export interface PrivacyReport {
  /** PNG data URL of the display with the overlays, as other apps capture it. */
  image: string;
  /** Each window and whether Windows hides it from capture (display affinity 0x11). */
  windows: { name: string; hidden: boolean }[];
  /** Windows 10 2004+ (build 19041): older builds show protected windows as black boxes. */
  osOk: boolean;
}

export interface RendererApi {
  send(cmd: Command): void;
  hide(): void;
  onEvent(cb: (e: CoreEvent) => void): void;
  /** Opens Settings, on `section` if given ("guide": the in-app guide). */
  openSettings(section?: string): void;
  closeWindow(): void;
  loadConfig(): Promise<ConfigSnapshot>;
  /** Dotted keys ("vad.minSilenceMs") to values; written into config.json, then the core restarts. */
  saveConfig(patch: Record<string, unknown>): Promise<SaveResult>;
  listMics(): Promise<string[]>;
  openCalls(): void;
  onUi(cb: (m: UiMessage) => void): void;
  /** Runs what a hotkey runs (the overlay buttons). */
  action(a: HotkeyAction): void;
  /** The hotkeys in effect, for tooltips. */
  hotkeys(): Promise<Hotkeys>;
  copy(text: string): void;
  calls: CallsApi;
  models: ModelsApi;
  packs: PacksApi;
  update: UpdateApi;
  ready: ReadyApi;
  privacyTest(): Promise<PrivacyReport>;
  openLogs(): void;
  /** Disk path of a file dropped on the page. */
  pathForFile(file: File): string;
}
