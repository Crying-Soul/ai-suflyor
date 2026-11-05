import type { RendererApi, Status, UiMessage } from "../shared/protocol";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export const api = window.api;
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** Russian label of the core's STT state ("loading", "ready (gpu)", "error: …"). */
export function sttLabel(stt: string): string {
  if (stt === "off") return "распознавание выключено";
  if (stt === "loading") return "загружаю модель речи…";
  if (stt.startsWith("ready")) return stt.includes("gpu") ? "распознавание готово (GPU)" : "распознавание готово (CPU)";
  if (stt.startsWith("error")) return `ошибка распознавания: ${stt.slice(6).trim()}`;
  return stt;
}

export function modelLabel(s: Status): string {
  return s.model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
}

/**
 * Keeps `box` scrolled to the bottom while the user is there. When they scrolled up to read,
 * new content does not yank the view; `pill` appears instead and jumps back down on click.
 * Returns the function to call after content changed.
 */
export function follow(box: HTMLElement, pill: HTMLElement): () => void {
  let pinned = true;
  box.addEventListener("scroll", () => {
    pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
    if (pinned) pill.hidden = true;
  });
  pill.addEventListener("click", () => {
    box.scrollTop = box.scrollHeight;
    pill.hidden = true;
  });
  return () => {
    if (pinned) box.scrollTop = box.scrollHeight;
    else pill.hidden = false;
  };
}

const ICONS = { check: "M4 10.5l3.5 3.5L16 6" } as const;

/** A 14px stroke icon in the current colour, hidden from assistive tech (the word beside it says it). */
export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/**
 * Overlay window modes from main: `mini` (the camera strip) and `through` (clicks pass through)
 * as body classes. The pointer over the window keeps it from dimming. Other messages go to `cb`.
 */
export function overlayUi(cb: (m: Exclude<UiMessage, { kind: "mode" }>) => void = () => {}): void {
  api.onUi((m) => {
    if (m.kind !== "mode") return cb(m);
    document.body.classList.toggle("mini", m.mini);
    document.body.classList.toggle("through", m.clickThrough);
  });
  document.addEventListener("mouseenter", () => api.uiActive());
  document.addEventListener("mousemove", () => api.uiActive(), { passive: true });
}
