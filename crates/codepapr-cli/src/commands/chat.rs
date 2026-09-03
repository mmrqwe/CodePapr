use crate::rpc_client::{JsonRpcNotification, RpcClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;

#[derive(clap::Args, Debug)]
pub struct ChatArgs {
    #[arg(help = "Prompt / query for the AI coding agent")]
    pub prompt: Option<String>,

    #[arg(short = 'm', long, help = "Model identifier (e.g. deepseek-chat, gpt-4o)")]
    pub model: Option<String>,

    #[arg(short = 'p', long, help = "Provider (deepseek, openai, claude)")]
    pub provider: Option<String>,

    #[arg(long, help = "API key for the model provider")]
    pub api_key: Option<String>,

    #[arg(long, help = "Custom base URL for the model provider")]
    pub base_url: Option<String>,

    #[arg(long, help = "System prompt override")]
    pub system_prompt: Option<String>,

    #[arg(long, help = "Automatically approve all file and command tool permissions")]
    pub yolo: bool,

    #[arg(long, help = "Print raw JSON stream frames from the agent sidecar")]
    pub raw: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedLlmConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub api_format: String,
}

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    args: ChatArgs,
    mut event_rx: mpsc::UnboundedReceiver<JsonRpcNotification>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Resolve LLM Configuration
    let config = resolve_llm_config(client, &args).await?;

    // 2. Start the Agent Sidecar Runtime
    let start_res = client.call("agent/start", json!({})).await?;
    let runtime_id = start_res.get("runtimeId")
        .and_then(|v| v.as_str())
        .ok_or("Failed to obtain runtimeId from agent/start")?
        .to_string();

    let session_id = format!("cli-session-{}", std::process::id());
    let default_system_prompt = args.system_prompt.unwrap_or_else(|| {
        "You are CodePapr, an expert AI software engineering agent. You assist the user by reading, editing, and analyzing code in their workspace. Be precise, concise, and helpful.".to_string()
    });

    // 3. Send Init Frame to Sidecar
    let settings_val = build_worker_settings(&config);
    let tool_defs = get_default_cli_tool_definitions();

    let init_frame = json!({
        "type": "init",
        "payload": {
            "settings": settings_val,
            "toolDefinitions": tool_defs,
            "workspacePath": workspace,
            "runtime": {
                "mode": "agent",
                "lang": "en",
            }
        }
    });

    client.call("agent/send", json!({
        "runtimeId": runtime_id,
        "line": serde_json::to_string(&init_frame)?,
    })).await?;

    // 4. Check for piped stdin
    let piped_stdin = if !std::io::stdin().is_terminal() {
        use std::io::Read;
        let mut buf = String::new();
        let _ = std::io::stdin().read_to_string(&mut buf);
        let trimmed = buf.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    } else {
        None
    };

    let yolo = Arc::new(AtomicBool::new(args.yolo));

    // Handle single-shot prompt or piped input
    let initial_prompt = match (args.prompt, piped_stdin) {
        (Some(p), Some(pipe)) => Some(format!("{p}\n\n```\n{pipe}\n```")),
        (None, Some(pipe)) => Some(pipe),
        (Some(p), None) => Some(p),
        (None, None) => None,
    };

    let mut messages: Vec<Value> = Vec::new();

    if let Some(prompt) = initial_prompt {
        // Single turn execution
        execute_turn(
            client,
            &runtime_id,
            &session_id,
            workspace,
            &prompt,
            &mut messages,
            &config,
            &settings_val,
            &tool_defs,
            &default_system_prompt,
            &mut event_rx,
            &yolo,
            args.raw,
            json_mode,
        ).await?;

        let _ = client.call("agent/stop", json!({"runtimeId": runtime_id})).await;
        return Ok(());
    }

    // Interactive REPL loop
    if !std::io::stdin().is_terminal() {
        eprintln!("No prompt provided and standard input is not a terminal.");
        return Ok(());
    }

    println!("============================================================");
    println!("  CodePapr Agent CLI (v{})", codepapr_core::version());
    println!("  Workspace: {workspace}");
    println!("  Provider:  {} ({})", config.provider, config.model);
    println!("  Type /exit or Ctrl+C to quit, /clear to reset history.");
    println!("============================================================\n");

    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin).lines();

    loop {
        eprint!("codepapr> ");
        std::io::stderr().flush()?;

        let line = match reader.next_line().await? {
            Some(l) => l.trim().to_string(),
            None => break,
        };

        if line.is_empty() {
            continue;
        }

        if line == "/exit" || line == "/quit" {
            println!("Goodbye!");
            break;
        }

        if line == "/clear" {
            messages.clear();
            println!("Conversation history cleared.");
            continue;
        }

        if line == "/status" {
            crate::commands::status::run(client, workspace, false).await?;
            continue;
        }

        execute_turn(
            client,
            &runtime_id,
            &session_id,
            workspace,
            &line,
            &mut messages,
            &config,
            &settings_val,
            &tool_defs,
            &default_system_prompt,
            &mut event_rx,
            &yolo,
            args.raw,
            json_mode,
        ).await?;

        println!();
    }

    let _ = client.call("agent/stop", json!({"runtimeId": runtime_id})).await;
    Ok(())
}

async fn execute_turn(
    client: &RpcClient,
    runtime_id: &str,
    session_id: &str,
    workspace: &str,
    user_input: &str,
    messages: &mut Vec<Value>,
    config: &ResolvedLlmConfig,
    settings_val: &Value,
    tool_defs: &[Value],
    system_prompt: &str,
    event_rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    yolo: &Arc<AtomicBool>,
    raw_mode: bool,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let req_id = format!("req-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis());
    let user_msg_id = format!("msg-user-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis());

    let user_msg = json!({
        "id": user_msg_id,
        "role": "user",
        "content": user_input,
        "timestamp": chrono_now_ms(),
    });
    messages.push(user_msg);

    let chat_frame = json!({
        "type": "chat",
        "payload": {
            "requestId": req_id,
            "sessionId": session_id,
            "workspacePath": workspace,
            "userInput": user_input,
            "userMessageId": user_msg_id,
            "messages": messages,
            "settings": settings_val,
            "providerName": config.provider,
            "model": config.model,
            "systemPrompt": system_prompt,
            "parameters": {
                "temperature": 0.3,
                "topP": 0.95,
                "maxTokens": 4096,
                "thinkingEnabled": false,
                "reasoningEffort": "medium",
            },
            "toolDefinitions": tool_defs,
            "runtime": {
                "mode": "agent",
                "lang": "en",
            }
        }
    });

    client.call("agent/send", json!({
        "runtimeId": runtime_id,
        "line": serde_json::to_string(&chat_frame)?,
    })).await?;

    // Drain events for this turn
    let mut assistant_response_text = String::new();
    let mut in_thinking = false;

    loop {
        tokio::select! {
            notif_opt = event_rx.recv() => {
                match notif_opt {
                    Some(notif) => {
                        if notif.method == "event" {
                            let event_name = notif.params.get("event").and_then(|v| v.as_str()).unwrap_or("");
                            let payload = notif.params.get("payload").cloned().unwrap_or(Value::Null);

                            // 1. Permission request event
                            if event_name == "agent-runtime://permission-request" {
                                let request_id = payload.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let op = payload.get("operation").and_then(|v| v.as_str()).unwrap_or("unknown");
                                let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");

                                let approved = if yolo.load(Ordering::SeqCst) {
                                    true
                                } else {
                                    eprint!("\n[Permission Required] Operation: {op} on '{path}'\nApprove this action? [y/N]: ");
                                    std::io::stderr().flush()?;
                                    let mut answer = String::new();
                                    let _ = std::io::stdin().read_line(&mut answer);
                                    let trimmed = answer.trim().to_lowercase();
                                    trimmed == "y" || trimmed == "yes"
                                };

                                let _ = client.call("agent/respondPermission", json!({
                                    "requestId": request_id,
                                    "approved": approved,
                                    "scope": "directory",
                                })).await;
                                continue;
                            }

                            // 2. Sidecar Frame event
                            if event_name == "agent-runtime://frame" {
                                if let Some(msg) = payload.get("message") {
                                    if raw_mode {
                                        println!("{}", serde_json::to_string(&msg)?);
                                    }

                                    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                    if msg_type == "stream" {
                                        if let Some(stream_evt) = msg.get("event") {
                                            let evt_type = stream_evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                            if evt_type == "content-delta" {
                                                if in_thinking {
                                                    eprintln!();
                                                    in_thinking = false;
                                                }
                                                if let Some(tok) = stream_evt.get("delta").and_then(|v| v.as_str()) {
                                                    assistant_response_text.push_str(tok);
                                                    if !json_mode && !raw_mode {
                                                        print!("{tok}");
                                                        std::io::stdout().flush()?;
                                                    }
                                                }
                                            } else if evt_type == "reasoning-delta" {
                                                if !in_thinking {
                                                    eprint!("\n[Thinking] ");
                                                    in_thinking = true;
                                                }
                                                if let Some(text) = stream_evt.get("delta").and_then(|v| v.as_str()) {
                                                    eprint!("{text}");
                                                    std::io::stderr().flush()?;
                                                }
                                            } else if evt_type == "tool-call-start" {
                                                if in_thinking {
                                                    eprintln!();
                                                    in_thinking = false;
                                                }
                                                let tool_name = stream_evt.get("toolName").and_then(|v| v.as_str()).unwrap_or("unknown");
                                                eprintln!("\n> Tool call: {tool_name}...");
                                            } else if evt_type == "assistant-round-complete" {
                                                if let Some(content) = stream_evt.get("content").and_then(|v| v.as_str()) {
                                                    if assistant_response_text.is_empty() {
                                                        assistant_response_text.push_str(content);
                                                        if !json_mode && !raw_mode {
                                                            print!("{content}");
                                                            std::io::stdout().flush()?;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    } else if msg_type == "tool-host-activity" {
                                        let phase = msg.get("phase").and_then(|v| v.as_str()).unwrap_or("");
                                        if phase == "end" {
                                            eprintln!("> Tool finished.");
                                        }
                                    } else if msg_type == "result" {
                                        let success = msg.get("response").and_then(|p| p.get("success")).and_then(|v| v.as_bool()).unwrap_or(true);
                                        if !success {
                                            if let Some(err_msg) = msg.get("response").and_then(|p| p.get("error")).and_then(|v| v.as_str()) {
                                                eprintln!("\nAgent error: {err_msg}");
                                            }
                                        }
                                        break;
                                    } else if msg_type == "error" {
                                        if let Some(err_msg) = msg.get("error").and_then(|v| v.as_str()) {
                                            eprintln!("\nAgent error: {err_msg}");
                                        }
                                        break;
                                    } else if msg_type == "worker-diagnostic" {
                                        if let Some(diag_msg) = msg.get("message").and_then(|v| v.as_str()) {
                                            eprintln!("[Sidecar diagnostic] {diag_msg}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(120)) => {
                eprintln!("\nTurn timed out waiting for response.");
                break;
            }
        }
    }

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&json!({
            "response": assistant_response_text,
            "user": user_input,
        }))?);
    } else {
        println!();
    }

    if !assistant_response_text.is_empty() {
        let asst_msg_id = format!("msg-asst-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis());
        messages.push(json!({
            "id": asst_msg_id,
            "role": "assistant",
            "content": assistant_response_text,
            "timestamp": chrono_now_ms(),
        }));
    }

    Ok(())
}

async fn resolve_llm_config(
    client: &RpcClient,
    args: &ChatArgs,
) -> Result<ResolvedLlmConfig, Box<dyn std::error::Error>> {
    // 1. Try to load saved settings from CodePapr DB
    let db_settings = match client.call("db/loadSettings", json!({})).await {
        Ok(res) => res.get("settings").and_then(|v| v.as_str()).and_then(|s| serde_json::from_str::<Value>(s).ok()),
        Err(_) => None,
    };

    // 2. Resolve provider and API key
    let mut provider = args.provider.clone().unwrap_or_default();
    let mut api_key = args.api_key.clone().unwrap_or_default();
    let mut base_url = args.base_url.clone().unwrap_or_default();
    let mut model = args.model.clone().unwrap_or_default();

    // From env vars
    if api_key.is_empty() {
        if let Ok(k) = std::env::var("DEEPSEEK_API_KEY") {
            api_key = k;
            if provider.is_empty() {
                provider = "deepseek".to_string();
            }
        } else if let Ok(k) = std::env::var("OPENAI_API_KEY") {
            api_key = k;
            if provider.is_empty() {
                provider = "openai".to_string();
            }
        } else if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
            api_key = k;
            if provider.is_empty() {
                provider = "claude".to_string();
            }
        }
    }

    // From saved DB settings
    if let Some(settings) = db_settings {
        if provider.is_empty() {
            if let Some(p) = settings.get("provider").and_then(|v| v.as_str()) {
                provider = p.to_string();
            }
        }
        if api_key.is_empty() {
            if let Some(k) = settings.get("apiKey").and_then(|v| v.as_str()) {
                api_key = k.to_string();
            }
        }
        if base_url.is_empty() {
            if let Some(u) = settings.get("baseURL").and_then(|v| v.as_str()) {
                base_url = u.to_string();
            }
        }
        if model.is_empty() {
            if let Some(m) = settings.get("model").and_then(|v| v.as_str()) {
                model = m.to_string();
            }
        }
    }

    if provider.is_empty() {
        provider = "deepseek".to_string();
    }

    let (default_model, default_url, api_format) = match provider.as_str() {
        "deepseek" => ("deepseek-chat", "https://api.deepseek.com", "openai"),
        "claude" => ("claude-3-5-sonnet-20241022", "https://api.anthropic.com", "claude"),
        _ => ("gpt-4o", "https://api.openai.com/v1", "openai"),
    };

    if model.is_empty() {
        model = default_model.to_string();
    }
    if base_url.is_empty() {
        base_url = default_url.to_string();
    }

    if api_key.is_empty() {
        return Err(format!(
            "No API key found for provider '{provider}'.\n\
            Set it via environment variable (e.g. export DEEPSEEK_API_KEY=\"...\") or flag --api-key <KEY>."
        ).into());
    }

    Ok(ResolvedLlmConfig {
        provider,
        model,
        api_key,
        base_url,
        api_format: api_format.to_string(),
    })
}

fn build_worker_settings(config: &ResolvedLlmConfig) -> Value {
    json!({
        "apiMode": if config.provider == "deepseek" { "deepseek" } else { "custom" },
        "apiFormat": config.api_format,
        "provider": config.provider,
        "baseURL": config.base_url,
        "apiKey": config.api_key,
        "model": config.model,
        "fastModelEnabled": false,
        "fastModel": config.model,
        "temperature": 0.3,
        "maxTokens": 4096,
        "maxToolRounds": 15,
        "thinkingEnabled": false,
        "thinkingEffort": "medium",
        "thinkingBudgetTokens": 2048,
        "thinkingPayload": "standard",
        "mentorEnabled": false,
        "exploreTopP": 0.95,
        "exploreMaxTokens": 2048,
        "exploreThinkingEnabled": false,
        "exploreTemperature": 0.3,
        "exploreMaxToolRounds": 8,
        "exploreMaxDepth": 2,
        "exploreModelTier": "primary",
        "scoutTopP": 0.95,
        "scoutMaxTokens": 2048,
        "scoutThinkingEnabled": false,
        "scoutTemperature": 0.3,
        "scoutMaxToolRounds": 8,
        "scoutMaxDepth": 2,
        "scoutModelTier": "primary",
        "appSubAgentModelTier": "primary",
        "appSubAgentThinkingEnabled": false,
        "appSubAgentMaxToolRounds": 8,
        "mcp": { "servers": [] },
        "graphToolTimeoutMs": 30000,
        "toolIpcTimeoutMs": 60000,
        "streamIdleTimeoutMs": 120000,
        "multimodalEnabled": false,
        "multimodalModelTier": "primary",
        "toolOutputInterceptChars": 8000,
        "toolOutputOffloadChars": 16000,
        "toolOutputCeilingChars": 32000,
        "toolOutputPreviewChars": 1000,
        "toolOutputMiddleKeepChars": 1000,
        "pruneOldToolResults": true,
        "pruneProtectRounds": 2,
        "pruneMinChars": 500,
        "toolContextDefaultMode": "auto",
        "toolContextOverrides": {},
        "toolContextSummaryMaxChars": 2000,
        "toolContextAutoThresholdChars": 5000,
        "maxContextTokens": 64000,
        "maxConversationRounds": 25,
        "compactionModel": "fast",
        "compactionMaxTokens": 2048,
        "compactionTemperature": 0.3,
    })
}

fn get_default_cli_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "read",
            "description": "Read file contents from the workspace. Supports startLine and endLine.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string", "description": "Relative file path" },
                    "startLine": { "type": "number", "description": "Start line (1-based)" },
                    "endLine": { "type": "number", "description": "End line (1-based)" },
                    "maxBytes": { "type": "number", "description": "Max bytes to read" },
                },
                "required": ["relativePath"]
            }
        }),
        json!({
            "name": "write",
            "description": "Write entire file content to workspace path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string", "description": "Relative file path" },
                    "content": { "type": "string", "description": "File content to write" },
                },
                "required": ["relativePath", "content"]
            }
        }),
        json!({
            "name": "edit",
            "description": "Exact search and replace modification in a single file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string", "description": "Relative file path" },
                    "search": { "type": "string", "description": "Exact text to find" },
                    "replace": { "type": "string", "description": "Replacement text" },
                },
                "required": ["relativePath", "search", "replace"]
            }
        }),
        json!({
            "name": "list",
            "description": "List files and directories in workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subPath": { "type": "string", "description": "Subpath" },
                    "maxDepth": { "type": "number", "description": "Maximum depth" },
                }
            }
        }),
        json!({
            "name": "grep",
            "description": "Search text patterns in workspace files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text pattern" },
                    "caseSensitive": { "type": "boolean" },
                    "isRegexp": { "type": "boolean" },
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "bash",
            "description": "Execute a shell command in workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to run" },
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "git",
            "description": "Run git status or diff in workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "status, diff, branch" },
                },
                "required": ["action"]
            }
        }),
    ]
}

fn chrono_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
