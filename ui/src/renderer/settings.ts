import type { ConfigSnapshot, RendererApi } from "../shared/protocol";

declare global {
  interface Window {
    api: RendererApi;
  }
}

const api = window.api;

type Kind = "text" | "secret" | "textarea" | "list" | "number" | "bool" | "select" | "mic" | "source";

interface Field {
  /** Dotted config.json key. */
  key: string;
  label: string;
  kind: Kind;
  hint?: string;
  options?: [value: string, label: string][];
  min?: number;
  max?: number;
  step?: number;
}

interface Section {
  id: string;
  title: string;
  /** Shown above the fields, e.g. when the core does not read them yet. */
  note?: string;
  fields: Field[];
}

const MODELS: [string, string][] = [
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

// Adding a setting is one line here; main.ts writes any dotted key into config.json.
const SECTIONS: Section[] = [
  {
    id: "context",
    title: "Context",
    fields: [
      { key: "userContext", label: "About you", kind: "textarea", hint: "Role, stack, the position. Claude reads it before every answer." },
      { key: "language", label: "Speech language", kind: "select", options: [["auto", "Detect"], ["ru", "Russian"], ["en", "English"]] },
      { key: "glossary", label: "Glossary", kind: "list", hint: "One term per line. Whisper uses it as a spelling hint." },
    ],
  },
  {
    id: "answers",
    title: "Answers",
    note: "Saving restarts the core. Answers come on the ask hotkey; automatic answers arrive in phase 5.",
    fields: [
      {
        key: "llm.backend",
        label: "Connect through",
        kind: "select",
        options: [["api", "API key"], ["claude-code", "Claude Code login"]],
        hint: "Claude Code uses your claude.ai subscription and its limits. Run claude login once.",
      },
      { key: "anthropicApiKey", label: "Anthropic API key", kind: "secret", hint: "Only for the API key connection." },
      {
        key: "claudeCode.command",
        label: "Claude Code command",
        kind: "list",
        hint: "One argument per line. Default: claude. From WSL: wsl.exe, -e, then the path to claude.",
      },
      { key: "model", label: "Model", kind: "select", options: MODELS },
      { key: "altModel", label: "Second model", kind: "select", options: MODELS, hint: "The model button in the overlay switches to it." },
      { key: "quickModel", label: "Quick hint model", kind: "select", options: MODELS },
      { key: "twoTier", label: "Quick hint first", kind: "bool", hint: "A one-line hint arrives first, the full answer follows." },
      { key: "effort", label: "Effort", kind: "select", options: [["low", "Low"], ["medium", "Medium"], ["high", "High"]] },
      { key: "autoDetect", label: "Answer automatically", kind: "bool", hint: "Answer when the other side asks a question." },
      {
        key: "answerMode",
        label: "When to answer",
        kind: "select",
        options: [["confirmed", "After the question ends"], ["speculative", "Start early, cancel if they keep talking"]],
      },
    ],
  },
  {
    id: "audio",
    title: "Audio",
    fields: [
      { key: "audio.micDevice", label: "Microphone", kind: "mic" },
      { key: "audio.themSource", label: "Other side", kind: "source", hint: "One app only needs Windows 10 2004 or later." },
    ],
  },
  {
    id: "speech",
    title: "Speech detection",
    fields: [
      { key: "vad.minSilenceMs", label: "Pause that ends a phrase, ms", kind: "number", min: 200, max: 2000, step: 50, hint: "Lower is faster, but phrases get cut at commas." },
      { key: "vad.earlySilenceMs", label: "Early decode after, ms", kind: "number", min: 0, max: 1000, step: 50, hint: "Starts recognition before the pause is confirmed. 0 turns it off." },
      { key: "vad.threshold", label: "Speech threshold", kind: "number", min: 0.05, max: 0.95, step: 0.05 },
      { key: "vad.negThreshold", label: "Silence threshold", kind: "number", min: 0.05, max: 0.95, step: 0.05, hint: "Below the speech threshold." },
      { key: "vad.minSpeechMs", label: "Shortest phrase, ms", kind: "number", min: 50, max: 2000, step: 50 },
      { key: "vad.preRollMs", label: "Audio kept before speech, ms", kind: "number", min: 0, max: 1000, step: 50 },
      { key: "vad.maxUtteranceMs", label: "Longest phrase, ms", kind: "number", min: 5000, max: 30000, step: 1000 },
    ],
  },
  {
    id: "stt",
    title: "Recognition",
    fields: [
      { key: "stt.useGpu", label: "Use the GPU", kind: "bool" },
      { key: "stt.partialMs", label: "Live text every, ms", kind: "number", min: 0, max: 3000, step: 100, hint: "Shows text while someone speaks. 0 turns it off and frees the GPU for finals." },
      { key: "stt.flashAttn", label: "Flash attention", kind: "bool" },
      { key: "stt.gpuDevice", label: "GPU index", kind: "number", min: 0, max: 7, step: 1 },
      { key: "stt.beamSize", label: "Beam size", kind: "number", min: 1, max: 8, step: 1, hint: "1 is greedy and fastest." },
      { key: "stt.threads", label: "CPU threads", kind: "number", min: 1, max: 32, step: 1 },
      { key: "stt.noSpeechThold", label: "No-speech threshold", kind: "number", min: 0, max: 1, step: 0.05 },
      { key: "stt.temperatureInc", label: "Temperature fallback step", kind: "number", min: 0, max: 1, step: 0.1, hint: "0 turns re-decoding on low confidence off." },
      { key: "stt.audioCtx", label: "Audio context", kind: "number", min: 0, max: 1500, step: 1, hint: "0 is the full context and the best quality." },
      { key: "stt.model", label: "Model file", kind: "text" },
      { key: "stt.dll", label: "whisper.dll", kind: "text" },
    ],
  },
  {
    id: "hotkeys",
    title: "Hotkeys",
    fields: [
      { key: "hotkeys.ask", label: "Ask", kind: "text" },
      { key: "hotkeys.screenshotAsk", label: "Screenshot and ask", kind: "text" },
      { key: "hotkeys.toggleWindow", label: "Show or hide the overlay", kind: "text" },
      { key: "hotkeys.toggleAuto", label: "Automatic answers on or off", kind: "text", hint: "Electron accelerators, e.g. CommandOrControl+Shift+Space." },
    ],
  },
  {
    id: "debug",
    title: "Debug",
    fields: [
      { key: "debug.recordWav", label: "Record WAV of both sides", kind: "bool" },
      { key: "debug.recordDir", label: "Recording folder", kind: "text" },
      { key: "stt.verbose", label: "Verbose whisper log", kind: "bool" },
    ],
  },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nav = $("sections");
const form = $<HTMLFormElement>("form");
const saveState = $("save-state");
const saveBtn = $<HTMLButtonElement>("btn-save");
const pathEl = $("cfg-path");

let snapshot: ConfigSnapshot;
/** Value of each field as loaded, to send only what changed. */
const initial = new Map<string, unknown>();
const readers = new Map<string, () => unknown>();

function get(obj: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function control(f: Field, value: unknown, id: string, mics: string[]): [HTMLElement, () => unknown] {
  switch (f.kind) {
    case "bool": {
      const b = el("button", { type: "button", className: "switch", id, textContent: value ? "On" : "Off" });
      b.setAttribute("role", "switch");
      b.setAttribute("aria-checked", String(Boolean(value)));
      b.onclick = () => {
        const on = b.getAttribute("aria-checked") !== "true";
        b.setAttribute("aria-checked", String(on));
        b.textContent = on ? "On" : "Off";
        markDirty();
      };
      return [b, () => b.getAttribute("aria-checked") === "true"];
    }
    case "number": {
      const i = el("input", { type: "number", className: "input num", id, name: f.key, value: String(value ?? "") });
      if (f.min !== undefined) i.min = String(f.min);
      if (f.max !== undefined) i.max = String(f.max);
      if (f.step !== undefined) i.step = String(f.step);
      i.required = true;
      return [i, () => i.valueAsNumber];
    }
    case "textarea":
    case "list": {
      const text = f.kind === "list" ? ((value as string[] | undefined) ?? []).join("\n") : String(value ?? "");
      const t = el("textarea", { className: "textarea", id, name: f.key, value: text, rows: f.kind === "list" ? 6 : 4 });
      return [t, () => (f.kind === "list" ? t.value.split("\n").map((s) => s.trim()).filter(Boolean) : t.value)];
    }
    case "select":
    case "mic": {
      const opts: [string, string][] = f.kind === "mic" ? [["", "System default"], ...mics.map((m): [string, string] => [m, m])] : f.options!;
      const v = String(value ?? "");
      // A stored value the list does not have (a renamed mic, a newer model) stays selectable.
      if (!opts.some(([o]) => o === v)) opts.push([v, v]);
      const s = el("select", { className: "select", id, name: f.key }, ...opts.map(([o, l]) => el("option", { value: o, textContent: l })));
      s.value = v;
      return [s, () => s.value];
    }
    case "source": {
      const v = String(value ?? "system");
      const isProc = v.startsWith("process:");
      const s = el("select", { className: "select", id, name: f.key },
        el("option", { value: "system", textContent: "All system audio" }),
        el("option", { value: "process", textContent: "One app" }),
      );
      s.value = isProc ? "process" : "system";
      const exe = el("input", { type: "text", className: "input", name: `${f.key}.exe`, placeholder: "chrome.exe", value: isProc ? v.slice(8) : "" });
      exe.setAttribute("aria-label", "App executable");
      exe.pattern = ".*\\.exe";
      const sync = () => {
        exe.hidden = s.value !== "process";
        exe.required = s.value === "process";
      };
      s.addEventListener("change", sync);
      sync();
      return [el("div", { className: "pair" }, s, exe), () => (s.value === "process" ? `process:${exe.value.trim()}` : "system")];
    }
    default: {
      const i = el("input", { type: f.kind === "secret" ? "password" : "text", className: "input", id, name: f.key, value: String(value ?? "") });
      i.autocomplete = "off";
      i.spellcheck = false;
      return [i, () => i.value];
    }
  }
}

function showSection(id: string): void {
  for (const b of nav.querySelectorAll<HTMLButtonElement>("button")) {
    if (b.dataset.section === id) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  for (const fs of form.querySelectorAll<HTMLElement>("fieldset")) fs.hidden = fs.dataset.section !== id;
}

function render(mics: string[]): void {
  nav.replaceChildren();
  form.replaceChildren();
  for (const sec of SECTIONS) {
    const b = el("button", { type: "button", textContent: sec.title });
    b.dataset.section = sec.id;
    b.onclick = () => showSection(sec.id);
    nav.append(el("li", {}, b));

    const fs = el("fieldset", {}, el("legend", {}, el("h2", { textContent: sec.title })));
    fs.dataset.section = sec.id;
    if (sec.note) fs.append(el("p", { className: "note", textContent: sec.note }));
    for (const f of sec.fields) {
      const id = `f-${f.key.replace(/\./g, "-")}`;
      const value = get(snapshot.effective, f.key) ?? get(snapshot.raw, f.key);
      const [ctl, read] = control(f, value, id, mics);
      readers.set(f.key, read);
      initial.set(f.key, JSON.stringify(read()));
      const label = el("label", { htmlFor: id, textContent: f.label });
      const body = el("div", { className: "control" }, ctl);
      if (f.hint) body.append(el("p", { className: "hint", textContent: f.hint }));
      fs.append(el("div", { className: "field" }, label, body));
    }
    form.append(fs);
  }
  showSection(SECTIONS[0].id);
}

function changes(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, read] of readers) {
    const v = read();
    if (JSON.stringify(v) !== initial.get(key)) out[key] = v;
  }
  return out;
}

function markDirty(): void {
  const n = Object.keys(changes()).length;
  saveState.className = n ? "pending" : "";
  saveState.textContent = n ? `${n} unsaved ${n === 1 ? "change" : "changes"}` : "";
}

form.addEventListener("input", markDirty);
form.addEventListener("change", markDirty);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const bad = form.querySelector<HTMLInputElement>(":invalid");
  if (bad) {
    showSection(bad.closest("fieldset")!.dataset.section!);
    bad.reportValidity();
    bad.focus();
    return;
  }
  const patch = changes();
  if (!Object.keys(patch).length) {
    saveState.className = "";
    saveState.textContent = "Nothing to save.";
    return;
  }
  saveBtn.disabled = true;
  saveState.className = "";
  saveState.textContent = "Saving…";
  const res = await api.saveConfig(patch);
  saveBtn.disabled = false;
  if (!res.ok) {
    saveState.className = "error";
    saveState.textContent = `Not saved: ${res.error}`;
    return;
  }
  for (const [k, v] of Object.entries(patch)) initial.set(k, JSON.stringify(v));
  pathEl.textContent = res.path ?? "";
  saveState.className = "done";
  saveState.textContent = "Saved. The core is restarting.";
});

$("btn-cancel").onclick = () => {
  if (Object.keys(changes()).length && !confirm("Close without saving your changes?")) return;
  api.closeWindow();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("btn-cancel").click();
});

(async () => {
  snapshot = await api.loadConfig();
  pathEl.textContent = snapshot.path;
  const mics = await api.listMics().catch(() => []);
  render(mics);
})();
