import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prune } from "./log.ts";

test("prune drops logs older than a week, keeps the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-"));
  for (const n of ["old.log", "new.log", "old.txt"]) fs.writeFileSync(path.join(dir, n), "x");
  const old = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(path.join(dir, "old.log"), old, old);
  fs.utimesSync(path.join(dir, "old.txt"), old, old);
  assert.deepEqual(prune(dir), ["old.log"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["new.log", "old.txt"]);
  assert.deepEqual(prune(path.join(dir, "missing")), []);
});
