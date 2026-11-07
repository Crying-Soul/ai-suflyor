import assert from "node:assert/strict";
import { test } from "node:test";
import { blocking, check, type Facts } from "./readiness.ts";

const base: Facts = {
  coreError: null,
  modelExists: true,
  backend: "api",
  apiKey: true,
  claudeCodeOk: false,
  nvidia: false,
  cudaInstalled: false,
  status: null,
  translate: false,
  mtInstalled: false,
};

test("a fresh install: no model, no key", () => {
  const items = check({ ...base, modelExists: false, apiKey: false });
  assert.equal(blocking(items)?.id, "whisper");
  assert.equal(items.find((i) => i.id === "claude")?.ok, false);
  assert.equal(items.find((i) => i.id === "whisper")?.model, "small");
});

test("CUDA is offered on NVIDIA only, and never blocks", () => {
  assert.equal(check(base).find((i) => i.id === "cuda"), undefined);
  const items = check({ ...base, nvidia: true });
  assert.equal(items.find((i) => i.id === "cuda")?.level, "recommended");
  assert.equal(items.find((i) => i.id === "whisper")?.model, "large-v3-turbo-q8_0");
  assert.equal(blocking(items), undefined);
});

test("Claude Code counts only when the command answered", () => {
  assert.equal(check({ ...base, backend: "claude-code" }).find((i) => i.id === "claude")?.ok, false);
  assert.equal(check({ ...base, backend: "claude-code", claudeCodeOk: true }).find((i) => i.id === "claude")?.ok, true);
});
