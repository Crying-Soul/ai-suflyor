import type { CoreEvent, Status } from "../shared/protocol";
import { $, api, el, icon, modelLabel } from "./common";
import { render } from "./md";

const turnsEl = $("turns");
const chip = $("chip");
const modelBtn = $<HTMLButtonElement>("btn-model");
const latencyEl = $("latency");

let status: Status | null = null;
/** First-token times of the current turn. */
let metrics: Record<string, number> = {};

// ---------- turn state chip: what the assistant is doing right now ----------

type Phase = "idle" | "listening" | "recognizing" | "caught" | "answering" | "done" | "error";
const PHASE_TEXT: Record<Phase, string> = {
  idle: "Слушаю",
  listening: "Собеседник говорит…",
  recognizing: "Распознаю…",
  caught: "Вопрос пойман",
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
/** Answer id -> its turn and tier. */
const answers = new Map<number, { turn: number; tier: "quick" | "full" }>();
let current = -1;
const HISTORY_LIMIT = 50;

function newTurn(id: number, question: string, trigger: string): Turn {
  const prev = turns.get(current);
  prev?.card.classList.remove("current");
  const card = el("article", "turn current");
  const head = el("header", "q");
  const state = el("span", "state-word");
  head.append(
    el("span", "qtext", question ? `«${question}»` : "Без вопроса: подсказка по разговору"),
    el("span", "trigger", trigger === "auto" ? "авто" : trigger === "picked" ? "выбрано" : "вручную"),
    state,
  );
  const quick = el("p", "quick");
  const full = el("div", "full md");
  card.append(head, quick, full);
  card.tabIndex = 0;
  card.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === card) {
      e.preventDefault();
      card.click();
    }
  });
  // Older cards collapse to the question and the quick line; a click opens the full answer.
  card.addEventListener("click", (e) => {
    if (card.classList.contains("current") || (e.target as Element).closest("pre, code")) return;
    card.classList.toggle("open");
  });
  turnsEl.prepend(card);
  const turn: Turn = { card, state, quick, full, text: { quick: "", full: "" }, error: { quick: "", full: "" } };
  turns.set(id, turn);
  current = id;
  metrics = {};
  latencyEl.textContent = "";
  while (turns.size > HISTORY_LIMIT) {
    const [oldest, t] = turns.entries().next().value!;
    t.card.remove();
    turns.delete(oldest);
  }
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

function paint(t: Turn): void {
  t.quick.textContent = t.error.quick ? `Ошибка: ${t.error.quick}` : t.text.quick;
  t.quick.classList.toggle("error", Boolean(t.error.quick));
  t.full.replaceChildren(render(t.text.full));
  if (t.error.full) t.full.append(el("p", "error", `Ошибка: ${t.error.full}`));
}

/** The pane's own status: answering (open, apricot), done (periwinkle check) or failed. */
function setTurnState(t: Turn, st: "answering" | "done" | "error"): void {
  t.state.dataset.state = st;
  t.state.replaceChildren();
  t.state.append(st === "done" ? icon("check") : el("span", "mark"), st === "done" ? "готово" : st === "answering" ? "отвечаю" : "ошибка");
}

function clearTurns(): void {
  for (const t of turns.values()) t.card.remove();
  turns.clear();
  answers.clear();
  current = -1;
  setPhase("idle");
}

// ---------- events ----------

function renderLatency(): void {
  const first = Math.min(metrics.answer_first_token_quick ?? Infinity, metrics.answer_first_token_full ?? Infinity);
  latencyEl.textContent = Number.isFinite(first) ? `Первое слово через ${(first / 1000).toFixed(1).replace(".", ",")}\u00a0с` : "";
}

api.onEvent((e: CoreEvent) => {
  switch (e.ev) {
    case "status":
      status = e;
      modelBtn.textContent = modelLabel(e);
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
      if (e.name.startsWith("answer_first_token_")) {
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

$("btn-ask").onclick = () => api.send({ cmd: "ask", screenshot: false });
$("btn-shot").onclick = () => api.send({ cmd: "ask", screenshot: true });
modelBtn.onclick = () => api.send({ cmd: "set", model: "toggle" });
$("btn-hide").onclick = () => api.hide();
setPhase("idle");
