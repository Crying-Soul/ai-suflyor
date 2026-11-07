import type { CaptureStatus, CoreEvent, ReadyItem, Speaker, Status } from "../shared/protocol";
import { $, api, el, follow, icon, overlayUi, sttLabel } from "./common";

const list = $("transcript");
const statusEl = $("status");
const autoBtn = $<HTMLButtonElement>("btn-auto");
const translateBtn = $<HTMLButtonElement>("btn-translate");
const metricsEl = $("metrics");
const meters: Record<Speaker, HTMLElement> = { me: $("meter-me"), them: $("meter-them") };
const sources: Record<Speaker, HTMLElement> = { me: $("src-me"), them: $("src-them") };
const labels: Record<Speaker, HTMLElement> = { me: $("lbl-me"), them: $("lbl-them") };
const WHO: Record<Speaker, string> = { me: "Я", them: "Собеседник" };

let status: Status | null = null;
const scrolled = follow(list, $("jump"));

// ---------- blocks: a speaker's consecutive utterances as one paragraph ----------

/** Utterance key `speaker-t` -> its inline segment in a block. */
const segs = new Map<string, HTMLElement>();
/** Utterances the core dropped: late partials for them must not bring the segment back. */
const dropped = new Set<string>();
/** A same-speaker utterance starting this long after the block's last one opens a new block (utterances are capped at 20 s). */
const BLOCK_GAP_MS = 30_000;
const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** Text of a block's question to ask about: its last unanswered question, else the whole block. */
function askBlock(b: HTMLElement): void {
  const all = [...b.querySelectorAll<HTMLElement>(".seg")];
  const open = all.filter((g) => g.classList.contains("q") && !g.dataset.asked);
  const pick = open.length ? open.slice(-1) : all;
  const q = pick.map((g) => g.textContent!.trim()).join(" ").trim();
  if (!q) return;
  pick.forEach(setAsked);
  hideOwed();
  api.send({ cmd: "ask", screenshot: false, question: q });
}

function setAsked(g: HTMLElement): void {
  if (g.dataset.asked) return;
  g.dataset.asked = "1";
  if (g.classList.contains("q")) g.append(icon("check"));
}

function newBlock(speaker: Speaker, t: number): HTMLElement {
  const b = el("div", `block ${speaker}`);
  const head = el("div", "bh");
  head.append(el("span", "who", WHO[speaker]), el("span", "time num", clock.format(t)));
  if (speaker === "them") {
    const ask = el("button", "ask btn-ghost small", "Спросить");
    ask.type = "button";
    ask.title = "Ответить на эту реплику";
    ask.onclick = () => askBlock(b);
    head.append(ask);
  }
  b.append(head, el("p", "text"));
  list.append(b);
  return b;
}

/** The utterance's segment, created on its first words: appended to the speaker's open block or a new one. */
function seg(speaker: Speaker, t: number): HTMLElement | null {
  const key = `${speaker}-${t}`;
  if (dropped.has(key)) return null;
  let g = segs.get(key);
  if (g) return g;
  g = el("span", "seg");
  g.dataset.t = String(t);
  g.append(el("span", "stable"), el("span", "tail"));
  // Appended in arrival order, never inserted above: overlapping speech must not shift what is being read.
  const last = list.lastElementChild as HTMLElement | null;
  const lastT = Number(last?.querySelector<HTMLElement>(".seg:last-child")?.dataset.t ?? -Infinity);
  const b = last?.classList.contains(speaker) && t - lastT <= BLOCK_GAP_MS ? last : newBlock(speaker, t);
  b.querySelector(".text")!.append(g);
  segs.set(key, g);
  return g;
}

function setText(g: HTMLElement, stable: string, tail: string): void {
  g.querySelector(".stable")!.textContent = stable;
  g.querySelector(".tail")!.textContent = tail && stable ? ` ${tail}` : tail;
}

function onFinal(speaker: Speaker, t: number, text: string, question: boolean): void {
  const key = `${speaker}-${t}`;
  live.done(speaker, t);
  if (!text) {
    const g = segs.get(key);
    const b = g?.closest(".block");
    g?.remove();
    if (b && !b.querySelector(".seg")) b.remove();
    segs.delete(key);
    dropped.add(key);
    return;
  }
  const g = seg(speaker, t)!;
  g.classList.remove("partial");
  g.classList.toggle("q", question);
  setText(g, text, "");
  if (g.dataset.asked && question && !g.querySelector(".icon")) g.append(icon("check"));
  scrolled();
  if (question && !g.dataset.asked) owe(g, text);
  else if (speaker === "me") hideOwed(); // the user answered it themselves
}

/** A translation goes under the block of its first utterance, one span per piece, in arrival order. */
function onTranslation(ts: number[], text: string): void {
  const b = ts.map((t) => segs.get(`them-${t}`)?.closest<HTMLElement>(".block")).find(Boolean);
  if (!b) return;
  let tr = b.querySelector<HTMLElement>(".tr");
  if (!tr) {
    tr = el("p", "tr");
    tr.lang = document.documentElement.lang;
    b.append(tr);
  }
  tr.append(el("span", "", text));
  scrolled();
}

/** Marks the "them" segments a question was taken from: the run that starts at `qt`, to its block's end. */
function markAsked(qt: number): void {
  let g = segs.get(`them-${qt}`) as HTMLElement | null | undefined;
  while (g) {
    setAsked(g);
    if (g === owedSeg) hideOwed();
    g = g.nextElementSibling as HTMLElement | null;
  }
}

// ---------- the live line: who is talking right now, in a fixed slot under the list ----------

const live = (() => {
  const line = $("live");
  const word = $("live-word");
  const speaking: Record<Speaker, boolean> = { me: false, them: false };
  /** Utterances whose speech ended and whose final text has not arrived yet. */
  const waiting = new Set<string>();
  const render = () => {
    const text = speaking.me && speaking.them ? "Оба говорят…" : speaking.them ? "Собеседник говорит…" : speaking.me ? "Вы говорите…" : waiting.size ? "Распознаю…" : "";
    if (text) word.textContent = text;
    line.classList.toggle("on", Boolean(text));
    line.dataset.who = speaking.them ? "them" : speaking.me ? "me" : "";
  };
  return {
    vad(speaker: Speaker, t: number, active: boolean) {
      speaking[speaker] = active;
      if (!active) waiting.add(`${speaker}-${t}`);
      render();
    },
    done(speaker: Speaker, t: number) {
      waiting.delete(`${speaker}-${t}`);
      render();
    },
    clear() {
      waiting.clear();
      render();
    },
  };
})();

// ---------- the owed question: a caught question nobody asked about yet ----------

const owedEl = $("owed");
let owedSeg: HTMLElement | null = null;
let owedTimer: number | undefined;
/** With auto-answer on, the answer usually starts within half a second; the strip waits longer than that. */
const OWED_AFTER_MS = 1500;

function owe(g: HTMLElement, text: string): void {
  hideOwed();
  owedSeg = g;
  owedTimer = window.setTimeout(() => {
    if (owedSeg !== g || g.dataset.asked) return;
    $("owed-text").textContent = `«${text}»`;
    owedEl.hidden = false;
  }, OWED_AFTER_MS);
}

function hideOwed(): void {
  clearTimeout(owedTimer);
  owedSeg = null;
  owedEl.hidden = true;
}

$("btn-owed").onclick = () => {
  const g = owedSeg;
  if (!g) return;
  setAsked(g);
  hideOwed();
  api.send({ cmd: "ask", screenshot: false, question: g.textContent!.trim() });
};

function clearRows(): void {
  list.querySelectorAll(".block").forEach((b) => b.remove());
  segs.clear();
  dropped.clear();
  live.clear();
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
  translateBtn.setAttribute("aria-checked", String(s.translate));
  renderCapture("me", s.me);
  renderCapture("them", s.them);
  statusEl.textContent = s.recording_dir ? `${sttLabel(s.stt)}, пишу WAV` : sttLabel(s.stt);
  statusEl.classList.toggle("error", s.stt.startsWith("error"));
  statusEl.title = s.stt.startsWith("error") ? s.stt.slice(6).trim() : "";
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
    case "vad":
      labels[e.speaker].classList.toggle("speaking", e.active);
      // The live line shows speech at once: the user sees that nothing was missed, and the list stays still.
      live.vad(e.speaker, e.t, e.active);
      break;
    case "partial": {
      const g = seg(e.speaker, e.t);
      if (!g) break;
      g.classList.add("partial");
      setText(g, e.stable, e.tail);
      scrolled();
      break;
    }
    case "final":
      onFinal(e.speaker, e.t, e.text, e.question);
      break;
    case "translation":
      onTranslation(e.ts, e.text);
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
    case "call": {
      const chip = $("btn-call");
      chip.textContent = e.dir ? e.title : "Без звонка";
      chip.classList.toggle("live", Boolean(e.dir));
      chip.classList.toggle("warn", e.warnings.length > 0);
      const where = e.dir ? `${e.folder ? `${e.folder}: ` : ""}${e.title}\n` : "";
      chip.title = [`${where}Контекст ≈${e.tokens.toLocaleString("ru-RU")} токенов. Открыть «Звонки»`, ...e.warnings].join("\n");
      break;
    }
    case "error":
    case "core_down":
      statusEl.textContent = "ядро остановлено";
      statusEl.title = e.message;
      statusEl.classList.add("error");
      break;
  }
});

const SETUP: Record<ReadyItem["id"], string> = {
  core: "ядро не запустилось",
  whisper: "нет модели распознавания",
  claude: "Claude не подключён",
  audio: "нет звука",
  cuda: "нет CUDA",
  mt: "нет модели перевода",
};

// While something required is missing: one line naming it, and the way to the fix.
function renderSetup(items: ReadyItem[]): void {
  const missing = items.filter((i) => i.level === "required" && !i.ok);
  $("setup").hidden = !missing.length;
  $("setup-text").textContent = missing.length ? `Не всё готово: ${missing.map((i) => SETUP[i.id]).join(", ")}.` : "";
}
$("btn-setup").onclick = () => api.ready.open();
api.ready.onChange(renderSetup);
void api.ready.list().then(renderSetup);

autoBtn.onclick = () => api.send({ cmd: "set", auto: !(status?.auto ?? true) });
translateBtn.onclick = () => api.send({ cmd: "set", translate: !(status?.translate ?? false) });
$("btn-help").onclick = () => api.openSettings("guide");
$("btn-clear").onclick = () => api.send({ cmd: "clear" });
$("btn-hide").onclick = () => api.hide();
$("btn-settings").onclick = () => api.openSettings();
$("btn-call").onclick = () => api.openCalls();
overlayUi();
