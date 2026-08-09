use crate::shared::{
    canonical_workspace, ensure_path_accessible, expanded_path, normalize_workspace_filter,
    parse_browser_url, run_blocking_workspace_task, unix_millis,
};
use crate::shell::dangerous::{detect_dangerous_command, detect_dangerous_invocation};
use crate::shell::process_tree::{kill_process_tree, prepare_new_process_group, wait_for_child_exit};
use crate::shell::sandbox::{
    sandboxed_command, sandboxed_shell_command, validate_restricted_command,
    validate_restricted_shell_command, SandboxAccess, SandboxAccessArgs,
};
use crate::shell::types::{
    BackgroundCommandResult, BackgroundProcessEntry, CommandResult, ManagedBackgroundProcess,
    StopAllBackgroundProcessesResult, StopBackgroundProcessResult,
};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) const MAX_COMMAND_SECONDS: u64 = 600;
pub(crate) const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_BACKGROUND_LOG_LINES: usize = 48;
pub(crate) const BLOCKED_COMMANDS: &[&str] = &[
    "bash",
    "sh",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "sudo",
    "su",
    "doas",
    "login",
    "ssh",
    "scp",
    "sftp",
    "osascript",
];
const SHELL_SCRIPT_EXTENSIONS: [&str; 6] = [".sh", ".bash", ".zsh", ".command", ".ksh", ".fish"];

pub(crate) static BACKGROUND_PROCESSES: OnceLock<Mutex<HashMap<u32, ManagedBackgroundProcess>>> =
    OnceLock::new();

pub(crate) fn background_processes() -> &'static Mutex<HashMap<u32, ManagedBackgroundProcess>> {
    BACKGROUND_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cleanup_finished_background_processes(
    processes: &mut HashMap<u32, ManagedBackgroundProcess>,
) {
    let finished_pids: Vec<u32> = processes
        .iter_mut()
        .filter_map(|(pid, process)| match process.child.try_wait() {
            Ok(Some(_)) => Some(*pid),
            Ok(None) => None,
            Err(_) => Some(*pid),
        })
        .collect();

    for pid in finished_pids {
        processes.remove(&pid);
    }
}

pub(crate) fn with_background_processes<T>(
    handler: impl FnOnce(&mut HashMap<u32, ManagedBackgroundProcess>) -> Result<T, String>,
) -> Result<T, String> {
    let mut processes = background_processes()
        .lock()
        .map_err(|_| "后台进程注册表锁定失败".to_string())?;
    cleanup_finished_background_processes(&mut processes);
    handler(&mut processes)
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

fn append_background_log_line(log_tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    append_output_line(log_tail, line, MAX_BACKGROUND_LOG_LINES);
}

fn spawn_background_log_reader<R>(
    reader: R,
    log_tail: Arc<Mutex<VecDeque<String>>>,
    stream_label: &'static str,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            match line {
                Ok(content) => {
                    append_background_log_line(&log_tail, format!("[{stream_label}] {content}"));
                }
                Err(_) => break,
            }
        }
    });
}

pub(crate) fn snapshot_background_log_tail(log_tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let Ok(lines) = log_tail.lock() else {
        return String::new();
    };

    lines.iter().cloned().collect::<Vec<_>>().join("\n")
}

fn command_allowed(command: &str) -> bool {
    let command_name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    !BLOCKED_COMMANDS.contains(&command_name)
}

fn looks_like_shell_script(command: &str) -> bool {
    let ext = Path::new(command)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()));
    ext.as_deref()
        .map(|e| SHELL_SCRIPT_EXTENSIONS.contains(&e))
        .unwrap_or(false)
}

pub(crate) fn scan_script_for_version_constraint(
    workspace: &Path,
    command: &str,
) -> Option<String> {
    if !looks_like_shell_script(command) {
        return None;
    }
    let script_path = {
        let p = Path::new(command);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            workspace.join(p)
        }
    };
    let content = match fs::read_to_string(&script_path) {
        Ok(c) if c.len() <= 500_000 => c,
        _ => return None,
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(found) = super::guard::find_unquoted_shell_version_constraint(line) {
            return Some(found);
        }
    }
    None
}

#[tauri::command]
pub(crate) async fn run_workspace_command(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
    workdir: Option<String>,
) -> Result<CommandResult, String> {
    run_blocking_workspace_task(move || {
        run_workspace_command_impl(workspace_path, command, args, timeout_seconds, workdir)
    })
    .await
}

pub(crate) fn run_workspace_command_impl(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
    workdir: Option<String>,
) -> Result<CommandResult, String> {
    if !command_allowed(&command) {
        return Err(format!(
            "命令 `{command}` 被安全策略阻止。已阻止的入口: {}",
            BLOCKED_COMMANDS.join(", ")
        ));
    }
    if let Some(reason) = detect_dangerous_invocation(&command, args.as_deref().unwrap_or(&[])) {
        return Err(format!(
            "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
        ));
    }

    let workspace = canonical_workspace(&workspace_path)?;

    if let Some(constraint) = scan_script_for_version_constraint(&workspace, &command) {
        return Err(format!(
            "脚本 `{command}` 包含未加引号的版本约束 `{constraint}`，\
            shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。\
            请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。"
        ));
    }

    let args = args.unwrap_or_default();
    validate_restricted_command(&command, &args, &workspace)?;
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, MAX_COMMAND_SECONDS));
    // 嵌套项目（如子目录里的 go.mod）需要在模块目录内执行，否则命令会跑错模块。
    let cwd = resolve_shell_workdir(&workspace, workdir)?;

    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = sandboxed_command(&command, &args, &workspace, None)?;
    cmd
        .env("PATH", expanded_path())
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    prepare_new_process_group(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Ok(CommandResult {
                command,
                args,
                status: Some(-1),
                stdout: String::new(),
                stderr: format!("启动命令失败: {err}"),
                timed_out: false,
            });
        }
    };

    let (status, stdout, stderr, timed_out) = collect_command_output(child, timeout)?;

    Ok(CommandResult {
        command,
        args,
        status,
        stdout,
        stderr,
        timed_out,
    })
}

/// 等待子进程退出并收集 stdout/stderr；超时则终止进程并标记 timed_out。
/// 只保留上限内的输出，但持续读到底：旧实现 read_to_end 无上限，超时窗口内
/// 输出几百 MB 会先撑爆内存；只读到上限就停又会让子进程阻塞在满管道上。
pub(crate) fn drain_capped_output(mut reader: impl Read) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buffer.len() < MAX_OUTPUT_BYTES {
                    let take = (MAX_OUTPUT_BYTES - buffer.len()).min(n);
                    buffer.extend_from_slice(&chunk[..take]);
                }
            }
            Err(_) => break,
        }
    }
    buffer
}

/// 命令输出解码：UTF-8 直通，非 UTF-8（GBK 等）走编码探测兜底；
/// 二进制/无法解码时退回 lossy，保证始终有输出可见。
fn decode_command_output(bytes: &[u8]) -> String {
    crate::workspace_fs::read::decode_text_bytes(bytes.to_vec())
        .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
}

fn collect_command_output(
    mut child: Child,
    timeout: Duration,
) -> Result<(Option<i32>, String, String, bool), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获命令标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获命令标准错误".to_string())?;

    let stdout_handle = thread::spawn(move || drain_capped_output(stdout));
    let stderr_handle = thread::spawn(move || drain_capped_output(stderr));

    let started = Instant::now();
    let mut timed_out = false;
    let status;
    loop {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|err| format!("等待命令失败: {err}"))?
        {
            status = exit_status.code();
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            kill_process_tree(&mut child)
                .map_err(|err| format!("终止超时命令失败: {err}"))?;
            status = child
                .wait()
                .map_err(|err| format!("等待超时命令退出失败: {err}"))?
                .code();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let stdout = stdout_handle
        .join()
        .map_err(|_| "读取标准输出线程异常".to_string())?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "读取标准错误线程异常".to_string())?;

    let stdout_bytes = if stdout.len() > MAX_OUTPUT_BYTES {
        &stdout[..MAX_OUTPUT_BYTES]
    } else {
        &stdout
    };
    let stderr_bytes = if stderr.len() > MAX_OUTPUT_BYTES {
        &stderr[..MAX_OUTPUT_BYTES]
    } else {
        &stderr
    };

    Ok((
        status,
        decode_command_output(stdout_bytes),
        decode_command_output(stderr_bytes),
        timed_out,
    ))
}

/// 解析 bash 工具的工作目录：相对路径基于 workspace 解析，绝对路径直接使用；缺省为 workspace 根。
fn resolve_shell_workdir(workspace: &Path, workdir: Option<String>) -> Result<PathBuf, String> {
    match workdir.map(|w| w.trim().to_string()).filter(|w| !w.is_empty()) {
        Some(w) => {
            let p = Path::new(&w);
            let resolved = if p.is_absolute() {
                p.to_path_buf()
            } else {
                workspace.join(p)
            };
            let canonical = fs::canonicalize(&resolved)
                .map_err(|_| format!("工作目录不存在: {}", resolved.display()))?;
            if !canonical.is_dir() {
                return Err(format!("工作目录不是目录: {}", resolved.display()));
            }
            ensure_path_accessible(workspace, &canonical)?;
            Ok(canonical)
        }
        None => Ok(workspace.to_path_buf()),
    }
}

/// 构建「穿过 shell 执行」的 Command：unix 用 $SHELL -c（缺省 /bin/bash），windows 用 cmd /C。
fn build_shell_spawn_command(
    command: &str,
    cwd: &Path,
    workspace: &Path,
    access: Option<SandboxAccess>,
) -> Result<Command, String> {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW_SHELL: u32 = 0x08000000;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd.creation_flags(CREATE_NO_WINDOW_SHELL);
        cmd.current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_new_process_group(&mut cmd);
        Ok(cmd)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = sandboxed_shell_command(&shell, command, workspace, access)?;
        cmd.current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_new_process_group(&mut cmd);
        Ok(cmd)
    }
}

#[tauri::command]
pub(crate) async fn run_workspace_shell_command(
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    timeout_seconds: Option<u64>,
    sandbox: Option<SandboxAccessArgs>,
) -> Result<CommandResult, String> {
    run_blocking_workspace_task(move || {
        run_workspace_shell_command_impl(workspace_path, command, workdir, timeout_seconds, sandbox)
    })
    .await
}

pub(crate) fn run_workspace_shell_command_impl(
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    timeout_seconds: Option<u64>,
    sandbox: Option<SandboxAccessArgs>,
) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }
    if let Some(reason) = detect_dangerous_command(&command) {
        return Err(format!(
            "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
        ));
    }
    let workspace = canonical_workspace(&workspace_path)?;
    validate_restricted_shell_command(&command, &workspace)?;
    let cwd = resolve_shell_workdir(&workspace, workdir)?;
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, MAX_COMMAND_SECONDS));
    let mut cmd = build_shell_spawn_command(&command, &cwd, &workspace, sandbox.map(Into::into))?;
    let child = cmd.spawn().map_err(|err| format!("启动命令失败: {err}"))?;
    let (status, stdout, stderr, timed_out) = collect_command_output(child, timeout)?;
    Ok(CommandResult {
        command,
        args: Vec::new(),
        status,
        stdout,
        stderr,
        timed_out,
    })
}

#[tauri::command]
pub(crate) fn start_workspace_background_command(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    preview_url: Option<String>,
    sandbox: Option<SandboxAccessArgs>,
) -> Result<BackgroundCommandResult, String> {
    if !command_allowed(&command) {
        return Err(format!(
            "命令 `{command}` 被安全策略阻止。已阻止的入口: {}",
            BLOCKED_COMMANDS.join(", ")
        ));
    }
    if let Some(reason) = detect_dangerous_invocation(&command, args.as_deref().unwrap_or(&[])) {
        return Err(format!(
            "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
        ));
    }

    let workspace = canonical_workspace(&workspace_path)?;

    if let Some(constraint) = scan_script_for_version_constraint(&workspace, &command) {
        return Err(format!(
            "脚本 `{command}` 包含未加引号的版本约束 `{constraint}`，\
            shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。\
            请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。"
        ));
    }

    let args = args.unwrap_or_default();
    validate_restricted_command(&command, &args, &workspace)?;
    let preview_url = preview_url
        .map(|raw_url| parse_browser_url(&raw_url))
        .transpose()?;
    let workspace_path = workspace.to_string_lossy().to_string();

    #[cfg(windows)]
    const CREATE_NO_WINDOW_BG: u32 = 0x08000000;
    let mut bg_cmd = sandboxed_command(&command, &args, &workspace, sandbox.map(Into::into))?;
    bg_cmd
        .args(&args)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    bg_cmd.creation_flags(CREATE_NO_WINDOW_BG);
    prepare_new_process_group(&mut bg_cmd);

    spawn_and_register_background(workspace_path, command, args, preview_url, bg_cmd)
}

/// 启动子进程并登记到后台进程注册表（含去重、日志捕获）。供直接 spawn 与 shell spawn 复用。
fn spawn_and_register_background(
    workspace_path: String,
    command: String,
    args: Vec<String>,
    preview_url: Option<String>,
    mut cmd: Command,
) -> Result<BackgroundCommandResult, String> {
    if let Some(existing_result) = with_background_processes(|processes| {
        let mut stale_pids: Vec<u32> = Vec::new();
        let mut existing: Option<BackgroundCommandResult> = None;
        for (pid, process) in processes.iter_mut() {
            // Dedup key includes preview_url (which carries the per-app port) so
            // two apps in the same workspace running an identical command (e.g.
            // `node server.js`) on different ports are NOT collapsed into one
            // shared process that one app's stop/delete would kill for both.
            if process.workspace_path == workspace_path
                && process.command == command
                && process.args == args
                && process.preview_url == preview_url
            {
                // 只有进程确实存活才算命中；死条目剔除后走重新 spawn，
                // 否则命中 stale pid 会导致 app_start 永远不再真正拉起进程。
                if matches!(process.child.try_wait(), Ok(None)) {
                    existing = Some(BackgroundCommandResult {
                        command: command.clone(),
                        args: args.clone(),
                        pid: Some(*pid),
                        started: false,
                        preview_url: process.preview_url.clone(),
                    });
                    break;
                }
                stale_pids.push(*pid);
            }
        }
        for pid in stale_pids {
            processes.remove(&pid);
        }
        Ok(existing)
    })? {
        return Ok(existing_result);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动后台命令失败: {err}"))?;

    let log_tail = Arc::new(Mutex::new(VecDeque::new()));

    if let Some(stdout) = child.stdout.take() {
        spawn_background_log_reader(stdout, Arc::clone(&log_tail), "out");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_background_log_reader(stderr, Arc::clone(&log_tail), "err");
    }

    let pid = child.id();
    let started_at = unix_millis()?;

    with_background_processes(|processes| {
        processes.insert(
            pid,
            ManagedBackgroundProcess {
                child,
                command: command.clone(),
                args: args.clone(),
                workspace_path: workspace_path.clone(),
                started_at,
                preview_url: preview_url.clone(),
                log_tail: Arc::clone(&log_tail),
            },
        );
        Ok(())
    })?;

    Ok(BackgroundCommandResult {
        command,
        args,
        pid: Some(pid),
        started: true,
        preview_url,
    })
}

#[tauri::command]
pub(crate) fn start_workspace_shell_background_command(
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    preview_url: Option<String>,
) -> Result<BackgroundCommandResult, String> {
    if command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }
    if let Some(reason) = detect_dangerous_command(&command) {
        return Err(format!(
            "高危命令被拦截：{reason}。如确需执行，请用户在终端手动运行。"
        ));
    }
    let workspace = canonical_workspace(&workspace_path)?;
    validate_restricted_shell_command(&command, &workspace)?;
    let cwd = resolve_shell_workdir(&workspace, workdir)?;
    let preview_url = preview_url
        .map(|raw_url| parse_browser_url(&raw_url))
        .transpose()?;
    let workspace_path = workspace.to_string_lossy().to_string();
    let cmd = build_shell_spawn_command(&command, &cwd, &workspace, None)?;
    spawn_and_register_background(workspace_path, command, Vec::new(), preview_url, cmd)
}

#[tauri::command]
pub(crate) fn list_background_processes(
    workspace_path: Option<String>,
) -> Result<Vec<BackgroundProcessEntry>, String> {
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    with_background_processes(|processes| {
        let mut entries: Vec<BackgroundProcessEntry> = processes
            .iter()
            .filter(|(_, process)| {
                workspace_filter
                    .as_ref()
                    .map(|filter| &process.workspace_path == filter)
                    .unwrap_or(true)
            })
            .map(|(pid, process)| BackgroundProcessEntry {
                pid: *pid,
                command: process.command.clone(),
                args: process.args.clone(),
                workspace_path: process.workspace_path.clone(),
                started_at: process.started_at,
                preview_url: process.preview_url.clone(),
                log_tail: snapshot_background_log_tail(&process.log_tail),
            })
            .collect();

        entries.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.pid.cmp(&right.pid))
        });

        Ok(entries)
    })
}

#[tauri::command]
pub(crate) fn stop_background_process(pid: u32) -> Result<StopBackgroundProcessResult, String> {
    with_background_processes(|processes| {
        let Some(mut process) = processes.remove(&pid) else {
            return Ok(StopBackgroundProcessResult {
                pid,
                stopped: false,
            });
        };

        let still_running = match process.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => true,
        };

        if still_running {
            let _ = kill_process_tree(&mut process.child);
            wait_for_child_exit(&mut process.child, Duration::from_secs(3));
        }

        Ok(StopBackgroundProcessResult {
            pid,
            stopped: still_running,
        })
    })
}

#[tauri::command]
pub(crate) fn stop_all_background_processes(
    workspace_path: Option<String>,
) -> Result<StopAllBackgroundProcessesResult, String> {
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    with_background_processes(|processes| {
        let target_pids: Vec<u32> = processes
            .iter()
            .filter(|(_, process)| {
                workspace_filter
                    .as_ref()
                    .map(|filter| &process.workspace_path == filter)
                    .unwrap_or(true)
            })
            .map(|(pid, _)| *pid)
            .collect();

        let mut stopped = 0usize;

        for pid in target_pids {
            if let Some(mut process) = processes.remove(&pid) {
                let still_running = match process.child.try_wait() {
                    Ok(Some(_)) => false,
                    Ok(None) => true,
                    Err(_) => true,
                };

                if still_running {
                    let _ = kill_process_tree(&mut process.child);
                    wait_for_child_exit(&mut process.child, Duration::from_secs(3));
                    stopped += 1;
                }
            }
        }

        Ok(StopAllBackgroundProcessesResult { stopped })
    })
}
