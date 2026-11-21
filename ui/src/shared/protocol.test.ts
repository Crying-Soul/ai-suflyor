import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME, THEMES, toTheme } from "./protocol.ts";

test("stored themes: current ids kept, old ids mapped, junk falls back to the default", () => {
  for (const t of THEMES) assert.equal(toTheme(t), t);
  assert.equal(toTheme("prompter"), "night");
  assert.equal(toTheme("paper"), "day");
  assert.equal(toTheme("panel"), "graphite");
  assert.equal(toTheme("dusk"), "graphite");
  assert.equal(toTheme(undefined), DEFAULT_THEME);
  assert.equal(toTheme("toString"), DEFAULT_THEME);
});
