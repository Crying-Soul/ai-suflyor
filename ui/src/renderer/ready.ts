// «Проверка готовности»: one card per thing the app needs, kept in place while the list updates,
// so a download in progress or a key being typed is never redrawn away.
import type { ReadyItem } from "../shared/protocol";
import { $, api, guardPopups } from "./common";
import { el, packOps, renderModels, small, type ModelOps } from "./model-row";

const LEVEL: Record<ReadyItem["level"], string> = { required: "обязательно", recommended: "рекомендуется", optional: "по желанию" };

interface Card {
  li: HTMLLIElement;
  mark: HTMLElement;
  problem: HTMLElement;
  /** The way to get it: shown only while it is missing. */
  act: HTMLElement;
}
const cards = new Map<ReadyItem["id"], Card>();
const list = $("items");

/** Model rows refresh themselves on every download change. */
function models(ops: ModelOps): HTMLElement {
  const box = el("ul", { className: "models" });
  const draw = () => void renderModels(box, ops).catch(() => box.replaceChildren(el("li", { className: "hint", textContent: "Список недоступен." })));
  draw();
  api.models.onChange(draw);
  return box;
}

function result(): [HTMLElement, (ok: boolean, text: string) => void] {
  const p = el("p", { className: "result", role: "status" });
  return [
    p,
    (ok, text) => {
      p.className = ok ? "result" : "result error";
      p.textContent = text;
    },
  ];
}

function command(text: string): HTMLElement {
  return el("div", { className: "cmd" }, el("code", { textContent: text }), small("Копировать", () => api.copy(text)));
}

function claude(item: ReadyItem): HTMLElement {
  const box = el("div", { className: "act" });
  const tabs = el("div", { className: "tabs", role: "tablist" });
  const panes = {
    api: el("div", { className: "pane", role: "tabpanel" }),
    code: el("div", { className: "pane", role: "tabpanel" }),
    other: el("div", { className: "pane", role: "tabpanel" }),
  };
  const select = (k: keyof typeof panes) => {
    for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== k;
    // Roving tabindex: Tab enters the selected tab only, arrows move between tabs.
    tabs.querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.k === k));
      b.tabIndex = b.dataset.k === k ? 0 : -1;
    });
  };
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = [...tabs.querySelectorAll<HTMLButtonElement>("button")];
    const next = all[(all.indexOf(e.target as HTMLButtonElement) + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next.focus();
    next.click();
  });
  for (const [k, label] of [["api", "Ключ Anthropic"], ["code", "Claude Code"], ["other", "Другие модели"]] as const) {
    const b = el("button", { type: "button", role: "tab", textContent: label });
    b.dataset.k = k;
    b.onclick = () => select(k);
    tabs.append(b);
  }
  const key = el("input", { type: "password", className: "input key", placeholder: "sk-ant-…", autocomplete: "off", spellcheck: false });
  key.setAttribute("aria-label", "Ключ API Anthropic");
  const [apiRes, apiSay] = result();
  const connect = small("Подключить", async () => {
    const r = await api.ready.useApiKey(key.value);
    apiSay(r.ok, r.ok ? (r.note ?? "Ключ принят и сохранён.") : (r.error ?? "Не удалось сохранить."));
  }, "btn small");
  key.onkeydown = (e) => e.key === "Enter" && connect.click();
  panes.api.append(
    el("p", { className: "hint", textContent: "Ключ создаётся на console.anthropic.com → API Keys. Оплата по токенам." }),
    el("div", { className: "row" }, key, connect),
    apiRes,
  );
  const [codeRes, codeSay] = result();
  panes.code.append(
    el("p", { className: "hint", textContent: "Использует подписку claude.ai. Установите Claude Code в PowerShell и войдите в аккаунт:" }),
    command("irm https://claude.ai/install.ps1 | iex"),
    command("claude login"),
    el("div", { className: "row" }, small("Проверить и использовать", async () => {
      codeSay(true, "Проверяю…");
      const r = await api.ready.useClaudeCode();
      codeSay(r.ok, r.ok ? "Claude Code найден и подключён." : (r.error ?? "Не найден."));
    }, "btn small")),
    codeRes,
  );
  panes.other.append(
    el("p", { className: "hint", textContent: "GPT, Gemini, DeepSeek, Qwen, Kimi, GLM, GigaChat, YandexGPT, OpenRouter или локальная модель в Ollama и LM Studio. Выберите провайдера, вставьте его ключ и модель." }),
    el("div", { className: "row" }, small("Открыть настройки ответов", () => api.openSettings("answers"), "btn small")),
  );
  select(item.backend === "claude-code" ? "code" : item.backend === "openai" ? "other" : "api");
  box.append(tabs, panes.api, panes.code, panes.other);
  return box;
}

function action(item: ReadyItem): HTMLElement {
  switch (item.id) {
    case "whisper": {
      const ops: ModelOps = {
        list: async () => (await api.models.list()).filter((m) => m.id === item.model),
        download: (id) => api.ready.getModel(id),
        cancel: (id) => api.models.cancel(id),
      };
      return el("div", { className: "act" }, models(ops), el("div", { className: "row" }, small("Другие модели", () => api.openSettings("stt"))));
    }
    case "cuda":
      return el("div", { className: "act" }, models(packOps(item.id)));
    case "claude":
      return claude(item);
    case "audio":
      return el("div", { className: "act" }, el("div", { className: "row" }, small("Настройки звука", () => api.openSettings("audio"), "btn small")));
    case "core":
      return el("div", { className: "act" }, el("div", { className: "row" }, small("Перезапустить ядро", () => api.ready.restartCore(), "btn small"), small("Открыть логи", () => api.ready.openLogs())));
  }
}

function card(item: ReadyItem): Card {
  const mark = el("span", { className: "mark" });
  mark.setAttribute("aria-hidden", "true");
  const problem = el("p", { className: "problem" });
  const act = action(item);
  const li = el(
    "li",
    {},
    mark,
    el("div", { className: "item-head" }, el("span", { className: "item-title", textContent: item.title }), el("span", { className: "level", textContent: LEVEL[item.level] })),
    el("p", { className: "why", textContent: item.why }),
    problem,
    act,
  );
  return { li, mark, problem, act };
}

function render(items: ReadyItem[]): void {
  for (const [id, c] of cards) {
    if (items.some((i) => i.id === id)) continue;
    c.li.remove();
    cards.delete(id);
  }
  for (const item of items) {
    let c = cards.get(item.id);
    if (!c) {
      c = card(item);
      cards.set(item.id, c);
    }
    list.append(c.li); // keeps the order of `items`
    c.li.className = `item ${item.ok ? "ok" : "missing"} ${item.level}`;
    c.mark.textContent = item.ok ? "✓" : item.level === "required" ? "!" : "○";
    c.problem.textContent = item.ok ? "" : (item.problem ?? "");
    c.problem.hidden = item.ok || !item.problem;
    c.act.hidden = item.ok;
  }
  const ok = items.filter((i) => i.ok).length;
  const missing = items.filter((i) => i.level === "required" && !i.ok);
  $("summary").textContent = missing.length
    ? `Готово ${ok} из ${items.length}. Без отмеченных «обязательно» Суфлёр не сможет помогать в звонке.`
    : `Готово ${ok} из ${items.length}. Дальше: в «Звонках» заполните «Обо мне» и создайте звонок, иначе транскрипт и ответы не сохранятся.`;
  ready = !missing.length;
  const done = $<HTMLButtonElement>("btn-done");
  done.textContent = ready ? "Открыть «Звонки»" : "Пропустить пока";
  done.className = ready ? "btn" : "btn-ghost";
}

/** Everything required is in place: «Готово» leads on to «Звонки». */
let ready = false;

guardPopups();
$("btn-done").onclick = () => {
  if (ready) api.openCalls();
  api.closeWindow();
};
$("btn-settings").onclick = () => api.openSettings();
document.addEventListener("keydown", (e) => e.key === "Escape" && !document.querySelector("dialog[open]") && api.closeWindow());
api.ready.onChange(render);
void api.ready.list().then(render);
