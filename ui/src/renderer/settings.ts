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
    title: "Контекст",
    fields: [
      { key: "userContext", label: "О вас", kind: "textarea", hint: "Роль, стек, вакансия. Claude читает это перед каждым ответом." },
      { key: "language", label: "Язык речи", kind: "select", options: [["auto", "Определять"], ["ru", "Русский"], ["en", "Английский"]] },
      { key: "glossary", label: "Глоссарий", kind: "list", hint: "Один термин на строку. Подсказка Whisper, как писать термины." },
    ],
  },
  {
    id: "answers",
    title: "Ответы",
    note: "Сохранение перезапускает ядро.",
    fields: [
      {
        key: "llm.backend",
        label: "Подключение",
        kind: "select",
        options: [["api", "API-ключ"], ["claude-code", "Вход Claude Code"]],
        hint: "Claude Code использует подписку claude.ai и её лимиты. Один раз выполните claude login.",
      },
      { key: "anthropicApiKey", label: "API-ключ Anthropic", kind: "secret", hint: "Только для подключения по API-ключу." },
      {
        key: "claudeCode.command",
        label: "Команда Claude Code",
        kind: "list",
        hint: "Один аргумент на строку. По умолчанию: claude. Из WSL: wsl.exe, -e, затем путь к claude.",
      },
      { key: "model", label: "Модель", kind: "select", options: MODELS },
      { key: "altModel", label: "Вторая модель", kind: "select", options: MODELS, hint: "Кнопка модели в окне подсказок переключает на неё." },
      { key: "quickModel", label: "Модель быстрой подсказки", kind: "select", options: MODELS },
      { key: "twoTier", label: "Сначала быстрая подсказка", kind: "bool", hint: "Сначала приходит одна строка, затем полный ответ." },
      { key: "effort", label: "Усилие", kind: "select", options: [["low", "Низкое"], ["medium", "Среднее"], ["high", "Высокое"]] },
      { key: "autoDetect", label: "Отвечать автоматически", kind: "bool", hint: "Отвечать, когда собеседник задаёт вопрос." },
      {
        key: "answerMode",
        label: "Когда отвечать",
        kind: "select",
        options: [["confirmed", "Когда вопрос закончен"], ["speculative", "Начинать раньше, отменять, если собеседник продолжит"]],
      },
    ],
  },
  {
    id: "audio",
    title: "Звук",
    fields: [
      { key: "audio.micDevice", label: "Микрофон", kind: "mic" },
      { key: "audio.themSource", label: "Собеседник", kind: "source", hint: "Захват одного приложения требует Windows 10 2004 или новее." },
    ],
  },
  {
    id: "speech",
    title: "Детектор речи",
    fields: [
      { key: "vad.minSilenceMs", label: "Пауза конца фразы, мс", kind: "number", min: 200, max: 2000, step: 50, hint: "Меньше — быстрее, но фразы режутся на запятых." },
      { key: "vad.earlySilenceMs", label: "Раннее распознавание через, мс", kind: "number", min: 0, max: 1000, step: 50, hint: "Начинает распознавание до подтверждения паузы. 0 — выключено." },
      { key: "vad.threshold", label: "Порог речи", kind: "number", min: 0.05, max: 0.95, step: 0.05 },
      { key: "vad.negThreshold", label: "Порог тишины", kind: "number", min: 0.05, max: 0.95, step: 0.05, hint: "Ниже порога речи." },
      { key: "vad.minSpeechMs", label: "Самая короткая фраза, мс", kind: "number", min: 50, max: 2000, step: 50 },
      { key: "vad.preRollMs", label: "Звук до начала речи, мс", kind: "number", min: 0, max: 1000, step: 50 },
      { key: "vad.maxUtteranceMs", label: "Самая длинная фраза, мс", kind: "number", min: 5000, max: 30000, step: 1000 },
    ],
  },
  {
    id: "stt",
    title: "Распознавание",
    fields: [
      { key: "stt.useGpu", label: "Использовать GPU", kind: "bool" },
      { key: "stt.partialMs", label: "Живой текст каждые, мс", kind: "number", min: 0, max: 3000, step: 100, hint: "Показывает текст прямо во время речи. 0 — выключено, GPU свободен для финальных фраз." },
      { key: "stt.flashAttn", label: "Flash attention", kind: "bool" },
      { key: "stt.gpuDevice", label: "Номер GPU", kind: "number", min: 0, max: 7, step: 1 },
      { key: "stt.beamSize", label: "Beam size", kind: "number", min: 1, max: 8, step: 1, hint: "1 — жадный поиск, быстрее всего." },
      { key: "stt.threads", label: "Потоки CPU", kind: "number", min: 1, max: 32, step: 1 },
      { key: "stt.noSpeechThold", label: "Порог «нет речи»", kind: "number", min: 0, max: 1, step: 0.05 },
      { key: "stt.temperatureInc", label: "Шаг температуры при повторе", kind: "number", min: 0, max: 1, step: 0.1, hint: "0 — не перераспознавать при низкой уверенности." },
      { key: "stt.audioCtx", label: "Аудиоконтекст", kind: "number", min: 0, max: 1500, step: 1, hint: "0 — полный контекст и лучшее качество." },
      { key: "stt.model", label: "Файл модели", kind: "text" },
      { key: "stt.dll", label: "whisper.dll", kind: "text" },
    ],
  },
  {
    id: "hotkeys",
    title: "Горячие клавиши",
    fields: [
      { key: "hotkeys.ask", label: "Спросить", kind: "text" },
      { key: "hotkeys.screenshotAsk", label: "Снимок экрана и вопрос", kind: "text" },
      { key: "hotkeys.toggleWindow", label: "Показать или скрыть окна", kind: "text" },
      { key: "hotkeys.toggleAuto", label: "Автоответы вкл./выкл.", kind: "text", hint: "Формат Electron, например CommandOrControl+Shift+Space." },
    ],
  },
  {
    id: "debug",
    title: "Отладка",
    fields: [
      { key: "debug.recordWav", label: "Записывать WAV обеих сторон", kind: "bool" },
      { key: "debug.recordDir", label: "Папка записей", kind: "text" },
      { key: "stt.verbose", label: "Подробный лог whisper", kind: "bool" },
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
      const b = el("button", { type: "button", className: "switch", id, textContent: value ? "Вкл." : "Выкл." });
      b.setAttribute("role", "switch");
      b.setAttribute("aria-checked", String(Boolean(value)));
      b.onclick = () => {
        const on = b.getAttribute("aria-checked") !== "true";
        b.setAttribute("aria-checked", String(on));
        b.textContent = on ? "Вкл." : "Выкл.";
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
      const opts: [string, string][] = f.kind === "mic" ? [["", "Системный по умолчанию"], ...mics.map((m): [string, string] => [m, m])] : f.options!;
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
        el("option", { value: "system", textContent: "Весь звук системы" }),
        el("option", { value: "process", textContent: "Одно приложение" }),
      );
      s.value = isProc ? "process" : "system";
      const exe = el("input", { type: "text", className: "input", name: `${f.key}.exe`, placeholder: "chrome.exe", value: isProc ? v.slice(8) : "" });
      exe.setAttribute("aria-label", "Исполняемый файл приложения");
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
  saveState.textContent = n ? `Несохранённых изменений: ${n}` : "";
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
    saveState.textContent = "Нечего сохранять.";
    return;
  }
  saveBtn.disabled = true;
  saveState.className = "";
  saveState.textContent = "Сохраняю…";
  const res = await api.saveConfig(patch);
  saveBtn.disabled = false;
  if (!res.ok) {
    saveState.className = "error";
    saveState.textContent = `Не сохранено: ${res.error}`;
    return;
  }
  for (const [k, v] of Object.entries(patch)) initial.set(k, JSON.stringify(v));
  pathEl.textContent = res.path ?? "";
  saveState.className = "done";
  saveState.textContent = "Сохранено. Ядро перезапускается.";
});

$("btn-cancel").onclick = () => {
  if (Object.keys(changes()).length && !confirm("Закрыть без сохранения изменений?")) return;
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
