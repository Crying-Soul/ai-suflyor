// What the app needs before a call, checked on startup and after every change that can fix it.
// Pure: index.ts gathers the facts, this file turns them into the «Готовность» list.
import type { ReadyItem, Status } from "../shared/protocol";

export interface Facts {
  coreError: string | null;
  modelExists: boolean;
  backend: "api" | "claude-code" | "openai";
  apiKey: boolean;
  /** openai backend: a key is set, or the provider runs locally and needs none. */
  llmReady: boolean;
  claudeCodeOk: boolean;
  nvidia: boolean;
  cudaInstalled: boolean;
  status: Status | null;
}

/** The whisper model to offer: the q8 Turbo is as accurate in half the memory; small is the one that keeps up on a CPU. */
export const recommendedModel = (nvidia: boolean) => (nvidia ? "large-v3-turbo-q8_0" : "small");

export function check(f: Facts): ReadyItem[] {
  const items: ReadyItem[] = [];
  if (f.coreError) {
    items.push({ id: "core", level: "required", ok: false, title: "Ядро не запустилось", why: "Без него не работают звук, распознавание и подсказки.", problem: f.coreError });
  }
  items.push({
    id: "whisper",
    level: "required",
    ok: f.modelExists,
    title: "Модель распознавания речи",
    why: "Whisper превращает речь в текст прямо на этом компьютере. Скачивается один раз.",
    model: recommendedModel(f.nvidia),
  });
  if (f.nvidia) {
    items.push({
      id: "cuda",
      level: "recommended",
      ok: f.cudaInstalled,
      title: "Ускорение на видеокарте NVIDIA",
      why: "Текст появляется в несколько раз быстрее. Без него Whisper работает на процессоре.",
    });
  }
  const claudeOk = { api: f.apiKey, "claude-code": f.claudeCodeOk, openai: f.llmReady }[f.backend];
  const problem = { api: "Ключ API не задан.", "claude-code": "Команда claude не найдена или не вошли в аккаунт.", openai: "Ключ API провайдера не задан." }[f.backend];
  items.push({
    id: "claude",
    level: "required",
    ok: claudeOk,
    title: "Подключение к модели",
    why: "Языковая модель пишет подсказки. Подойдёт Claude (ключ API или подписка через Claude Code), GPT, DeepSeek, Qwen, GigaChat, YandexGPT или локальная модель в Ollama.",
    problem: claudeOk ? undefined : problem,
    backend: f.backend,
  });
  const failed = (["me", "them"] as const).filter((s) => f.status?.[s].state === "error");
  if (f.status) {
    items.push({
      id: "audio",
      level: "required",
      ok: !failed.length,
      title: "Микрофон и звук собеседника",
      why: "Приложение слушает ваш микрофон и звук звонка из колонок или наушников.",
      problem: failed.map((s) => `${s === "me" ? "Микрофон" : "Звук собеседника"}: ${f.status![s].error ?? "недоступен"}`).join(" ") || undefined,
    });
  }
  return items;
}

/** The first required item that blocks work: what the transcript's strip names. */
/** [model, quick model] for Ollama from what `ollama list` has: the suggested ones first, else the first installed. */
export function ollamaModels(installed: string[]): [string, string] | null {
  const has = (m: string) => installed.find((i) => i === m || i === `${m}:latest`);
  const model = has("qwen3:14b") ?? has("gemma3:12b") ?? installed[0];
  return model ? [model, has("qwen3:4b") ?? model] : null;
}

export const blocking = (items: ReadyItem[]) => items.find((i) => i.level === "required" && !i.ok);
