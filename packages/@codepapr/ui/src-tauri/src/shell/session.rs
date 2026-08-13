use crate::shared::{canonical_workspace, normalize_workspace_filter, unix_millis};
use crate::shell::dangerous::{detect_dangerous_command, detect_dangerous_invocation};
use crate::shell::guard::{
    build_shell_command_line, create_shell_session_id, detect_default_shell,
    find_unquoted_shell_version_constraint, write_shell_payload,
};
use crate::shell::process_tree::{kill_process_tree, prepare_new_process_group, wait_for_child_exit};
use crate::shell::sandbox::sandboxed_command;
use crate::shell::sandbox::{validate_restricted_command, validate_restricted_shell_command};
use crate::shell::types::{
    ManagedShellSession, ShellCloseSessionResult, ShellReadOutputResult, ShellSendInputResult,
    ShellSessionEntry, ShellSessionResult,
};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read},
    path::Path,
    process::Stdio,
    sync::{atomic::AtomicU64, Arc, Mutex, OnceLock},
    thread,
    time::Duration,
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
    let shell = detect_default_shell(shell)?;
    #[cfg(windows)]
    const CREATE_NO_WINDOW_SHELL: u32 = 0x08000000;
    let mut shell_cmd = sandboxed_command(&shell, &[], &workspace, None)?;
    shell_cmd
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    shell_cmd.creation_flags(CREATE_NO_WINDOW_SHELL);
    prepare_new_process_group(&mut shell_cmd);
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
    // 注册表锁内只做校验并取出 stdin 句柄；实际写出在锁外执行。
    // 子进程不读 stdin 时管道缓冲写满会让 write_all 长时间阻塞，
    // 若在注册表锁内执行会卡死所有会话的全部操作。
    let stdin = with_shell_sessions(|sessions| {
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Shell 会话不存在: {session_id}"))?;

        let workspace = Path::new(&session.workspace_path);
        validate_restricted_shell_command(&input, workspace)?;
        crate::shell::path_guard::ensure_command_paths_accessible(workspace, &input, &[])?;

        if let Some(reason) = detect_dangerous_command(&input) {
            return Err(format!(
                "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
            ));
        }

        if let Some(token) = find_unquoted_shell_version_constraint(&input) {
            return Err(format!(
                "检测到未加引号的版本约束 {token:?}。这会在 shell 中被解析成重定向并生成空文件。请把该参数包在引号里后重试，例如 '{token}'。"
            ));
        }

        Ok(Arc::clone(&session.stdin))
    })?;
    write_shell_payload(&session_id, &stdin, input)
}

#[tauri::command]
pub(crate) fn send_shell_command(
    session_id: String,
    command: String,
    args: Option<Vec<String>>,
) -> Result<ShellSendInputResult, String> {
    // 注册表锁内只做校验并取出 stdin 句柄；实际写出在锁外执行（同 send_shell_input）。
    let (stdin_handle, payload) = with_shell_sessions(|sessions| {
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Shell 会话不存在: {session_id}"))?;
        let command_args = args.as_deref().unwrap_or(&[]);
        let workspace = Path::new(&session.workspace_path);
        validate_restricted_command(&command, command_args, workspace)?;
        crate::shell::path_guard::ensure_command_paths_accessible(
            workspace,
            &command,
            args.as_deref().unwrap_or(&[]),
        )?;
        if let Some(reason) = detect_dangerous_invocation(&command, args.as_deref().unwrap_or(&[]))
        {
            return Err(format!(
                "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
            ));
        }
        let payload =
            build_shell_command_line(&session.shell, &command, &args.unwrap_or_default())?;
        Ok((Arc::clone(&session.stdin), payload))
    })?;
    write_shell_payload(&session_id, &stdin_handle, payload)
}

#[tauri::command]
pub(crate) fn close_shell_session(session_id: String) -> Result<ShellCloseSessionResult, String> {
    // 锁内只做移除；kill + 等待退出（最多 3s+）在锁外执行，
    // 否则单个慢退出进程会把所有会话操作卡住。
    let removed = with_shell_sessions(|sessions| Ok(sessions.remove(&session_id)))?;
    let Some(mut session) = removed else {
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
        let _ = kill_process_tree(&mut session.child);
        wait_for_child_exit(&mut session.child, Duration::from_secs(3));
    }

    Ok(ShellCloseSessionResult {
        session_id,
        closed: true,
    })
}

pub(crate) fn stop_all_shell_sessions() {
    // 先在锁内取走全部会话，再在锁外逐个 kill，避免持锁等待进程退出。
    let drained: Vec<ManagedShellSession> = match shell_sessions().lock() {
        Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect(),
        Err(_) => return,
    };
    for mut session in drained {
        let _ = kill_process_tree(&mut session.child);
        wait_for_child_exit(&mut session.child, Duration::from_secs(3));
    }
}
