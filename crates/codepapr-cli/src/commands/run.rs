//! `codepapr run` — thin harness client.
//!
//! Contract (CLI 运行时对等方案 §3): argv parsing, capability handshake
//! (harness/ping), init/run frame forwarding, NDJSON event persistence,
//! result-json writing and process lifecycle/exit codes. ALL agent-runtime
//! decisions (mode filtering, tool surface, prompt assembly, UI-bound
//! policies) live in the desktop-sidecar TS runtime; this file must never
//! grow a tool table or agent loop of its own.

use crate::commands::chat::{resolve_llm_config, ResolvedLlmConfig};
use crate::harness::allowlist::Allowlist;
use crate::harness::events::{frame_to_lines, EventWriter, PROTOCOL_VERSION};
use crate::rpc_client::{JsonRpcNotification, RpcClient};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub const EXIT_OK: i32 = 0;
pub const EXIT_RUNTIME_ERROR: i32 = 1;
pub const EXIT_TIMEOUT: i32 = 2;
pub const EXIT_DENIED: i32 = 3;
pub const EXIT_INTERRUPTED: i32 = 130;

const HARNESS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// After a local cancel we let in-flight tool-host activity settle so every
/// tool.start gets an end/cancel line before we give up on the runtime.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

#[derive(clap::Args, Debug)]
pub struct RunArgs {
    #[arg(help = "Prompt for the agent (or piped via stdin)")]
    pub prompt: Option<String>,

    #[arg(long, value_parser = ["ask", "plan", "agent"], default_value = "agent")]
    pub mode: String,

    #[arg(short = 'm', long)]
    pub model: Option<String>,

    #[arg(short = 'p', long)]
    pub provider: Option<String>,

    #[arg(long)]
    pub api_key: Option<String>,

    #[arg(long)]
    pub base_url: Option<String>,

    #[arg(long)]
    pub system_prompt: Option<String>,

    #[arg(long, help = "Auto-approve all permission requests (evaluation default)")]
    pub yolo: bool,

    #[arg(long, help = "JSON allowlist of permission rules; deny otherwise")]
    pub permission: Option<PathBuf>,

    #[arg(long, help = "Plan-mode question policy: answer with the provided JSON map or the first option")]
    pub question_auto: bool,

    #[arg(long, help = "JSON object mapping question text to answers (implies --question-auto)")]
    pub question_answers: Option<PathBuf>,

    #[arg(long, help = "Overall run deadline in milliseconds (2 -> exit code on hit)")]
    pub timeout_ms: Option<u64>,

    #[arg(long, help = "Session id for the run (default: generated)")]
    pub session_id: Option<String>,

    #[arg(long, help = "Append versioned NDJSON event trace to this file")]
    pub events_jsonl: Option<PathBuf>,

    #[arg(long, help = "Write the machine-readable result document to this file")]
    pub result_json: Option<PathBuf>,
}

struct ToolCallRecord {
    name: String,
    started: Instant,
    finished: bool,
    ok: bool,
}

struct RunState {
    tool_calls_by_id: HashMap<String, ToolCallRecord>,
    tool_calls: Vec<(String, bool, u128)>,
    final_text: String,
    usage: Option<Value>,
}

impl RunState {
    fn new() -> Self {
        Self {
            tool_calls_by_id: HashMap::new(),
            tool_calls: Vec::new(),
            final_text: String::new(),
            usage: None,
        }
    }

    fn track_stream_event(&mut self, event: &Value) {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "tool-call-start" => {
                let id = event.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                let name = event.get("toolName").and_then(Value::as_str).unwrap_or("unknown").to_string();
                if !id.is_empty() && !self.tool_calls_by_id.contains_key(&id) {
                    self.tool_calls_by_id.insert(
                        id,
                        ToolCallRecord { name, started: Instant::now(), finished: false, ok: false },
                    );
                }
            }
            "tool-call-end" => {
                let id = event.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                if let Some(record) = self.tool_calls_by_id.get_mut(&id) {
                    record.finished = true;
                    record.ok = event.get("success").and_then(Value::as_bool).unwrap_or(true);
                    self.tool_calls.push((
                        record.name.clone(),
                        record.ok,
                        record.started.elapsed().as_millis(),
                    ));
                }
            }
            _ => {}
        }
    }

    fn close_unfinished_tool_calls(&mut self, reason: &str) {
        for record in self.tool_calls_by_id.values_mut() {
            if !record.finished {
                record.finished = true;
                self.tool_calls.push((record.name.clone(), false, record.started.elapsed().as_millis()));
            }
        }
        let _ = reason;
    }
}

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    args: RunArgs,
    event_rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    json_mode: bool,
) -> i32 {
    let mut events = match args.events_jsonl.as_deref() {
        Some(path) => match EventWriter::new(path, args.session_id.clone().unwrap_or_default()) {
            Ok(writer) => writer,
            Err(err) => {
                eprintln!("failed to create events file: {err}");
                return EXIT_RUNTIME_ERROR;
            }
        },
        None => EventWriter::null(String::new()),
    };

    match drive(client, workspace, &args, event_rx, &mut events, json_mode).await {
        Ok(code) => code,
        Err(message) => {
            eprintln!("run failed: {message}");
            EXIT_RUNTIME_ERROR
        }
    }
}

async fn drive(
    client: &RpcClient,
    workspace: &str,
    args: &RunArgs,
    event_rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    events: &mut EventWriter,
    json_mode: bool,
) -> Result<i32, Box<dyn std::error::Error>> {
    let session_id = args
        .session_id
        .clone()
        .unwrap_or_else(|| format!("cli-run-{}", std::process::id()));
    let allowlist = match args.permission.as_deref() {
        Some(path) => Some(Allowlist::load(path)?),
        None => None,
    };
    let question_answers = match args.question_answers.as_deref() {
        Some(path) => Some(load_question_answers(path)?),
        None => None,
    };

    let config = resolve_llm_config(
        client,
        args.provider.as_deref(),
        args.api_key.as_deref(),
        args.base_url.as_deref(),
        args.model.as_deref(),
    )
    .await?;

    let prompt = match resolve_prompt(args.prompt.as_deref()) {
        Some(prompt) => prompt,
        None => {
            return Err("no prompt provided (argument or piped stdin)".into());
        }
    };

    let start_res = client.call("agent/start", json!({})).await?;
    let runtime_id = start_res
        .get("runtimeId")
        .and_then(|v| v.as_str())
        .ok_or("agent/start returned no runtimeId")?
        .to_string();

    // ── Capability handshake: no silent fallback to legacy frames ──
    let init_request_id = format!("hinit-{}", std::process::id());
    let run_request_id = format("hrun", std::process::id());
    send_frame(client, &runtime_id, &json!({ "type": "harness/ping" })).await?;
    if let Err(err) = wait_for_frames(event_rx, HARNESS_HANDSHAKE_TIMEOUT, &runtime_id, &mut |message| {
        message.get("type").and_then(Value::as_str) == Some("harness-pong")
    })
    .await
    {
        let _ = client.call("agent/stop", json!({ "runtimeId": runtime_id })).await;
        return Err(format!(
            "{err}: sidecar lacks harness capability. Build it first: npm run build:sidecar (and upgrade codepapr-server). NOT falling back to the legacy tool table."
        )
        .into());
    }

    let settings_override = harness_settings_override(&config);
    let mut policy = json!({});
    if args.question_auto || question_answers.is_some() {
        let mut question = json!({ "mode": "auto-default" });
        if let Some(answers) = &question_answers {
            question["answers"] = answers.clone();
        }
        policy["question"] = question;
    }
    send_frame(
        client,
        &runtime_id,
        &json!({
            "type": "harness/init",
            "payload": {
                "requestId": init_request_id,
                "workspacePath": workspace,
                "mode": args.mode,
                "settingsOverride": settings_override,
                "systemPromptOverride": args.system_prompt,
                "policy": policy,
            }
        }),
    )
    .await?;
    if let Err(err) = wait_for_frames(event_rx, HARNESS_HANDSHAKE_TIMEOUT, &runtime_id, &mut |message| {
        message.get("type").and_then(Value::as_str) == Some("harness-ready")
    })
    .await
    {
        let _ = client.call("agent/stop", json!({ "runtimeId": runtime_id })).await;
        return Err(format!("harness/init handshake failed: {err}").into());
    }

    let deadline = args
        .timeout_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms.min(24 * 3600 * 1000)));

    events.run_start(&args.mode, &config.model, &config.provider, workspace);
    send_frame(
        client,
        &runtime_id,
        &json!({
            "type": "harness/run",
            "payload": {
                "requestId": run_request_id,
                "sessionId": session_id,
                "prompt": prompt,
            }
        }),
    )
    .await?;

    let mut state = RunState::new();
    let mut exit_reason: &'static str = "error";
    let mut exit_code = EXIT_RUNTIME_ERROR;
    let mut denied = false;
    let mut timed_out = false;
    let mut interrupted = false;

    loop {
        let recv_budget = match deadline {
            Some(at) => at.saturating_duration_since(Instant::now()),
            None => Duration::from_secs(3600 * 24),
        };
        if deadline.is_some() && recv_budget.is_zero() {
            timed_out = true;
            break;
        }
        let notified = tokio::select! {
            result = tokio::time::timeout(recv_budget, event_rx.recv()) => result,
            _ = tokio::signal::ctrl_c() => {
                interrupted = true;
                break;
            }
        };
        let notif = match notified {
            Ok(Some(notif)) => notif,
            Ok(None) => {
                // server channel closed mid-run: treat as a runtime error and
                // let the finalizer below normalize state.
                break;
            }
            Err(_elapsed) => {
                timed_out = true;
                break;
            }
        };
        if notif.method != "event" {
            continue;
        }
        let event_name = notif.params.get("event").and_then(Value::as_str).unwrap_or("");
        let payload = notif.params.get("payload").cloned().unwrap_or(Value::Null);
        let frame_runtime = payload.get("runtimeId").and_then(Value::as_str).unwrap_or("");
        if !frame_runtime.is_empty() && frame_runtime != runtime_id {
            continue;
        }

        if event_name == "agent-runtime://permission-request" {
            let request_id = payload.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
            let operation = payload.get("operation").and_then(Value::as_str).unwrap_or("unknown");
            let path = payload.get("path").and_then(Value::as_str).unwrap_or("");
            let tool = payload.get("toolName").and_then(Value::as_str);
            let approved = args.yolo
                || allowlist
                    .as_ref()
                    .is_some_and(|list| list.is_allowed(tool, Some(operation), Some(path)));
            events.line(json!({
                "type": "permission",
                "operation": operation,
                "path": path,
                "toolName": tool,
                "approved": approved,
            }));
            let _ = client
                .call(
                    "agent/respondPermission",
                    json!({ "requestId": request_id, "approved": approved, "scope": "once" }),
                )
                .await;
            if !approved {
                denied = true;
                break;
            }
            continue;
        }

        if event_name != "agent-runtime://frame" {
            continue;
        }
        let Some(message) = payload.get("message") else { continue };
        let frame_type = message.get("type").and_then(Value::as_str).unwrap_or("");

        if frame_type == "stream" {
            if let Some(event) = message.get("event") {
                state.track_stream_event(event);
            }
        }
        for line in frame_to_lines(message) {
            events.line(line);
        }

        match frame_type {
            "result" => {
                if let Some(content) = message
                    .pointer("/response/content")
                    .and_then(Value::as_str)
                {
                    state.final_text = content.to_string();
                }
                state.usage = message.pointer("/response/cacheStats").cloned();
                exit_reason = "completed";
                exit_code = EXIT_OK;
                break;
            }
            "error" => {
                let error = message.get("error").and_then(Value::as_str).unwrap_or("agent error");
                eprintln!("agent error: {error}");
                events.line(json!({ "type": "error", "error": error }));
                exit_reason = "error";
                exit_code = EXIT_RUNTIME_ERROR;
                break;
            }
            "cancelled" => {
                exit_reason = if timed_out {
                    "timeout"
                } else if interrupted {
                    "cancelled"
                } else {
                    "error"
                };
                break;
            }
            "harness-pong" | "harness-ready" => {}
            _ => {}
        }
    }

    // Normalize exit state after the loop: cancel/timeout/deny override the
    // "error" default; an explicit `completed` from the result arm stands.
    if timed_out {
        exit_reason = "timeout";
        exit_code = EXIT_TIMEOUT;
    } else if denied {
        exit_reason = "denied";
        exit_code = EXIT_DENIED;
    } else if interrupted {
        exit_reason = "cancelled";
        exit_code = EXIT_INTERRUPTED;
    }

    // Best-effort cancel + grace so hosted tools emit end events on timeout.
    if timed_out || interrupted || denied {
        let _ = send_frame(
            client,
            &runtime_id,
            &json!({ "type": "cancel-session", "requestId": run_request_id }),
        )
        .await;
        let grace_deadline = Instant::now() + CANCEL_GRACE;
        while Instant::now() < grace_deadline {
            let Ok(maybe) =
                tokio::time::timeout(Duration::from_millis(200), event_rx.recv()).await
            else {
                break;
            };
            let Some(notif) = maybe else { break };
            if notif.method != "event" {
                continue;
            }
            let payload = notif.params.get("payload").cloned().unwrap_or(Value::Null);
            if notif.params.get("event").and_then(Value::as_str) == Some("agent-runtime://frame") {
                if let Some(message) = payload.get("message") {
                    let frame_type = message.get("type").and_then(Value::as_str).unwrap_or("");
                    if frame_type == "stream" {
                        if let Some(event) = message.get("event") {
                            state.track_stream_event(event);
                        }
                    }
                    for line in frame_to_lines(message) {
                        events.line(line);
                    }
                    // Cancelled is the expected ACK; result/error mean the
                    // turn finished anyway — stop waiting either way.
                    if matches!(frame_type, "cancelled" | "result" | "error") {
                        break;
                    }
                }
            }
        }
    }
    state.close_unfinished_tool_calls(if timed_out { "timeout" } else { "cancel" });
    let _ = client.call("agent/stop", json!({ "runtimeId": runtime_id })).await;

    let result = build_result_json(
        &session_id,
        args,
        &config,
        workspace,
        question_answers.as_ref(),
        &state,
        exit_reason,
    );
    if let Some(path) = args.result_json.as_deref() {
        if let Err(err) = std::fs::write(path, serde_json::to_vec_pretty(&result)?) {
            eprintln!("failed to write result json: {err}");
        }
    }
    if json_mode {
        println!("{}", serde_json::to_string(&result)?);
    } else if !state.final_text.is_empty() {
        println!("{}", state.final_text);
    }
    events.run_end(exit_reason, Some(json!({ "exitCode": exit_code })));
    Ok(exit_code)
}

fn format(prefix: &str, id: u32) -> String {
    format!("{prefix}-{id}")
}

fn harness_settings_override(config: &ResolvedLlmConfig) -> Value {
    json!({
        "apiMode": if config.provider == "deepseek" { "deepseek" } else { "custom" },
        "apiFormat": config.api_format,
        "provider": config.provider,
        "baseURL": config.base_url,
        "apiKey": config.api_key,
        "model": config.model,
    })
}

fn resolve_prompt(arg: Option<&str>) -> Option<String> {
    if let Some(arg) = arg {
        return Some(arg.to_string());
    }
    use std::io::Read;
    if !std::io::stdin().is_terminal() {
        let mut buf = String::new();
        if std::io::stdin().read_to_string(&mut buf).is_ok() {
            let trimmed = buf.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn load_question_answers(path: &std::path::Path) -> Result<Value, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&text)?;
    if !value.is_object() {
        return Err("question answers file must be a JSON object".into());
    }
    Ok(value)
}

async fn send_frame(client: &RpcClient, runtime_id: &str, frame: &Value) -> Result<(), Box<dyn std::error::Error>> {
    client
        .call(
            "agent/send",
            json!({ "runtimeId": runtime_id, "line": serde_json::to_string(frame)? }),
        )
        .await?;
    Ok(())
}

async fn wait_for_frames(
    event_rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    timeout: Duration,
    runtime_id: &str,
    predicate: &mut dyn FnMut(&Value) -> bool,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        let budget = deadline.saturating_duration_since(Instant::now());
        if budget.is_zero() {
            return Err("timed out waiting for harness handshake frame");
        }
        let Ok(Some(notif)) = tokio::time::timeout(budget, event_rx.recv()).await else {
            return Err("timed out waiting for harness handshake frame");
        };
        if notif.method != "event" {
            continue;
        }
        let payload = notif.params.get("payload").cloned().unwrap_or(Value::Null);
        let frame_runtime = payload.get("runtimeId").and_then(Value::as_str).unwrap_or("");
        if !frame_runtime.is_empty() && frame_runtime != runtime_id {
            continue;
        }
        if notif.params.get("event").and_then(Value::as_str) != Some("agent-runtime://frame") {
            continue;
        }
        if let Some(message) = payload.get("message") {
            if predicate(message) {
                return Ok(());
            }
            if message.get("type").and_then(Value::as_str) == Some("error") {
                let err = message.get("error").and_then(Value::as_str).unwrap_or("unknown");
                return Err(Box::leak(format!("sidecar error during handshake: {err}").into_boxed_str()) as &'static str);
            }
        }
    }
}

fn build_result_json(
    session_id: &str,
    args: &RunArgs,
    config: &ResolvedLlmConfig,
    workspace: &str,
    _answers: Option<&Value>,
    state: &RunState,
    exit_reason: &str,
) -> Value {
    let tool_calls: Vec<Value> = state
        .tool_calls
        .iter()
        .map(|(name, ok, ms)| json!({ "name": name, "ok": ok, "ms": ms }))
        .collect();
    json!({
        "v": PROTOCOL_VERSION,
        "sessionId": session_id,
        "mode": args.mode,
        "model": config.model,
        "provider": config.provider,
        "workspace": workspace,
        "finalText": state.final_text,
        "toolCalls": tool_calls,
        "usage": state.usage,
        "exitReason": exit_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_override_maps_deepseek_to_its_api_mode() {
        let config = ResolvedLlmConfig {
            provider: "deepseek".into(),
            model: "deepseek-chat".into(),
            api_key: "k".into(),
            base_url: "https://api.deepseek.com".into(),
            api_format: "openai".into(),
        };
        let value = harness_settings_override(&config);
        assert_eq!(value["apiMode"], "deepseek");
        assert_eq!(value["provider"], "deepseek");
    }

    #[test]
    fn settings_override_custom_for_other_providers() {
        let config = ResolvedLlmConfig {
            provider: "claude".into(),
            model: "claude-x".into(),
            api_key: "k".into(),
            base_url: "https://api.anthropic.com".into(),
            api_format: "claude".into(),
        };
        let value = harness_settings_override(&config);
        assert_eq!(value["apiMode"], "custom");
        assert_eq!(value["apiFormat"], "claude");
    }

    #[test]
    fn result_document_shape() {
        let args = RunArgs {
            prompt: None,
            mode: "agent".into(),
            model: None,
            provider: None,
            api_key: None,
            base_url: None,
            system_prompt: None,
            yolo: true,
            permission: None,
            question_auto: false,
            question_answers: None,
            timeout_ms: None,
            session_id: None,
            events_jsonl: None,
            result_json: None,
        };
        let config = ResolvedLlmConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            api_key: "k".into(),
            base_url: "u".into(),
            api_format: "openai".into(),
        };
        let mut state = RunState::new();
        state.final_text = "done".into();
        state.tool_calls.push(("bash".into(), true, 12));
        let doc = build_result_json("s1", &args, &config, "/ws", None, &state, "completed");
        assert_eq!(doc["v"], PROTOCOL_VERSION);
        assert_eq!(doc["exitReason"], "completed");
        assert_eq!(doc["toolCalls"][0]["name"], "bash");
        assert_eq!(doc["finalText"], "done");
    }

    #[test]
    fn tool_state_tracks_start_end() {
        let mut state = RunState::new();
        state.track_stream_event(&json!({"type":"tool-call-start","toolCallId":"c1","toolName":"read","arguments":{}}));
        state.track_stream_event(&json!({"type":"tool-call-end","toolCallId":"c1","toolName":"read","success":false,"error":"denied"}));
        assert_eq!(state.tool_calls.len(), 1);
        assert_eq!(state.tool_calls[0].0, "read");
        assert!(!state.tool_calls[0].1);
    }

    #[test]
    fn unfinished_tools_are_closed_on_cancel() {
        let mut state = RunState::new();
        state.track_stream_event(&json!({"type":"tool-call-start","toolCallId":"c1","toolName":"bash","arguments":{}}));
        state.close_unfinished_tool_calls("timeout");
        assert_eq!(state.tool_calls.len(), 1);
        assert!(!state.tool_calls[0].1);
    }

    #[test]
    fn timeout_is_bounded_to_one_day() {
        let bounded = |ms: u64| Duration::from_millis(ms.min(24 * 3600 * 1000));
        assert_eq!(bounded(999_999_999_999), Duration::from_secs(24 * 3600));
    }
}
