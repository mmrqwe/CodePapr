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
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    sync::mpsc,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) const MAX_COMMAND_SECONDS: u64 = 600;
pub(crate) const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_BACKGROUND_LOG_LINES: usize = 48;
/// 命令结束后读线程收尾的等待上限（见 collect_command_output_with_cancel）。
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// 前台命令（run_workspace_command / run_workspace_shell_command）的取消令牌表：
/// token → 取消标志。前端在信号 abort（会话取消 / 工具超时）时调用
/// cancel_running_command 置位，阻塞等待的命令轮询到标志后立即杀进程树。
/// 旧实现没有取消通道：Tauri invoke 无法中途取消，bash 等长命令会在
/// 超时/取消后继续在后台跑完，副作用滞后落地。
static ACTIVE_COMMAND_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn command_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE_COMMAND_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一个可取消前台命令的取消标志；返回的 Arc 用于轮询，token 用于
/// cancel_running_command 远程置位。命令结束后必须调用
/// `unregister_command_cancel(token)` 清理。
fn register_command_cancel(token: &str) -> Option<Arc<AtomicBool>> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let flag = Arc::new(AtomicBool::new(false));
    command_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(token.to_string(), flag.clone());
    Some(flag)
}

fn unregister_command_cancel(token: &str) {
    command_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(token);
}

#[tauri::command]
pub(crate) fn cancel_running_command(token: String) -> Result<bool, String> {
    let flag = command_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(token.trim());
    match flag {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

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
    let finished: Vec<(u32, Option<std::process::ExitStatus>, String, String)> = processes
        .iter_mut()
        .filter_map(|(pid, process)| match process.child.try_wait() {
            // 注意：Ok(None) = 进程仍存活，绝不能当作已退出（会把活进程踢出注册表）
            Ok(Some(status)) => Some((
                *pid,
                Some(status),
                process.command.clone(),
                process.workspace_path.clone(),
            )),
            Ok(None) => None,
            Err(_) => Some((*pid, None, process.command.clone(), process.workspace_path.clone())),
        })
        .collect();

    for (pid, status, command, workspace_path) in finished {
        processes.remove(&pid);
        // 能走到这里的都是「未经 stop 请求的意外退出」（stop_* 会先移除条目再杀）。
        // 退出信号是辨认凶手的第一证据：signal=9 即被外部 SIGKILL。
        let (code, signal) = match status {
            Some(status) => (status.code(), exit_signal(status)),
            None => (None, None),
        };
        let hint = match (code, signal) {
            (_, Some(9)) => "SIGKILL：系统内存压力或外部进程所杀",
            (_, Some(_)) => "被信号终止（非宿主 stop 路径）",
            (Some(0), _) => "自行退出 code=0（查应用日志，常见于 EADDRINUSE 端口被占）",
            (Some(_), _) => "自行退出（非零码=应用自身错误）",
            (None, None) => "未知退出状态",
        };
        log_background_event(
            &workspace_path,
            format!(
                "unexpected-exit pid={pid} command={command} code={code:?} signal={signal:?} (no stop request; {hint})"
            ),
        );
    }
}

#[cfg(unix)]
fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: std::process::ExitStatus) -> Option<i32> {
    None
}

/// UI 侧事件埋点：谁清空了 openedAppId / 停了 app，全部带调用栈落盘，
/// 与 spawn/stop 同文件，时间线对齐勘验。
#[tauri::command]
pub(crate) fn log_ui_event(workspace_path: String, message: String) {
    log_background_event(&workspace_path, format!("ui-event {message}"));
}

/// 进程是否仍存活（注册表视角：条目存在且未退出）。
/// 端口探测只是间接证据（IPv4/IPv6 语义、瞬时窗口都可能误判），
/// 进程存活才是判定后端生死的直接证据。
#[tauri::command]
pub(crate) fn background_process_alive(pid: u32) -> bool {
    with_background_processes(|processes| {
        Ok(match processes.get_mut(&pid) {
            Some(process) => matches!(process.child.try_wait(), Ok(None)),
            None => false,
        })
    })
    .unwrap_or(false)
}

/// 后台进程生命周期日志：<workspace>/.CodePapr/logs/background-lifecycle.log。
/// spawn / stop请求 / 意外退出全部落盘；进程被「无声杀死」时这里是唯一勘验现场。
fn log_background_event(workspace_path: &str, message: String) {
    let path = Path::new(workspace_path)
        .join(".CodePapr")
        .join("logs")
        .join("background-lifecycle.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!("{} {message}\n", utc_timestamp());
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

fn utc_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (h, m, s) = (secs % 86400 / 3600, secs % 3600 / 60, secs % 60);
    let days = secs / 86400;
    // days-since-epoch → 公历（Howard Hinnant 的 civil_from_days 算法）
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{:03}Z",
        now.subsec_millis()
    )
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
    cancel_token: Option<String>,
) -> Result<CommandResult, String> {
    run_blocking_workspace_task(move || {
        run_workspace_command_impl(workspace_path, command, args, timeout_seconds, workdir, cancel_token)
    })
    .await
}

pub(crate) fn run_workspace_command_impl(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
    workdir: Option<String>,
    cancel_token: Option<String>,
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
    super::path_guard::ensure_command_paths_accessible(&workspace, &command, &args)?;
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

    let cancel_flag = register_command_cancel(cancel_token.as_deref().unwrap_or(""));
    let collected =
        collect_command_output_with_cancel(child, timeout, cancel_flag.clone());
    // 无论成功失败都必须注销取消令牌，否则错误路径会让条目永久泄漏。
    if let Some(token) = cancel_token.as_deref() {
        unregister_command_cancel(token);
    }
    let (status, stdout, stderr, timed_out) = collected?;

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

/// 等待子进程退出并收集 stdout/stderr；超时或 cancel_flag 置位（前端取消）
/// 则杀进程树终止。只保留上限内的输出，但持续读到底：旧实现 read_to_end
/// 无上限，超时窗口内输出几百 MB 会先撑爆内存；只读到上限就停又会让子进程
/// 阻塞在满管道上。取消与超时统一标记为 timed_out（命令未正常完成）。
/// 错误路径上必须回收子进程：Rust 的 Child drop 不会 wait，
/// 直接返回 Err 会留下僵尸进程直到宿主退出。先杀进程树再有界等待。
fn reap_child_quietly(child: &mut Child) {
    let _ = kill_process_tree(child);
    wait_for_child_exit(child, Duration::from_secs(3));
}

fn collect_command_output_with_cancel(
    mut child: Child,
    timeout: Duration,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<(Option<i32>, String, String, bool), String> {
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            reap_child_quietly(&mut child);
            return Err("无法捕获命令标准输出".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            reap_child_quietly(&mut child);
            return Err("无法捕获命令标准错误".to_string());
        }
    };

    // 读线程把结果发回通道而非 join 直接取：孙进程逃逸进程组后仍持有管道
    // 写端时，读线程永远等不到 EOF（join 永久阻塞）。通道版可用 recv_timeout
    // 有界等待（与 lsp_managed_tools.rs 的同类修复一致）。
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();
    let stdout_handle = thread::spawn(move || {
        let _ = stdout_tx.send(drain_capped_output(stdout));
    });
    let stderr_handle = thread::spawn(move || {
        let _ = stderr_tx.send(drain_capped_output(stderr));
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status;
    loop {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                status = exit_status.code();
                break;
            }
            Ok(None) => {}
            Err(err) => {
                reap_child_quietly(&mut child);
                return Err(format!("等待命令失败: {err}"));
            }
        }
        let cancelled = cancel_flag
            .as_ref()
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false);
        if cancelled || started.elapsed() >= timeout {
            timed_out = true;
            if let Err(err) = kill_process_tree(&mut child) {
                reap_child_quietly(&mut child);
                return Err(format!("终止超时/取消命令失败: {err}"));
            }
            match child.wait() {
                Ok(exit_status) => {
                    status = exit_status.code();
                    break;
                }
                Err(err) => {
                    reap_child_quietly(&mut child);
                    return Err(format!("等待命令退出失败: {err}"));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // 有界等待读线程收尾：超时则放弃本轮输出（线程在管道最终关闭时自行
    // 退出），绝不因 join 无超时挂起命令调用方。
    let stdout = stdout_rx.recv_timeout(READER_DRAIN_TIMEOUT).unwrap_or_default();
    let stderr = stderr_rx.recv_timeout(READER_DRAIN_TIMEOUT).unwrap_or_default();
    drop(stdout_handle);
    drop(stderr_handle);

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
    cancel_token: Option<String>,
) -> Result<CommandResult, String> {
    run_blocking_workspace_task(move || {
        run_workspace_shell_command_impl(workspace_path, command, workdir, timeout_seconds, sandbox, cancel_token)
    })
    .await
}

pub(crate) fn run_workspace_shell_command_impl(
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    timeout_seconds: Option<u64>,
    sandbox: Option<SandboxAccessArgs>,
    cancel_token: Option<String>,
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
    super::path_guard::ensure_command_paths_accessible(&workspace, &command, &[])?;
    let cwd = resolve_shell_workdir(&workspace, workdir)?;
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, MAX_COMMAND_SECONDS));
    let mut cmd = build_shell_spawn_command(&command, &cwd, &workspace, sandbox.map(Into::into))?;
    let child = cmd.spawn().map_err(|err| format!("启动命令失败: {err}"))?;
    let cancel_flag = register_command_cancel(cancel_token.as_deref().unwrap_or(""));
    let collected = collect_command_output_with_cancel(child, timeout, cancel_flag);
    // 无论成功失败都必须注销取消令牌，否则错误路径会让条目永久泄漏。
    if let Some(token) = cancel_token.as_deref() {
        unregister_command_cancel(token);
    }
    let (status, stdout, stderr, timed_out) = collected?;
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
    super::path_guard::ensure_command_paths_accessible(&workspace, &command, &args)?;
    let preview_url = preview_url
        .map(|raw_url| parse_browser_url(&raw_url))
        .transpose()?;
    let workspace_path = workspace.to_string_lossy().to_string();

    #[cfg(windows)]
    const CREATE_NO_WINDOW_BG: u32 = 0x08000000;
    // sandboxed_command 内部已把 args 追加到 Command（macOS: sandbox-exec -p <profile>
    // <program> <args...>；其他平台: <program> <args...>），此处不得再次 .args(&args)，
    // 否则所有后台命令都会以重复的 argv 启动（如 `node server.js server.js`）。
    let mut bg_cmd = sandboxed_command(&command, &args, &workspace, sandbox.map(Into::into))?;
    bg_cmd
        // GUI 壳进程的 PATH 只有系统目录（无 /opt/homebrew/bin 等），不注入则
        // sandbox-exec 里 exec "node"/"python" 直接失败，后端进程秒退且无任何日志。
        .env("PATH", expanded_path())
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

    log_background_event(
        &workspace_path,
        format!(
            "spawn pid={pid} command={command} args={args:?} preview_url={preview_url:?}"
        ),
    );

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
    super::path_guard::ensure_command_paths_accessible(&workspace, &command, &[])?;
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
pub(crate) fn stop_background_process(
    pid: u32,
    source: Option<String>,
) -> Result<StopBackgroundProcessResult, String> {
    let source = source.unwrap_or_else(|| "unknown".to_string());
    // 锁内只做日志记录与移除；kill + 等待退出（最多 3s+）在锁外执行。
    // 旧实现持锁等待进程退出，单个慢退出进程会把所有后台进程的
    // list/spawn/stop 全部卡住（stop-all 场景为 N 倍）。
    // 代价：kill 期间进程不再出现在 list 中（短暂的可见性窗口），
    // 相比全局阻塞是可接受的取舍。
    let removed = with_background_processes(|processes| {
        let Some(process) = processes.get(&pid) else {
            return Ok(None);
        };

        log_background_event(
            &process.workspace_path,
            format!(
                "stop-requested pid={pid} command={} source={source}",
                process.command
            ),
        );

        Ok(processes.remove(&pid))
    })?;

    let Some(mut process) = removed else {
        return Ok(StopBackgroundProcessResult {
            pid,
            stopped: false,
            reason: Some("not-found".to_string()),
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
        reason: if still_running {
            Some("kill-failed".to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
pub(crate) fn stop_all_background_processes(
    workspace_path: Option<String>,
    source: Option<String>,
) -> Result<StopAllBackgroundProcessesResult, String> {
    let source = source.unwrap_or_else(|| "unknown".to_string());
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    // 锁内只做日志记录与批量移除；kill + 等待在锁外逐个执行（同 stop_background_process）。
    let removed: Vec<ManagedBackgroundProcess> = with_background_processes(|processes| {
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

        let mut removed = Vec::new();
        for pid in target_pids {
            if let Some(process) = processes.get(&pid) {
                log_background_event(
                    &process.workspace_path,
                    format!(
                        "stop-all-requested pid={pid} command={} source={source}",
                        process.command
                    ),
                );
            }
            if let Some(process) = processes.remove(&pid) {
                removed.push(process);
            }
        }

        Ok(removed)
    })?;

    let mut stopped = 0usize;
    for mut process in removed {
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

    Ok(StopAllBackgroundProcessesResult { stopped })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn make_entry(child: Child) -> ManagedBackgroundProcess {
        ManagedBackgroundProcess {
            child,
            command: "sleep".to_string(),
            args: vec!["30".to_string()],
            workspace_path: std::env::temp_dir().to_string_lossy().to_string(),
            started_at: 0,
            preview_url: None,
            log_tail: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    /// 回归：cleanup 绝不能把仍存活的进程踢出注册表。
    /// 此前 `match try_wait() { Ok(status) => ... }` 误匹配 Ok(None)（存活），
    /// 导致运行中的后端被登记为 unexpected-exit，UI 误报「app 已退出」。
    #[test]
    fn cleanup_keeps_live_processes() {
        let mut processes = HashMap::new();
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep should spawn");
        let pid = child.id();
        processes.insert(pid, make_entry(child));

        cleanup_finished_background_processes(&mut processes);

        assert!(
            processes.contains_key(&pid),
            "live process must survive cleanup"
        );

        // 清理：杀掉测试进程
        if let Some(mut entry) = processes.remove(&pid) {
            let _ = entry.child.kill();
            let _ = entry.child.wait();
        }
    }

    /// 已退出的进程必须被清理，且其退出信息可被记录。
    #[test]
    fn cleanup_reaps_finished_processes() {
        let mut processes = HashMap::new();
        let child = Command::new("true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("true should spawn");
        let pid = child.id();
        processes.insert(pid, make_entry(child));

        // 等待子进程退出
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(entry) = processes.get_mut(&pid) {
                if matches!(entry.child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
            if Instant::now() >= deadline {
                panic!("true should exit quickly");
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        cleanup_finished_background_processes(&mut processes);

        assert!(
            !processes.contains_key(&pid),
            "finished process must be reaped"
        );
    }
}
