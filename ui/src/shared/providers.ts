// Model providers for the `openai` backend (any OpenAI-compatible Chat Completions API). The core keeps
// the endpoints and per-provider request quirks (core/suflyor-core/src/llm/openai.rs, same ids); this
// list is what the settings show: names, model suggestions, where to get a key.

export interface Provider {
  id: string;
  label: string;
  /** Suggested [model, second model, quick model]; any other id can be typed. */
  models: [full: string, alt: string, quick: string];
  /** More ids for the drop-down. */
  more?: string[];
  /** Where the key is created; absent for local servers. */
  keyUrl?: string;
  /** Shown under the provider field. */
  hint: string;
  /** Runs on this computer: no key, no bill. */
  local?: boolean;
}

export const PROVIDERS: Provider[] = [
  {
    id: "openai",
    label: "OpenAI (GPT)",
    models: ["gpt-5", "gpt-5", "gpt-4.1-mini"],
    more: ["gpt-5-mini", "gpt-5-nano", "gpt-4.1"],
    keyUrl: "https://platform.openai.com/api-keys",
    hint: "Ключ на platform.openai.com → API keys. Подписка ChatGPT Plus сюда не подходит: API оплачивается отдельно.",
  },
  {
    id: "openrouter",
    label: "OpenRouter (Claude, GPT, Gemini, DeepSeek… одним ключом)",
    models: ["anthropic/claude-sonnet-5.5", "openai/gpt-5", "anthropic/claude-haiku-5.5"],
    more: ["google/gemini-2.5-flash", "deepseek/deepseek-chat", "qwen/qwen3-max", "moonshotai/kimi-k2", "z-ai/glm-4.6"],
    keyUrl: "https://openrouter.ai/keys",
    hint: "Один ключ на сотни моделей, цена хода приходит от OpenRouter. Названия моделей: openrouter.ai/models.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-chat"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    hint: "deepseek-chat отвечает без рассуждений и быстрее. Снимки экрана DeepSeek не читает.",
  },
  {
    id: "qwen",
    label: "Qwen (Alibaba Cloud)",
    models: ["qwen-plus", "qwen3-max", "qwen-flash"],
    more: ["qwen-vl-max"],
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    hint: "Ключ DashScope (Model Studio). Для материкового Китая укажите адрес https://dashscope.aliyuncs.com/compatible-mode/v1.",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot AI)",
    models: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    hint: "Ключ на platform.moonshot.ai. Для platform.moonshot.cn укажите адрес https://api.moonshot.cn/v1.",
  },
  {
    id: "glm",
    label: "GLM (Z.ai / Zhipu)",
    models: ["glm-4.6", "glm-4.6", "glm-4.5-air"],
    more: ["glm-4.5v"],
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    hint: "Ключ Z.ai. Для open.bigmodel.cn укажите адрес https://open.bigmodel.cn/api/paas/v4.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    models: ["gemini-2.5-pro", "gemini-2.5-pro", "gemini-2.5-flash"],
    more: ["gemini-2.5-flash-lite"],
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Ключ из Google AI Studio.",
  },
  {
    id: "yandex",
    label: "YandexGPT (Yandex Cloud)",
    models: ["gpt://<folder_id>/yandexgpt/latest", "gpt://<folder_id>/yandexgpt/latest", "gpt://<folder_id>/yandexgpt-lite/latest"],
    keyUrl: "https://console.yandex.cloud/",
    hint: "API-ключ сервисного аккаунта с ролью ai.languageModels.user. В названии модели замените <folder_id> на идентификатор каталога. Снимки экрана не читает.",
  },
  {
    id: "gigachat",
    label: "GigaChat (Сбер)",
    models: ["GigaChat-2-Max", "GigaChat-2-Pro", "GigaChat-2"],
    keyUrl: "https://developers.sber.ru/studio/",
    hint: "Ключ авторизации (Authorization key) из личного кабинета, физлица. Windows должна доверять сертификату «Russian Trusted Root CA» (Госуслуги → сертификаты Минцифры). Снимки экрана не читает.",
  },
  {
    id: "ollama",
    label: "Ollama (локально)",
    models: ["qwen3:14b", "qwen3:14b", "qwen3:4b"],
    more: ["gemma3:12b", "llama3.1:8b", "mistral-small3.2"],
    hint: "Модель на этом компьютере, без ключа и оплаты. Скачайте её заранее: ollama pull qwen3:14b. Скорость зависит от видеокарты: Whisper занимает её же.",
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio (локально)",
    models: ["qwen3-14b", "qwen3-14b", "qwen3-4b"],
    hint: "Включите сервер в LM Studio (Developer → Start server) и загрузите модель. Ключ не нужен.",
    local: true,
  },
  {
    id: "custom",
    label: "Другой OpenAI-совместимый",
    models: ["", "", ""],
    hint: "Любой сервис с /chat/completions: укажите адрес (до /v1) и ключ. Например xAI, Mistral, vLLM, LiteLLM.",
  },
];

export const CLAUDE_MODELS: [string, string][] = [
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

export const provider = (id: string): Provider => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/** Model ids to suggest for a backend and provider. */
export function modelChoices(backend: string, providerId: string): string[] {
  if (backend !== "openai") return CLAUDE_MODELS.map(([id]) => id);
  const p = provider(providerId);
  return [...new Set([...p.models, ...(p.more ?? [])].filter(Boolean))];
}

/** The [model, alt, quick] a backend starts with. */
export function defaultModels(backend: string, providerId: string): [string, string, string] {
  return backend === "openai" ? provider(providerId).models : ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
}
