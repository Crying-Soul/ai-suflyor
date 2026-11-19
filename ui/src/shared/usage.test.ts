import assert from "node:assert/strict";
import test from "node:test";
import { addTurn, emptyUsage, turnCost } from "./usage.ts";

test("cost per model, cache priced apart from input", () => {
  const t = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
  assert.equal(turnCost("claude-sonnet-5-5", t), 2);
  assert.equal(turnCost("claude-sonnet-5", t), 2);
  assert.equal(turnCost("claude-opus-5-5", { ...t, input: 0, output: 1_000_000 }), 20);
  assert.equal(turnCost("claude-sonnet-5-5", { ...t, input: 0, cacheRead: 1_000_000 }), 0.1, "not the Sonnet 5 rate");
  assert.equal(turnCost("claude-haiku-5-5", { ...t, input: 0, cacheWrite: 1_000_000 }), 0.2);
  assert.equal(turnCost("gpt-x", t), null);
});

test("a Claude Code turn adds tokens, not dollars", () => {
  let u = addTurn(emptyUsage(), { model: "claude-sonnet-5-5", api: true, input: 1000, cache_read: 0, cache_write: 0, output: 100 });
  u = addTurn(u, { model: "claude-sonnet-5-5", api: false, input: 1000, cache_read: 0, cache_write: 0, output: 100 });
  assert.equal(u.input, 2000);
  assert.equal(u.output, 200);
  assert.ok(Math.abs(u.usd - 0.003) < 1e-12);
  assert.ok(u.subscription);
});
