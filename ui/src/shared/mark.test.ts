import assert from "node:assert/strict";
import test from "node:test";
import { rasterize } from "./mark.ts";
import { ico, png } from "./png.ts";

test("the mark rasterizes with a transparent corner and an apricot tally", () => {
  const s = 64;
  const px = rasterize(s);
  assert.equal(px[3], 0, "the rounded corner is see-through");
  const at = (x: number, y: number) => [...px.subarray((y * s + x) * 4, (y * s + x) * 4 + 4)];
  assert.deepEqual(at(32, 16), [0xf2, 0xc0, 0x8f, 255], "the tally light");
  assert.equal(at(32, 32 - 26)[3], 255, "the tile is opaque inside");
});

test("png and ico headers", () => {
  const p = png(rasterize(16), 16);
  assert.deepEqual([...p.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const i = ico([{ size: 16, png: p }, { size: 256, png: p }]);
  assert.equal(i.readUInt16LE(4), 2);
  assert.equal(i[6 + 16], 0, "256 px is stored as 0");
  assert.equal(i.readUInt32LE(6 + 12), 6 + 32);
});
