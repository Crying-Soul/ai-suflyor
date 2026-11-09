import type { CoreEvent, ReadyItem, Status } from "../shared/protocol";
import { $, api, bindActions, el, icon, keyLabel, modelLabel, overlayUi } from "./common";
import { render } from "./md";

const turnsEl = $("turns");
const chip = $("chip");
const modelBtn = $<HTMLButtonElement>("btn-model");
const latencyEl = $("latency");

let status: Status | null = null;
/** First-token times of the current turn. */
let metrics: Record<string, number> = {};

// ---------- turn state chip: what the assistant is doing right now ----------

type Phase = "idle" | "listening" | "recognizing" | "caught" | "looking" | "answering" | "done" | "error";
const PHASE_TEXT: Record<Phase, string> = {
  idle: "Слушаю",
  listening: "Собеседник говорит…",
  recognizing: "Распознаю…",
  caught: "Вопрос пойман",
  looking: "Смотрю на экран…",
  answering: "Отвечаю…",
  done: "Готово",
  error: "Ошибка",
};

function setPhase(p: Phase, detail = ""): void {
  chip.dataset.phase = p;
  chip.textContent = detail ? `${PHASE_TEXT[p]}. ${detail}` : PHASE_TEXT[p];
}

// ---------- answers: one card per ask, newest on top ----------

interface Turn {
  card: HTMLElement;
  state: HTMLElement;
  quick: HTMLElement;
  full: HTMLElement;
  text: Record<"quick" | "full", string>;
  error: Record<"quick" | "full", string>;
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
let moreTip = "Ещё 2–3 предложения к этому ответу";

/** How the card names its ask: a fixed title for the suggestion kinds, else the question itself. */
const KIND_TITLE: Record<string, string> = { questions: "Что спросить у собеседника", continue: "Как продолжить ваш ответ", more: "Продолжение ответа" };
const TRIGGER_LABEL: Record<string, string> = { auto: "авто", early: "авто", picked: "выбрано", screen: "экран", questions: "мои вопросы", continue: "что сказать", more: "продолжение" };

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
    // The next part of this answer: shown on the current card once it is done (CSS).
    const more = el("button", "more btn-ghost small", "Продолжить ответ");
    more.type = "button";
    more.title = moreTip;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      api.action("moreAnswer");
    });
    card.append(more);
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
  const turn: Turn = { card, state, quick, full, text: { quick: "", full: "" }, error: { quick: "", full: "" } };
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
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    for (const d of dirty) paint(d);
    dirty.clear();
  });
}

/** A failed answer: what happened in words, the raw cause folded away. */
function failure(raw: string): HTMLElement {
  const title = /timed? ?out|timeout/i.test(raw)
    ? "Claude не ответил вовремя"
    : /401|api[_ ]?key|auth|login/i.test(raw)
      ? "Claude не подключён: проверьте ключ или вход"
      : "Claude не ответил";
  const box = el("details", "error");
  box.append(el("summary", "", title), el("p", "", raw));
  return box;
}

function paint(t: Turn): void {
  t.quick.replaceChildren(t.error.quick ? failure(t.error.quick) : t.text.quick);
  t.quick.classList.toggle("error", Boolean(t.error.quick));
  t.full.replaceChildren(render(t.text.full));
  if (t.error.full) t.full.append(failure(t.error.full));
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
/** «‹ 3/5 ›»: which answer is on show; the arrows stop at the ends, the counter hides under two answers. */
function renderNav(): void {
  const ids = [...turns.keys()];
  const i = ids.indexOf(shown);
  navEl.hidden = ids.length < 2;
  navPos.textContent = i < 0 ? "" : `${i + 1}/${ids.length}`;
  prevBtn.disabled = i <= 0;
  nextBtn.disabled = i < 0 || i >= ids.length - 1;
  copyBtn.disabled = i < 0;
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
  const before = chip.textContent;
  const phase = chip.dataset.phase;
  chip.textContent = "Ответ скопирован";
  setTimeout(() => chip.dataset.phase === phase && chip.textContent === "Ответ скопирован" && (chip.textContent = before), 1500);
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

api.onEvent((e: CoreEvent) => {
  switch (e.ev) {
    case "status":
      status = e;
      modelBtn.textContent = modelLabel(e);
      modelBtn.hidden = false;
      break;
    case "vad":
      if (e.speaker !== "them") break;
      if (e.active) setPhase("listening");
      else if (chip.dataset.phase === "listening") setPhase("recognizing");
      break;
    case "final":
      if (e.speaker !== "them" || chip.dataset.phase === "answering") break;
      if (e.question) setPhase("caught", status?.auto ? "" : "Автоответ выключен, нажмите «Спросить»");
      else if (chip.dataset.phase === "recognizing") setPhase("idle");
      break;
    case "screenshot":
      shots.set(e.turn, { thumb: e.thumb, width: e.width, height: e.height });
      break;
    case "answer_start": {
      const t = turns.get(e.turn) ?? newTurn(e.turn, e.question, e.trigger);
      answers.set(e.id, { turn: e.turn, tier: e.tier });
      t.text[e.tier] = "";
      t.error[e.tier] = "";
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
      if (e.error === "retracted") {
        t.card.classList.add("retracted");
        t.card.classList.remove("open");
        setTurnState(t, "retracted");
        if (a.turn === current) setPhase("listening");
        break;
      }
      if (e.error && e.error !== "cancelled") {
        t.error[a.tier] = e.error;
        schedule(t);
      }
      // The full answer decides the chip; a cancelled one was replaced by a newer ask.
      if (a.tier === "full" && e.error !== "cancelled") {
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
      clearTurns();
      break;
    case "core_down":
      setPhase("error", e.message);
      break;
  }
});

$("btn-help").onclick = () => api.openSettings("guide");
modelBtn.onclick = () => api.send({ cmd: "set", model: "toggle" });
$("btn-hide").onclick = () => api.hide();
setPhase("idle");
renderNav();
// Ask, screen, continue, questions and the answer arrows run through main, like their hotkeys.
const bound = bindActions();
const refreshKeys = () => {
  bound();
  void api.hotkeys().then((k) => {
    moreTip = `Ещё 2–3 предложения к этому ответу · ${keyLabel(k.moreAnswer)}`;
    document.querySelectorAll<HTMLElement>(".turn .more").forEach((b) => (b.title = moreTip));
  });
};
refreshKeys();
overlayUi((m) => {
  if (m.kind === "nav") nav(m.dir);
  else if (m.kind === "looking") setPhase("looking");
  else if (m.kind === "copy") copyShown();
  else if (m.kind === "hotkeys") refreshKeys();
});

// The empty pane says why no hint will come when Claude is not set up.
const showNoClaude = (items: ReadyItem[]) => ($("no-claude").hidden = items.find((i) => i.id === "claude")?.ok !== false);
api.ready.onChange(showNoClaude);
void api.ready.list().then(showNoClaude);
$("btn-ready").onclick = () => api.ready.open();
