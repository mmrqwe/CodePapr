use crate::shared::{canonical_workspace, normalize_workspace_filter, unix_millis};
use crate::shell::guard::{
    build_shell_command_line, create_shell_session_id, detect_default_shell,
    find_unquoted_shell_version_constraint, write_shell_payload,
};
use crate::shell::types::{
    ManagedShellSession, ShellCloseSessionResult, ShellReadOutputResult, ShellSendInputResult,
    ShellSessionEntry, ShellSessionResult,
};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    sync::{atomic::AtomicU64, Arc, Mutex, OnceLock},
    thread,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAX_TERMINAL_OUTPUT_LINES: usize = 200;

pub(crate) static SHELL_SESSIONS: OnceLock<Mutex<HashMap<String, ManagedShellSession>>> =
    OnceLock::new();
pub(crate) static SHELL_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(crate) fn shell_sessions() -> &'static Mutex<HashMap<String, ManagedShellSession>> {
    SHELL_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cleanup_finished_shell_sessions(sessions: &mut HashMap<String, ManagedShellSession>) {
    let finished_ids: Vec<String> = sessions
        .iter_mut()
        .filter_map(|(session_id, session)| match session.child.try_wait() {
            Ok(Some(_)) => Some(session_id.clone()),
            Ok(None) => None,
            Err(_) => Some(session_id.clone()),
        })
        .collect();

    for session_id in finished_ids {
        sessions.remove(&session_id);
    }
}

pub(crate) fn with_shell_sessions<T>(
    handler: impl FnOnce(&mut HashMap<String, ManagedShellSession>) -> Result<T, String>,
) -> Result<T, String> {
    let mut sessions = shell_sessions()
        .lock()
        .map_err(|_| "Shell 会话注册表锁定失败".to_string())?;
    cleanup_finished_shell_sessions(&mut sessions);
    handler(&mut sessions)
}

fn append_output_line(tail: &Arc<Mutex<VecDeque<String>>>, line: String, max_lines: usize) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let truncated: String = trimmed.chars().take(400).collect();
    let Ok(mut lines) = tail.lock() else {
        return;
    };

    lines.push_back(truncated);
    while lines.len() > max_lines {
        lines.pop_front();
    }
}

fn append_shell_output_line(output_tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    append_output_line(output_tail, line, MAX_TERMINAL_OUTPUT_LINES);
}

fn spawn_shell_output_reader<R>(
    reader: R,
    output_tail: Arc<Mutex<VecDeque<String>>>,
    stream_label: &'static str,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            match line {
                Ok(content) => {
                    append_shell_output_line(&output_tail, format!("[{stream_label}] {content}"));
                }
                Err(_) => break,
            }
        }
    });
}

pub(crate) fn snapshot_shell_output(output_tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let Ok(lines) = output_tail.lock() else {
        return String::new();
    };

    lines.iter().cloned().collect::<Vec<_>>().join("\n")
}

#[tauri::command]
pub(crate) fn open_shell_session(
    workspace_path: String,
    shell: Option<String>,
) -> Result<ShellSessionResult, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let shell = detect_default_shell(shell);
    #[cfg(windows)]
    const CREATE_NO_WINDOW_SHELL: u32 = 0x08000000;
    let mut shell_cmd = Command::new(&shell);
    shell_cmd
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    shell_cmd.creation_flags(CREATE_NO_WINDOW_SHELL);
    let mut child = shell_cmd
        .spawn()
        .map_err(|err| format!("启动 Shell 会话失败: {err}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法捕获 Shell 标准输入".to_string())?;
    let output_tail = Arc::new(Mutex::new(VecDeque::new()));

    if let Some(stdout) = child.stdout.take() {
        spawn_shell_output_reader(stdout, Arc::clone(&output_tail), "out");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_shell_output_reader(stderr, Arc::clone(&output_tail), "err");
    }

    let session_id = create_shell_session_id()?;
    let started_at = unix_millis()?;
    let workspace_path = workspace.to_string_lossy().to_string();

    with_shell_sessions(|sessions| {
        sessions.insert(
            session_id.clone(),
            ManagedShellSession {
                child,
                stdin: Arc::new(Mutex::new(stdin)),
                shell: shell.clone(),
                workspace_path: workspace_path.clone(),
                started_at,
                output_tail: Arc::clone(&output_tail),
            },
        );
        Ok(())
    })?;

    Ok(ShellSessionResult {
        session_id,
        shell,
        workspace_path,
        started_at,
        output_tail: snapshot_shell_output(&output_tail),
    })
}

#[tauri::command]
pub(crate) fn list_shell_sessions(
    workspace_path: Option<String>,
) -> Result<Vec<ShellSessionEntry>, String> {
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    with_shell_sessions(|sessions| {
        let mut entries: Vec<ShellSessionEntry> = sessions
            .iter()
            .filter(|(_, session)| {
                workspace_filter
                    .as_ref()
                    .map(|filter| &session.workspace_path == filter)
                    .unwrap_or(true)
            })
            .map(|(session_id, session)| ShellSessionEntry {
                session_id: session_id.clone(),
                shell: session.shell.clone(),
                workspace_path: session.workspace_path.clone(),
                started_at: session.started_at,
                output_tail: snapshot_shell_output(&session.output_tail),
                active: true,
            })
            .collect();

        entries.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });

        Ok(entries)
    })
}

#[tauri::command]
pub(crate) fn read_shell_output(session_id: String) -> Result<ShellReadOutputResult, String> {
    with_shell_sessions(|sessions| {
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Shell 会话不存在: {session_id}"))?;

        Ok(ShellReadOutputResult {
            session_id,
            output_tail: snapshot_shell_output(&session.output_tail),
            active: true,
        })
    })
}

#[tauri::command]
pub(crate) fn send_shell_input(
    session_id: String,
    input: String,
) -> Result<ShellSendInputResult, String> {
    with_shell_sessions(|sessions| {
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Shell 会话不存在: {session_id}"))?;

        if let Some(token) = find_unquoted_shell_version_constraint(&input) {
            return Err(format!(
                "检测到未加引号的版本约束 {token:?}。这会在 shell 中被解析成重定向并生成空文件。请把该参数包在引号里后重试，例如 '{token}'。"
            ));
        }

        write_shell_payload(&session_id, session, input)
    })
}

#[tauri::command]
pub(crate) fn send_shell_command(
    session_id: String,
    command: String,
    args: Option<Vec<String>>,
) -> Result<ShellSendInputResult, String> {
    with_shell_sessions(|sessions| {
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Shell 会话不存在: {session_id}"))?;
        let payload =
            build_shell_command_line(&session.shell, &command, &args.unwrap_or_default())?;
        write_shell_payload(&session_id, session, payload)
    })
}

#[tauri::command]
pub(crate) fn close_shell_session(session_id: String) -> Result<ShellCloseSessionResult, String> {
    with_shell_sessions(|sessions| {
        let Some(mut session) = sessions.remove(&session_id) else {
            return Ok(ShellCloseSessionResult {
                session_id,
                closed: false,
            });
        };

        let still_running = match session.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => true,
        };

        if still_running {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }

        Ok(ShellCloseSessionResult {
            session_id,
            closed: true,
        })
    })
}
