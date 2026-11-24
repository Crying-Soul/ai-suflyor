// Line coverage over every source file. `npm run coverage` counts only the files the tests load;
// this also counts the ones no test loads (main's IPC and windows, the renderer pages) as 0%.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const lcov = path.join(os.tmpdir(), `suflyor-ui-${process.pid}.lcov`);
const args = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", "--experimental-test-coverage", "--test-coverage-exclude=src/**/*.test.ts"];
execFileSync(process.execPath, [...args, "--test-reporter=dot", "--test-reporter-destination=stdout", "--test-reporter=lcov", `--test-reporter-destination=${lcov}`, "src/**/*.test.ts"], { stdio: "inherit" });

const rel = (f) => path.relative(process.cwd(), f).replaceAll("\\", "/");
const covered = new Map(); // file -> [hit, found]
for (const rec of fs.readFileSync(lcov, "utf8").split("end_of_record")) {
  const file = /^SF:(.*)$/m.exec(rec)?.[1];
  if (file) covered.set(rel(file), [Number(/^LH:(\d+)/m.exec(rec)?.[1] ?? 0), Number(/^LF:(\d+)/m.exec(rec)?.[1] ?? 0)]);
}
fs.rmSync(lcov, { force: true });

const sources = fs.globSync("src/**/*.ts").map(rel).filter((f) => !f.endsWith(".test.ts") && !f.includes("/generated/"));
let [hit, found] = [0, 0];
const untested = [];
for (const f of sources) {
  const [h, n] = covered.get(f) ?? [0, fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length];
  if (!covered.has(f)) untested.push(`${f} (${n})`);
  hit += h;
  found += n;
}
console.log(`\nNot loaded by any test (lines): ${untested.join(", ")}`);
console.log(`All files: ${((100 * hit) / found).toFixed(1)}% of ${found} lines`);
