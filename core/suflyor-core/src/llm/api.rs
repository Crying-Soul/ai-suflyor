//! Messages API over raw HTTP + SSE (no official Rust SDK). Append-only history, so every
//! request reads the previous prefix from the prompt cache.

use std::sync::LazyLock;
use std::time::Duration;

use anyhow::Result;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use protocol::ErrorKind;
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::{info, warn};

use super::{Chunk, StreamEvent, Turn, Usage};

const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

/// One client for every session: quick, full, translation and one-off turns share its pooled HTTP/2
/// connection. Keep-alive pings hold it open while idle, so a question after a quiet minute does not
/// pay for a new TCP and TLS handshake.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(None)
        .tcp_keepalive(Duration::from_secs(30))
        .http2_keep_alive_interval(Duration::from_secs(20))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .build()
        .expect("reqwest client")
});

/// Retries wait at most this long: in a live call a late answer is worth little.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(2);

/// A non-success HTTP answer of the API.
#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}: {}", self.status, self.message)
    }
}

impl std::error::Error for HttpError {}

pub struct ApiSession {
    key: String,
    system: String,
    effort: String,
    max_tokens: u32,
    messages: Vec<Value>,
    fresh: bool,
    /// `MESSAGES_URL`; tests point it at a local server.
    url: String,
}

impl ApiSession {
    pub fn new(key: String, system: String, effort: String, max_tokens: u32) -> ApiSession {
        ApiSession { key, system, effort, max_tokens, messages: Vec::new(), fresh: true, url: MESSAGES_URL.into() }
    }

    pub fn prepare(&mut self) -> bool {
        std::mem::take(&mut self.fresh)
    }

    pub fn set_system(&mut self, system: String) {
        self.system = system;
    }

    pub fn reset(&mut self) {
        self.messages.clear();
        self.fresh = true;
    }

    fn body(&self, model: &str, messages: &[Value], max_tokens: u32, stream: bool) -> Value {
        let mut b = json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": stream,
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            "messages": messages,
            // Automatic breakpoint on the last block: the history prefix is cached between turns.
            "cache_control": {"type": "ephemeral"},
            "output_config": {"effort": self.effort},
        });
        // Thinking off where the model allows it: latency matters more than depth here.
        if model.starts_with("claude-sonnet-5-5") {
            b["thinking"] = json!({"type": "between_tools"});
        } else if model.starts_with("claude-haiku") {
            b["thinking"] = json!({"type": "disabled"});
        }
        if fallback_supported(model) {
            b["fallbacks"] = json!("default");
        }
        b
    }

    /// Opens the pooled connection ahead of the first question; with `cache`, also writes the system
    /// prompt to the prompt cache (a one-token turn), so the first answer of a call reads it instead.
    pub async fn warm(&self, model: &str, cache: bool, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        if self.key.is_empty() {
            return Ok(());
        }
        if !cache {
            // Any answer will do: the point is the handshake.
            let _ = CLIENT.head("https://api.anthropic.com/").send().await;
            return Ok(());
        }
        let started = std::time::Instant::now();
        let body = self.body(model, &[json!({"role": "user", "content": "OK"})], 1, false);
        let reply: Value = self.send(model, &body).await?.json().await?;
        let usage: Usage = serde_json::from_value(reply["usage"].clone()).unwrap_or_default();
        info!("prompt cache warmed in {} ms: write {}, read {}", started.elapsed().as_millis(), usage.cache_write(), usage.cache_read());
        out(usage.chunk());
        Ok(())
    }

    /// POST with up to two retries on 429, 5xx and connection failures, honouring a short `retry-after`.
    async fn send(&self, model: &str, body: &Value) -> Result<reqwest::Response> {
        let mut attempt = 0u32;
        loop {
            let mut req = CLIENT.post(&self.url).header("x-api-key", &self.key).header("anthropic-version", "2023-06-01").json(body);
            if fallback_supported(model) {
                req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            attempt += 1;
            let backoff = Duration::from_millis(400 * attempt as u64);
            match req.send().await {
                Ok(r) if r.status().is_success() => return Ok(r),
                Ok(r) => {
                    let status = r.status();
                    let wait = retry_after(r.headers()).unwrap_or(backoff);
                    let message = error_message(&r.text().await.unwrap_or_default());
                    let retry = status.as_u16() == 429 || status.is_server_error();
                    if !retry || attempt > 2 || wait > MAX_RETRY_WAIT {
                        return Err(HttpError { status: status.as_u16(), message }.into());
                    }
                    warn!("claude api HTTP {status}, retrying in {} ms", wait.as_millis());
                    tokio::time::sleep(wait).await;
                }
                Err(e) if attempt <= 2 && (e.is_connect() || e.is_timeout()) => {
                    warn!("claude api: {e}, retrying");
                    tokio::time::sleep(backoff).await;
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    pub async fn ask(&mut self, model: &str, turn: &Turn, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        if self.key.is_empty() {
            return Err(super::fail(ErrorKind::Auth, "no Anthropic API key: set it in «Проверка готовности», or switch to the Claude Code connection"));
        }
        // The user turn stays in history even if the answer fails: consecutive user turns are merged by the API.
        self.messages.push(json!({"role": "user", "content": turn.content()}));
        let body = self.body(model, &self.messages, self.max_tokens, true);
        let resp = self.send(model, &body).await?;
        let answer = read_stream(resp.bytes_stream(), out).await?;
        if !answer.is_empty() {
            self.messages.push(json!({"role": "assistant", "content": [{"type": "text", "text": answer}]}));
        }
        Ok(())
    }
}

/// `retry-after` in seconds (the API sends whole seconds).
fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    h.get("retry-after")?.to_str().ok()?.trim().parse::<f64>().ok().map(Duration::from_secs_f64)
}

/// Reads an SSE answer stream, passing text deltas and usage to `out`; returns the whole text.
async fn read_stream<B: AsRef<[u8]>, E: std::error::Error + Send + Sync + 'static>(
    stream: impl futures_util::Stream<Item = std::result::Result<B, E>> + Unpin,
    out: &mut (dyn FnMut(Chunk) + Send),
) -> Result<String> {
    let mut events = stream.eventsource();
    let mut answer = String::new();
    let mut usage = Usage::default();
    let mut stop_reason = None;
    let mut stopped = false;
    while let Some(event) = events.next().await {
        let event = event?;
        let Ok(ev) = serde_json::from_str::<StreamEvent>(&event.data) else { continue };
        match ev {
            StreamEvent::MessageStart { message } => usage = message.usage,
            StreamEvent::ContentBlockDelta { delta } => {
                if let Some(t) = delta.text() {
                    answer.push_str(t);
                    out(Chunk::Text(t.to_string()));
                }
            }
            StreamEvent::MessageDelta { delta, usage: u } => {
                stop_reason = delta.stop_reason;
                if let Some(o) = u.and_then(|u| u.output_tokens) {
                    usage.output_tokens = Some(o);
                }
            }
            StreamEvent::MessageStop => {
                stopped = true;
                break;
            }
            StreamEvent::Error { error } => return Err(super::fail(error.error_kind(), format!("stream error: {}", error.message))),
            StreamEvent::Other => {}
        }
    }
    out(usage.chunk());
    // A connection cut mid-answer ends the stream without message_stop: not a finished answer.
    if !stopped {
        return Err(super::fail(ErrorKind::Network, "the answer stream was cut off"));
    }
    if stop_reason.as_deref() == Some("refusal") {
        return Err(super::fail(ErrorKind::Refused, "Claude declined to answer this request"));
    }
    Ok(answer)
}

fn fallback_supported(model: &str) -> bool {
    model.starts_with("claude-sonnet-5-5") || model.starts_with("claude-opus-5-5")
}

fn error_message(body: &str) -> String {
    #[derive(Deserialize)]
    struct Body {
        error: super::ErrorBody,
    }
    serde_json::from_str::<Body>(body).map(|b| b.error.message).unwrap_or_else(|_| body.chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read(parts: &[&str]) -> Result<String> {
        let chunks: Vec<std::result::Result<Vec<u8>, std::io::Error>> = parts.iter().map(|p| Ok(p.as_bytes().to_vec())).collect();
        read_stream(futures_util::stream::iter(chunks), &mut |_| {}).await
    }

    #[tokio::test]
    async fn cut_stream_is_an_error() {
        let delta = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Лёгкий\"}}\n\n";
        let stop = "data: {\"type\":\"message_stop\"}\n\n";
        assert_eq!(read(&[delta, stop]).await.unwrap(), "Лёгкий");
        assert!(read(&[delta]).await.is_err(), "no message_stop: the connection was cut");
    }

    #[tokio::test]
    async fn events_split_across_chunks_and_crlf() {
        let parts = [
            "event: content_block_delta\r\ndata: {\"type\":\"content_block_del",
            "ta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\r\n\r\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        ];
        assert_eq!(read(&parts).await.unwrap(), "a");
    }

    #[tokio::test]
    async fn usage_from_start_and_delta() {
        let start = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":null,\"output_tokens\":1}}}\n\n";
        let delta = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\n";
        let stop = "data: {\"type\":\"message_stop\"}\n\n";
        let chunks: Vec<std::result::Result<Vec<u8>, std::io::Error>> = [start, delta, stop].iter().map(|p| Ok(p.as_bytes().to_vec())).collect();
        let mut got = None;
        read_stream(futures_util::stream::iter(chunks), &mut |c| {
            if let Chunk::Usage { input, cache_read, cache_write, output } = c {
                got = Some((input, cache_read, cache_write, output));
            }
        })
        .await
        .unwrap();
        assert_eq!(got, Some((5, 100, 0, 42)));
    }

    #[test]
    fn retry_after_seconds() {
        let mut h = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after(&h), None);
        h.insert("retry-after", "1".parse().unwrap());
        assert_eq!(retry_after(&h), Some(Duration::from_secs(1)));
    }

    #[test]
    fn body_per_model() {
        let s = ApiSession::new("k".into(), "sys".into(), "low".into(), 100);
        let b = s.body("claude-sonnet-5-5", &[], 100, true);
        assert_eq!(b["thinking"]["type"], "between_tools");
        assert_eq!(b["fallbacks"], "default");
        let b = s.body("claude-opus-5-5", &[], 100, true);
        assert!(b.get("thinking").is_none());
        let b = s.body("claude-haiku-5-5", &[], 1, false);
        assert_eq!(b["thinking"]["type"], "disabled");
        assert!(b.get("fallbacks").is_none());
        assert_eq!((b["max_tokens"].as_u64(), b["stream"].as_bool()), (Some(1), Some(false)));
    }

    /// A local HTTP/1.1 server: answers the n-th request with `replies[n]` (status, extra header lines,
    /// body) and closes the connection. Returns its URL and the number of requests it got.
    async fn server(replies: Vec<(u16, &'static str, String)>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for (status, headers, body) in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                // The whole request first: headers, then content-length bytes of JSON.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                    if n == 0 || buf.len() >= end + 4 + len {
                        break;
                    }
                }
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let kind = if status == 200 { "text/event-stream" } else { "application/json" };
                let reply =
                    format!("HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}", body.len());
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
        });
        (url, hits)
    }

    fn error(kind: &str, message: &str) -> String {
        json!({"type": "error", "error": {"type": kind, "message": message}}).to_string()
    }

    fn session(url: String) -> ApiSession {
        let mut s = ApiSession::new("k".into(), "sys".into(), "low".into(), 100);
        s.url = url;
        s
    }

    const ANSWER: &str =
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";

    #[tokio::test]
    async fn rate_limit_and_overload_are_retried() {
        let (url, hits) = server(vec![
            (429, "retry-after: 0\r\n", error("rate_limit_error", "slow down")),
            (529, "retry-after: 0\r\n", error("overloaded_error", "busy")),
            (200, "", ANSWER.into()),
        ])
        .await;
        let mut s = session(url);
        let mut text = String::new();
        s.ask("claude-haiku-5-5", &Turn::text("q"), &mut |c| {
            if let Chunk::Text(t) = c {
                text.push_str(&t);
            }
        })
        .await
        .unwrap();
        assert_eq!((text.as_str(), hits.load(std::sync::atomic::Ordering::SeqCst)), ("ok", 3));
        assert_eq!(s.messages.len(), 2, "the question and the answer stay in history");
    }

    #[tokio::test]
    async fn three_failures_give_up_with_the_kind_of_the_last() {
        let busy = || (500, "retry-after: 0\r\n", error("api_error", "internal"));
        let (url, hits) = server(vec![busy(), busy(), busy()]).await;
        let e = session(url).ask("claude-haiku-5-5", &Turn::text("q"), &mut |_| {}).await.unwrap_err();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(super::super::error_kind(&e), ErrorKind::Overloaded);
        assert_eq!(e.to_string(), "HTTP 500: internal", "the API's message, not its JSON");
    }

    #[tokio::test]
    async fn client_errors_and_long_waits_are_not_retried() {
        let (url, hits) = server(vec![(401, "", error("authentication_error", "invalid x-api-key"))]).await;
        let e = session(url).ask("claude-haiku-5-5", &Turn::text("q"), &mut |_| {}).await.unwrap_err();
        assert_eq!((super::super::error_kind(&e), hits.load(std::sync::atomic::Ordering::SeqCst)), (ErrorKind::Auth, 1));

        // A minute's wait is worth nothing in a live call: fail now.
        let (url, hits) = server(vec![(429, "retry-after: 60\r\n", error("rate_limit_error", "slow down"))]).await;
        let e = session(url).ask("claude-haiku-5-5", &Turn::text("q"), &mut |_| {}).await.unwrap_err();
        assert_eq!((super::super::error_kind(&e), hits.load(std::sync::atomic::Ordering::SeqCst)), (ErrorKind::RateLimit, 1));
    }

    #[tokio::test]
    async fn no_key_fails_without_a_request() {
        let mut s = session("http://127.0.0.1:9/unused".into());
        s.key.clear();
        let e = s.ask("m", &Turn::text("q"), &mut |_| {}).await.unwrap_err();
        assert_eq!(super::super::error_kind(&e), ErrorKind::Auth);
        assert!(s.messages.is_empty());
    }
}
