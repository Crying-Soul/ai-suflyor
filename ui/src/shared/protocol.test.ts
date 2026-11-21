import assert from "node:assert/strict";
import test from "node:test";
import { applyPlan, DEFAULT_THEME, THEMES, toTheme } from "./protocol.ts";

test("stored themes: current ids kept, old ids mapped, junk falls back to the default", () => {
  for (const t of THEMES) assert.equal(toTheme(t), t);
  assert.equal(toTheme("prompter"), "night");
  assert.equal(toTheme("paper"), "day");
  assert.equal(toTheme("panel"), "graphite");
  assert.equal(toTheme("dusk"), "graphite");
  assert.equal(toTheme(undefined), DEFAULT_THEME);
  assert.equal(toTheme("toString"), DEFAULT_THEME);
});

test("saved settings: hotkeys re-register, Claude settings reload live, the rest restart the core", () => {
  assert.equal(applyPlan(["hotkeys.ask"], true), "hotkeys");
  assert.equal(applyPlan(["model", "hotkeys.ask", "llm.backend", "claudeCode.command"], true), "live");
  assert.equal(applyPlan(["model"], false), "restart", "no core running: start one");
  assert.equal(applyPlan(["model", "vad.minSilenceMs"], true), "restart", "one key that needs a restart is enough");
  assert.equal(applyPlan(["stt.model"], true), "restart");
});
