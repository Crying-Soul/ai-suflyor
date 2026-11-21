//! Local Claude Code (`claude -p` in stream-json mode) as the backend: uses the user's
//! `claude login` session instead of an API key. One persistent process per tier;
//! the process keeps the conversation, so each turn sends only the new transcript.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use protocol::ErrorKind;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tracing::{info, warn};

use super::{Chunk, StreamEvent, Turn, Usage};

/// The lines of `claude -p --output-format stream-json` that matter here.
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Message {
    StreamEvent {
        event: StreamEvent,
    },
    System {
        #[serde(default)]
        subtype: String,
        #[serde(default)]
        model: Value,
        #[serde(default)]
        tools: Value,
    },
    Result {
        #[serde(default)]
        usage: Usage,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        subtype: String,
    },
    #[serde(other)]
    Other,
}

struct Proc {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    model: String,
}

pub struct CodeSession {
    /// argv prefix, e.g. ["claude"] or ["wsl.exe", "-e", "/path/to/claude"].
    command: Vec<String>,
    system: String,
    effort: String,
    /// Empty working directory: no project files, CLAUDE.md or settings get picked up.
    dir: PathBuf,
    proc: Option<Proc>,
    fresh: bool,
    next_request: u64,
}

impl CodeSession {
    pub fn new(command: Vec<String>, system: String, effort: String, tier: &str) -> CodeSession {
        // One directory per session: two sessions of one tier (notes and call summary) or two cores
        // must not overwrite each other's system.txt.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("suflyor-core-claude-{tier}-{}-{n}", std::process::id()));
        CodeSession { command, system, effort, dir, proc: None, fresh: true, next_request: 1 }
    }

    fn spawn(&mut self, model: &str) -> Result<()> {
        self.proc = None; // kill_on_drop ends the old process
        let (exe, prefix) = self.command.split_first().context("claudeCode.command is empty")?;
        std::fs::create_dir_all(&self.dir)?;
        // A file avoids quoting a multi-line prompt through wsl.exe; the path is relative to cwd.
        std::fs::write(self.dir.join("system.txt"), &self.system)?;
        let mut cmd = Command::new(exe);
        cmd.args(prefix)
            .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose"])
            .args(["--model", model, "--effort", &self.effort, "--system-prompt-file", "system.txt"])
            .args(["--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"])
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().with_context(|| format!("start {}", self.command.join(" ")))?;
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(l)) = stderr.next_line().await {
                warn!("claude: {l}");
            }
        });
        info!("claude code started: {} (model {model})", self.command.join(" "));
        self.proc = Some(Proc { _child: child, stdin, lines, model: model.to_string() });
        self.fresh = true;
        Ok(())
    }

    /// Starts the process if needed (or restarts it for another model). True if its history is empty.
    pub fn prepare(&mut self, model: &str) -> Result<bool> {
        if self.proc.as_ref().is_none_or(|p| p.model != model) {
            self.spawn(model)?;
        }
        Ok(std::mem::take(&mut self.fresh))
    }

    /// The first turn of a fresh process takes several seconds (sign-in check); pay it up front.
    pub async fn warm(&mut self, model: &str, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        let fresh = self.prepare(model)?;
        let t = std::time::Instant::now();
        self.ask(&Turn::text("Reply with OK."), &mut |c| {
            if matches!(c, Chunk::Usage { .. }) {
                out(c);
            }
        })
        .await?;
        info!("claude code warm in {} ms", t.elapsed().as_millis());
        self.fresh = fresh;
        Ok(())
    }

    async fn send(&mut self, v: Value) -> Result<()> {
        let p = self.proc.as_mut().context("claude code is not running")?;
        let mut line = serde_json::to_vec(&v)?;
        line.push(b'\n');
        p.stdin.write_all(&line).await?;
        p.stdin.flush().await?;
        Ok(())
    }

    async fn next(&mut self) -> Result<Value> {
        let p = self.proc.as_mut().context("claude code is not running")?;
        loop {
            match p.lines.next_line().await {
                Ok(Some(l)) => match serde_json::from_str::<Value>(&l) {
                    Ok(v) => return Ok(v),
                    Err(_) => warn!("claude: non-JSON output: {l}"),
                },
                Ok(None) | Err(_) => {
                    self.proc = None;
                    return Err(super::fail(ErrorKind::Auth, "claude code exited (check `claude login` and claudeCode.command)"));
                }
            }
        }
    }

    pub async fn ask(&mut self, turn: &Turn, out: &mut (dyn FnMut(Chunk) + Send)) -> Result<()> {
        self.send(json!({"type": "user", "message": {"role": "user", "content": turn.content()}})).await?;
        loop {
            let Ok(msg) = serde_json::from_value::<Message>(self.next().await?) else { continue };
            match msg {
                Message::StreamEvent { event: StreamEvent::ContentBlockDelta { delta } } => {
                    if let Some(t) = delta.text() {
                        out(Chunk::Text(t.to_string()));
                    }
                }
                Message::System { subtype, model, tools } if subtype == "init" => {
                    info!("claude code session: model {model}, tools {tools}");
                }
                Message::Result { usage, is_error, result, subtype } => {
                    out(usage.chunk());
                    if is_error {
                        return Err(anyhow!("claude code: {}", result.unwrap_or(subtype)));
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
    }

    /// Stops the turn in progress and waits for its `result`, so the next turn starts clean.
    pub async fn interrupt(&mut self) {
        if self.proc.is_none() {
            return;
        }
        let id = format!("interrupt-{}", self.next_request);
        self.next_request += 1;
        let req = json!({"type": "control_request", "request_id": id, "request": {"subtype": "interrupt"}});
        let drained = async {
            self.send(req).await?;
            while self.next().await?["type"] != "result" {}
            anyhow::Ok(())
        };
        if !matches!(tokio::time::timeout(Duration::from_secs(3), drained).await, Ok(Ok(()))) {
            warn!("claude code did not stop in time, restarting it");
            self.proc = None;
        }
    }

    /// Takes effect at the next spawn: the prompt file is written then.
    pub fn set_system(&mut self, system: String) {
        self.system = system;
    }

    pub fn reset(&mut self) {
        self.proc = None;
        self.fresh = true;
    }
}

impl Drop for CodeSession {
    fn drop(&mut self) {
        self.proc = None; // kill_on_drop: the process lets go of its working directory
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for `claude -p` in stream-json mode. It echoes "<model>|<system.txt>|<text>" as two
    /// deltas; "fail" ends the turn with an error result, "exit" quits, "hang" never answers.
    const FAKE: &str = r#"
const fs = require("fs");
const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const model = process.argv[process.argv.indexOf("--model") + 1];
out({ type: "system", subtype: "init", model, tools: [] });
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "control_request") return out({ type: "result", subtype: "error_during_execution", is_error: true, usage: {} });
  const text = m.message.content.map((b) => b.text || "").join("");
  if (text === "exit") process.exit(0);
  if (text === "hang") return;
  if (text === "fail") return out({ type: "result", subtype: "error", is_error: true, result: "boom", usage: {} });
  console.log("not json");
  const delta = (t) => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  delta(model + "|");
  delta(fs.readFileSync("system.txt", "utf8") + "|" + text);
  out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 2 } });
});
"#;

    /// None when node is not installed: the test is skipped.
    fn fake() -> Option<CodeSession> {
        if std::process::Command::new("node").arg("--version").output().is_err() {
            eprintln!("node not found: skipped");
            return None;
        }
        // `--` keeps the session's own flags (-p, --model...) away from node.
        let command = ["node", "-e", FAKE, "--"].map(String::from).to_vec();
        Some(CodeSession::new(command, "SYS".into(), "low".into(), "test"))
    }

    async fn ask(s: &mut CodeSession, text: &str) -> Result<(String, Vec<u64>)> {
        let (mut answer, mut usage) = (String::new(), vec![]);
        s.ask(&Turn::text(text), &mut |c| match c {
            Chunk::Text(t) => answer.push_str(&t),
            Chunk::Usage { input, output, .. } => usage.extend([input, output]),
        })
        .await?;
        Ok((answer, usage))
    }

    #[tokio::test]
    async fn streams_the_answer_and_restarts_for_another_model() {
        let Some(mut s) = fake() else { return };
        assert!(s.prepare("m1").unwrap(), "a new process has no history");
        assert_eq!(ask(&mut s, "hi").await.unwrap(), ("m1|SYS|hi".to_string(), vec![3, 2]));
        assert!(!s.prepare("m1").unwrap(), "the same process keeps the conversation");
        s.set_system("NEW".into());
        assert!(s.prepare("m2").unwrap(), "another model: a new process");
        assert_eq!(ask(&mut s, "hi").await.unwrap().0, "m2|NEW|hi", "the new system prompt is written for it");
    }

    #[tokio::test]
    async fn an_error_result_fails_the_turn_and_an_exit_restarts_the_process() {
        let Some(mut s) = fake() else { return };
        s.prepare("m").unwrap();
        let e = ask(&mut s, "fail").await.unwrap_err();
        assert!(e.to_string().contains("boom"), "{e}");
        assert_eq!(ask(&mut s, "again").await.unwrap().0, "m|SYS|again", "the process is still usable");
        let e = ask(&mut s, "exit").await.unwrap_err();
        assert_eq!(super::super::error_kind(&e), ErrorKind::Auth, "an exit points at the login");
        assert!(s.prepare("m").unwrap(), "the next turn starts a new process");
        assert_eq!(ask(&mut s, "back").await.unwrap().0, "m|SYS|back");
    }

    #[tokio::test]
    async fn interrupt_drains_the_cancelled_turn() {
        let Some(mut s) = fake() else { return };
        s.prepare("m").unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(300), ask(&mut s, "hang")).await.is_err());
        s.interrupt().await;
        assert!(!s.prepare("m").unwrap(), "interrupted in time: the process stays");
        assert_eq!(ask(&mut s, "next").await.unwrap().0, "m|SYS|next", "no leftovers of the cancelled turn");
    }
}
