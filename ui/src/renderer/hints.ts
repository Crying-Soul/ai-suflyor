import type { AskKind, CoreEvent, ErrorKind, ReadyItem, Status } from "../shared/protocol";
import { $, api, bindActions, coreDownText, el, humanError, icon, keyLabel, modelLabel, overlayUi, replayGuard, sttLabel } from "./common";
import { render } from "./md";

const turnsEl = $("turns");
const chip = $("chip");
const modelBtn = $<HTMLButtonElement>("btn-model");
const latencyEl = $("latency");

let status: Status | null = null;
/** First-token times of the current turn. */
let metrics: Record<string, number> = {};

// ---------- turn state chip: what the assistant is doing right now ----------

type Phase = "idle" | "listening" | "recognizing" | "caught" | "asking" | "looking" | "answering" | "done" | "error";
const PHASE_TEXT: Record<Phase, string> = {
  idle: "Слушаю",
  listening: "Собеседник говорит…",
  recognizing: "Распознаю…",
  caught: "Вопрос пойман",
  asking: "Спрашиваю…",
  looking: "Смотрю на экран…",
  answering: "Отвечаю…",
  done: "Готово",
  error: "Ошибка",
};

/** What «Слушаю» would claim, checked against the core: no core, no recognition or a muted side say so. */
function idleText(): { text: string; warn: boolean } {
  if (!status) return { text: "Жду ядро…", warn: false };
  if (status.stt.state === "loading") return { text: "Загружаю распознавание…", warn: false };
  if (status.stt.state !== "ready") return { text: `Не слушаю: ${sttLabel(status.stt)}`, warn: true };
  if (status.mute_them && status.mute_me) return { text: "Не слушаю: оба звука выключены", warn: true };
  if (status.mute_them) return { text: "Не слышу собеседника: его звук выключен", warn: true };
  if (status.them.state === "error") return { text: "Не слышу собеседника: звук недоступен", warn: true };
  return { text: "Слушаю", warn: false };
}

/** The phase the turn is in; the chip may show it up to HOLD_MS later. */
let phase: Phase = "idle";
/** A phase stays on screen this long, so «Слушаю → Распознаю» does not flicker. */
const HOLD_MS = 400;
/** Phases the user acts on: shown at once. */
const URGENT = new Set<Phase>(["caught", "asking", "looking", "answering", "error"]);
let shownAt = 0;
let holdTimer = 0;

function setPhase(p: Phase, detail = "", tip = ""): void {
  phase = p;
  clearTimeout(holdTimer);
  const wait = shownAt + HOLD_MS - Date.now();
  if (wait > 0 && !URGENT.has(p)) {
    holdTimer = window.setTimeout(() => paintPhase(p, detail, tip), wait);
    return;
  }
  paintPhase(p, detail, tip);
}

function paintPhase(p: Phase, detail: string, tip: string): void {
  const idle = p === "idle" ? idleText() : null;
  chip.dataset.phase = idle?.warn ? "warn" : p;
  chip.textContent = idle ? idle.text : detail ? `${PHASE_TEXT[p]}. ${detail}` : PHASE_TEXT[p];
  chip.title = tip;
  shownAt = Date.now();
}

// ---------- answers: one card per ask, newest on top ----------

interface Turn {
  card: HTMLElement;
  state: HTMLElement;
  quick: HTMLElement;
  full: HTMLElement;
  text: Record<"quick" | "full", string>;
  /** A failed answer: its kind and raw cause. */
  error: Record<"quick" | "full", { kind?: ErrorKind; raw: string } | null>;
  /** The user's rating: 1 useful, -1 not. */
  rating: 1 | -1 | null;
}

const turns = new Map<number, Turn>();
/** Screenshots arrive just before their turn's first answer_start. */
const shots = new Map<number, { thumb: string; width: number; height: number }>();
/** Answer id -> its turn and tier. */
const answers = new Map<number, { turn: number; tier: "quick" | "full" }>();
let current = -1;
/** The turn on show: the newest, or an older one picked with Ctrl+Alt+PageUp. */
let shown = -1;
const HISTORY_LIMIT = 50;
/** Tooltip of the «Продолжить ответ» buttons, with the key in effect. */
let moreTip = "Ещё 2–3 предложения к этой подсказке";

/** How the card names its ask: a fixed title for the suggestion kinds, else the question itself. */
const KIND_TITLE: Record<string, string> = {
  questions: "Что спросить у собеседника",
  continue: "Как продолжить ваш ответ",
  more: "Продолжение ответа",
  shorter: "Прошлый ответ короче",
  simpler: "Прошлый ответ проще",
  example: "Пример к прошлому ответу",
};
const TRIGGER_LABEL: Record<string, string> = {
  auto: "авто",
  early: "авто",
  picked: "выбрано",
  screen: "экран",
  questions: "вопросы",
  continue: "что сказать",
  more: "продолжение",
  shorter: "короче",
  simpler: "проще",
  example: "пример",
};
/** Ways to redo the answer on show, under its card. */
const REFINE: [AskKind, string, string][] = [
  ["shorter", "Короче", "Тот же ответ в 1–2 фразы"],
  ["simpler", "Проще", "Тот же ответ простыми словами"],
  ["example", "Пример", "Конкретный пример: из вашего опыта или код"],
];

function newTurn(id: number, question: string, trigger: string): Turn {
  const prev = turns.get(current);
  prev?.card.classList.remove("current");
  const card = el("article", "turn current");
  const head = el("header", "q");
  const state = el("span", "state-word");
  head.append(
    el("span", "qtext", KIND_TITLE[trigger] ?? (question ? `«${question}»` : trigger === "screen" ? "Задача с экрана" : "Без вопроса: подсказка по разговору")),
    el("span", "trigger", TRIGGER_LABEL[trigger] ?? "вручную"),
    state,
  );
  const quick = el("p", "quick");
  const full = el("div", "full md");
  card.append(head);
  const shot = shots.get(id);
  if (shot) {
    shots.delete(id);
    // What the model saw: a thumb that opens to the card's width on click.
    const fig = el("figure", "shot");
    const img = el("img");
    img.src = shot.thumb;
    img.alt = `Снимок экрана ${shot.width}×${shot.height}, отправлен вместе с вопросом`;
    fig.append(img);
    fig.addEventListener("click", (e) => {
      e.stopPropagation();
      fig.classList.toggle("big");
    });
    card.append(fig);
  }
  card.append(quick, full);
  if (trigger !== "questions" && trigger !== "continue") {
    // Redo or continue this answer: shown on the current card once it is done (CSS).
    const row = el("div", "refine");
    for (const [kind, text, tip] of REFINE) {
      const b = el("button", "btn-ghost small", text);
      b.type = "button";
      b.title = tip;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setPhase("asking");
        api.send({ cmd: "ask", screenshot: false, kind });
      });
      row.append(b);
    }
    const more = el("button", "more btn-ghost small", "Продолжить");
    more.type = "button";
    more.title = moreTip;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      api.action("moreAnswer");
    });
    row.append(more);
    card.append(row);
  }
  card.tabIndex = 0;
  card.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === card) {
      e.preventDefault();
      card.click();
    }
  });
  // Older cards collapse to the question and the quick line; a click opens the full answer.
  card.addEventListener("click", (e) => {
    if ((card.classList.contains("current") && !card.classList.contains("retracted")) || (e.target as Element).closest("pre, code")) return;
    card.classList.toggle("open");
  });
  turnsEl.prepend(card);
  const turn: Turn = { card, state, quick, full, text: { quick: "", full: "" }, error: { quick: null, full: null }, rating: null };
  turns.set(id, turn);
  current = id;
  show(id);
  metrics = {};
  latencyEl.textContent = "";
  while (turns.size > HISTORY_LIMIT) {
    const [oldest, t] = turns.entries().next().value!;
    t.card.remove();
    turns.delete(oldest);
  }
  renderNav();
  turnsEl.scrollTop = 0;
  return turn;
}

const dirty = new Set<Turn>();
let frame = 0;
/** Re-renders changed cards once per frame: deltas arrive far faster than the screen refreshes. */
function schedule(t: Turn): void {
  dirty.add(t);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const d of dirty) paint(d);
    dirty.clear();
  });
}

/** A failed answer: what happened in words, the raw cause folded away. */
function failure({ kind, raw }: { kind?: ErrorKind; raw: string }): HTMLElement {
  const box = el("details", "error");
  box.append(el("summary", "", humanError(kind)), el("p", "", raw));
  return box;
}

function paint(t: Turn): void {
  t.quick.replaceChildren(t.error.quick ? failure(t.error.quick) : t.text.quick);
  t.quick.classList.toggle("error", Boolean(t.error.quick));
  patch(t.full, render(t.text.full));
  if (t.error.full) t.full.append(failure(t.error.full));
}

/** Replaces `target`'s children with `next`, keeping the leading ones that did not change: a streaming
 * answer only grows at the end, so finished paragraphs stay as they are (and a selection in them survives). */
function patch(target: HTMLElement, next: DocumentFragment): void {
  const fresh = [...next.childNodes];
  const old = [...target.childNodes];
  let same = 0;
  while (same < fresh.length && same < old.length && old[same].isEqualNode(fresh[same])) same++;
  for (const n of old.slice(same)) n.remove();
  target.append(...fresh.slice(same));
}

/** The pane's own status: answering (open, apricot), done (periwinkle check) or failed. */
function setTurnState(t: Turn, st: "answering" | "done" | "error" | "retracted"): void {
  t.state.dataset.state = st;
  t.card.dataset.state = st;
  t.state.replaceChildren();
  const label = { done: "готово", answering: "отвечаю", error: "ошибка", retracted: "отменено, собеседник продолжил" }[st];
  t.state.append(st === "done" ? icon("check") : el("span", "mark"), label);
}

function show(id: number): void {
  turns.get(shown)?.card.classList.remove("shown");
  shown = id;
  const t = turns.get(id);
  if (!t) return;
  t.card.classList.add("shown");
  if (id !== current) t.card.classList.add("open");
  t.card.scrollIntoView({ block: "nearest" });
  renderNav();
}

const navEl = $("nav");
const navPos = $("nav-pos");
const prevBtn = $<HTMLButtonElement>("btn-prev");
const nextBtn = $<HTMLButtonElement>("btn-next");
const copyBtn = $<HTMLButtonElement>("btn-copy");
const upBtn = $<HTMLButtonElement>("btn-up");
const downBtn = $<HTMLButtonElement>("btn-down");
/** «‹ 3/5 ›»: which answer is on show; the arrows stop at the ends, the counter hides under two answers. */
function renderNav(): void {
  const ids = [...turns.keys()];
  const i = ids.indexOf(shown);
  navEl.hidden = ids.length < 2;
  navPos.textContent = i < 0 ? "" : `${i + 1}/${ids.length}`;
  prevBtn.disabled = i <= 0;
  nextBtn.disabled = i < 0 || i >= ids.length - 1;
  copyBtn.disabled = i < 0;
  const t = turns.get(shown);
  upBtn.disabled = downBtn.disabled = i < 0;
  upBtn.setAttribute("aria-pressed", String(t?.rating === 1));
  downBtn.setAttribute("aria-pressed", String(t?.rating === -1));
}

/** The call open in the core: ratings are saved into it, so without one there is nowhere to keep them. */
let callOpen = false;
void api.calls.current().then((c) => (callOpen = Boolean(c?.dir)));

/** Rates the answer on show; the same rating again clears it. */
function rate(value: 1 | -1): void {
  const t = turns.get(shown);
  if (!t) return;
  if (!callOpen) {
    flash("Оценка сохраняется только в открытом звонке");
    return;
  }
  t.rating = t.rating === value ? null : value;
  api.send({ cmd: "feedback", turn: shown, value: t.rating });
  renderNav();
  flash(t.rating === null ? "Оценка снята" : t.rating === 1 ? "Отмечено: полезно" : "Отмечено: мимо");
}

/** A short note in the state chip, then back to what it said. */
function flash(text: string): void {
  const before = chip.textContent;
  const was = chip.dataset.phase;
  chip.textContent = text;
  setTimeout(() => {
    if (chip.dataset.phase === was && chip.textContent === text) chip.textContent = before;
  }, 1500);
}

/** -1: an older answer, 1: a newer one. Turns are kept in the order they were asked. */
function nav(dir: -1 | 1): void {
  const ids = [...turns.keys()];
  const i = ids.indexOf(shown);
  if (i < 0) return;
  show(ids[Math.min(ids.length - 1, Math.max(0, i + dir))]);
}

function copyShown(): void {
  const t = turns.get(shown);
  const text = t && (t.text.full.trim() || t.text.quick.trim());
  if (!text) return;
  api.copy(text);
  flash("Ответ скопирован");
}

function clearTurns(): void {
  for (const t of turns.values()) t.card.remove();
  turns.clear();
  answers.clear();
  current = -1;
  shown = -1;
  shots.clear();
  setPhase("idle");
  renderNav();
}

// ---------- a long reply of the user's ----------

/** After this long of the user's own reply, a quiet «пора закругляться». */
const LONG_REPLY_MS = 90_000;
/** The user's silence this long ends their reply even if the other side says nothing. */
const REPLY_GAP_MS = 10_000;
const talkEl = $("talk");
/** Start of the user's current reply (their speech since the other side last spoke), and their last sound. */
let replyStart: number | null = null;
let lastMe = 0;

function onSpeech(speaker: "me" | "them", active: boolean): void {
  const now = Date.now();
  if (speaker === "them") {
    if (active) replyStart = null;
  } else {
    if (active && (replyStart === null || now - lastMe > REPLY_GAP_MS)) replyStart = now;
    lastMe = now;
  }
  renderTalk();
}

function renderTalk(): void {
  const now = Date.now();
  if (replyStart !== null && now - lastMe > REPLY_GAP_MS) replyStart = null;
  const ms = replyStart === null ? 0 : now - replyStart;
  talkEl.hidden = ms < LONG_REPLY_MS;
  if (!talkEl.hidden) {
    const s = Math.floor(ms / 1000);
    talkEl.textContent = `Вы говорите ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}, пора закругляться`;
  }
}
setInterval(renderTalk, 1000);

// ---------- events ----------

function renderLatency(): void {
  const min = (p: string) => Math.min(metrics[`${p}_quick`] ?? Infinity, metrics[`${p}_full`] ?? Infinity);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")}\u00a0с`;
  const fromQuestion = min("question_to_first_token");
  const first = min("answer_first_token");
  latencyEl.textContent = Number.isFinite(fromQuestion)
    ? `От конца вопроса до первого слова ${secs(fromQuestion)}`
    : Number.isFinite(first)
      ? `Первое слово через ${secs(first)}`
      : "";
}

const replaying = replayGuard();
/** The quick line, read out once it is complete (the cards themselves are not a live region: they stream). */
const say = $("say");

api.onEvent((e: CoreEvent) => {
  switch (e.ev) {
    case "status": {
      const model = status && status.model !== e.model;
      status = e;
      modelBtn.textContent = modelLabel(e);
      modelBtn.hidden = false;
      if (model) flash(`Модель: ${modelLabel(e)}`);
      else if (phase === "idle") setPhase("idle");
      break;
    }
    case "vad":
      onSpeech(e.speaker, e.active);
      if (e.speaker !== "them") break;
      if (e.active) setPhase("listening");
      else if (phase === "listening") setPhase("recognizing");
      break;
    case "final":
      if (e.speaker !== "them" || phase === "answering") break;
      if (e.question) setPhase("caught", status?.auto ? "" : `Автоответ выключен. Спросить: ${askKey}`);
      else if (phase === "recognizing") setPhase("idle");
      break;
    case "screenshot":
      shots.set(e.turn, { thumb: e.thumb, width: e.width, height: e.height });
      break;
    case "answer_start": {
      if (document.body.classList.contains("replay")) replaying();
      const t = turns.get(e.turn) ?? newTurn(e.turn, e.question, e.trigger);
      const tier = e.tier === "quick" ? "quick" : "full";
      answers.set(e.id, { turn: e.turn, tier });
      t.text[tier] = "";
      t.error[tier] = null;
      schedule(t);
      setTurnState(t, "answering");
      setPhase("answering");
      break;
    }
    case "answer_delta": {
      const a = answers.get(e.id);
      const t = a && turns.get(a.turn);
      if (!a || !t) break;
      t.text[a.tier] += e.text;
      schedule(t);
      break;
    }
    case "answer_end": {
      const a = answers.get(e.id);
      const t = a && turns.get(a.turn);
      answers.delete(e.id);
      if (!a || !t) break;
      // An early answer whose question went on: the card stays, folded, with a note.
      if (e.kind === "retracted") {
        t.card.classList.add("retracted");
        t.card.classList.remove("open");
        setTurnState(t, "retracted");
        if (a.turn === current) setPhase("listening");
        break;
      }
      if (e.error && e.kind !== "cancelled") {
        t.error[a.tier] = { kind: e.kind, raw: e.error };
        schedule(t);
      }
      if (e.feedback) {
        t.rating = e.feedback > 0 ? 1 : -1;
        renderNav();
      }
      if (a.tier === "quick" && !e.error && a.turn === current && !document.body.classList.contains("replay")) say.textContent = t.text.quick;
      // The full answer decides the chip; a cancelled one was replaced by a newer ask.
      if (a.tier === "full" && e.kind !== "cancelled") {
        setTurnState(t, e.error ? "error" : "done");
        if (a.turn === current) setPhase(e.error ? "error" : "done");
      }
      break;
    }
    case "metrics":
      if (e.name.startsWith("answer_first_token_") || e.name.startsWith("question_to_first_token_")) {
        metrics[e.name] = e.ms;
        renderLatency();
      }
      break;
    case "cleared":
      replaying();
      clearTurns();
      break;
    case "call":
      callOpen = Boolean(e.dir);
      break;
    case "error":
      // Claude failing outside an answer (its warm-up): said here, before the first question finds it.
      if (e.kind) setPhase("error", humanError(e.kind), e.message);
      break;
    case "ready":
      if (phase === "error") setPhase("idle");
      break;
    case "core_down":
      status = null;
      setPhase("error", coreDownText(e.message), e.message);
      break;
  }
});

$("btn-help").onclick = () => api.openSettings("guide");
modelBtn.onclick = () => api.send({ cmd: "set", model: "toggle" });
setPhase("idle");
renderNav();
// Ask, screen, continue, questions and the answer arrows run through main, like their hotkeys.
const bound = bindActions();
/** The ask key as the user reads it, for the chip's «Спросить: …». */
let askKey = "";
const refreshKeys = () => {
  bound();
  void api.hotkeys().then((k) => {
    askKey = keyLabel(k.ask);
    moreTip = `Ещё 2–3 предложения к этой подсказке · ${keyLabel(k.moreAnswer)}`;
    for (const b of document.querySelectorAll<HTMLElement>(".turn .more")) b.title = moreTip;
  });
};
refreshKeys();
overlayUi((m) => {
  if (m.kind === "nav") nav(m.dir);
  else if (m.kind === "looking") setPhase("looking");
  else if (m.kind === "asking") {
    setPhase("asking");
    // Nothing to answer (an empty transcript): the chip must not wait forever.
    setTimeout(() => phase === "asking" && setPhase("idle"), 10_000);
  }
  else if (m.kind === "copy") copyShown();
  else if (m.kind === "rate") rate(m.value);
  else if (m.kind === "hotkeys") refreshKeys();
});

// The empty pane says why no hint will come when Claude is not set up.
const showNoClaude = (items: ReadyItem[]) => ($("no-claude").hidden = items.find((i) => i.id === "claude")?.ok !== false);
api.ready.onChange(showNoClaude);
void api.ready.list().then(showNoClaude);
$("btn-ready").onclick = () => api.ready.open();
