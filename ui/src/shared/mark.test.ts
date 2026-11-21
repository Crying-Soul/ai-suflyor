import assert from "node:assert/strict";
import test from "node:test";
import { MARK_SVG, rasterize } from "./mark.ts";
import { ico, png } from "./png.ts";

test("the mark rasterizes: see-through corner, ink tile, paper disc, cinnabar ring", () => {
  const s = 100;
  const px = rasterize(s);
  const at = (x: number, y: number) => [...px.subarray((y * s + x) * 4, (y * s + x) * 4 + 4)];
  assert.equal(px[3], 0, "the rounded corner is see-through");
  assert.deepEqual(at(50, 8), [0x11, 0x11, 0x13, 255], "the tile");
  assert.deepEqual(at(20, 50), [0xf1, 0xef, 0xea, 255], "the disc");
  assert.deepEqual(at(84, 50), [0xe5, 0x48, 0x2b, 255], "the ring, right side");
  assert.deepEqual(at(62, 50), [0x11, 0x11, 0x13, 255], "the ring's hole shows the tile");
  assert.deepEqual(at(31, 50), [0x11, 0x11, 0x13, 255], "the gap between disc and ring");
});

test("without the tile only the disc and ring are opaque", () => {
  const px = rasterize(100, false);
  assert.equal(px[(50 * 100 + 50) * 4 + 3], 0);
  assert.equal(px[(50 * 100 + 20) * 4 + 3], 255);
});

test("the SVG mark is one colour: the theme's text colour", () => {
  assert.doesNotMatch(MARK_SVG, /#[0-9a-f]{3,6}/i);
  assert.match(MARK_SVG, /currentColor/);
});

test("png and ico headers", () => {
  const p = png(rasterize(16), 16);
  assert.deepEqual([...p.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const i = ico([{ size: 16, png: p }, { size: 256, png: p }]);
  assert.equal(i.readUInt16LE(4), 2);
  assert.equal(i[6 + 16], 0, "256 px is stored as 0");
  assert.equal(i.readUInt32LE(6 + 12), 6 + 32);
});
