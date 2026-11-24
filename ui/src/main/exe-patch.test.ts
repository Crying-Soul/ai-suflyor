import assert from "node:assert/strict";
import { test } from "node:test";
import * as ResEdit from "resedit";
import { ico } from "../shared/png.ts";
import { patchExe } from "./exe-patch.ts";

const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const icon = (n: number) => ico([{ size: 32, png: png(n) }, { size: 48, png: png(n) }]);

function read(exe: Buffer) {
  const res = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(exe));
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  return {
    descriptions: vis.flatMap((vi) => vi.getAllLanguagesForStringValues().map((l) => vi.getStringValues(l).FileDescription)),
    groups: groups.map((g) => ({ id: g.id, icons: g.getIconItemsFromEntries(res.entries).map((i) => Buffer.from((i as ResEdit.Data.RawIconItem).bin)) })),
  };
}

// The Rust core has no resources at all: without a version resource Task Manager shows "suflyor-core".
test("an exe without resources gets the name and the icon", () => {
  const bare = Buffer.from(ResEdit.NtExecutable.createEmpty().generate());
  const r = read(patchExe(ResEdit, bare, "Блокнот", icon(1)));
  assert.deepEqual(r.descriptions, ["Блокнот"]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].icons.length, 2);
});

// A new version or a new choice rebuilds from an exe that already has both: replaced, not added.
test("a patched exe patched again: one version entry and one icon group, the new values", () => {
  const bare = Buffer.from(ResEdit.NtExecutable.createEmpty().generate());
  const once = patchExe(ResEdit, bare, "Блокнот", icon(1));
  const r = read(patchExe(ResEdit, once, "Калькулятор", icon(2)));
  assert.deepEqual(r.descriptions, ["Калькулятор"]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].id, read(once).groups[0].id);
  assert.equal(r.groups[0].icons[0].at(-1), 2);
});

test("no icon keeps the exe's own", () => {
  const withIcon = patchExe(ResEdit, Buffer.from(ResEdit.NtExecutable.createEmpty().generate()), "A", icon(1));
  const r = read(patchExe(ResEdit, withIcon, "B", null));
  assert.deepEqual(r.descriptions, ["B"]);
  assert.equal(r.groups[0].icons[0].at(-1), 1);
});
