import assert from "node:assert/strict";
import test from "node:test";
import { accelerator, duplicates } from "./hotkeys.ts";

const press = (code: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) =>
  ({ code, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta });

test("key presses become accelerators", () => {
  assert.equal(accelerator(press("KeyQ", { ctrl: true, alt: true })), "CommandOrControl+Alt+Q");
  assert.equal(accelerator(press("Space", { ctrl: true, shift: true })), "CommandOrControl+Shift+Space");
  assert.equal(accelerator(press("Equal", { ctrl: true, alt: true })), "CommandOrControl+Alt+=");
  assert.equal(accelerator(press("F9")), "F9", "a function key alone is fine");
  assert.equal(accelerator(press("KeyQ")), null, "a bare letter would fire in every app");
  assert.equal(accelerator(press("ControlLeft", { ctrl: true })), null, "modifiers alone: still waiting");
});

test("two actions on one key are reported both ways", () => {
  const d = duplicates({ ask: "CommandOrControl+Alt+Q", translate: "CmdOrCtrl+alt+q", zoomIn: "CommandOrControl+Alt+=" });
  assert.deepEqual(d.get("ask"), ["translate"]);
  assert.deepEqual(d.get("translate"), ["ask"]);
  assert.ok(!d.has("zoomIn"));
});
