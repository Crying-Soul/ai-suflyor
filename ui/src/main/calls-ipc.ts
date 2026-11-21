// IPC of the «Звонки» window: the context nodes on disk, search, export and moving calls.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { CallInfo, NodePatch } from "../shared/protocol";
import * as calls from "./calls";
import { coreArgs, readRaw, writeConfig } from "./config";
import type { CoreProcess } from "./core";
import { openCalls, wins } from "./windows";

export interface CallsDeps {
  core: CoreProcess;
  runCore(args: string[], timeout?: number): Promise<{ stdout: string; stderr: string }>;
  dataDir(): string;
  lastCall(): CallInfo | null;
}

export type RunCore = CallsDeps["runCore"];

let d!: CallsDeps;

/** userContext and glossary used to live in config.json; the profile node holds them now. */
export function migrateContext(): void {
  const raw = readRaw();
  const ctx = typeof raw.userContext === "string" ? raw.userContext : "";
  const glossary = Array.isArray(raw.glossary) ? raw.glossary.map(String) : [];
  try {
    if (calls.migrate(d.dataDir(), ctx, glossary)) writeConfig({ userContext: "", glossary: [] });
  } catch (e) {
    console.warn(`[calls] migration failed: ${e}`);
  }
}

/** After the context of a node changed: rebuild the prompt if that node is part of it. */
function contextChanged(dir: string): void {
  const open = d.lastCall()?.dir;
  const inUse = calls.kindOf(d.dataDir(), dir) === "profile" || (open && (open === dir || open.startsWith(dir + path.sep)));
  if (inUse) d.core.send({ cmd: "reload_context" });
}

async function addFiles(dir: string, paths?: string[]): Promise<void> {
  if (!paths?.length) {
    const r = await dialog.showOpenDialog(wins.calls ?? BrowserWindow.getFocusedWindow()!, {
      title: "Файлы контекста",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Документы", extensions: ["md", "txt", "pdf"] }],
    });
    if (r.canceled) return;
    paths = r.filePaths;
  }
  const failed: string[] = [];
  for (const pdf of calls.addFiles(d.dataDir(), dir, paths)) {
    await d.runCore(["--extract", pdf], 120_000).catch((e) => failed.push(`${path.basename(pdf)}: ${e.message}`));
  }
  contextChanged(dir);
  if (failed.length) throw new Error(`Текст не извлечён. ${failed.join("; ")}`);
}

async function fileText(dir: string, name: string): Promise<string> {
  const p = calls.filePath(d.dataDir(), dir, name);
  if (path.extname(p).toLowerCase() !== ".pdf") return fs.readFileSync(p, "utf8");
  return (await d.runCore(["--extract", p], 120_000)).stdout;
}

async function removeNode(dir: string): Promise<void> {
  if (calls.kindOf(d.dataDir(), dir) === "profile") throw new Error("профиль не удаляется");
  const open = d.lastCall()?.dir;
  if (open && (open === dir || open.startsWith(dir + path.sep))) throw new Error("сначала завершите звонок");
  await shell.trashItem(dir);
}

export function registerCallsIpc(deps: CallsDeps): void {
  d = deps;
  ipcMain.on("calls:open", openCalls);
  ipcMain.handle("calls:tree", () => calls.tree(d.dataDir()));
  ipcMain.handle("calls:node", (_e, dir: string) => calls.node(d.dataDir(), dir));
  ipcMain.handle("calls:save", (_e, dir: string, patch: NodePatch) => {
    calls.save(d.dataDir(), dir, patch);
    contextChanged(dir);
  });
  ipcMain.handle("calls:create-folder", (_e, title: string) => calls.createFolder(d.dataDir(), title));
  ipcMain.handle("calls:create-call", (_e, folder: string, title: string) => calls.createCall(d.dataDir(), folder, title));
  ipcMain.handle("calls:add-files", (_e, dir: string, paths?: string[]) => addFiles(dir, paths));
  ipcMain.handle("calls:file-text", (_e, dir: string, name: string) => fileText(dir, name));
  ipcMain.handle("calls:remove-file", (_e, dir: string, name: string) => {
    calls.removeFile(d.dataDir(), dir, name);
    contextChanged(dir);
  });
  ipcMain.handle("calls:remove", (_e, dir: string) => removeNode(dir));
  ipcMain.handle("calls:preview", async (_e, dir: string | null) => {
    const { stdout, stderr } = await d.runCore(["--print-context", dir ?? "", ...coreArgs()], 120_000);
    return `${stderr.trim()}\n\n${stdout.trim()}`;
  });
  // Only the data folder is ever revealed: a path from the renderer would let a page open any program.
  ipcMain.on("calls:reveal", () => d.dataDir() && shell.openPath(d.dataDir()));
  ipcMain.handle("calls:current", () => d.lastCall());
  ipcMain.handle("calls:search", (_e, q: string) => calls.search(d.dataDir(), q));
  ipcMain.handle("calls:export", async (_e, dir: string) => {
    const md = await calls.exportMarkdown(d.dataDir(), dir);
    const name = `${path.basename(dir)}.md`;
    const r = await dialog.showSaveDialog(wins.calls ?? BrowserWindow.getFocusedWindow()!, {
      title: "Сохранить звонок",
      defaultPath: path.join(app.getPath("documents"), name),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, md);
    return r.filePath;
  });
  ipcMain.handle("calls:move", (_e, dir: string, folder: string) => {
    // The core writes the open call's transcript into its directory: moving it would split the call.
    const open = d.lastCall()?.dir;
    if (open && path.resolve(open) === path.resolve(dir)) throw new Error("звонок открыт, сначала закройте его");
    return calls.move(d.dataDir(), dir, folder);
  });
  // «Подготовить»: the core writes brief.md into the call; a live call picks up its prepared answers.
  ipcMain.handle("calls:prepare", async (_e, dir: string) => {
    if (calls.kindOf(d.dataDir(), dir) !== "call") throw new Error("готовится только звонок");
    const { stdout } = await d.runCore(["--brief", dir, ...coreArgs()], 600_000);
    contextChanged(dir);
    return stdout.trim();
  });
  ipcMain.handle("calls:add-to-profile", (_e, dir: string, fact: string) => {
    calls.addToProfile(d.dataDir(), dir, fact);
    contextChanged(path.join(d.dataDir(), "profile"));
  });
}

