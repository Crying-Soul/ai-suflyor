import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Job } from "./models.ts";
import * as models from "./models.ts";
import { fetchFile, pack } from "./pack.ts";

const info = { id: "x", label: "X", sizeMb: 1, note: "" };

test("pack states: absent, partial, installed, and a failed install's error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  try {
    let fail = true;
    const p = pack({
      info,
      files: ["a.dll"],
      progress: ["a.zip.part"],
      async install(d) {
        if (fail) throw new Error("нет сети");
        fs.writeFileSync(path.join(d, "a.dll"), "dll");
      },
    });
    assert.equal(p.status(dir).state, "absent");
    fs.writeFileSync(path.join(dir, "a.zip.part"), "12345");
    assert.deepEqual([p.status(dir).state, p.status(dir).received], ["partial", 5]);
    await p.download(dir, () => {});
    assert.equal(p.status(dir).error, "нет сети");
    fail = false;
    await p.download(dir, () => {});
    assert.deepEqual([p.status(dir).state, p.status(dir).active, p.status(dir).error], ["installed", true, undefined]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled pack download is not an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  try {
    const p = pack({
      info,
      files: ["a.dll"],
      progress: [],
      install: (_d, job) =>
        new Promise((_, reject) => job.controller.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const running = p.download(dir, () => {});
    assert.equal(p.status(dir).state, "downloading");
    p.cancel();
    await running;
    assert.deepEqual([p.status(dir).state, p.status(dir).error], ["absent", undefined]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchFile skips a file that is there and renames the .part when done", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  try {
    let calls = 0;
    models.useFetch((async () => {
      calls++;
      return new Response("zip bytes");
    }) as unknown as typeof fetch);
    const job: Job = { controller: new AbortController(), received: 0, total: 0 };
    const file = path.join(dir, "sub", "a.zip");
    await fetchFile("https://example.invalid/a.zip", file, job);
    assert.equal(fs.readFileSync(file, "utf8"), "zip bytes");
    assert.equal(job.received, 9);
    await fetchFile("https://example.invalid/a.zip", file, job);
    assert.equal(calls, 1, "an existing file is not fetched again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
