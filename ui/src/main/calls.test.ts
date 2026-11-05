import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as calls from "./calls.ts";

test("folders, calls, files, save and migration", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "calls-"));
  assert.ok(calls.migrate(data, "Go, 6 лет", ["Kafka"]));
  assert.equal(fs.readFileSync(path.join(data, "profile", "context.md"), "utf8"), "Go, 6 лет\n");
  assert.ok(!calls.migrate(data, "", []));

  const f = calls.createFolder(data, "Яндекс: Маркет?");
  assert.equal(path.basename(f), "яндекс-маркет");
  assert.equal(path.basename(calls.createFolder(data, "Яндекс: Маркет?")), "яндекс-маркет-2");
  const c = calls.createCall(data, f, "Тех секция");
  assert.match(path.basename(c), /^\d{4}-\d{2}-\d{2}-\d{4}-тех-секция$/);
  assert.throws(() => calls.createCall(data, c, "x"));

  const src = path.join(data, "cv.txt");
  fs.writeFileSync(src, "x".repeat(30));
  assert.deepEqual(calls.addFiles(data, c, [src, path.join(data, "a.png")]), []);
  calls.save(data, c, { title: "Системный дизайн", context: "Анна", glossary: [" YDB ", ""] });

  const n = calls.node(data, c);
  assert.equal(n.kind, "call");
  assert.equal(n.title, "Системный дизайн");
  assert.deepEqual(n.glossary, ["YDB"]);
  assert.deepEqual(n.files, [{ name: "cv.txt", size: 30, tokens: 10 }]);
  assert.ok(n.started);

  const t = calls.tree(data);
  assert.equal(t.folders[0].calls[0].title, "Системный дизайн");
  assert.equal(calls.node(data, t.profile).glossary[0], "Kafka");
  assert.throws(() => calls.filePath(data, c, "../meta.json"));
  calls.removeFile(data, c, "cv.txt");
  assert.equal(calls.node(data, c).files.length, 0);
  assert.throws(() => calls.kindOf(data, path.join(data, "folders")));
  fs.rmSync(data, { recursive: true, force: true });
});
