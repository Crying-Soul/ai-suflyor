import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreProcess } from "./core.ts";

// A stand-in core: says "ready", exits on {"cmd":"shutdown"} or stdin EOF.
const FAKE = `
process.stdout.write(JSON.stringify({ ev: "ready", version: String(process.pid) }) + "\\n");
require("readline").createInterface({ input: process.stdin })
  .on("line", (l) => { if (JSON.parse(l).cmd === "shutdown") process.exit(0); })
  .on("close", () => process.exit(0));
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("restart called twice runs one core, not two", async () => {
  const ready: string[] = [];
  const core = new CoreProcess(process.execPath, () => ["-e", FAKE], process.cwd(), (e) => {
    if (e.ev === "ready") ready.push(e.version);
  });
  core.start();
  await wait(500);
  core.restart();
  core.restart();
  core.start();
  await wait(1500);
  assert.equal(ready.length, 2, `the first core and one restart: ${ready}`);
  await core.stopped();
});

test("stop cancels a pending restart", async () => {
  const ready: string[] = [];
  const core = new CoreProcess(process.execPath, () => ["-e", FAKE], process.cwd(), (e) => {
    if (e.ev === "ready") ready.push(e.version);
  });
  core.start();
  await wait(500);
  core.restart();
  await core.stopped();
  await wait(800);
  assert.equal(ready.length, 1, `no core after stop: ${ready}`);
});
