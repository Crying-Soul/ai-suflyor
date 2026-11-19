// Call folders on disk: <dataDir>/profile, folders/<slug>, folders/<slug>/calls/<date>-<slug>.
// Every node has context.md, meta.json {title, glossary, ...} and files/. The core reads the same layout.
import fs from "node:fs";
import path from "node:path";
import type { CallsTree, NodeData, NodeFile, NodeKind, NodePatch, SearchHit, TranscriptLine } from "../shared/protocol";

const CONTEXT_EXT = new Set([".md", ".txt", ".pdf"]);

export function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Writes dotted keys ("stt.model") into `raw`, creating the objects on the way. */
export function setDotted(raw: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    // "__proto__.x" would write into Object.prototype.
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    let obj = raw;
    for (const part of parts.slice(0, -1)) {
      if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  }
}

/** Write then rename: a crash mid-write never leaves a truncated file. */
export function writeAtomic(p: string, data: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, data);
  fs.renameSync(`${p}.tmp`, p);
}

const readText = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const title = (dir: string) => String(readJson(path.join(dir, "meta.json")).title ?? "") || path.basename(dir);
const subdirs = (dir: string) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)).sort()
    : [];

export function kindOf(dataDir: string, dir: string): NodeKind {
  const rel = path.relative(dataDir, dir).split(path.sep);
  if (rel.length === 1 && rel[0] === "profile") return "profile";
  if (rel.length === 2 && rel[0] === "folders") return "folder";
  if (rel.length === 4 && rel[0] === "folders" && rel[2] === "calls") return "call";
  throw new Error(`не узел контекста: ${dir}`);
}

export function tree(dataDir: string): CallsTree {
  return {
    dataDir,
    profile: path.join(dataDir, "profile"),
    folders: subdirs(path.join(dataDir, "folders")).map((f) => ({
      dir: f,
      title: title(f),
      // Newest call first: names start with the date.
      calls: subdirs(path.join(f, "calls"))
        .reverse()
        .map((c) => ({ dir: c, title: title(c), hasSummary: fs.existsSync(path.join(c, "summary.md")) })),
    })),
  };
}

/** Tokens the way the core counts them (characters / 3). */
const tokens = (s: string) => Math.ceil([...s].length / 3);

/** Cached PDF text, if it is not older than the PDF (the core's rule). */
function pdfCache(file: string): string | null {
  const cache = path.join(path.dirname(file), ".text", `${path.basename(file)}.txt`);
  try {
    return fs.statSync(cache).mtimeMs >= fs.statSync(file).mtimeMs ? fs.readFileSync(cache, "utf8") : null;
  } catch {
    return null;
  }
}

function files(dir: string): NodeFile[] {
  const fdir = path.join(dir, "files");
  if (!fs.existsSync(fdir)) return [];
  return fs
    .readdirSync(fdir, { withFileTypes: true })
    .filter((d) => d.isFile() && CONTEXT_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => {
      const p = path.join(fdir, d.name);
      const text = path.extname(d.name).toLowerCase() === ".pdf" ? pdfCache(p) : fs.readFileSync(p, "utf8");
      return { name: d.name, size: fs.statSync(p).size, tokens: text === null ? null : tokens(text) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function transcript(dir: string): TranscriptLine[] {
  return readText(path.join(dir, "transcript.jsonl"))
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

export function node(dataDir: string, dir: string): NodeData {
  const kind = kindOf(dataDir, dir);
  const meta = readJson(path.join(dir, "meta.json"));
  const data: NodeData = {
    dir,
    kind,
    title: kind === "profile" ? "Обо мне" : title(dir),
    context: readText(path.join(dir, "context.md")),
    glossary: Array.isArray(meta.glossary) ? meta.glossary.map(String) : [],
    files: files(dir),
  };
  if (kind === "call") {
    data.started = typeof meta.started === "string" ? meta.started : undefined;
    data.summary = readText(path.join(dir, "summary.md"));
    data.transcript = transcript(dir);
    data.answers = readText(path.join(dir, "answers.jsonl")).split("\n").filter((l) => l.trim()).length;
  }
  return data;
}

export function save(dataDir: string, dir: string, patch: NodePatch): void {
  const kind = kindOf(dataDir, dir);
  const metaPath = path.join(dir, "meta.json");
  const meta = readJson(metaPath);
  if (kind !== "profile" && patch.title.trim()) meta.title = patch.title.trim();
  meta.glossary = patch.glossary.map((g) => g.trim()).filter(Boolean);
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
  writeAtomic(path.join(dir, "context.md"), patch.context);
}

/** A directory name from a title: Windows-safe, short, unique among its siblings. */
function slug(parent: string, base: string, prefix = ""): string {
  const s =
    base
      .toLowerCase()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "без-названия";
  let name = prefix + s;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${prefix}${s}-${i}`;
  return path.join(parent, name);
}

function create(dir: string, meta: Record<string, unknown>): string {
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return dir;
}

export function createFolder(dataDir: string, name: string): string {
  return create(slug(path.join(dataDir, "folders"), name), { title: name.trim(), glossary: [] });
}

export function createCall(dataDir: string, folder: string, name: string): string {
  if (kindOf(dataDir, folder) !== "folder") throw new Error("звонок создаётся только в папке");
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  // Names sort by time: the core takes earlier calls' summaries by this order.
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-`;
  return create(slug(path.join(folder, "calls"), name, stamp), { title: name.trim(), glossary: [], started: now.toISOString() });
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
export function search(dataDir: string, query: string, limit = 50): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  const look = (dir: string, folder: string | undefined, parts: [string, string][]) => {
    for (const [where, text] of parts) {
      const s = snippet(text, q);
      if (s !== null) return void hits.push({ dir, title: title(dir), folder, where, snippet: s });
    }
  };
  for (const f of subdirs(path.join(dataDir, "folders"))) {
    const ft = title(f);
    look(f, undefined, [["название", ft], ["заметки", readText(path.join(f, "context.md"))]]);
    for (const c of subdirs(path.join(f, "calls")).reverse()) {
      const lines = transcript(c).map((l) => l.text).join("\n");
      look(c, ft, [
        ["название", title(c)],
        ["заметки", readText(path.join(c, "context.md"))],
        ["итог", readText(path.join(c, "summary.md"))],
        ["транскрипт", lines],
      ]);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** The call as one Markdown document: summary, notes, the transcript and the full hints. */
export function exportMarkdown(dataDir: string, dir: string): string {
  if (kindOf(dataDir, dir) !== "call") throw new Error("экспортируется только звонок");
  const n = node(dataDir, dir);
  const clock = (t: number) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const out = [`# ${n.title}`, ""];
  out.push(`Папка: ${title(path.dirname(path.dirname(dir)))}`);
  if (n.started) out.push(`Начало: ${new Date(n.started).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}`);
  if (n.summary?.trim()) out.push("", "## Итог", "", n.summary.trim());
  if (n.context.trim()) out.push("", "## Заметки", "", n.context.trim());
  const lines = transcript(dir);
  if (lines.length) {
    out.push("", "## Транскрипт", "");
    for (const l of lines) out.push(`**${clock(l.t)} ${l.speaker === "them" ? "Собеседник" : "Я"}:** ${l.text}`, "");
  }
  const hints = readText(path.join(dir, "answers.jsonl"))
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
