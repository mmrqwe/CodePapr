//! Stable v1 NDJSON event line protocol for `codepapr run --events-jsonl`.
//!
//! Every line carries `{"v":1,"ts":<ms>,"type":...,"sessionId":...}` plus
//! type-specific fields. Sidecar/loop frames are translated here so the wire
//! format stays decoupled from the internal worker protocol.

use serde_json::{json, Value};
use std::io::{BufWriter, Write};

pub const PROTOCOL_VERSION: u64 = 1;

pub struct EventWriter {
    inner: Option<BufWriter<std::fs::File>>,
    session_id: String,
}

impl EventWriter {
    pub fn null(session_id: String) -> Self {
        Self { inner: None, session_id }
    }

    pub fn new(path: &std::path::Path, session_id: String) -> Result<Self, std::io::Error> {
        let file = std::fs::File::create(path)?;
        Ok(Self {
            inner: Some(BufWriter::new(file)),
            session_id,
        })
    }

    pub fn line(&mut self, fields: Value) {
        let Some(writer) = self.inner.as_mut() else {
            return;
        };
        let mut record = match fields {
            Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("payload".to_string(), other);
                map
            }
        };
        record.insert("v".into(), json!(PROTOCOL_VERSION));
        record.insert("ts".into(), json!(now_ms()));
        record.insert("sessionId".into(), json!(self.session_id));
        let mut line = serde_json::to_string(&Value::Object(record)).unwrap_or_default();
        line.push('\n');
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }

    pub fn run_start(&mut self, mode: &str, model: &str, provider: &str, workspace: &str, tools: &[String]) {
        self.line(json!({
            "type": "run.start",
            "mode": mode,
            "model": model,
            "provider": provider,
            "workspace": workspace,
            "tools": tools,
        }));
    }

    pub fn run_end(&mut self, exit_reason: &str, extra: Option<Value>) {
        let mut record = json!({ "type": "run.end", "exitReason": exit_reason });
        if let Some(Value::Object(map)) = extra {
            if let Some(obj) = record.as_object_mut() {
                for (k, v) in map {
                    obj.insert(k, v);
                }
            }
        }
        self.line(record);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Preview cap keeps the trace machine-readable without duplicating huge
/// tool payloads (the canonical log stays in the session mirror).
const PREVIEW_CHARS: usize = 2048;

pub fn truncate_preview(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= PREVIEW_CHARS {
        return value.to_string();
    }
    let mut out: String = chars[..PREVIEW_CHARS].iter().collect();
    out.push('…');
    out
}

/// Translate one outgoing sidecar frame (the `message` inside
/// `agent-runtime://frame`) into zero or more protocol lines. Terminal frames
/// (result/error) are handled by the run loop itself and map to nothing here.
pub fn frame_to_lines(message: &Value) -> Vec<Value> {
    let frame_type = message.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "stream" => {
            let Some(event) = message.get("event") else {
                return vec![];
            };
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            match event_type {
                "content-delta" => vec![json!({
                    "type": "message.delta",
                    "channel": "content",
                    "delta": event.get("delta").cloned().unwrap_or(Value::Null),
                })],
                "reasoning-delta" => vec![json!({
                    "type": "message.delta",
                    "channel": "reasoning",
                    "delta": event.get("delta").cloned().unwrap_or(Value::Null),
                })],
                "tool-call-start" => vec![json!({
                    "type": "tool.start",
                    "toolCallId": event.get("toolCallId").cloned().unwrap_or(Value::Null),
                    "toolName": event.get("toolName").cloned().unwrap_or(Value::Null),
                    "arguments": event.get("arguments").cloned().unwrap_or(Value::Null),
                })],
                "tool-call-end" => {
                    let mut line = json!({
                        "type": "tool.end",
                        "toolCallId": event.get("toolCallId").cloned().unwrap_or(Value::Null),
                        "toolName": event.get("toolName").cloned().unwrap_or(Value::Null),
                        "success": event.get("success").cloned().unwrap_or(json!(true)),
                    });
                    if let Some(error) = event.get("error") {
                        line["errorPreview"] = json!(truncate_preview(
                            error.as_str().unwrap_or(&error.to_string())
                        ));
                    }
                    if let Some(output) = event.get("output") {
                        line["outputPreview"] = json!(truncate_preview(
                            output.as_str().unwrap_or(&output.to_string())
                        ));
                    }
                    vec![line]
                }
                "assistant-round-complete" => vec![json!({
                    "type": "message.end",
                    "round": event.get("round").cloned().unwrap_or(Value::Null),
                    "hasToolCalls": event.get("hasToolCalls").cloned().unwrap_or(json!(false)),
                    "contentChars": event.get("content").and_then(Value::as_str).map(|s| s.chars().count()),
                })],
                _ => vec![],
            }
        }
        "harness-event" => vec![json!({
            "type": "harness",
            "name": message.get("name").cloned().unwrap_or(Value::Null),
            "payload": message.get("payload").cloned().unwrap_or(Value::Null),
        })],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_stream_frames() {
        let lines = frame_to_lines(&json!({
            "type": "stream",
            "requestId": "r1",
            "event": { "type": "tool-call-start", "toolCallId": "c1", "toolName": "read", "arguments": {"relativePath": "a.rs"} }
        }));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], "tool.start");
        assert_eq!(lines[0]["toolName"], "read");
        assert_eq!(lines[0]["arguments"]["relativePath"], "a.rs");
    }

    #[test]
    fn tool_end_previews() {
        let big = "x".repeat(5000);
        let lines = frame_to_lines(&json!({
            "type": "stream",
            "event": { "type": "tool-call-end", "toolCallId": "c1", "toolName": "bash", "success": true, "output": big }
        }));
        assert_eq!(lines[0]["type"], "tool.end");
        let preview = lines[0]["outputPreview"].as_str().unwrap();
        assert!(preview.chars().count() <= PREVIEW_CHARS + 1);
    }

    #[test]
    fn terminal_frames_map_to_nothing() {
        assert!(frame_to_lines(&json!({"type": "result", "requestId": "r"})).is_empty());
        assert!(frame_to_lines(&json!({"type": "harness-pong", "protocolVersion": 1})).is_empty());
    }

    #[test]
    fn harness_event_lines() {
        let lines = frame_to_lines(&json!({
            "type": "harness-event", "requestId": "r", "sessionId": "s",
            "name": "question.skipped", "payload": {"question": "why"}
        }));
        assert_eq!(lines[0]["type"], "harness");
        assert_eq!(lines[0]["name"], "question.skipped");
    }

    #[test]
    fn writer_emits_versioned_lines() {
        let dir = std::env::temp_dir().join(format!("cpapr-ev-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("run.jsonl");
        {
            let mut w = EventWriter::new(&path, "sess-1".into()).unwrap();
            w.run_start("agent", "m", "p", "/ws", &["bash".into(), "read".into()]);
            w.line(json!({"type": "tool.start", "toolName": "read"}));
            w.run_end("completed", Some(json!({"model": "m"})));
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["v"], 1);
        assert_eq!(lines[0]["tools"], json!(["bash", "read"]));
        assert_eq!(lines[0]["type"], "run.start");
        assert!(lines[0]["ts"].is_number());
        assert_eq!(lines[1]["sessionId"], "sess-1");
        assert_eq!(lines[2]["exitReason"], "completed");
        assert_eq!(lines[2]["model"], "m");
        let _ = std::fs::remove_dir_all(dir);
    }
}
