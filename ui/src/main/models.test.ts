import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as models from "./models.ts";

test("model ids from the renderer must be catalog ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
  const outside = path.join(dir, "..", `victim-${process.pid}.bin`);
  fs.writeFileSync(outside, "keep");
  try {
    assert.throws(() => models.fileOf("../x"));
    assert.throws(() => models.remove(dir, `../victim-${process.pid}`, ""));
    assert.equal(fs.readFileSync(outside, "utf8"), "keep");
    assert.equal(models.fileOf("small"), "ggml-small.bin");
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
