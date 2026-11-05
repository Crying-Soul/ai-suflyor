import type { CaptureStatus, CoreEvent, Speaker, Status } from "../shared/protocol";
import { $, api, el, follow, icon, sttLabel } from "./common";

const list = $("transcript");
const statusEl = $("status");
const autoBtn = $<HTMLButtonElement>("btn-auto");
const metricsEl = $("metrics");
const meters: Record<Speaker, HTMLElement> = { me: $("meter-me"), them: $("meter-them") };
const sources: Record<Speaker, HTMLElement> = { me: $("src-me"), them: $("src-them") };
const labels: Record<Speaker, HTMLElement> = { me: $("lbl-me"), them: $("lbl-them") };
const WHO: Record<Speaker, string> = { me: "Я", them: "Собеседник" };

let status: Status | null = null;
const scrolled = follow(list, $("jump"));

// ---------- rows: one per utterance, keyed by speaker + start time ----------

const rows = new Map<string, HTMLElement>();
/** Utterances the core dropped: late partials for them must not bring the row back. */
const dropped = new Set<string>();

/** The row's state word on the right: what happens to this utterance now. */
type RowState = "live" | "waiting" | "question" | "asked" | "";
const STATE_WORD: Record<RowState, string> = { live: "говорит", waiting: "распознаю", question: "вопрос", asked: "отвечено", "": "" };

function setState(r: HTMLElement, st: RowState): void {
  r.dataset.state = st;
  const word = r.querySelector<HTMLElement>(".state-word")!;
  word.replaceChildren();
  if (st === "asked") word.append(icon("check"));
  else if (st) word.append(el("span", "mark"));
  if (st) word.append(STATE_WORD[st]);
}

function askAbout(r: HTMLElement): void {
  const q = r.querySelector(".text")!.textContent!.trim();
  if (!q) return;
  setState(r, "asked");
  hideOwed();
  api.send({ cmd: "ask", screenshot: false, question: q });
}

function row(speaker: Speaker, t: number): HTMLElement | null {
  const key = `${speaker}-${t}`;
  if (dropped.has(key)) return null;
  let r = rows.get(key);
  if (r) return r;
  r = el("div", `row ${speaker}`);
  r.dataset.t = String(t);
  const who = el("span", "who");
  who.title = WHO[speaker];
  who.append(el("span", "initial", WHO[speaker][0]), el("span", "visually-hidden", WHO[speaker]));
  const text = el("p", "text");
  text.append(el("span", "stable"), el("span", "tail"));
  const side = el("div", "side");
  side.append(el("span", "state-word"));
  if (speaker === "them") {
    const ask = el("button", "ask btn-ghost small", "Спросить");
    ask.type = "button";
    ask.title = "Ответить на эту реплику";
    const self = r;
    ask.onclick = () => askAbout(self);
    side.append(ask);
  }
  r.append(who, text, side);
  setState(r, "live");
  // Rows are chronological; the two speakers' events interleave, so insert by start time.
  let next: Element | null = null;
  for (let o = list.lastElementChild as HTMLElement | null; o?.classList.contains("row") && Number(o.dataset.t) > t; o = o.previousElementSibling as HTMLElement | null) {
    next = o;
  }
  list.insertBefore(r, next);
  rows.set(key, r);
  scrolled();
  return r;
}

function setText(r: HTMLElement, stable: string, tail: string): void {
  r.querySelector(".stable")!.textContent = stable;
  r.querySelector(".tail")!.textContent = tail && stable ? ` ${tail}` : tail;
}

function onFinal(speaker: Speaker, t: number, text: string, question: boolean): void {
  const key = `${speaker}-${t}`;
  if (!text) {
    rows.get(key)?.remove();
    rows.delete(key);
    dropped.add(key);
    return;
  }
  const r = row(speaker, t)!;
  r.classList.remove("partial");
  if (r.dataset.state !== "asked") setState(r, question ? "question" : "");
  setText(r, text, "");
  scrolled();
  if (question) owe(r, text);
  else if (speaker === "me") hideOwed(); // the user answered it themselves
}

/** Marks the "them" rows a question was taken from: the run that starts at `qt`. */
function markAsked(qt: number): void {
  let r = rows.get(`them-${qt}`) as HTMLElement | null | undefined;
  while (r?.classList.contains("them")) {
    setState(r, "asked");
    if (r === owedRow) hideOwed();
    r = r.nextElementSibling as HTMLElement | null;
  }
}

// ---------- the owed question: a caught question nobody asked about yet ----------

const owedEl = $("owed");
let owedRow: HTMLElement | null = null;
let owedTimer: number | undefined;
/** With auto-answer on, the answer usually starts within half a second; the strip waits longer than that. */
const OWED_AFTER_MS = 1500;

function owe(r: HTMLElement, text: string): void {
  hideOwed();
  owedRow = r;
  owedTimer = window.setTimeout(() => {
    if (owedRow !== r || r.dataset.state !== "question") return;
    $("owed-text").textContent = `«${text}»`;
    owedEl.hidden = false;
  }, OWED_AFTER_MS);
}

function hideOwed(): void {
  clearTimeout(owedTimer);
  owedRow = null;
  owedEl.hidden = true;
}

$("btn-owed").onclick = () => owedRow && askAbout(owedRow);

function clearRows(): void {
  for (const r of rows.values()) r.remove();
  rows.clear();
  dropped.clear();
  hideOwed();
}

// ---------- status ----------

function renderCapture(speaker: Speaker, c: CaptureStatus): void {
  const e = sources[speaker];
  e.textContent = c.state === "error" ? `⚠ ${c.error ?? c.source}` : c.source || "…";
  e.classList.toggle("error", c.state === "error");
  e.title = c.error ?? c.source;
}

function renderStatus(s: Status): void {
  status = s;
  autoBtn.setAttribute("aria-checked", String(s.auto));
  renderCapture("me", s.me);
  renderCapture("them", s.them);
  statusEl.textContent = s.recording_dir ? `${sttLabel(s.stt)}, пишу WAV` : sttLabel(s.stt);
  statusEl.classList.toggle("error", s.stt.startsWith("error"));
}

function setMeter(speaker: Speaker, peak: number): void {
  // -60 dBFS .. 0 dBFS -> 0..1
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  meters[speaker].style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60))})`;
}

const metrics: Record<string, number> = {};
function renderMetrics(): void {
  const { speech_end_to_final: e2f, stt_decode: dec } = metrics;
  // Both arrive with every final; until the pair is in, show nothing rather than half a sentence.
  if (e2f === undefined || dec === undefined) return;
  metricsEl.textContent = `Текст за ${e2f.toFixed(0)}\u00a0мс, декод ${dec.toFixed(0)}\u00a0мс`;
  metricsEl.title = `Текст пришёл через ${e2f.toFixed(0)}\u00a0мс после конца фразы, распознавание заняло ${dec.toFixed(0)}\u00a0мс`;
}

// ---------- events ----------

api.onEvent((e: CoreEvent) => {
  switch (e.ev) {
    case "ready":
      statusEl.textContent = "ядро запущено";
      statusEl.classList.remove("error");
      break;
    case "status":
      renderStatus(e);
      break;
    case "level":
      setMeter(e.speaker, e.peak);
      break;
    case "vad": {
      labels[e.speaker].classList.toggle("speaking", e.active);
      // The row appears the moment speech starts: the user sees at once that nothing was missed.
      const r = row(e.speaker, e.t);
      if (r && !e.active && r.dataset.state === "live") setState(r, "waiting");
      break;
    }
    case "partial": {
      const r = row(e.speaker, e.t);
      if (!r) break;
      if (r.dataset.state === "live" || r.dataset.state === "waiting") setState(r, "");
      r.classList.add("partial");
      setText(r, e.stable, e.tail);
      scrolled();
      break;
    }
    case "final":
      onFinal(e.speaker, e.t, e.text, e.question);
      break;
    case "answer_start":
      if (e.q_t !== undefined) markAsked(e.q_t);
      break;
    case "metrics":
      metrics[e.name] = e.ms;
      if (e.name === "speech_end_to_final" || e.name === "stt_decode") renderMetrics();
      break;
    case "cleared":
      clearRows();
      break;
    case "error":
    case "core_down":
      statusEl.textContent = `⚠ ${e.message}`;
      statusEl.classList.add("error");
      break;
  }
});

autoBtn.onclick = () => api.send({ cmd: "set", auto: !(status?.auto ?? true) });
$("btn-clear").onclick = () => api.send({ cmd: "clear" });
$("btn-hide").onclick = () => api.hide();
$("btn-settings").onclick = () => api.openSettings();
