// The core's protocol (NDJSON over its stdio) is generated from core/crates/protocol by ts-rs
// (`cargo test` rewrites generated/protocol.ts); this file adds the UI's own types.
import type { Event } from "./generated/protocol";

export type * from "./generated/protocol";
import type { Command, Speaker } from "./generated/protocol";

/** The context in use; `dir` null = no call open, the profile alone. */
export type CallInfo = Omit<Extract<Event, { ev: "call" }>, "ev">;

export type CoreEvent =
  | Event
  // Emitted by the UI main process itself, not the core:
  | { ev: "core_down"; message: string }
  /** A window sent "clear": every window drops its transcript and answers. */
  | { ev: "cleared" };

/** Config keys the core applies without a restart (`reload_llm`): the LLM side only. Others
 * (audio, speech recognition, paths) restart the core. */
const LIVE_KEYS = ["anthropicApiKey", "model", "altModel", "quickModel", "effort", "twoTier", "answerMode", "autoDetect", "translate", "userLanguage"];
export const appliesLive = (key: string): boolean => LIVE_KEYS.includes(key) || key.startsWith("llm.") || key.startsWith("claudeCode.");

/** How saved keys take effect: hotkeys alone only re-register (an answer in progress goes on), Claude
 * settings reload in a running core (`reload_llm`), anything else restarts it. */
export function applyPlan(keys: string[], coreRunning: boolean): "hotkeys" | "live" | "restart" {
  const hotkey = (k: string) => k.startsWith("hotkeys.");
  if (keys.every(hotkey)) return "hotkeys";
  return coreRunning && keys.every((k) => hotkey(k) || appliesLive(k)) ? "live" : "restart";
}

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
  /** Saved, with something the user should know. */
  note?: string;
  /** Applied without restarting the core (Claude settings only). */
  live?: boolean;
}

export type NodeKind = "profile" | "folder" | "call";

export interface CallsTree {
  dataDir: string;
  profile: string;
  folders: { dir: string; title: string; calls: { dir: string; title: string; hasSummary: boolean; started?: string }[] }[];
}

/** A call or folder whose text matches a search, with the matching line. */
export interface SearchHit {
  dir: string;
  title: string;
  /** The folder's title for a call; absent for a folder. */
  folder?: string;
  /** Where the words are: название, заметки, итог, транскрипт. */
  where: string;
  snippet: string;
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
  /** Interview stage of a call (meta.json `stage`): "", hr, tech, system_design, final. */
  stage?: string;
  /** The call's brief.md without its header (likely questions, vacancy gaps), if built. */
  brief?: string;
  /** Lines of the summary's «Добавить в профиль» section not yet added. */
  suggestions?: string[];
}

export interface NodePatch {
  title: string;
  context: string;
  glossary: string[];
  /** Calls only. */
  stage?: string;
}

interface CallsApi {
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
  /** Calls and folders whose title, notes, summary or transcript contain `query`. */
  search(query: string): Promise<SearchHit[]>;
  /** Asks where to save the call as Markdown; resolves to the saved path, or null if cancelled. */
  exportMd(dir: string): Promise<string | null>;
  /** Moves a call to another folder; resolves to its new directory. */
  move(dir: string, folder: string): Promise<string>;
  /** «Подготовить»: builds the call's brief now (a model call, up to minutes); resolves to it. */
  prepare(dir: string): Promise<string>;
  /** Adds a fact from the call's summary to the profile notes and drops it from the summary. */
  addToProfile(dir: string, fact: string): Promise<void>;
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
  backend?: "api" | "claude-code" | "openai";
}

interface ReadyApi {
  list(): Promise<ReadyItem[]>;
  open(): void;
  /** Saves the key and switches the backend to it. */
  useApiKey(key: string): Promise<SaveResult>;
  /** Switches to Claude Code and checks that `claude --version` answers. */
  useClaudeCode(): Promise<SaveResult>;
  /** Switches to the local Ollama server with a model it already has. */
  useOllama(): Promise<SaveResult>;
  /** Downloads and selects the whisper model. */
  getModel(id: string): void;
  openLogs(): void;
  /** Starts the core again, also after it gave up restarting by itself. */
  restartCore(): void;
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

interface UpdateApi {
  state(): Promise<UpdateState>;
  check(): void;
  download(): void;
  install(): void;
  onChange(cb: (s: UpdateState) => void): void;
}

/** Optional downloads: the translation model and the CUDA backend. Changes arrive through `ModelsApi.onChange`. */
export type PackId = "cuda";
interface PacksApi {
  status(id: PackId): Promise<ModelInfo>;
  download(id: PackId): Promise<void>;
  cancel(id: PackId): void;
}

interface ModelsApi {
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
  | "moreAnswer"
  | "rateUp"
  | "rateDown";
export type Hotkeys = Record<HotkeyAction, string>;

/** UI themes: `data-theme` on <html> (static/themes.css). Stored by main in windows.json. */
export const THEMES = ["graphite", "night", "day", "contrast"] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = "graphite";
export const isTheme = (v: unknown): v is ThemeId => THEMES.includes(v as ThemeId);
/** Themes of earlier versions, kept in windows.json, and what they became. */
const RENAMED: Record<string, ThemeId> = { prompter: "night", paper: "day", panel: "graphite", dusk: "graphite" };
/** A stored theme id, old ones mapped to their successor; anything else falls back to the default. */
export const toTheme = (v: unknown): ThemeId => (isTheme(v) ? v : Object.hasOwn(RENAMED, String(v)) ? RENAMED[String(v)] : DEFAULT_THEME);

/** Main -> overlay messages that are not core events: window mode and hotkey actions. */
export type UiMessage =
  | { kind: "mode"; mini: boolean; clickThrough: boolean }
  /** Show an older (-1) or newer (1) answer. */
  | { kind: "nav"; dir: -1 | 1 }
  /** Copy the answer on show. */
  | { kind: "copy" }
  /** Rate the answer on show: 1 useful, -1 not (again the same: cleared). */
  | { kind: "rate"; value: 1 | -1 }
  /** The screen hotkey was pressed: a capture and an answer are coming. */
  | { kind: "looking" }
  /** Ask, «Что сказать», «Вопросы» or «Продолжить ответ» was pressed: an answer is coming. */
  | { kind: "asking" }
  /** Settings: show this section (the guide is "guide"). */
  | { kind: "section"; id: string }
  /** The hotkeys changed: re-read them for the button tooltips. */
  | { kind: "hotkeys" }
  /** The theme changed (every window). */
  | { kind: "theme"; id: ThemeId };

export interface PrivacyReport {
  /** Image data URL of the display with the overlays, as other apps capture it. */
  image: string;
  /** Each window and whether Windows hides it from capture (display affinity 0x11). */
  windows: { name: string; hidden: boolean }[];
  /** Windows 10 2004+ (build 19041): older builds show protected windows as black boxes. */
  osOk: boolean;
}

/** Settings → Кастомизация: the name and icon in Task Manager. */
export interface BrandInfo {
  /** The custom name; null: the original. */
  name: string | null;
  /** The original name ("Suflyor"). */
  original: string;
  /** Image data URL of the icon in use. */
  icon: string;
  originalIcon: string;
  customIcon: boolean;
  /** Why the last change failed (it was rolled back), or null. */
  error: string | null;
  /** Ready names with icons of standard Windows programs. */
  presets: { id: string; name: string; icon: string }[];
}

interface BrandApi {
  info(): Promise<BrandInfo>;
  /** Checks a picked .ico or .png; a preview, or what is wrong with it. */
  checkIcon(path: string): Promise<{ url: string } | { error: string }>;
  /** Builds the renamed program and restarts into it. `icon`: a file, null for the original icon,
   * undefined to keep the current one. Resolves only on failure (nothing changed). */
  apply(name: string, icon: string | null | undefined): Promise<{ error: string } | undefined>;
  /** Back to the original name and icon; restarts. */
  reset(): Promise<void>;
}

export interface RendererApi {
  send(cmd: Command): void;
  onEvent(cb: (e: CoreEvent) => void): void;
  /** Opens Settings, on `section` if given ("guide": the in-app guide). */
  openSettings(section?: string): void;
  closeWindow(): void;
  loadConfig(): Promise<ConfigSnapshot>;
  /** Dotted keys ("vad.minSilenceMs") to values; written into config.json, then the core applies them
   * (`appliesLive` keys) or restarts. */
  saveConfig(patch: Record<string, unknown>): Promise<SaveResult>;
  listMics(): Promise<string[]>;
  openCalls(): void;
  onUi(cb: (m: UiMessage) => void): void;
  /** Runs what a hotkey runs (the overlay buttons). */
  action(a: HotkeyAction): void;
  /** The hotkeys in effect, for tooltips. */
  hotkeys(): Promise<Hotkeys>;
  /** Actions whose keys failed to register: taken by another app, or not a valid accelerator. */
  hotkeyFailures(): Promise<HotkeyAction[]>;
  /** Programs playing sound now (exe names), for capturing one app. */
  listAudioApps(): Promise<string[]>;
  /** Switches every window to this theme at once and remembers it. */
  setTheme(id: ThemeId): void;
  copy(text: string): void;
  calls: CallsApi;
  models: ModelsApi;
  packs: PacksApi;
  update: UpdateApi;
  ready: ReadyApi;
  privacyTest(): Promise<PrivacyReport>;
  brand: BrandApi;
  openLogs(): void;
  /** Disk path of a file dropped on the page. */
  pathForFile(file: File): string;
}
