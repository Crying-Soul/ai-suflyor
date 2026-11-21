import type { ErrorKind, HotkeyAction, Hotkeys, RendererApi, Status, SttState, UiMessage } from "../shared/protocol";
import { DEFAULT_THEME, isTheme } from "../shared/protocol";
import { MARK_SVG } from "../shared/mark";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export const api = window.api;

// Every page imports this module: the theme comes in the page URL (main's `load`), then live by `{kind: "theme"}`.
const theme = new URLSearchParams(location.search).get("theme");
document.documentElement.dataset.theme = isTheme(theme) ? theme : DEFAULT_THEME;
api.onUi((m) => {
  if (m.kind === "theme") document.documentElement.dataset.theme = m.id;
});
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Window headers carry the app's mark: `<span data-mark>` becomes its SVG (a constant, not user text). */
for (const slot of document.querySelectorAll("[data-mark]")) {
  slot.replaceWith(document.importNode(new DOMParser().parseFromString(MARK_SVG, "image/svg+xml").documentElement, true));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** "CommandOrControl+Alt+PageUp" as the user reads it: "Ctrl+Alt+PageUp". */
export function keyLabel(accel: string): string {
  return accel.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");
}

/**
 * Buttons with `data-action` run that hotkey's action in main; the tooltip is `data-label` plus
 * the keys in effect, re-read when the hotkeys change (`{kind: "hotkeys"}` through `overlayUi`).
 * `<span data-key="action">` in the text shows that action's keys.
 */
export function bindActions(): () => void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-action]")];
  for (const b of buttons) b.addEventListener("click", () => api.action(b.dataset.action as HotkeyAction));
  const refresh = () =>
    void api.hotkeys().then((keys: Hotkeys) => {
      for (const b of buttons) {
        const key = keys[b.dataset.action as HotkeyAction];
        const label = b.dataset.label ?? "";
        b.title = key ? `${label} · ${keyLabel(key)}` : label;
        if (!b.textContent?.trim()) b.setAttribute("aria-label", label);
      }
      for (const s of document.querySelectorAll<HTMLElement>("[data-key]")) s.textContent = keyLabel(keys[s.dataset.key as HotkeyAction] ?? "");
    });
  refresh();
  return refresh;
}

/** Russian label of the core's STT state. */
export function sttLabel(stt: SttState): string {
  switch (stt.state) {
    case "off":
      return "распознавание выключено";
    case "loading":
      return "загружаю модель речи…";
    case "ready":
      return stt.gpu ? "готово, GPU" : "готово, CPU";
    // The raw cause goes to the tooltip; «Проверка готовности» names the fix.
    case "error":
      return "распознавание не запущено";
  }
}

/** A Claude failure in words, by its kind (the raw cause goes to a tooltip or a fold, never in front). */
export function humanError(kind: ErrorKind | undefined): string {
  switch (kind) {
    case "timeout":
      return "Claude не ответил вовремя";
    case "auth":
      return "Claude не подключён: проверьте ключ или вход";
    case "rate_limit":
    case "overloaded":
      return "Claude перегружен, повторите через минуту";
    case "network":
      return "Нет связи с Claude";
    case "refused":
      return "Claude отказался отвечать на этот вопрос";
    default:
      return "Claude недоступен";
  }
}

/** core_down in words: restarting by itself, or stopped for good (then the tray restarts it). */
export function coreDownText(raw: string): string {
  return /gave up/.test(raw) ? "Ядро остановилось. Перезапуск: значок в трее → «Перезапустить ядро»" : "Ядро перезапускается…";
}

/**
 * New content rises in only when it arrives live: a replayed call (after `cleared`) or a restarted
 * core fills the windows at once. Call the result on `cleared` and on every replayed event.
 */
export function replayGuard(): () => void {
  let timer = 0;
  return () => {
    document.body.classList.add("replay");
    clearTimeout(timer);
    timer = window.setTimeout(() => document.body.classList.remove("replay"), 300);
  };
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
  /** Our own smooth scroll is under way: its midway positions must not unpin the view. */
  let gliding = false;
  const check = () => {
    pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
    if (pinned) pill.hidden = true;
  };
  box.addEventListener("scroll", () => gliding || check());
  box.addEventListener("scrollend", () => {
    if (!gliding) return check();
    // Text may have grown during the glide: finish at the very bottom, still pinned.
    gliding = false;
    box.scrollTop = box.scrollHeight;
  });
  pill.addEventListener("click", () => {
    box.scrollTop = box.scrollHeight;
    pill.hidden = true;
  });
  return () => {
    if (!pinned) {
      pill.hidden = false;
      return;
    }
    // Small steps glide; a big jump (a replayed call) goes at once.
    const step = box.scrollHeight - box.clientHeight - box.scrollTop;
    if (step <= 0) return;
    gliding = step < box.clientHeight && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: box.scrollHeight, behavior: gliding ? "smooth" : "instant" });
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
 * as body classes. Other messages go to `cb`.
 */
export function overlayUi(cb: (m: Exclude<UiMessage, { kind: "mode" }>) => void = () => {}): void {
  api.onUi((m) => {
    if (m.kind !== "mode") return cb(m);
    document.body.classList.toggle("mini", m.mini);
    document.body.classList.toggle("through", m.clickThrough);
  });
  guardPopups();
}

/**
 * Native popups are separate OS windows, and not all of them inherit the window's capture
 * protection: a `confirm()` box shows up in a screen share, tooltips are not proven safe. So
 * `title` becomes an in-page tooltip, and `askConfirm` replaces confirm/alert.
 */
export function guardPopups(): void {
  const tip = el("div", "tip");
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  const move = (n: Element) => {
    if (!(n instanceof HTMLElement) || !n.title) return;
    n.dataset.tip = n.title;
    if (!n.getAttribute("aria-label") && !n.textContent?.trim()) n.setAttribute("aria-label", n.title);
    n.removeAttribute("title");
  };
  document.querySelectorAll("[title]").forEach(move);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "attributes") move(m.target as Element);
      else
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          move(n);
          n.querySelectorAll("[title]").forEach(move);
        }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  let timer = 0;
  const hide = () => {
    clearTimeout(timer);
    tip.hidden = true;
  };
  const over = (e: Event, delay: number) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-tip]");
    hide();
    if (!t) return;
    timer = window.setTimeout(() => {
      tip.textContent = t.dataset.tip ?? "";
      tip.hidden = false;
      const r = t.getBoundingClientRect();
      const x = Math.min(Math.max(4, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 4);
      const below = r.bottom + 6;
      const y = below + tip.offsetHeight > innerHeight - 4 ? r.top - tip.offsetHeight - 6 : below;
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(4, y)}px`;
    }, delay);
  };
  document.addEventListener("mouseover", (e) => over(e, 500));
  // Keyboard users get the same text (the keys included) when a control takes focus.
  document.addEventListener("focusin", (e) => (e.target as Element).matches?.(":focus-visible") && over(e, 0));
  document.addEventListener("focusout", hide);
  document.addEventListener("mousedown", hide);
  document.addEventListener("mouseleave", hide);
}

/**
 * An in-page confirm: resolves true on «ok». `cancel: null` makes it a notice with one button.
 * `danger`: «ok» loses or deletes something, so Enter lands on the cancel button.
 */
export function askConfirm(text: string, ok = "Да", cancel: string | null = "Отмена", danger = false): Promise<boolean> {
  const d = el("dialog", "confirm");
  const row = el("div", "confirm-actions");
  const yes = el("button", "btn", ok);
  yes.type = "button";
  let no: HTMLButtonElement | null = null;
  if (cancel !== null) {
    no = el("button", "btn-ghost", cancel);
    no.type = "button";
    no.onclick = () => done(false);
    row.append(no);
  }
  row.append(yes);
  d.append(el("p", "", text), row);
  document.body.append(d);
  d.showModal();
  (danger && no ? no : yes).focus();
  let done: (v: boolean) => void = () => {};
  return new Promise((resolve) => {
    done = (v) => {
      resolve(v);
      // Leaves faster than it came (tokens.css): the answer is already in, the dialog only fades.
      d.classList.add("closing");
      setTimeout(() => {
        d.close();
        d.remove();
      }, 120);
    };
    yes.onclick = () => done(true);
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(false);
    });
  });
}
