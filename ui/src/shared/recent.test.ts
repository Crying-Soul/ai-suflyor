import assert from "node:assert/strict";
import { test } from "node:test";
import { recentFolders } from "./recent.ts";

test("folders sort by their newest call, empty ones last", () => {
  const f = (dir: string, calls: string[]) => ({ dir, title: dir, calls: calls.map((c) => ({ dir: `${dir}\\calls\\${c}`, title: c, hasSummary: false })) });
  const tree = { dataDir: "d", profile: "p", folders: [f("a", ["2026-01-02-1000-x"]), f("empty", []), f("b", ["2026-03-01-0900-y", "2025-01-01-0000-z"])] };
  assert.deepEqual(recentFolders(tree, 3).map((x) => x.dir), ["b", "a", "empty"]);
  assert.deepEqual(recentFolders(tree, 1).map((x) => x.dir), ["b"]);
});
