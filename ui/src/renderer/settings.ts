import type { ConfigSnapshot, ModelInfo, RendererApi } from "../shared/protocol";
import { askConfirm, guardPopups } from "./common";

declare global {
  interface Window {
    api: RendererApi;
  }
}

const api = window.api;

type Kind = "text" | "secret" | "textarea" | "list" | "number" | "bool" | "select" | "mic" | "source" | "models" | "privacy";

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
      { key: "vad.minSilenceMs", label: "Пауза конца фразы, мс", kind: "number", min: 200, max: 2000, step: 50, hint: "Меньше значит быстрее, но фразы режутся на запятых." },
      { key: "vad.earlySilenceMs", label: "Раннее распознавание через, мс", kind: "number", min: 0, max: 1000, step: 50, hint: "Начинает распознавание до подтверждения паузы. 0 выключает." },
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
    note: "Контекст о вас и глоссарий теперь в окне «Звонки»: кнопка с названием звонка в окне транскрипта.",
    fields: [
      { key: "stt.model", label: "Модель Whisper", kind: "models", hint: "Выбор сразу перезапускает ядро, модель грузится несколько секунд. Загрузку можно прервать и продолжить." },
      { key: "language", label: "Язык речи", kind: "select", options: [["auto", "Определять"], ["ru", "Русский"], ["en", "Английский"]] },
      { key: "stt.useGpu", label: "Использовать GPU", kind: "bool" },
      { key: "stt.partialMs", label: "Живой текст каждые, мс", kind: "number", min: 0, max: 3000, step: 100, hint: "Показывает текст прямо во время речи. 0 выключает и освобождает GPU для финальных фраз." },
      { key: "stt.flashAttn", label: "Flash attention", kind: "bool" },
      { key: "stt.gpuDevice", label: "Номер GPU", kind: "number", min: 0, max: 7, step: 1 },
      { key: "stt.beamSize", label: "Beam size", kind: "number", min: 1, max: 8, step: 1, hint: "1: жадный поиск, быстрее всего." },
      { key: "stt.threads", label: "Потоки CPU", kind: "number", min: 1, max: 32, step: 1 },
      { key: "stt.noSpeechThold", label: "Порог «нет речи»", kind: "number", min: 0, max: 1, step: 0.05 },
      { key: "stt.temperatureInc", label: "Шаг температуры при повторе", kind: "number", min: 0, max: 1, step: 0.1, hint: "0: не перераспознавать при низкой уверенности." },
      { key: "stt.audioCtx", label: "Аудиоконтекст", kind: "number", min: 0, max: 1500, step: 1, hint: "0: полный контекст и лучшее качество." },
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
      { key: "hotkeys.toggleAuto", label: "Автоответы вкл./выкл.", kind: "text" },
      { key: "hotkeys.cameraMode", label: "«У камеры»: полоска подсказок у камеры", kind: "text" },
      { key: "hotkeys.clickThrough", label: "Клики сквозь окна", kind: "text" },
      { key: "hotkeys.opacity", label: "Прозрачность 100, 80, 60 %", kind: "text" },
      { key: "hotkeys.prevAnswer", label: "Предыдущий ответ", kind: "text" },
      { key: "hotkeys.nextAnswer", label: "Следующий ответ", kind: "text" },
      { key: "hotkeys.copyAnswer", label: "Копировать ответ", kind: "text" },
      { key: "hotkeys.zoomIn", label: "Крупнее текст", kind: "text" },
      { key: "hotkeys.zoomOut", label: "Мельче текст", kind: "text", hint: "Формат Electron, например CommandOrControl+Alt+M. Ctrl+Shift+S и Ctrl+Shift+A заняты в Teams: лучше заменить их на Ctrl+Alt." },
    ],
  },
  {
    id: "privacy",
    title: "Приватность",
    note: "Все окна ассистента скрыты от демонстрации экрана, записи и скриншотов (Windows 10 2004 и новее). Не скрывает: камеру телефона, направленную на экран, карты видеозахвата и системное окно выбора файлов.",
    fields: [{ key: "privacy", label: "Проверка", kind: "privacy", hint: "Снимает экран с окнами ассистента так, как его видят Zoom, Teams и OBS. Окон на снимке быть не должно." }],
  },
  {
    id: "data",
    title: "Данные",
    fields: [
      { key: "dataDir", label: "Папка звонков", kind: "text", hint: "Профиль, папки, транскрипты и итоги. Пусто: Документы\\Call Assistant." },
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
    case "privacy": {
      const out = el("div", { className: "privacy-out" });
      const run = el("button", { type: "button", className: "btn-ghost", textContent: "Проверить захват" });
      run.onclick = async () => {
        run.disabled = true;
        out.replaceChildren(el("p", { className: "hint", textContent: "Снимаю экран…" }));
        try {
          const r = await api.privacyTest();
          const list = el("ul", { className: "privacy-list" }, ...r.windows.map((w) => el("li", { className: w.hidden ? "ok" : "bad", textContent: `${w.name}: ${w.hidden ? "скрыто" : "ВИДНО в захвате"}` })));
          if (!r.osOk) list.append(el("li", { className: "bad", textContent: "Windows старше 10 2004: окна видны чёрными прямоугольниками" }));
          const img = el("img", { src: r.image, alt: "Экран так, как его видят другие программы" });
          out.replaceChildren(list, img);
        } catch (e) {
          out.replaceChildren(el("p", { className: "hint error", textContent: `Не удалось: ${e}` }));
        } finally {
          run.disabled = false;
        }
      };
      return [el("div", { className: "privacy" }, run, out), () => undefined];
    }
    case "models": {
      const box = el("ul", { className: "models" });
      renderModels(box).catch(() => box.replaceChildren(el("li", { className: "hint", textContent: "Список моделей недоступен." })));
      api.models.onChange(() => void renderModels(box));
      return [box, () => value];
    }
    default: {
      const i = el("input", { type: f.kind === "secret" ? "password" : "text", className: "input", id, name: f.key, value: String(value ?? "") });
      i.autocomplete = "off";
      i.spellcheck = false;
      return [i, () => i.value];
    }
  }
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024).toLocaleString("ru-RU");

function small(text: string, onclick: () => unknown, cls = "btn-ghost small"): HTMLButtonElement {
  const b = el("button", { type: "button", className: cls, textContent: text });
  b.onclick = () => {
    b.disabled = true;
    Promise.resolve(onclick()).finally(() => (b.disabled = false));
  };
  return b;
}

/** Whisper models: one row each, the action fits its state. Redrawn on every download change. */
async function renderModels(box: HTMLElement): Promise<void> {
  const list = await api.models.list();
  box.replaceChildren(...list.map((m) => modelRow(m, box)));
}

function modelRow(m: ModelInfo, box: HTMLElement): HTMLElement {
  const info = el("div", { className: "model-info" },
    el("span", { className: "model-name", textContent: m.label }),
    el("span", { className: "hint", textContent: `${m.note} ${m.sizeMb.toLocaleString("ru-RU")}\u00a0МБ.` }),
  );
  if (m.error) info.append(el("span", { className: "hint error", textContent: `Не скачалась: ${m.error}` }));
  const act = el("div", { className: "model-act" });
  const refresh = () => renderModels(box);
  const use = async () => {
    const res = await api.models.use(m.id);
    saveState.className = res.ok ? "done" : "error";
    saveState.textContent = res.ok ? `Модель ${m.label}. Ядро перезапускается.` : `Не выбрана: ${res.error}`;
    await refresh();
  };
  const del = async () => {
    if (!(await askConfirm(`Удалить модель ${m.label} с диска?`, "Удалить"))) return;
    await api.models.remove(m.id).catch((e) => askConfirm(String(e), "Понятно", null));
    await refresh();
  };
  if (m.active && m.state === "installed") {
    act.append(el("span", { className: "in-use", textContent: "используется" }));
  } else if (m.state === "installed") {
    act.append(small("Выбрать", use, "btn small"), small("Удалить", del));
  } else if (m.state === "downloading") {
    const pct = m.total ? Math.floor((m.received / m.total) * 100) : 0;
    const bar = el("progress", { max: 100, value: pct });
    bar.setAttribute("aria-label", `Загрузка ${m.label}`);
    act.append(bar, el("span", { className: "num pct", textContent: `${pct}\u00a0%` }), small("Отмена", () => api.models.cancel(m.id)));
  } else if (m.state === "partial") {
    act.append(el("span", { className: "hint num", textContent: `${mb(m.received)}\u00a0МБ` }), small("Продолжить", () => api.models.download(m.id), "btn small"), small("Удалить", del));
  } else {
    act.append(small("Скачать", () => api.models.download(m.id)));
  }
  const li = el("li", { className: m.active ? "model active" : "model" }, info, act);
  return li;
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

$("btn-cancel").onclick = async () => {
  if (Object.keys(changes()).length && !(await askConfirm("Закрыть без сохранения изменений?", "Закрыть"))) return;
  api.closeWindow();
};

guardPopups();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) $("btn-cancel").click();
});

(async () => {
  snapshot = await api.loadConfig();
  pathEl.textContent = snapshot.path;
  const mics = await api.listMics().catch(() => []);
  render(mics);
})();
