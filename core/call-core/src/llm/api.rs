//! Messages API over raw HTTP + SSE (no official Rust SDK). Append-only history, so every
//! request reads the previous prefix from the prompt cache.

use std::time::Duration;

use anyhow::{Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tracing::warn;

use super::Chunk;

pub struct ApiSession {
    client: reqwest::Client,
    key: String,
    system: String,
    effort: String,
    max_tokens: u32,
    messages: Vec<Value>,
    fresh: bool,
}

impl ApiSession {
    pub fn new(key: String, system: String, effort: String, max_tokens: u32) -> ApiSession {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(300))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        ApiSession { client, key, system, effort, max_tokens, messages: Vec::new(), fresh: true }
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

    fn body(&self, model: &str) -> Value {
        let mut b = json!({
            "model": model,
            "max_tokens": self.max_tokens,
            "stream": true,
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            "messages": self.messages,
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

    pub async fn ask(&mut self, model: &str, text: String, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        if self.key.is_empty() {
            bail!("no Anthropic API key: set anthropicApiKey or ANTHROPIC_API_KEY, or switch to the Claude Code connection");
        }
        // The user turn stays in history even if the answer fails: consecutive user turns are merged by the API.
        self.messages.push(json!({"role": "user", "content": [{"type": "text", "text": text}]}));
        let body = self.body(model);
        let mut attempt = 0;
        let resp = loop {
            let mut req = self
                .client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &self.key)
                .header("anthropic-version", "2023-06-01")
                .json(&body);
            if fallback_supported(model) {
                req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            match req.send().await {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    let retry = status.as_u16() == 429 || status.is_server_error();
                    if !retry || attempt >= 2 {
                        bail!("HTTP {status}: {}", error_message(&text));
                    }
                    warn!("claude api HTTP {status}, retrying");
                }
                Err(e) if attempt < 2 && (e.is_connect() || e.is_timeout()) => warn!("claude api: {e}, retrying"),
                Err(e) => return Err(e.into()),
            }
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
        };

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut answer = String::new();
        let (mut input, mut cache_read, mut cache_write, mut output) = (0, 0, 0, 0);
        let mut stop_reason = String::new();
        'read: while let Some(bytes) = stream.next().await {
            buf.extend_from_slice(&bytes?);
            while let Some(end) = find_event_end(&buf) {
                let event: Vec<u8> = buf.drain(..end).collect();
                let event = String::from_utf8_lossy(&event);
                for data in event.lines().filter_map(|l| l.strip_prefix("data:")) {
                    let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
                    match v["type"].as_str().unwrap_or("") {
                        "message_start" => {
                            let u = &v["message"]["usage"];
                            input = u["input_tokens"].as_u64().unwrap_or(0);
                            cache_read = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
                            cache_write = u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                        }
                        "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                            let t = v["delta"]["text"].as_str().unwrap_or("");
                            answer.push_str(t);
                            out(Chunk::Text(t.to_string()));
                        }
                        "message_delta" => {
                            stop_reason = v["delta"]["stop_reason"].as_str().unwrap_or("").to_string();
                            output = v["usage"]["output_tokens"].as_u64().unwrap_or(output);
                        }
                        "message_stop" => break 'read,
                        "error" => bail!("stream error: {}", v["error"]["message"].as_str().unwrap_or("unknown")),
                        _ => {}
                    }
                }
            }
        }
        out(Chunk::Usage { input, cache_read, cache_write, output });
        if stop_reason == "refusal" {
            bail!("Claude declined to answer this request");
        }
        if !answer.is_empty() {
            self.messages.push(json!({"role": "assistant", "content": [{"type": "text", "text": answer}]}));
        }
        Ok(())
    }
}

fn fallback_supported(model: &str) -> bool {
    model.starts_with("claude-sonnet-5-5") || model.starts_with("claude-opus-5-5")
}

/// End (exclusive) of the first complete SSE event, including its blank-line terminator.
fn find_event_end(buf: &[u8]) -> Option<usize> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|i| i + 2);
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

fn error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_framing() {
        assert_eq!(find_event_end(b"event: a\ndata: {}\n\nrest"), Some(19));
        assert_eq!(find_event_end(b"data: {}\r\n\r\n"), Some(12));
        assert_eq!(find_event_end(b"data: {"), None);
    }

    #[test]
    fn body_per_model() {
        let s = ApiSession::new("k".into(), "sys".into(), "low".into(), 100);
        let b = s.body("claude-sonnet-5-5");
        assert_eq!(b["thinking"]["type"], "between_tools");
        assert_eq!(b["fallbacks"], "default");
        let b = s.body("claude-opus-5-5");
        assert!(b.get("thinking").is_none());
        let b = s.body("claude-haiku-5-5");
        assert_eq!(b["thinking"]["type"], "disabled");
        assert!(b.get("fallbacks").is_none());
    }
}
