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

test("the provider's own price wins; an unknown model is flagged, not counted as free", () => {
  const turn = { api: true, input: 1000, cache_read: 0, cache_write: 0, output: 100 };
  let u = addTurn(emptyUsage(), { ...turn, model: "openai/gpt-5", usd: 0.25 });
  assert.equal(u.usd, 0.25);
  assert.equal(u.unpriced, false);
  u = addTurn(u, { ...turn, model: "deepseek-chat" });
  assert.equal(u.usd, 0.25);
  assert.ok(u.unpriced);
  assert.equal(addTurn(emptyUsage(), { ...turn, api: false, model: "qwen3:14b" }).unpriced, false, "a local model costs nothing");
});
