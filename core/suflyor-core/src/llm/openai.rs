//! OpenAI-compatible Chat Completions over raw HTTP + SSE: GPT, OpenRouter, DeepSeek, Qwen, Kimi, GLM,
//! YandexGPT, GigaChat, Gemini, and local Ollama or LM Studio. One session type; what differs between
//! providers (endpoint, auth, how to turn thinking off, usage fields) is in `PROVIDERS` and `extras`.
//! History is append-only, like the Anthropic session: providers with automatic prefix caching
//! (OpenAI, DeepSeek, Qwen, Kimi, GLM) read the system prompt and earlier turns from their cache.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use protocol::ErrorKind;
use serde_json::{Value, json};
use tracing::{info, warn};

use super::api::{CLIENT, post};
use super::{Chunk, Turn};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Auth {
    /// `Authorization: Bearer <key>`.
    Bearer,
    /// GigaChat: the key is an authorization key traded for a 30-minute access token.
    GigaChat,
    /// Local servers: no key at all.
    None,
}

pub struct Provider {
    pub id: &'static str,
    pub base_url: &'static str,
    pub auth: Auth,
    /// Takes images inline (`image_url` data URLs). A model that does not is found out at the first
    /// screenshot: the request is sent again without it.
    pub vision: bool,
}

/// The presets the settings offer (`ui/src/shared/providers.ts` lists the same ids with labels and models).
pub const PROVIDERS: &[Provider] = &[
    Provider { id: "openai", base_url: "https://api.openai.com/v1", auth: Auth::Bearer, vision: true },
    Provider { id: "openrouter", base_url: "https://openrouter.ai/api/v1", auth: Auth::Bearer, vision: true },
    Provider { id: "deepseek", base_url: "https://api.deepseek.com", auth: Auth::Bearer, vision: false },
    Provider { id: "qwen", base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", auth: Auth::Bearer, vision: true },
    Provider { id: "kimi", base_url: "https://api.moonshot.ai/v1", auth: Auth::Bearer, vision: true },
    Provider { id: "glm", base_url: "https://api.z.ai/api/paas/v4", auth: Auth::Bearer, vision: true },
    Provider { id: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", auth: Auth::Bearer, vision: true },
    Provider { id: "yandex", base_url: "https://llm.api.cloud.yandex.net/v1", auth: Auth::Bearer, vision: false },
    // shortcut: images would need GigaChat's file upload; screenshots go as text only until someone asks.
    Provider { id: "gigachat", base_url: "https://gigachat.devices.sberbank.ru/api/v1", auth: Auth::GigaChat, vision: false },
    Provider { id: "ollama", base_url: "http://localhost:11434/v1", auth: Auth::None, vision: true },
    Provider { id: "lmstudio", base_url: "http://localhost:1234/v1", auth: Auth::None, vision: true },
    Provider { id: "custom", base_url: "", auth: Auth::Bearer, vision: true },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// One message of the history; images stay apart so they can be dropped for a model without vision.
struct Msg {
    assistant: bool,
    text: String,
    image: Option<Arc<Vec<u8>>>,
}

pub struct OpenAiSession {
    provider: &'static Provider,
    url: String,
    key: String,
    system: String,
    effort: String,
    max_tokens: u32,
    history: Vec<Msg>,
    fresh: bool,
    vision: bool,
}

impl OpenAiSession {
    /// `base_url` empty: the provider's own. An unknown provider id works as "custom".
    pub fn new(provider_id: &str, base_url: &str, key: String, system: String, effort: String, max_tokens: u32) -> OpenAiSession {
        let provider = provider(provider_id).unwrap_or_else(|| provider("custom").expect("custom preset"));
        let base = if base_url.trim().is_empty() { provider.base_url } else { base_url.trim() };
        let url = format!("{}/chat/completions", base.trim_end_matches('/'));
        OpenAiSession { provider, url, key, system, effort, max_tokens, history: Vec::new(), fresh: true, vision: provider.vision }
    }

    pub fn prepare(&mut self) -> bool {
        std::mem::take(&mut self.fresh)
    }

    pub fn set_system(&mut self, system: String) {
        self.system = system;
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.fresh = true;
    }

    /// Billed per token: everything but a local server.
    pub fn is_api(&self) -> bool {
        self.provider.auth != Auth::None
    }

    fn messages(&self) -> Vec<Value> {
        let mut out = vec![json!({"role": "system", "content": self.system})];
        for m in &self.history {
            let content = match (&m.image, self.vision) {
                (Some(img), true) => {
                    use base64::Engine as _;
                    let url = format!("data:{};base64,{}", crate::screen::MEDIA_TYPE, base64::engine::general_purpose::STANDARD.encode(img.as_slice()));
                    json!([{"type": "image_url", "image_url": {"url": url}}, {"type": "text", "text": m.text}])
                }
                (Some(_), false) => json!(format!(
                    "{}\n<screen>The screenshot could not be attached: this model does not read images. Answer from the transcript.</screen>",
                    m.text
                )),
                (None, _) => json!(m.text),
            };
            out.push(json!({"role": if m.assistant { "assistant" } else { "user" }, "content": content}));
        }
        out
    }

    fn body(&self, model: &str) -> Value {
        let mut b = json!({"model": model, "stream": true, "messages": self.messages()});
        // OpenAI's reasoning models reject `max_tokens`; the others know only it.
        let limit = if self.provider.id == "openai" { "max_completion_tokens" } else { "max_tokens" };
        b[limit] = json!(self.max_tokens);
        // Usage in the last chunk; GigaChat and Yandex send theirs unasked and may reject the option.
        if !matches!(self.provider.id, "gigachat" | "yandex") {
            b["stream_options"] = json!({"include_usage": true});
        }
        if let Some(Value::Object(extra)) = extras(self.provider.id, model, &self.effort) {
            b.as_object_mut().expect("object").extend(extra);
        }
        b
    }

    async fn authorization(&self) -> Result<Option<String>> {
        match self.provider.auth {
            Auth::None if self.key.is_empty() => Ok(None),
            Auth::None | Auth::Bearer => Ok(Some(format!("Bearer {}", self.key))),
            Auth::GigaChat => Ok(Some(format!("Bearer {}", gigachat_token(&self.key).await?))),
        }
    }

    /// Opens the pooled connection (and fetches a GigaChat token) ahead of the first question. Prefix
    /// caches fill on the first real turn: there is no explicit cache write to make.
    pub async fn warm(&self) -> Result<()> {
        if self.needs_key() && self.key.is_empty() {
            return Ok(());
        }
        if self.provider.auth == Auth::GigaChat {
            gigachat_token(&self.key).await?;
        }
        let _ = CLIENT.head(&self.url).send().await;
        Ok(())
    }

    fn needs_key(&self) -> bool {
        self.provider.auth != Auth::None
    }

    pub async fn ask(&mut self, model: &str, turn: &Turn, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        if self.needs_key() && self.key.is_empty() {
            return Err(super::fail(ErrorKind::Auth, "no API key for the model provider: set it in Settings → Ответы"));
        }
        if model.trim().is_empty() {
            return Err(super::fail(ErrorKind::Other, "no model name: set it in Settings → Ответы"));
        }
        // The user turn stays in history even if the answer fails, like the Anthropic session.
        self.history.push(Msg { assistant: false, text: turn.text.clone(), image: turn.image.clone() });
        let auth = self.authorization().await?;
        let resp = match self.send(model, auth.as_deref()).await {
            // A model without vision: once told, every later turn goes without images.
            Err(e) if self.vision && turn.image.is_some() && is_bad_request(&e) => {
                warn!("{}: request with an image refused ({e:#}), sending it without", self.provider.id);
                self.vision = false;
                self.send(model, auth.as_deref()).await?
            }
            r => r?,
        };
        let answer = read_stream(resp.bytes_stream(), out).await?;
        if !answer.is_empty() {
            self.history.push(Msg { assistant: true, text: answer, image: None });
        }
        Ok(())
    }

    async fn send(&self, model: &str, auth: Option<&str>) -> Result<reqwest::Response> {
        let body = self.body(model);
        post(
            || {
                let req = CLIENT.post(&self.url).json(&body);
                match auth {
                    Some(a) => req.header("authorization", a),
                    None => req,
                }
            },
            self.provider.id,
        )
        .await
    }
}

fn is_bad_request(e: &anyhow::Error) -> bool {
    e.downcast_ref::<super::api::HttpError>().is_some_and(|h| h.status == 400 || h.status == 422)
}

/// Per-provider fields that keep answers fast: thinking off or low where the API has a switch.
fn extras(provider: &str, model: &str, effort: &str) -> Option<Value> {
    match provider {
        // Only the reasoning families take `reasoning_effort`; older chat models reject it.
        "openai" if model.starts_with("gpt-5") || model.starts_with('o') => Some(json!({"reasoning_effort": effort})),
        // Normalised across its models; price of the turn in the usage chunk.
        "openrouter" => Some(json!({"reasoning": {"effort": effort}, "usage": {"include": true}})),
        "qwen" => Some(json!({"enable_thinking": false})),
        "glm" => Some(json!({"thinking": {"type": "disabled"}})),
        "gemini" => Some(json!({"reasoning_effort": effort})),
        _ => None,
    }
}

/// Token counts of the usage chunk; providers name the cached part differently.
fn usage_chunk(u: &Value) -> Chunk {
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    let prompt = n(&u["prompt_tokens"]);
    let cached = [&u["prompt_tokens_details"]["cached_tokens"], &u["prompt_cache_hit_tokens"], &u["precached_prompt_tokens"]]
        .into_iter()
        .map(n)
        .max()
        .unwrap_or(0)
        .min(prompt);
    Chunk::Usage { input: prompt - cached, cache_read: cached, cache_write: 0, output: n(&u["completion_tokens"]), usd: u["cost"].as_f64() }
}

/// Drops a leading `<think>…</think>` block: local reasoning models (Qwen3, DeepSeek-R1 on Ollama or
/// LM Studio) may write their thinking into the answer text.
#[derive(Default)]
struct ThinkFilter {
    buf: String,
    /// Past the point where a think block could start: text passes through.
    open: bool,
}

impl ThinkFilter {
    const START: &str = "<think>";
    const END: &str = "</think>";

    fn push(&mut self, t: &str) -> String {
        if self.open {
            return t.to_string();
        }
        self.buf.push_str(t);
        let head = self.buf.trim_start();
        if head.starts_with(Self::START) {
            let Some(end) = head.find(Self::END) else { return String::new() };
            let rest = head[end + Self::END.len()..].trim_start().to_string();
            self.open = true;
            self.buf.clear();
            return rest;
        }
        if Self::START.starts_with(head) {
            return String::new();
        }
        self.open = true;
        std::mem::take(&mut self.buf)
    }

    /// At the end: a cut-short prefix like "<th" is text; an unclosed think block is dropped.
    fn finish(&mut self) -> String {
        let head = self.buf.trim_start();
        if self.open || head.starts_with(Self::START) { String::new() } else { std::mem::take(&mut self.buf) }
    }
}

/// Reads a Chat Completions SSE stream, passing text and usage to `out`; returns the whole text.
async fn read_stream<B: AsRef<[u8]>, E: std::error::Error + Send + Sync + 'static>(
    stream: impl futures_util::Stream<Item = std::result::Result<B, E>> + Unpin,
    out: &mut (dyn FnMut(Chunk) + Send),
) -> Result<String> {
    let mut events = stream.eventsource();
    let mut answer = String::new();
    let mut think = ThinkFilter::default();
    let mut usage = None;
    let mut finish: Option<String> = None;
    let mut done = false;
    let mut emit = |t: String, answer: &mut String| {
        if !t.is_empty() {
            answer.push_str(&t);
            out(Chunk::Text(t));
        }
    };
    while let Some(event) = events.next().await {
        let event = event?;
        if event.data.trim() == "[DONE]" {
            done = true;
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(&event.data) else { continue };
        if v["error"].is_object() {
            let e = super::api::http_error(500, &event.data);
            let kind = if e.quota { ErrorKind::Quota } else { ErrorKind::Overloaded };
            return Err(super::fail(kind, format!("stream error: {}", e.message)));
        }
        if v["usage"].is_object() {
            usage = Some(usage_chunk(&v["usage"]));
        }
        let choice = &v["choices"][0];
        // Thinking (`reasoning_content`, `reasoning`) is never shown: only the answer.
        if let Some(t) = choice["delta"]["content"].as_str() {
            emit(think.push(t), &mut answer);
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            finish = Some(f.to_string());
        }
    }
    emit(think.finish(), &mut answer);
    if let Some(u) = usage {
        out(u);
    }
    // A connection cut mid-answer: neither [DONE] nor a finish reason.
    if !done && finish.is_none() {
        return Err(super::fail(ErrorKind::Network, "the answer stream was cut off"));
    }
    match finish.as_deref() {
        Some("content_filter") => Err(super::fail(ErrorKind::Refused, "the model's content filter blocked the answer")),
        Some("length") if answer.trim().is_empty() => {
            Err(super::fail(ErrorKind::Other, "the model spent the whole token limit thinking: pick a model without reasoning or a lower effort"))
        }
        _ => Ok(answer),
    }
}

/// A GigaChat access token for `key`, fetched once per 30 minutes and shared by every session.
async fn gigachat_token(key: &str) -> Result<String> {
    static TOKEN: Mutex<Option<(String, String, u64)>> = Mutex::new(None);
    let now_ms = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    if let Some((k, token, expires)) = TOKEN.lock().unwrap().as_ref()
        && k == key
        && *expires > now_ms() + 60_000
    {
        return Ok(token.clone());
    }
    let resp = post(
        || {
            CLIENT
                .post("https://ngw.devices.sberbank.ru:9443/api/v2/oauth")
                .header("authorization", format!("Basic {key}"))
                .header("rquid", request_id())
                .header("content-type", "application/x-www-form-urlencoded")
                .header("accept", "application/json")
                .timeout(Duration::from_secs(15))
                // shortcut: personal scope only; business accounts (GIGACHAT_API_B2B / _CORP) need a setting.
                .body("scope=GIGACHAT_API_PERS")
        },
        "gigachat oauth",
    )
    .await?;
    let v: Value = resp.json().await?;
    let token = v["access_token"].as_str().ok_or_else(|| super::fail(ErrorKind::Auth, "GigaChat returned no access token"))?.to_string();
    let expires = v["expires_at"].as_u64().unwrap_or_else(|| now_ms() + 25 * 60_000);
    info!("gigachat: access token until {expires}");
    *TOKEN.lock().unwrap() = Some((key.to_string(), token.clone(), expires));
    Ok(token)
}

/// A random UUID v4 string (GigaChat's `RqUID`), from the std hasher's random keys: no extra crate.
fn request_id() -> String {
    use std::hash::{BuildHasher, RandomState};
    let a = RandomState::new().hash_one(1u8);
    let b = RandomState::new().hash_one(2u8);
    let hex = format!("{a:016x}{b:016x}");
    format!("{}-{}-4{}-a{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings offer what `PROVIDERS` knows: an id on one side only would be sent as "custom" or never shown.
    #[test]
    fn ui_lists_the_same_providers() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/shared/providers.ts");
        let ts = std::fs::read_to_string(file).unwrap();
        let ui: Vec<&str> = ts.lines().filter_map(|l| l.trim().strip_prefix("id: \"")?.split('"').next()).collect();
        assert_eq!(ui, PROVIDERS.iter().map(|p| p.id).collect::<Vec<_>>());
    }

    async fn read(parts: &[&str]) -> (Result<String>, Vec<(u64, u64, u64, Option<f64>)>) {
        let chunks: Vec<std::result::Result<Vec<u8>, std::io::Error>> = parts.iter().map(|p| Ok(p.as_bytes().to_vec())).collect();
        let mut usage = vec![];
        let r = read_stream(futures_util::stream::iter(chunks), &mut |c| {
            if let Chunk::Usage { input, cache_read, output, usd, .. } = c {
                usage.push((input, cache_read, output, usd));
            }
        })
        .await;
        (r, usage)
    }

    fn delta(t: &str) -> String {
        format!("data: {}\n\n", json!({"choices": [{"delta": {"content": t}}]}))
    }

    #[tokio::test]
    async fn stream_text_usage_and_end() {
        let usage = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":60},\"cost\":0.0012}}\n\n";
        let (r, u) =
            read(&[&delta("При"), &delta("вет"), "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", usage, "data: [DONE]\n\n"]).await;
        assert_eq!(r.unwrap(), "Привет");
        assert_eq!(u, vec![(40, 60, 7, Some(0.0012))]);
        // DeepSeek names the cached part its own way.
        let ds = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1,\"prompt_cache_hit_tokens\":8}}\n\n";
        assert_eq!(read(&[ds, "data: [DONE]\n\n"]).await.1, vec![(2, 8, 1, None)]);
    }

    #[tokio::test]
    async fn cut_filtered_and_errors() {
        assert_eq!(error_kind(read(&[&delta("a")]).await.0), ErrorKind::Network, "no [DONE], no finish reason");
        let filtered = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n";
        assert_eq!(error_kind(read(&[filtered]).await.0), ErrorKind::Refused);
        let length = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"},\"finish_reason\":\"length\"}]}\n\n";
        assert!(read(&[length]).await.0.unwrap_err().to_string().contains("token limit"));
        let quota = "data: {\"error\":{\"message\":\"no money\",\"code\":\"insufficient_quota\"}}\n\n";
        assert_eq!(error_kind(read(&[quota]).await.0), ErrorKind::Quota);
    }

    fn error_kind(r: Result<String>) -> ErrorKind {
        super::super::error_kind(&r.unwrap_err())
    }

    #[test]
    fn think_blocks_are_dropped() {
        let run = |parts: &[&str]| {
            let mut f = ThinkFilter::default();
            let mut s: String = parts.iter().map(|p| f.push(p)).collect();
            s.push_str(&f.finish());
            s
        };
        assert_eq!(run(&["<th", "ink>plan", "…</thi", "nk>\n\nОтвет", " тут"]), "Ответ тут");
        assert_eq!(run(&["Обычный ", "<think> внутри"]), "Обычный <think> внутри");
        assert_eq!(run(&["<th"]), "<th", "a cut-short prefix is text");
        assert_eq!(run(&["<think>never closed"]), "");
    }

    #[test]
    fn body_per_provider() {
        let s = |p: &str| OpenAiSession::new(p, "", "k".into(), "sys".into(), "low".into(), 100);
        let b = s("openai").body("gpt-5.2");
        assert_eq!((b["max_completion_tokens"].as_u64(), b["reasoning_effort"].as_str()), (Some(100), Some("low")));
        assert_eq!(b["messages"][0], json!({"role": "system", "content": "sys"}));
        assert!(s("openai").body("gpt-4.1").get("reasoning_effort").is_none());
        let b = s("qwen").body("qwen-plus");
        assert_eq!((b["max_tokens"].as_u64(), b["enable_thinking"].as_bool()), (Some(100), Some(false)));
        assert!(s("gigachat").body("GigaChat-2-Max").get("stream_options").is_none());
        assert_eq!(s("glm").body("glm-4.6")["thinking"]["type"], "disabled");
        assert_eq!(s("ollama").url, "http://localhost:11434/v1/chat/completions");
        assert_eq!(
            OpenAiSession::new("custom", "https://x.test/v1/", String::new(), String::new(), String::new(), 1).url,
            "https://x.test/v1/chat/completions"
        );
        assert!(!s("lmstudio").is_api() && s("deepseek").is_api());
    }

    #[test]
    fn images_inline_or_as_a_note() {
        let mut s = OpenAiSession::new("openai", "", "k".into(), "sys".into(), "low".into(), 100);
        s.history.push(Msg { assistant: false, text: "q".into(), image: Some(Arc::new(vec![1, 2, 3])) });
        let m = s.messages();
        assert_eq!(m[1]["content"][0]["image_url"]["url"].as_str(), Some(format!("data:{};base64,AQID", crate::screen::MEDIA_TYPE).as_str()));
        s.vision = false;
        assert!(s.messages()[1]["content"].as_str().unwrap().starts_with("q\n<screen>The screenshot could not be attached"));
        let id = request_id();
        assert_eq!((id.len(), &id[14..15], id.matches('-').count()), (36, "4", 4));
    }

    /// A local server that answers each request with the next of `replies` (status, body).
    async fn server(replies: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, body) in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 65536];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                    if n == 0 || buf.len() >= end + 4 + len {
                        log.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
                        break;
                    }
                }
                let kind = if status == 200 { "text/event-stream" } else { "application/json" };
                let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
        });
        (base, seen)
    }

    #[tokio::test]
    async fn a_model_without_vision_gets_the_turn_again_without_the_image() {
        let ok = format!("{}data: [DONE]\n\n", delta("ok"));
        let (base, seen) = server(vec![(400, "{\"error\":{\"message\":\"image input not supported\"}}".into()), (200, ok)]).await;
        let mut s = OpenAiSession::new("custom", &base, "k".into(), "sys".into(), "low".into(), 100);
        let turn = Turn { text: "q".into(), image: Some(Arc::new(vec![1])) };
        let mut text = String::new();
        s.ask("m", &turn, &mut |c| {
            if let Chunk::Text(t) = c {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!((text.as_str(), seen.len(), s.history.len()), ("ok", 2, 2));
        assert!(seen[0].contains("image_url") && !seen[1].contains("image_url"));
        assert!(seen[1].to_lowercase().contains("authorization: bearer k"));
    }

    #[tokio::test]
    async fn no_key_or_model_fails_before_a_request() {
        let mut s = OpenAiSession::new("deepseek", "http://127.0.0.1:9", String::new(), String::new(), String::new(), 1);
        assert_eq!(super::super::error_kind(&s.ask("m", &Turn::text("q"), &mut |_| {}).await.unwrap_err()), ErrorKind::Auth);
        s.key = "k".into();
        assert!(s.ask(" ", &Turn::text("q"), &mut |_| {}).await.is_err());
        assert!(s.history.is_empty());
    }
}

#[cfg(test)]
mod ui_tests {
    /// The settings offer `ui/src/shared/providers.ts`; an id the core does not know would fall back to
    /// "custom" with no endpoint.
    #[test]
    fn every_provider_of_the_settings_is_known() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/shared/providers.ts");
        let ts = std::fs::read_to_string(path).unwrap();
        let ids: Vec<&str> = ts.split("id: \"").skip(1).filter_map(|s| s.split('"').next()).collect();
        assert!(ids.len() >= 10, "{ids:?}");
        for id in ids {
            assert!(super::provider(id).is_some(), "providers.ts has `{id}`, the core does not");
        }
    }
}
