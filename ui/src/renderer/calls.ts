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
/** Calls whose summary is being written: no «Продолжить звонок» until it is in. */
const summarizing = new Set<string>();
/** Saves the form on show (set by renderPane). */
let saveForm: () => Promise<void> = async () => {};
/** The form's values as typed, for a re-render that must keep unsaved edits. */
let typed: (() => Pick<NodeData, "title" | "context" | "glossary" | "stage">) | null = null;

/** The interview stages of a call (meta.json `stage`), as the select offers them. */
const STAGE_LABEL: [string, string][] = [
  ["", "Не указан"],
  ["hr", "HR-скрининг"],
  ["tech", "Техническое"],
  ["system_design", "System design"],
  ["final", "Финальное"],
];

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
      li.append(treeButton(c.dir, c.title, callDate(c.dir, c.started)));
      return li;
    }));
    if (!f.calls.length) ul.append(el("li", "empty", "Звонков нет: «Новый звонок» в папке"));
    items[i + 1].append(treeButton(f.dir, f.title), ul);
  });
  if (!tree.folders.length) items.push(el("li", "empty", "Создайте папку компании, в ней звонок: так транскрипт и итог сохранятся"));
  treeEl.replaceChildren(...items);
}

/** When the call started (meta.json `started`, set when it is first opened), else its name's date: "05.11, 12:00". */
function callDate(dir: string, started?: string): string {
  if (started) {
    const d = new Date(started);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-[^\\/]*$/.exec(dir);
  return m ? `${m[3]}.${m[2]}, ${m[4]}:${m[5]}` : "";
}

// ---------- the node pane ----------

async function select(dir: string): Promise<void> {
  if (dirty && current?.dir !== dir && !(await askConfirm("Перейти без сохранения изменений?", "Перейти", "Отмена", true))) return;
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
  const kind = n.kind === "profile" ? "Для всех звонков" : n.kind === "folder" ? "Папка" : n.started ? `Звонок от ${new Date(n.started).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}` : "Звонок";
  head.append(el("p", "kind", kind), h, el("p", "hint", KIND_NOTE[n.kind]));

  const actions = el("div", "pane-actions");
  if (n.kind === "call") {
    const isLive = live?.dir === n.dir;
    if (isLive) {
      actions.append(
        button("Завершить звонок", "btn", () => {
          summarizing.add(n.dir);
          api.send({ cmd: "close_call" });
          setState("pending", "Звонок завершён. Пишу итог…");
        }),
        el("span", "live-note", "Идёт: транскрипт и ответы сохраняются сюда"),
      );
    } else if (summarizing.has(n.dir)) {
      actions.append(el("span", "live-note", "Пишу итог… Продолжить звонок можно, когда он будет готов."));
    } else {
      actions.append(button(n.transcript?.length ? "Продолжить звонок" : "Начать звонок", "btn", () => start(n)));
      if (n.transcript?.length) {
        actions.append(
          button(n.summary?.trim() ? "Повторить итог" : "Написать итог", "btn-ghost", () => {
            summarizing.add(n.dir);
            api.send({ cmd: "summarize", dir: n.dir });
            renderPane(dirty && typed ? { ...n, ...typed() } : n);
            setState("pending", "Пишу итог…");
          }),
        );
      }
    }
    actions.append(
      button("Предпросмотр контекста", "btn-ghost", () => preview(n.dir)),
      button("Экспорт в Markdown", "btn-ghost", () =>
        api.calls.exportMd(n.dir).then((p) => p && setState("done", `Сохранено: ${p}`)).catch(fail),
      ),
    );
    actions.append(moveControl(n, isLive));
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
  const stage = el("select", "select");
  stage.append(...STAGE_LABEL.map(([v, label]) => Object.assign(el("option", "", label), { value: v, selected: v === (n.stage ?? "") })));
  const stageValue = () => (n.kind === "call" ? stage.value : undefined);
  typed = () => ({ title: title.value, context: notes.value, glossary: glossary.value.split("\n"), stage: stageValue() });
  if (n.kind !== "profile") form.append(field("Название", title));
  if (n.kind === "call") form.append(field("Этап", stage, "Подсказки делают акцент этапа: HR — мотивация и условия, техническое — точность и компромиссы."));
  form.append(
    field("Заметки", notes, "Markdown. Claude читает это перед каждым ответом."),
    field("Глоссарий", glossary, "Один термин на строку: имена, продукты, технологии. Подсказывает Whisper, как их писать."),
    filesField(n),
  );
  form.addEventListener("input", () => {
    dirty = true;
    setState("pending", "Есть несохранённые изменения");
  });
  saveForm = async () => {
    await api.calls.save(n.dir, { title: title.value, context: notes.value, glossary: glossary.value.split("\n"), stage: stageValue() });
    dirty = false;
    n.title = n.kind === "profile" ? n.title : title.value.trim() || n.title;
    n.context = notes.value;
    h.textContent = n.title;
    setState("done", live?.dir || n.kind === "profile" ? "Сохранено. Контекст обновлён." : "Сохранено.");
    await loadTree();
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveForm().catch(fail);
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
    else body.append(rehearsal(n), form, summary, log);
  } else body.append(form);
  pane.replaceChildren(body, footer);
}

/** A folder picker and a button that moves the call there (not the open one: the core writes into it). */
function moveControl(n: NodeData, isLive: boolean): HTMLElement {
  const here = tree.folders.find((f) => f.calls.some((c) => c.dir === n.dir));
  const others = tree.folders.filter((f) => f !== here);
  const box = el("div", "move");
  // Said, not just missing: the user looking for «Перенести» learns why it is not there.
  if (isLive) return (box.append(el("span", "hint", "Перенести можно после «Завершить звонок».")), box);
  if (!others.length) return (box.append(el("span", "hint", "Перенести некуда: другой папки нет.")), box);
  const pick = el("select", "select");
  pick.setAttribute("aria-label", "Папка, куда перенести звонок");
  pick.append(...others.map((f) => Object.assign(el("option", "", f.title), { value: f.dir })));
  box.append(
    pick,
    button("Перенести", "btn-ghost", async () => {
      if (dirty && !(await askConfirm("Перенести без сохранения изменений?", "Перенести", "Отмена", true))) return;
      try {
        const to = await api.calls.move(n.dir, pick.value);
        dirty = false;
        current = null;
        await loadTree();
        await select(to);
        setState("done", `Перенесено в «${pick.selectedOptions[0].textContent}».`);
      } catch (err) {
        fail(err);
      }
    }),
  );
  return box;
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
        if (!(await askConfirm(`Удалить ${f.name} из контекста?`, "Удалить", "Отмена", true))) return;
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

/** Starts (or continues) a call: unsaved notes are saved first, another open call ends with its summary. */
async function start(n: NodeData): Promise<void> {
  if (live?.dir && live.dir !== n.dir) {
    const ok = await askConfirm(`Идёт звонок «${live.title}». Завершить его (итог запишется) и начать этот?`, "Завершить и начать");
    if (!ok) return;
    summarizing.add(live.dir);
  }
  if (dirty) await saveForm();
  api.send({ cmd: "open_call", dir: n.dir });
}

/** Summary, transcript and answers of a call, read only. */
function callRecord(n: NodeData): HTMLElement[] {
  const summary = el("section", "record");
  summary.append(el("h3", "", "Итог"));
  if (n.summary?.trim()) {
    const body = el("div", "md");
    body.append(md(n.summary));
    summary.append(body);
    if (n.suggestions?.length) summary.append(profileSuggestions(n));
  } else {
    summary.append(el("p", "hint", n.transcript?.length && live?.dir !== n.dir ? "Итога нет: «Написать итог» выше. Следующие звонки этой папки получат его в контексте." : "Появится после «Завершить звонок». Следующие звонки этой папки получат его в контексте."));
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

/** «Добавить в профиль» of the summary: each fact goes into «Обо мне» with one click. */
function profileSuggestions(n: NodeData): HTMLElement {
  const box = el("div", "suggestions");
  box.append(el("h4", "", "Добавить в «Обо мне»"), el("p", "hint", "Факты о вас из этого звонка, которых нет в «Обо мне». Добавленный факт попадёт в раздел «Из звонков»."));
  const ul = el("ul", "suggestion-list");
  for (const fact of n.suggestions ?? []) {
    const li = el("li");
    li.append(
      el("span", "", fact),
      button("Добавить", "btn-ghost small", async () => {
        await api.calls.addToProfile(n.dir, fact);
        n.suggestions = (n.suggestions ?? []).filter((f) => f !== fact);
        li.remove();
        if (!n.suggestions.length) box.remove();
        setState("done", "Добавлено в «Обо мне».");
      }),
    );
    ul.append(li);
  }
  box.append(ul);
  return box;
}

/** «Репетиция»: the brief of a call before it starts (likely questions, gaps against the vacancy). */
function rehearsal(n: NodeData): HTMLElement {
  const box = el("section", "record rehearsal");
  box.append(el("h3", "", "Репетиция"));
  const body = el("div", "md");
  const note = el("p", "hint");
  const show = () => {
    if (n.brief) {
      body.replaceChildren(md(n.brief));
      note.textContent = "Досье по материалам: вероятные вопросы с ответами и пробелы против вакансии. Подсказки в звонке опираются на эти ответы. Файл brief.md можно править.";
    } else {
      body.replaceChildren();
      note.textContent = "Claude прочитает материалы и выпишет вероятные вопросы с ответами и пробелы против вакансии. Занимает до пары минут.";
    }
  };
  const go = button(n.brief ? "Обновить" : "Подготовить", "btn-ghost", async () => {
    if (dirty && !(await askConfirm("Готовить без сохранения изменений? Досье соберётся по сохранённым материалам.", "Готовить"))) return;
    go.disabled = true;
    setState("pending", "Готовлю досье…");
    try {
      n.brief = await api.calls.prepare(n.dir);
      show();
      go.textContent = "Обновить";
      setState("done", "Досье готово.");
    } finally {
      go.disabled = false;
    }
  });
  show();
  box.append(note, go, body);
  return box;
}

async function remove(n: NodeData): Promise<void> {
  const what = n.kind === "folder" ? `папку «${n.title}» со всеми звонками` : `звонок «${n.title}»`;
  if (!(await askConfirm(`Переместить ${what} в корзину?`, "В корзину", "Отмена", true))) return;
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
    // The live state changes the buttons; unsaved notes must survive that re-render.
    if (current) renderPane(dirty && typed ? { ...current, ...typed() } : current);
    if (e.warnings.length) setState("error", e.warnings.join(". "));
  } else if (e.ev === "summary") {
    summarizing.delete(e.dir);
    loadTree().catch(fail);
    if (current?.dir === e.dir) {
      select(e.dir).then(() => setState(e.ok ? "done" : "error", e.ok ? "Итог записан." : `Итог не записан: ${e.error}`));
    }
  }
});

// ---------- search ----------

const searchEl = $<HTMLInputElement>("search");
const hitsEl = $("hits");
let searchSeq = 0;
searchEl.addEventListener("input", async () => {
  const q = searchEl.value.trim();
  const seq = ++searchSeq;
  const on = q.length >= 2;
  hitsEl.hidden = !on;
  treeEl.hidden = on;
  if (!on) return;
  const hits = await api.calls.search(q).catch(() => []);
  if (seq !== searchSeq) return;
  hitsEl.replaceChildren(
    ...(hits.length
      ? hits.map((h) => {
          const li = el("li");
          li.append(treeButton(h.dir, h.title, `${h.folder ? `${h.folder} · ` : ""}${h.where}: ${h.snippet}`));
          return li;
        })
      : [el("li", "empty", "Ничего не нашлось")]),
  );
});
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchEl.value) {
    e.stopPropagation();
    searchEl.value = "";
    searchEl.dispatchEvent(new Event("input"));
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
