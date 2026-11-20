// Hotkeys as Electron accelerators: the defaults, and turning a key press into one.
import type { Hotkeys } from "./protocol";

export const DEFAULT_HOTKEYS: Hotkeys = {
  ask: "CommandOrControl+Shift+Space",
  screenshotAsk: "CommandOrControl+Shift+S",
  toggleWindow: "CommandOrControl+Shift+H",
  toggleAuto: "CommandOrControl+Shift+A",
  // In-call keys live under Ctrl+Alt: Ctrl+Shift combos collide with call apps (Teams answers on Ctrl+Shift+S/A).
  clickThrough: "CommandOrControl+Alt+X",
  cameraMode: "CommandOrControl+Alt+M",
  prevAnswer: "CommandOrControl+Alt+PageUp",
  nextAnswer: "CommandOrControl+Alt+PageDown",
  copyAnswer: "CommandOrControl+Alt+C",
  zoomIn: "CommandOrControl+Alt+=",
  zoomOut: "CommandOrControl+Alt+-",
  myQuestions: "CommandOrControl+Alt+Q",
  continueTalk: "CommandOrControl+Alt+W",
  translate: "CommandOrControl+Alt+T",
  moreAnswer: "CommandOrControl+Alt+E",
  // Not Ctrl+Alt+arrows: some Intel drivers rotate the screen on them.
  rateUp: "CommandOrControl+Alt+1",
  rateDown: "CommandOrControl+Alt+2",
};

const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

/** The key's accelerator name by its physical position (`code`), so a Russian layout gives the same keys. */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

type Press = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The accelerator a key press makes, or null while only modifiers are down or the key cannot be global
 * (a plain letter would fire in every app). */
export function accelerator(e: Press): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && "CommandOrControl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join("+");
}

/** Actions that share one accelerator with another, by action. */
export function duplicates(keys: Partial<Hotkeys>): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const [action, accel] of Object.entries(keys)) {
    if (!accel) continue;
    const norm = accel
      .toLowerCase()
      .split("+")
      .map((k) => (["cmdorctrl", "ctrl", "control", "commandorcontrol"].includes(k) ? "ctrl" : k))
      .join("+");
    by.set(norm, [...(by.get(norm) ?? []), action]);
  }
  const out = new Map<string, string[]>();
  for (const actions of by.values()) if (actions.length > 1) for (const a of actions) out.set(a, actions.filter((b) => b !== a));
  return out;
}
