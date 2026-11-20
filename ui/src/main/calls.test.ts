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

test("setDotted writes nested keys and skips prototype keys", () => {
  const raw: Record<string, unknown> = { stt: { dll: "a.dll" } };
  calls.setDotted(raw, { "stt.model": "m.bin", "__proto__.polluted": true, "a.constructor.prototype.x": 1 });
  assert.deepEqual(raw, { stt: { dll: "a.dll", model: "m.bin" } });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("search, export and move of a call", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "calls-"));
  const a = calls.createFolder(data, "Яндекс");
  const b = calls.createFolder(data, "Озон");
  const c = calls.createCall(data, a, "Тех секция");
  fs.writeFileSync(path.join(c, "transcript.jsonl"), [
    JSON.stringify({ speaker: "them", t_ms: 1_000, end_ms: 2_000, text: "Как устроен Kafka consumer group?" }),
    JSON.stringify({ speaker: "me", t_ms: 3_000, end_ms: 4_000, text: "Партиции делятся между консьюмерами." }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(c, "answers.jsonl"), JSON.stringify({ turn: 1, tier: "full", trigger: "auto", question: "Kafka?", model: "m", text: "Ребалансировка." }) + "\n");
  fs.writeFileSync(path.join(c, "summary.md"), "Обсудили очереди.\n");

  const hit = calls.search(data, "KAFKA consumer");
  assert.deepEqual(hit.map((h) => [h.dir, h.where, h.folder]), [[c, "транскрипт", "Яндекс"]]);
  assert.match(hit[0].snippet, /Kafka consumer group/);
  assert.equal(calls.search(data, "яндекс")[0].dir, a);
  assert.deepEqual(calls.search(data, "к"), [], "one letter is not a search");

  const md = calls.exportMarkdown(data, c);
  assert.match(md, /^# Тех секция\n/);
  assert.match(md, /## Итог\n\nОбсудили очереди\./);
  assert.match(md, /\*\*\d\d:\d\d Собеседник:\*\* Как устроен Kafka/);
  assert.match(md, /### Kafka\?\n\nРебалансировка\./);
  assert.throws(() => calls.exportMarkdown(data, a));

  const moved = calls.move(data, c, b);
  assert.equal(path.dirname(path.dirname(moved)), b);
  assert.ok(!fs.existsSync(c));
  assert.equal(calls.tree(data).folders.find((f) => f.dir === b)?.calls[0].title, "Тех секция");
  assert.throws(() => calls.move(data, moved, path.join(data, "profile")));
  fs.rmSync(data, { recursive: true, force: true });
});

test("templates, stage, brief and profile suggestions", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "calls-"));
  // A profile never saved shows the template; folders and calls are created with theirs.
  assert.equal(calls.node(data, path.join(data, "profile")).context, calls.TEMPLATES.profile);
  const f = calls.createFolder(data, "Acme");
  assert.equal(calls.node(data, f).context, calls.TEMPLATES.folder);
  const c = calls.createCall(data, f, "Тех");
  assert.equal(calls.node(data, c).context, calls.TEMPLATES.call);

  calls.save(data, c, { title: "Тех", context: "x", glossary: [], stage: "tech" });
  assert.equal(calls.node(data, c).stage, "tech");
  calls.save(data, c, { title: "Тех", context: "x", glossary: [], stage: "bogus" });
  assert.equal(calls.node(data, c).stage, "");

  fs.writeFileSync(path.join(c, "brief.md"), "<!-- source: abc -->\n## Стек\nGo\n");
  assert.equal(calls.node(data, c).brief, "## Стек\nGo");

  const summary = "## Темы\n- Go\n\n## Добавить в профиль\n- Вёл миграцию на Go 1.22\n- Знает Kafka Streams\n\n## Ещё\n- y\n";
  assert.deepEqual(calls.suggestions(summary), ["Вёл миграцию на Go 1.22", "Знает Kafka Streams"]);
  assert.deepEqual(calls.suggestions("## Темы\n- Go\n"), []);
  fs.writeFileSync(path.join(c, "summary.md"), summary);
  fs.mkdirSync(path.join(data, "profile"), { recursive: true });
  fs.writeFileSync(path.join(data, "profile", "context.md"), "## Стек\nGo\n");
  calls.addToProfile(data, c, "Знает Kafka Streams");
  calls.addToProfile(data, c, "Вёл миграцию на Go 1.22");
  assert.equal(fs.readFileSync(path.join(data, "profile", "context.md"), "utf8"), "## Стек\nGo\n\n## Из звонков\n- Знает Kafka Streams\n- Вёл миграцию на Go 1.22\n");
  const left = fs.readFileSync(path.join(c, "summary.md"), "utf8");
  assert.ok(!left.includes("Добавить в профиль") && left.includes("## Ещё"), left);
  assert.throws(() => calls.addToProfile(data, c, "Знает Kafka Streams"));
  // «Из звонков» in the middle: the fact goes to the end of that section, not of the file.
  assert.equal(calls.withFact("## Из звонков\n- a\n\n## Как я говорю\nx\n", "b"), "## Из звонков\n- a\n- b\n\n## Как я говорю\nx\n");
});
