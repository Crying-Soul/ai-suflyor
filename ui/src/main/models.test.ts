import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

/** A Hugging Face stand-in: the repo listing with `sha` for the model, and the file with Range support. */
function hub(body: Buffer, sha: string, honourRange = true) {
  const ranges: (string | null)[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/api/models/")) {
      return Response.json([{ path: "ggml-base.bin", size: 1, lfs: { oid: sha, size: body.length } }]);
    }
    const range = new Headers(init?.headers).get("range");
    ranges.push(range);
    const from = honourRange && range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    return new Response(new Uint8Array(body.subarray(from)), { status: from ? 206 : 200, headers: { "content-length": String(body.length - from) } });
  }) as typeof globalThis.fetch;
  return { fetch, ranges };
}

const BODY = Buffer.from("ggml model bytes ".repeat(1000));
const SHA = createHash("sha256").update(BODY).digest("hex");

async function inTemp(run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("download resumes a .part with Range and checks the sha256", async () => {
  await inTemp(async (dir) => {
    const h = hub(BODY, SHA);
    models.useFetch(h.fetch);
    fs.writeFileSync(path.join(dir, "ggml-base.bin.part"), BODY.subarray(0, 5000));
    assert.equal(models.list(dir, "").find((m) => m.id === "base")?.state, "partial");
    let ticks = 0;
    await models.download(dir, "base", () => ticks++);
    assert.deepEqual(h.ranges, ["bytes=5000-"]);
    assert.deepEqual(fs.readFileSync(path.join(dir, "ggml-base.bin")), BODY);
    assert.ok(!fs.existsSync(path.join(dir, "ggml-base.bin.part")));
    const m = models.list(dir, path.join(dir, "ggml-base.bin")).find((x) => x.id === "base");
    assert.equal(m?.state, "installed");
    assert.equal(m?.active, true);
    assert.ok(ticks >= 2, "progress at the start and the end");
  });
});

test("a server that ignores Range gets the file from the start", async () => {
  await inTemp(async (dir) => {
    models.useFetch(hub(BODY, SHA, false).fetch);
    fs.writeFileSync(path.join(dir, "ggml-base.bin.part"), Buffer.from("stale"));
    await models.download(dir, "base", () => {});
    assert.deepEqual(fs.readFileSync(path.join(dir, "ggml-base.bin")), BODY);
  });
});

test("a wrong sha256 deletes the download and reports it", async () => {
  await inTemp(async (dir) => {
    const h = hub(BODY, "0".repeat(64));
    models.useFetch(h.fetch);
    await models.download(dir, "base", () => {});
    assert.equal(h.ranges.length, 1, "bad bytes are not fetched again");
    assert.ok(!fs.existsSync(path.join(dir, "ggml-base.bin")) && !fs.existsSync(path.join(dir, "ggml-base.bin.part")));
    const m = models.list(dir, "").find((x) => x.id === "base");
    assert.equal(m?.state, "absent");
    assert.match(m?.error ?? "", /контрольная сумма/);
    assert.throws(() => models.remove(dir, "base", path.join(dir, "ggml-base.bin")), "the model in use stays");
    models.remove(dir, "base", "");
    assert.equal(models.list(dir, "").find((x) => x.id === "base")?.error, undefined, "remove clears the error");
  });
});
