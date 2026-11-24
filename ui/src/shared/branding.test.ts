import assert from "node:assert/strict";
import { test } from "node:test";
import { icoProblem, icoSizes, iconKind, nameProblem, PRESETS, pngProblem } from "./branding.ts";
import { ico } from "./png.ts";

test("names: empty, long, forbidden characters and reserved names are refused", () => {
  assert.equal(nameProblem("Блокнот"), null);
  assert.equal(nameProblem("  My App 2  "), null);
  assert.ok(nameProblem("   "));
  assert.ok(nameProblem("x".repeat(65)));
  assert.equal(nameProblem("x".repeat(64)), null);
  for (const bad of ["a/b", "a:b", 'a"b', "a?", "a*", "a|b", "a<b", "tab\there", "dot."]) assert.ok(nameProblem(bad), bad);
  for (const bad of ["CON", "nul", "Com1", "lpt9.txt"]) assert.ok(nameProblem(bad), bad);
  assert.equal(nameProblem("console"), null);
});

test("icons: format by content, .ico entries inside the file, a big enough image", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  assert.equal(iconKind(png), "png");
  assert.equal(iconKind(Buffer.from("GIF89a")), null);
  const good = ico([{ size: 32, png }, { size: 256, png }]);
  assert.equal(iconKind(good), "ico");
  assert.equal(icoProblem(good), null);
  assert.match(icoProblem(ico([{ size: 16, png }]))!, /не меньше 32/);
  assert.match(icoProblem(good.subarray(0, good.length - 1))!, /повреждён/);
  assert.match(icoProblem(Buffer.from([0, 0, 1, 0, 0, 0]))!, /повреждён/);
  assert.match(icoProblem(Buffer.concat([good, Buffer.alloc(1 << 20)]))!, /1 МБ/);
});

test("png: square, at least 32 px; sizes cut from it", () => {
  assert.equal(pngProblem(1000, 512, 512), null);
  assert.match(pngProblem(1000, 64, 32)!, /квадратным/);
  assert.match(pngProblem(1000, 16, 16)!, /не меньше/);
  assert.match(pngProblem(1000, 0, 0)!, /повреждён/);
  assert.deepEqual(icoSizes(48), [16, 24, 32, 48]);
  assert.deepEqual(icoSizes(1024), [16, 24, 32, 48, 64, 128, 256]);
});

test("presets: unique ids, valid names, a Windows program", () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  for (const p of PRESETS) {
    assert.equal(nameProblem(p.name), null, p.name);
    assert.match(p.exe, /^\w+\.exe$/, p.exe);
  }
});
