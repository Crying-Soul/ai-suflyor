import type { CaptureStatus, CoreEvent, RendererApi, Speaker, Status } from "../shared/protocol";

declare global {
  interface Window {
    api: RendererApi;
  }
}

const api = window.api;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const transcriptEl = $("transcript");
const quickEl = $("answer-quick");
const answerEl = $("answer");
const answerMeta = $("answer-meta");
const statusEl = $("status");
const autoBtn = $<HTMLButtonElement>("btn-auto");
const modelBtn = $<HTMLButtonElement>("btn-model");
const meters: Record<Speaker, HTMLElement> = { me: $("meter-me"), them: $("meter-them") };
const sources: Record<Speaker, HTMLElement> = { me: $("src-me"), them: $("src-them") };
const labels: Record<Speaker, HTMLElement> = { me: $("lbl-me"), them: $("lbl-them") };

let status: Status | null = null;
/** Answer ids per tier currently shown. */
const shown = { quick: -1, full: -1 };

// ---------- transcript ----------

function segEl(speaker: Speaker, seg: number): HTMLElement {
  const id = `seg-${speaker}-${seg}`;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = `seg ${speaker}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = speaker === "me" ? "Я" : "Они";
    const text = document.createElement("span");
    text.className = "text";
    el.append(who, text);
    transcriptEl.append(el);
  }
  return el;
}

function setSegText(speaker: Speaker, seg: number, text: string, partial: boolean): void {
  const el = segEl(speaker, seg);
  if (!text && !partial) {
    el.remove(); // the core dropped this utterance (noise, echo)
    return;
  }
  el.classList.toggle("partial", partial);
  el.querySelector(".text")!.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---------- status ----------

function renderCapture(speaker: Speaker, c: CaptureStatus): void {
  const el = sources[speaker];
  el.textContent = c.state === "error" ? `⚠ ${c.error ?? c.source}` : c.source || "…";
  el.classList.toggle("error", c.state === "error");
  el.title = c.error ?? c.source;
}

function renderStatus(s: Status): void {
  status = s;
  autoBtn.setAttribute("aria-checked", String(s.auto));
  modelBtn.textContent = s.model.replace(/^claude-/, "");
  renderCapture("me", s.me);
  renderCapture("them", s.them);
  const parts = [`stt ${s.stt}`, `${s.answer_mode} mode`];
  if (s.busy) parts.push("thinking…");
  if (s.recording_dir) parts.push("recording WAV");
  statusEl.textContent = parts.join(", ");
  statusEl.classList.remove("error");
}

function setMeter(speaker: Speaker, peak: number): void {
  // dBFS-ish scale: -60 dB .. 0 dB -> 0..100 %.
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meters[speaker].style.transform = `scaleX(${pct / 100})`;
}

// ---------- metrics ----------

const metrics: Record<string, number> = {};
const metricsEl = $("metrics");

function renderMetrics(): void {
  const f = (k: string) => (metrics[k] !== undefined ? `${metrics[k].toFixed(0)}` : "–");
  metricsEl.textContent = `Decode ${f("stt_decode")} ms, end of speech to text ${f("speech_end_to_final")} ms`;
}

// ---------- events ----------

function onEvent(e: CoreEvent): void {
  switch (e.ev) {
    case "ready":
      statusEl.textContent = `core ${e.version} ready`;
      break;
    case "status":
      renderStatus(e);
      break;
    case "level":
      setMeter(e.speaker, e.peak);
      break;
    case "vad":
      labels[e.speaker].classList.toggle("speaking", e.active);
      break;
    case "partial":
      setSegText(e.speaker, e.seg, e.text, true);
      break;
    case "final":
      setSegText(e.speaker, e.seg, e.text, false);
      break;
    case "answer_start": {
      shown[e.tier] = e.id;
      const el = e.tier === "quick" ? quickEl : answerEl;
      el.textContent = "";
      el.classList.remove("error");
      if (e.tier === "full") answerMeta.textContent = e.question ? `${e.trigger}: «${e.question}»` : e.trigger;
      break;
    }
    case "answer_delta": {
      const el = e.id === shown.quick ? quickEl : e.id === shown.full ? answerEl : null;
      if (!el) break;
      el.textContent += e.text;
      el.scrollTop = el.scrollHeight;
      break;
    }
    case "answer_end":
      if (e.error && e.error !== "cancelled" && (e.id === shown.full || e.id === shown.quick)) {
        answerEl.classList.add("error");
        answerEl.textContent += `\n\nError: ${e.error}`;
      }
      break;
    case "metrics":
      metrics[e.name] = e.ms;
      if (e.name === "speech_end_to_final" || e.name === "stt_decode") renderMetrics();
      break;
    case "error":
    case "core_down":
      statusEl.textContent = `⚠ ${e.message}`;
      statusEl.classList.add("error");
      break;
  }
}

api.onEvent(onEvent);

$("btn-ask").onclick = () => api.send({ cmd: "ask", screenshot: false });
$("btn-shot").onclick = () => api.send({ cmd: "ask", screenshot: true });
autoBtn.onclick = () => api.send({ cmd: "set", auto: !(status?.auto ?? true) });
modelBtn.onclick = () => api.send({ cmd: "set", model: "toggle" });
$("btn-clear").onclick = () => {
  api.send({ cmd: "clear" });
  transcriptEl.querySelectorAll(".seg").forEach((el) => el.remove());
  quickEl.textContent = "";
  answerEl.textContent = "";
  answerMeta.textContent = "";
};
$("btn-hide").onclick = () => api.hide();
$("btn-settings").onclick = () => api.openSettings();
