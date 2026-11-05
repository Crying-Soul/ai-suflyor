import type { CaptureStatus, CoreEvent, Speaker, Status } from "../shared/protocol";
import { $, api, el, follow, sttLabel } from "./common";

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

function row(speaker: Speaker, t: number): HTMLElement | null {
  const key = `${speaker}-${t}`;
  if (dropped.has(key)) return null;
  let r = rows.get(key);
  if (r) return r;
  r = el("div", `row ${speaker} live`);
  r.dataset.t = String(t);
  const text = el("p", "text");
  text.append(el("span", "stable"), el("span", "tail"));
  r.append(el("span", "who", WHO[speaker]), text);
  if (speaker === "them") {
    const ask = el("button", "ask btn-ghost", "Спросить");
    ask.type = "button";
    ask.title = "Ответить на эту реплику";
    ask.onclick = () => {
      const q = r!.querySelector(".text")!.textContent!.trim();
      if (!q) return;
      r!.classList.add("asked");
      api.send({ cmd: "ask", screenshot: false, question: q });
    };
    r.append(ask);
  }
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
  r.classList.remove("live", "partial", "waiting");
  r.classList.toggle("question", question);
  setText(r, text, "");
  scrolled();
}

/** Marks the "them" rows a question was taken from: the run that starts at `qt`. */
function markAsked(qt: number): void {
  let r = rows.get(`them-${qt}`) as Element | null | undefined;
  while (r && r.classList.contains("them")) {
    r.classList.add("asked");
    r = r.nextElementSibling;
  }
}

function clearRows(): void {
  for (const r of rows.values()) r.remove();
  rows.clear();
  dropped.clear();
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
  const parts = [sttLabel(s.stt)];
  if (s.recording_dir) parts.push("запись WAV");
  statusEl.textContent = parts.join(" · ");
  statusEl.classList.toggle("error", s.stt.startsWith("error"));
}

function setMeter(speaker: Speaker, peak: number): void {
  // -60 dBFS .. 0 dBFS -> 0..1
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  meters[speaker].style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60))})`;
}

const metrics: Record<string, number> = {};
function renderMetrics(): void {
  const f = (k: string) => (metrics[k] !== undefined ? `${metrics[k].toFixed(0)} мс` : "–");
  metricsEl.textContent = `конец фразы → текст ${f("speech_end_to_final")} · декод ${f("stt_decode")}`;
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
      if (r && !e.active && r.classList.contains("live")) r.classList.add("waiting");
      break;
    }
    case "partial": {
      const r = row(e.speaker, e.t);
      if (!r) break;
      r.classList.remove("live", "waiting");
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
