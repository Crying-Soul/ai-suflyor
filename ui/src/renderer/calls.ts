import type { CallInfo, CallsTree, NodeData, NodeKind } from "../shared/protocol";
import { $, api, askConfirm, el, guardPopups } from "./common";
import { render as md } from "./md";

const treeEl = $("tree");
const pane = $("pane");
const viewer = $<HTMLDialogElement>("viewer");

let tree!: CallsTree;
let current: NodeData | null = null;
/** The call the core has open now (its context is in use and its transcript is being saved). */
let live: CallInfo | null = null;
let dirty = false;

const KIND_NOTE: Record<NodeKind, string> = {
  profile: "Общий для всех звонков: кто вы, опыт, стек, чем гордитесь. Сюда же резюме.",
  folder: "Компания или проект: продукт, вакансия, команда, что важно им. Звонки ниже видят этот контекст и итоги прошлых звонков.",
  call: "Этот звонок: с кем, о чём, план, вопросы, которые хотите задать.",
};

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`);
const fmtTokens = (n: number) => `≈${n.toLocaleString("ru-RU")} ток.`;

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
  setState("error", msg);
}

function setState(kind: "" | "pending" | "done" | "error", text: string): void {
  const s = document.getElementById("save-state");
  if (!s) return;
  s.className = kind;
  s.textContent = text;
}

// ---------- tree ----------

function treeButton(dir: string, label: string, sub = ""): HTMLButtonElement {
  const b = el("button");
  b.type = "button";
  b.dataset.dir = dir;
  b.append(el("span", "label", label));
  if (sub) b.append(el("span", "sub", sub));
  if (live?.dir === dir) b.append(el("span", "live", "идёт"));
  if (current?.dir === dir) b.setAttribute("aria-current", "true");
  b.onclick = () => select(dir);
  return b;
}

async function loadTree(): Promise<void> {
  tree = await api.calls.tree();
  $("data-dir").textContent = tree.dataDir;
  const items: HTMLElement[] = [el("li", "", ""), ...tree.folders.map(() => el("li", "folder"))];
  items[0].append(treeButton(tree.profile, "Обо мне"));
  tree.folders.forEach((f, i) => {
    const ul = el("ul", "calls");
    ul.replaceChildren(...f.calls.map((c) => {
      const li = el("li");
      li.append(treeButton(c.dir, c.title, callDate(c.dir)));
      return li;
    }));
    items[i + 1].append(treeButton(f.dir, f.title), ul);
  });
  treeEl.replaceChildren(...items);
}

/** "2026-11-05-1200-..." -> "05.11, 12:00". */
function callDate(dir: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-[^\\/]*$/.exec(dir);
  return m ? `${m[3]}.${m[2]}, ${m[4]}:${m[5]}` : "";
}

// ---------- the node pane ----------

async function select(dir: string): Promise<void> {
  if (dirty && current?.dir !== dir && !(await askConfirm("Перейти без сохранения изменений?", "Перейти"))) return;
  try {
    current = await api.calls.node(dir);
  } catch (e) {
    fail(e);
    return;
  }
  dirty = false;
  for (const b of treeEl.querySelectorAll<HTMLButtonElement>("button")) {
    if (b.dataset.dir === dir) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  renderPane(current);
}

function field(label: string, control: HTMLElement, hint = ""): HTMLElement {
  const id = `f-${label.replace(/\s+/g, "-")}`;
  control.id = id;
  const l = el("label", "", label);
  l.htmlFor = id;
  const body = el("div", "control");
  body.append(control);
  if (hint) body.append(el("p", "hint", hint));
  const f = el("div", "field");
  f.append(l, body);
  return f;
}

function button(text: string, cls: string, onclick: () => unknown): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.onclick = () => {
    Promise.resolve(onclick()).catch(fail);
  };
  return b;
}

function renderPane(n: NodeData): void {
  const head = el("header", "pane-head");
  const h = el("h2", "", n.title);
  const kind = n.kind === "profile" ? "Профиль" : n.kind === "folder" ? "Папка" : n.started ? `Звонок от ${new Date(n.started).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}` : "Звонок";
  head.append(el("p", "kind", kind), h, el("p", "hint", KIND_NOTE[n.kind]));

  const actions = el("div", "pane-actions");
  if (n.kind === "call") {
    const isLive = live?.dir === n.dir;
    if (isLive) {
      actions.append(
        button("Завершить звонок", "btn", () => {
          api.send({ cmd: "close_call" });
          setState("pending", "Звонок завершён. Пишу итог…");
        }),
        el("span", "live-note", "Идёт: транскрипт и ответы сохраняются сюда"),
      );
    } else {
      actions.append(button(n.transcript?.length ? "Продолжить звонок" : "Начать звонок", "btn", () => api.send({ cmd: "open_call", dir: n.dir })));
    }
    actions.append(button("Предпросмотр контекста", "btn-ghost", () => preview(n.dir)));
  } else if (n.kind === "folder") {
    actions.append(
      button("Новый звонок", "btn", async () => select(await api.calls.createCall(n.dir, "Новый звонок")).then(loadTree)),
    );
  } else {
    actions.append(button("Предпросмотр контекста", "btn-ghost", () => preview(null)));
  }
  head.append(actions);

  const form = el("form", "node-form");
  form.autocomplete = "off";
  const title = Object.assign(el("input", "input"), { type: "text", value: n.title, required: true });
  const notes = Object.assign(el("textarea", "textarea notes"), { value: n.context, rows: 9 });
  const glossary = Object.assign(el("textarea", "textarea"), { value: n.glossary.join("\n"), rows: 4 });
  if (n.kind !== "profile") form.append(field("Название", title));
  form.append(
    field("Заметки", notes, "Markdown. Claude читает это перед каждым ответом."),
    field("Глоссарий", glossary, "Один термин на строку: имена, продукты, технологии. Подсказывает Whisper, как их писать."),
    filesField(n),
  );
  form.addEventListener("input", () => {
    dirty = true;
    setState("pending", "Есть несохранённые изменения");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.calls.save(n.dir, { title: title.value, context: notes.value, glossary: glossary.value.split("\n") });
      dirty = false;
      n.title = n.kind === "profile" ? n.title : title.value.trim() || n.title;
      h.textContent = n.title;
      setState("done", live?.dir || n.kind === "profile" ? "Сохранено. Контекст обновлён." : "Сохранено.");
      await loadTree();
    } catch (err) {
      fail(err);
    }
  });

  const footer = el("footer", "actions");
  const save = el("button", "btn", "Сохранить");
  save.type = "submit";
  form.id = "node-form";
  save.setAttribute("form", "node-form");
  const state = el("span");
  state.id = "save-state";
  state.setAttribute("role", "status");
  footer.append(state);
  if (n.kind !== "profile") footer.append(button(n.kind === "folder" ? "Удалить папку" : "Удалить звонок", "btn-ghost", () => remove(n)));
  footer.append(save);

  const body = el("div", "pane-body");
  body.append(head);
  if (n.kind === "call") {
    // A finished call is mostly read for its summary: that goes first.
    const [summary, log] = callRecord(n);
    if (n.summary?.trim()) body.append(summary, form, log);
    else body.append(form, summary, log);
  } else body.append(form);
  pane.replaceChildren(body, footer);
}

function filesField(n: NodeData): HTMLElement {
  const box = el("div", "files");
  const list = el("ul", "file-list");
  for (const f of n.files) {
    const li = el("li");
    li.append(
      el("span", "name", f.name),
      el("span", "meta num", `${fmtSize(f.size)}, ${f.tokens === null ? "текст не извлечён" : fmtTokens(f.tokens)}`),
      button("Текст", "btn-ghost small", () => showFile(n, f.name)),
      button("Удалить", "btn-ghost small", async () => {
        if (!(await askConfirm(`Удалить ${f.name} из контекста?`, "Удалить"))) return;
        await api.calls.removeFile(n.dir, f.name);
        await refreshFiles(n);
      }),
    );
    list.append(li);
  }
  const add = button("Добавить файлы", "btn-ghost", () => addFiles(n));
  box.append(list, add, el("p", "hint", "MD, TXT или PDF. Можно перетащить сюда. Текст PDF лежит рядом в files/.text и правится руками."));
  // Drop anywhere on the field.
  box.addEventListener("dragover", (e) => {
    e.preventDefault();
    box.classList.add("drop");
  });
  box.addEventListener("dragleave", () => box.classList.remove("drop"));
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drop");
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) addFiles(n, paths).catch(fail);
  });
  const f = field("Файлы", box);
  f.classList.add("files-field");
  f.querySelector("label")!.removeAttribute("for");
  return f;
}

/** Redraws only the file list: unsaved notes in the form stay. */
async function refreshFiles(n: NodeData): Promise<void> {
  n.files = (await api.calls.node(n.dir)).files;
  pane.querySelector(".files-field")?.replaceWith(filesField(n));
}

async function addFiles(n: NodeData, paths?: string[]): Promise<void> {
  setState("pending", "Добавляю файлы…");
  let err: unknown = null;
  try {
    await api.calls.addFiles(n.dir, paths);
  } catch (e) {
    err = e;
  }
  // Copied files show up even when a PDF failed to extract.
  await refreshFiles(n);
  if (err) fail(err);
  else setState("done", "Файлы добавлены.");
}

/** Summary, transcript and answers of a call, read only. */
function callRecord(n: NodeData): HTMLElement[] {
  const summary = el("section", "record");
  summary.append(el("h3", "", "Итог"));
  if (n.summary?.trim()) {
    const body = el("div", "md");
    body.append(md(n.summary));
    summary.append(body);
  } else {
    summary.append(el("p", "hint", "Появится после «Завершить звонок». Следующие звонки этой папки получат его в контексте."));
  }

  const log = el("section", "record");
  const lines = n.transcript ?? [];
  log.append(el("h3", "", "Транскрипт"), el("p", "hint", lines.length ? `${lines.length} реплик, ответов: ${n.answers ?? 0}` : "Пока пусто: начните звонок."));
  if (lines.length) {
    const details = el("details");
    details.append(el("summary", "", "Показать"));
    const ol = el("ol", "lines");
    for (const l of lines) {
      const li = el("li", l.speaker);
      li.append(el("span", "who", l.speaker === "me" ? "Я" : "Собеседник"), el("span", "", l.text));
      ol.append(li);
    }
    details.append(ol);
    log.append(details);
  }
  return [summary, log];
}

async function remove(n: NodeData): Promise<void> {
  const what = n.kind === "folder" ? `папку «${n.title}» со всеми звонками` : `звонок «${n.title}»`;
  if (!(await askConfirm(`Переместить ${what} в корзину?`, "В корзину"))) return;
  await api.calls.remove(n.dir);
  current = null;
  dirty = false;
  await loadTree();
  await select(tree.profile);
}

// ---------- viewer: file text and the context preview ----------

function view(title: string, note: string, text: string): void {
  $("viewer-title").textContent = title;
  $("viewer-note").textContent = note;
  $("viewer-text").textContent = text;
  viewer.showModal();
}

async function showFile(n: NodeData, name: string): Promise<void> {
  const text = await api.calls.fileText(n.dir, name);
  view(name, name.toLowerCase().endsWith(".pdf") ? "Текст, извлечённый из PDF. Если он кривой, поправьте файл в files/.text." : "", text);
}

async function preview(dir: string | null): Promise<void> {
  setState("pending", "Собираю контекст…");
  const out = await api.calls.preview(dir);
  setState("", "");
  const [stats, ...rest] = out.split("\n\n");
  view("Что получит Claude", stats, rest.join("\n\n"));
}

$("viewer-close").onclick = () => viewer.close();
viewer.addEventListener("click", (e) => e.target === viewer && viewer.close());

// ---------- live call state ----------

api.onEvent((e) => {
  if (e.ev === "call") {
    live = e.dir ? e : null;
    loadTree().catch(fail);
    if (current) renderPane(current);
    if (e.warnings.length) setState("error", e.warnings.join(". "));
  } else if (e.ev === "summary") {
    loadTree().catch(fail);
    if (current?.dir === e.dir) {
      select(e.dir).then(() => setState(e.ok ? "done" : "error", e.ok ? "Итог записан." : `Итог не записан: ${e.error}`));
    }
  }
});

$("btn-new-folder").onclick = () =>
  api.calls
    .createFolder("Новая папка")
    .then(async (dir) => {
      await loadTree();
      await select(dir);
      document.querySelector<HTMLInputElement>("#f-Название")?.select();
    })
    .catch(fail);
guardPopups();
$("data-dir").onclick = () => api.calls.reveal(tree.dataDir);

(async () => {
  const c = await api.calls.current();
  live = c?.dir ? c : null;
  await loadTree();
  await select(live?.dir ?? tree.profile);
})().catch(fail);
