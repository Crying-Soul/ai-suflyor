// What the app needs before a call, checked on startup and after every change that can fix it.
// Pure: index.ts gathers the facts, this file turns them into the «Готовность» list.
import type { ReadyItem, Status } from "../shared/protocol";

export interface Facts {
  coreError: string | null;
  modelExists: boolean;
  backend: "api" | "claude-code";
  apiKey: boolean;
  claudeCodeOk: boolean;
  nvidia: boolean;
  cudaInstalled: boolean;
  status: Status | null;
  translate: boolean;
  mtInstalled: boolean;
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
  const claudeOk = f.backend === "api" ? f.apiKey : f.claudeCodeOk;
  items.push({
    id: "claude",
    level: "required",
    ok: claudeOk,
    title: "Подключение к Claude",
    why: "Claude пишет подсказки. Нужен ключ API Anthropic или установленный Claude Code с подпиской.",
    problem: claudeOk ? undefined : f.backend === "api" ? "Ключ API не задан." : "Команда claude не найдена или не вошли в аккаунт.",
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
  if (f.translate) {
    items.push({
      id: "mt",
      level: "optional",
      ok: f.mtInstalled,
      title: "Модель перевода",
      why: "Перевод английской речи собеседника на русский. Нужна только для собеседований на английском.",
    });
  }
  return items;
}

/** The first required item that blocks work: what the transcript's strip names. */
export const blocking = (items: ReadyItem[]) => items.find((i) => i.level === "required" && !i.ok);
