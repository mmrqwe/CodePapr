use serde::Serialize;
use std::{
    collections::VecDeque,
    process::{Child, ChildStdin},
    sync::{Arc, Mutex},
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command: String,
    pub args: Vec<String>,
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommandResult {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) pid: Option<u32>,
    pub(crate) started: bool,
    pub(crate) preview_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessEntry {
    pub(crate) pid: u32,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) preview_url: Option<String>,
    pub(crate) log_tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopBackgroundProcessResult {
    pub(crate) pid: u32,
    pub(crate) stopped: bool,
    /// stopped=false 时的原因："not-found"（进程已退出，良性）；
    /// "kill-failed"（3 秒内未退出，可能仍在运行）。
    pub(crate) reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopAllBackgroundProcessesResult {
    pub(crate) stopped: usize,
    /// kill 后仍存活的进程数；这些条目会重新写回注册表以便重试。
    pub(crate) failed: usize,
}

/// 已退出后台进程的勘验信息：退出码/信号 + 进程被回收前捕获的输出尾部。
/// app_start 失败诊断依赖它——进程秒退后注册表条目会被 cleanup 移除，
/// 若不在移除时归档 log_tail，真实死因（如 Cannot find module）死无对证。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessExitInfo {
    pub(crate) pid: u32,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    /// None = 进程仍存活（仅返回实时 log_tail）或被信号杀死且无码。
    pub(crate) exit_code: Option<i32>,
    pub(crate) signal: Option<i32>,
    pub(crate) log_tail: String,
}

/// 归档条目：cleanup 移除死亡进程时连同 log_tail 一起搬入 reaped 存储。
pub struct ReapedBackgroundProcess {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) signal: Option<i32>,
    pub(crate) log_tail: String,
    pub(crate) reaped_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionResult {
    pub(crate) session_id: String,
    pub(crate) shell: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) output_tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionEntry {
    pub(crate) session_id: String,
    pub(crate) shell: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) output_tail: String,
    pub(crate) active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReadOutputResult {
    pub(crate) session_id: String,
    pub(crate) output_tail: String,
    pub(crate) active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSendInputResult {
    pub(crate) session_id: String,
    pub(crate) accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCloseSessionResult {
    pub(crate) session_id: String,
    pub(crate) closed: bool,
}

pub struct ManagedBackgroundProcess {
    pub child: Child,
    pub command: String,
    pub args: Vec<String>,
    pub workspace_path: String,
    pub started_at: i64,
    pub preview_url: Option<String>,
    pub log_tail: Arc<Mutex<VecDeque<String>>>,
}

pub struct ManagedShellSession {
    pub(crate) child: Child,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) shell: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) output_tail: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellFamily {
    Posix,
    PowerShell,
    Cmd,
}
