// Call folders on disk: <dataDir>/profile, folders/<slug>, folders/<slug>/calls/<date>-<slug>.
// Every node has context.md, meta.json {title, glossary, ...} and files/. The core reads the same layout.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CallsTree, NodeData, NodeFile, NodeKind, NodePatch, SearchHit, TranscriptLine } from "../shared/protocol";
import { readJson, writeAtomic } from "./json-file.ts"; // .ts: node --test runs this file unbundled

const CONTEXT_EXT = new Set([".md", ".txt", ".pdf"]);

/** Notes of a new node: the sections the core's prompts refer to by name. */
export const TEMPLATES: Record<NodeKind, string> = {
  profile: "## Стек и грейд\n\n## Истории (STAR, цифры)\n\n## Факты и красные линии\nЗарплатные ожидания, срок выхода, формат работы, о чём не говорить.\n\n## Как я говорю\n2–3 ваших типичных фразы.\n",
  folder: "## Вакансия\n\n## Компания\n\n## Люди\n",
  call: "## Цели звонка\n\n## Интервьюер\n",
};

/** Interview stages a call can be (meta.json `stage`); the core adds a line of focus for each. */
const STAGES = ["hr", "tech", "system_design", "final"];

/** The section of the summary that lists facts to add to the profile. */
const SUGGEST_HEADING = "## Добавить в профиль";
/** Where accepted facts go in the profile notes. */
const FROM_CALLS = "## Из звонков";

/** The «Добавить в профиль» lines of a summary, without the leading "- ". */
export function suggestions(summary: string): string[] {
  const lines = summary.split("\n");
  const at = lines.findIndex((l) => l.trim() === SUGGEST_HEADING);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("#")) break;
    const m = /^\s*[-*]\s+(.+)$/.exec(l);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** `summary` without the line of `fact`; the section heading goes too once it is empty. */
function dropSuggestion(summary: string, fact: string): string {
  const lines = summary.split("\n");
  const at = lines.findIndex((l) => l.trim() === SUGGEST_HEADING);
  if (at < 0) return summary;
  const i = lines.findIndex((l, j) => j > at && /^\s*[-*]\s+/.test(l) && l.replace(/^\s*[-*]\s+/, "").trim() === fact);
  if (i < 0) return summary;
  lines.splice(i, 1);
  if (!suggestions(lines.join("\n")).length) {
    let end = at + 1;
    while (end < lines.length && !lines[end].startsWith("#")) end++;
    lines.splice(at, end - at);
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** `notes` with `fact` appended under «Из звонков» (the section is created at the end if missing). */
export function withFact(notes: string, fact: string): string {
  const lines = notes.trimEnd().split("\n");
  const at = lines.findIndex((l) => l.trim() === FROM_CALLS);
  if (at < 0) return `${notes.trimEnd()}${notes.trim() ? "\n\n" : ""}${FROM_CALLS}\n- ${fact}\n`;
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, `- ${fact}`);
  return lines.join("\n") + "\n";
}

// Writes stay synchronous (one small file each). Reads that walk many files are async: the main
// process also routes hotkeys and the core's events, and must not stall on a large data folder.
const readText = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const read = (p: string) => fsp.readFile(p, "utf8").catch(() => "");
const exists = (p: string) => fsp.access(p).then(() => true, () => false);
async function readMeta(dir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return {};
  }
}
const title = async (dir: string) => String((await readMeta(dir)).title ?? "") || path.basename(dir);
const subdirs = async (dir: string) =>
  (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
    .sort();

export function kindOf(dataDir: string, dir: string): NodeKind {
  const rel = path.relative(dataDir, dir).split(path.sep);
  if (rel.length === 1 && rel[0] === "profile") return "profile";
  if (rel.length === 2 && rel[0] === "folders") return "folder";
  if (rel.length === 4 && rel[0] === "folders" && rel[2] === "calls") return "call";
  throw new Error(`не узел контекста: ${dir}`);
}

export async function tree(dataDir: string): Promise<CallsTree> {
  const call = async (c: string) => {
    const meta = await readMeta(c);
    const started = typeof meta.started === "string" ? meta.started : undefined;
    return { dir: c, title: String(meta.title ?? "") || path.basename(c), hasSummary: await exists(path.join(c, "summary.md")), started };
  };
  const folder = async (f: string) => ({
    dir: f,
    title: await title(f),
    // Newest call first: names start with the date.
    calls: await Promise.all((await subdirs(path.join(f, "calls"))).reverse().map(call)),
  });
  return { dataDir, profile: path.join(dataDir, "profile"), folders: await Promise.all((await subdirs(path.join(dataDir, "folders"))).map(folder)) };
}

/** Tokens the way the core counts them (characters / 3). */
const tokens = (s: string) => Math.ceil([...s].length / 3);

/** Cached PDF text, if it is not older than the PDF (the core's rule). */
async function pdfCache(file: string): Promise<string | null> {
  const cache = path.join(path.dirname(file), ".text", `${path.basename(file)}.txt`);
  try {
    const [c, f] = await Promise.all([fsp.stat(cache), fsp.stat(file)]);
    return c.mtimeMs >= f.mtimeMs ? await fsp.readFile(cache, "utf8") : null;
  } catch {
    return null;
  }
}

async function files(dir: string): Promise<NodeFile[]> {
  const fdir = path.join(dir, "files");
  const entries = (await fsp.readdir(fdir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isFile() && CONTEXT_EXT.has(path.extname(d.name).toLowerCase()));
  const list = await Promise.all(
    entries.map(async (d) => {
      const p = path.join(fdir, d.name);
      const text = path.extname(d.name).toLowerCase() === ".pdf" ? await pdfCache(p) : await read(p);
      return { name: d.name, size: (await fsp.stat(p)).size, tokens: text === null ? null : tokens(text) };
    }),
  );
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

async function transcript(dir: string): Promise<TranscriptLine[]> {
  return (await read(path.join(dir, "transcript.jsonl")))
    .split("\n")
    .flatMap((l) => {
      try {
        const s = JSON.parse(l);
        return [{ speaker: s.speaker, t: s.t_ms, text: s.text }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.t - b.t);
}

export async function node(dataDir: string, dir: string): Promise<NodeData> {
  const kind = kindOf(dataDir, dir);
  const meta = await readMeta(dir);
  const ctxFile = path.join(dir, "context.md");
  const data: NodeData = {
    dir,
    kind,
    title: kind === "profile" ? "Обо мне" : await title(dir),
    // A profile never saved starts from the template (folders and calls get it when created).
    context: kind === "profile" && !(await exists(ctxFile)) ? TEMPLATES.profile : await read(ctxFile),
    glossary: Array.isArray(meta.glossary) ? meta.glossary.map(String) : [],
    files: await files(dir),
  };
  if (kind === "call") {
    data.started = typeof meta.started === "string" ? meta.started : undefined;
    data.summary = await read(path.join(dir, "summary.md"));
    data.transcript = await transcript(dir);
    data.answers = (await read(path.join(dir, "answers.jsonl"))).split("\n").filter((l) => l.trim()).length;
    data.stage = typeof meta.stage === "string" ? meta.stage : "";
    // The first line is the core's cache key (`<!-- source: … -->`).
    data.brief = (await read(path.join(dir, "brief.md"))).replace(/^<!--[^\n]*-->\n/, "").trim() || undefined;
    data.suggestions = suggestions(data.summary);
  }
  return data;
}

export function save(dataDir: string, dir: string, patch: NodePatch): void {
  const kind = kindOf(dataDir, dir);
  const metaPath = path.join(dir, "meta.json");
  const meta = readJson(metaPath);
  if (kind !== "profile" && patch.title.trim()) meta.title = patch.title.trim();
  meta.glossary = patch.glossary.map((g) => g.trim()).filter(Boolean);
  if (kind === "call" && patch.stage !== undefined) {
    if (STAGES.includes(patch.stage)) meta.stage = patch.stage;
    else delete meta.stage;
  }
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
  writeAtomic(path.join(dir, "context.md"), patch.context);
}

/** A directory name from a title: Windows-safe, short, unique among its siblings. */
function slug(parent: string, base: string, prefix = ""): string {
  const s =
    base
      .toLowerCase()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in Windows file names.
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "без-названия";
  let name = prefix + s;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${prefix}${s}-${i}`;
  return path.join(parent, name);
}

function create(dir: string, meta: Record<string, unknown>, notes: string): string {
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeAtomic(path.join(dir, "context.md"), notes);
  return dir;
}

/** A call opened for the first time (nothing recorded yet) starts now, not when it was created. */
export function markStarted(dir: string): void {
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath) || readText(path.join(dir, "transcript.jsonl")).trim()) return;
  const meta = readJson(metaPath);
  meta.started = new Date().toISOString();
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

export function createFolder(dataDir: string, name: string): string {
  return create(slug(path.join(dataDir, "folders"), name), { title: name.trim(), glossary: [] }, TEMPLATES.folder);
}

export function createCall(dataDir: string, folder: string, name: string): string {
  if (kindOf(dataDir, folder) !== "folder") throw new Error("звонок создаётся только в папке");
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  // Names sort by time: the core takes earlier calls' summaries by this order.
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-`;
  return create(slug(path.join(folder, "calls"), name, stamp), { title: name.trim(), glossary: [], started: now.toISOString() }, TEMPLATES.call);
}

/** Moves `fact` from the call's «Добавить в профиль» into the profile notes. */
export function addToProfile(dataDir: string, call: string, fact: string): void {
  if (kindOf(dataDir, call) !== "call") throw new Error("факты берутся из итога звонка");
  const summaryPath = path.join(call, "summary.md");
  const summary = readText(summaryPath);
  if (!suggestions(summary).includes(fact)) throw new Error("этого факта нет в итоге звонка");
  const ctx = path.join(dataDir, "profile", "context.md");
  writeAtomic(ctx, withFact(fs.existsSync(ctx) ? readText(ctx) : TEMPLATES.profile, fact));
  writeAtomic(summaryPath, dropSuggestion(summary, fact));
}

/** Copies files into the node; returns the PDFs that need text extraction. */
export function addFiles(dataDir: string, dir: string, paths: string[]): string[] {
  kindOf(dataDir, dir);
  const fdir = path.join(dir, "files");
  fs.mkdirSync(fdir, { recursive: true });
  const pdfs: string[] = [];
  for (const src of paths) {
    const ext = path.extname(src).toLowerCase();
    if (!CONTEXT_EXT.has(ext)) continue;
    const dst = path.join(fdir, path.basename(src));
    fs.copyFileSync(src, dst);
    if (ext === ".pdf") pdfs.push(dst);
  }
  return pdfs;
}

/** The file's path inside the node; a name with path parts is refused. */
export function filePath(dataDir: string, dir: string, name: string): string {
  kindOf(dataDir, dir);
  if (path.basename(name) !== name) throw new Error(`плохое имя файла: ${name}`);
  return path.join(dir, "files", name);
}

export function removeFile(dataDir: string, dir: string, name: string): void {
  const p = filePath(dataDir, dir, name);
  fs.rmSync(p, { force: true });
  fs.rmSync(path.join(path.dirname(p), ".text", `${name}.txt`), { force: true });
}

/** Moves the old global settings into the profile once; the config keys are emptied after. */
export function migrate(dataDir: string, userContext: string, glossary: string[]): boolean {
  const dir = path.join(dataDir, "profile");
  if (!userContext.trim() && !glossary.length) return false;
  const ctx = path.join(dir, "context.md");
  if (userContext.trim() && !readText(ctx).trim()) writeAtomic(ctx, userContext.trim() + "\n");
  const metaPath = path.join(dir, "meta.json");
  const meta = readJson(metaPath);
  const old = Array.isArray(meta.glossary) ? meta.glossary.map(String) : [];
  meta.glossary = [...new Set([...old, ...glossary])];
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  return true;
}

/** The line of `text` around the first match of `q` (lowercase), trimmed for a list row. */
function snippet(text: string, q: string): string | null {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const s = text.slice(start, i + q.length + 80).replace(/\s+/g, " ").trim();
  return (start ? "…" : "") + s;
}

/** Folders and calls whose title, notes, summary or transcript contain `query` (any case). */
export async function search(dataDir: string, query: string, limit = 50): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  const look = (dir: string, title: string, folder: string | undefined, parts: [string, string][]) => {
    for (const [where, text] of parts) {
      const s = snippet(text, q);
      if (s !== null) return void hits.push({ dir, title, folder, where, snippet: s });
    }
  };
  for (const f of await subdirs(path.join(dataDir, "folders"))) {
    const ft = await title(f);
    look(f, ft, undefined, [["название", ft], ["заметки", await read(path.join(f, "context.md"))]]);
    for (const c of (await subdirs(path.join(f, "calls"))).reverse()) {
      const [ct, notes, summary, lines] = await Promise.all([title(c), read(path.join(c, "context.md")), read(path.join(c, "summary.md")), transcript(c)]);
      look(c, ct, ft, [
        ["название", ct],
        ["заметки", notes],
        ["итог", summary],
        ["транскрипт", lines.map((l) => l.text).join("\n")],
      ]);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** The call as one Markdown document: summary, notes, the transcript and the full hints. */
export async function exportMarkdown(dataDir: string, dir: string): Promise<string> {
  if (kindOf(dataDir, dir) !== "call") throw new Error("экспортируется только звонок");
  const n = await node(dataDir, dir);
  const clock = (t: number) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const out = [`# ${n.title}`, ""];
  out.push(`Папка: ${await title(path.dirname(path.dirname(dir)))}`);
  if (n.started) out.push(`Начало: ${new Date(n.started).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}`);
  if (n.summary?.trim()) out.push("", "## Итог", "", n.summary.trim());
  if (n.context.trim()) out.push("", "## Заметки", "", n.context.trim());
  const lines = n.transcript ?? [];
  if (lines.length) {
    out.push("", "## Транскрипт", "");
    for (const l of lines) out.push(`**${clock(l.t)} ${l.speaker === "them" ? "Собеседник" : "Я"}:** ${l.text}`, "");
  }
  const hints = (await read(path.join(dir, "answers.jsonl")))
    .split("\n")
    .flatMap((l) => {
      try {
        const a = JSON.parse(l);
        return a.tier === "full" && a.text ? [a as { question: string; text: string }] : [];
      } catch {
        return [];
      }
    });
  if (hints.length) {
    out.push("", "## Подсказки", "");
    for (const h of hints) out.push(`### ${h.question || "Без вопроса"}`, "", h.text.trim(), "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Moves a call into another folder (its directory keeps its name, made unique there). */
export function move(dataDir: string, dir: string, folder: string): string {
  if (kindOf(dataDir, dir) !== "call") throw new Error("переносится только звонок");
  if (kindOf(dataDir, folder) !== "folder") throw new Error("переносить можно только в папку");
  if (path.dirname(path.dirname(dir)) === folder) return dir;
  const parent = path.join(folder, "calls");
  fs.mkdirSync(parent, { recursive: true });
  let to = path.join(parent, path.basename(dir));
  for (let i = 2; fs.existsSync(to); i++) to = path.join(parent, `${path.basename(dir)}-${i}`);
  fs.renameSync(dir, to);
  return to;
}
