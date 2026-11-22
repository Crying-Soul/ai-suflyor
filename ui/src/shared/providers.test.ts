import assert from "node:assert/strict";
import test from "node:test";
import { defaultModels, modelChoices, PROVIDERS, provider } from "./providers.ts";

test("every provider has a unique id and a note; keyed ones say where the key is", () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  for (const p of PROVIDERS) {
    assert.ok(p.hint, p.id);
    if (!p.local && p.id !== "custom") assert.match(p.keyUrl ?? "", /^https:\/\//, p.id);
  }
});

test("model suggestions follow the connection", () => {
  assert.deepEqual(modelChoices("api", "deepseek"), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  assert.ok(modelChoices("openai", "deepseek").includes("deepseek-reasoner"));
  assert.deepEqual(modelChoices("openai", "custom"), [], "nothing to suggest for an unknown server");
  assert.deepEqual(defaultModels("openai", "ollama"), provider("ollama").models);
  assert.equal(provider("nope").id, "openai");
});
