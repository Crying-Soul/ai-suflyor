// Rows of downloadable models (whisper models, the translation model, CUDA): shared by Settings and «Готовность».
import type { ModelInfo, PackId, RendererApi, SaveResult } from "../shared/protocol";
import { askConfirm } from "./common";

const api = (window as unknown as { api: RendererApi }).api;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export const mb = (bytes: number) => Math.round(bytes / 1024 / 1024).toLocaleString("ru-RU");

export function small(text: string, onclick: () => unknown, cls = "btn-ghost small"): HTMLButtonElement {
  const b = el("button", { type: "button", className: cls, textContent: text });
  b.onclick = () => {
    b.disabled = true;
    Promise.resolve(onclick()).finally(() => (b.disabled = false));
  };
  return b;
}

/** What a model list can do. The translation model has no choice and no removal: one model, used when present. */
export interface ModelOps {
  list(): Promise<ModelInfo[]>;
  download(id: string): unknown;
  cancel(id: string): unknown;
  use?(id: string): Promise<SaveResult>;
  remove?(id: string): Promise<void>;
  /** After «Выбрать»: where the window reports the result. */
  onUse?(res: SaveResult, m: ModelInfo): void;
}

export const WHISPER: ModelOps = {
  list: () => api.models.list(),
  download: (id) => api.models.download(id),
  cancel: (id) => api.models.cancel(id),
  use: (id) => api.models.use(id),
  remove: (id) => api.models.remove(id),
};

export const packOps = (id: PackId): ModelOps => ({
  list: async () => [await api.packs.status(id)],
  download: () => api.packs.download(id),
  cancel: () => api.packs.cancel(id),
});

/** Models: one row each, the action fits its state. Redrawn on every download change. */
export async function renderModels(box: HTMLElement, ops: ModelOps): Promise<void> {
  const list = await ops.list();
  box.replaceChildren(...list.map((m) => modelRow(m, box, ops)));
}

export function modelRow(m: ModelInfo, box: HTMLElement, ops: ModelOps): HTMLElement {
  const info = el("div", { className: "model-info" },
    el("span", { className: "model-name", textContent: m.label }),
    el("span", { className: "hint", textContent: `${m.note} ${m.sizeMb.toLocaleString("ru-RU")}\u00a0МБ.` }),
  );
  if (m.error) info.append(el("span", { className: "hint error", textContent: `Не скачалась: ${m.error}` }));
  const act = el("div", { className: "model-act" });
  const refresh = () => renderModels(box, ops);
  const use = async () => {
    const res = await ops.use!(m.id);
    ops.onUse?.(res, m);
    await refresh();
  };
  const del = async () => {
    if (!(await askConfirm(`Удалить модель ${m.label} с диска?`, "Удалить"))) return;
    await ops.remove!(m.id).catch((e) => askConfirm(String(e), "Понятно", null));
    await refresh();
  };
  const delBtn = () => (ops.remove ? [small("Удалить", del)] : []);
  if (m.active && m.state === "installed") {
    act.append(el("span", { className: "in-use", textContent: ops.use ? "используется" : "установлена" }));
  } else if (m.state === "installed") {
    act.append(small("Выбрать", use, "btn small"), ...delBtn());
  } else if (m.state === "downloading") {
    const pct = m.total ? Math.floor((m.received / m.total) * 100) : 0;
    const bar = el("progress", { max: 100, value: pct });
    bar.setAttribute("aria-label", `Загрузка ${m.label}`);
    act.append(bar, el("span", { className: "num pct", textContent: `${pct}\u00a0%` }), small("Отмена", () => ops.cancel(m.id)));
  } else if (m.state === "partial") {
    act.append(el("span", { className: "hint num", textContent: `${mb(m.received)}\u00a0МБ` }), small("Продолжить", () => ops.download(m.id), "btn small"), ...delBtn());
  } else {
    act.append(small("Скачать", () => ops.download(m.id)));
  }
  const li = el("li", { className: m.active ? "model active" : "model" }, info, act);
  return li;
}
