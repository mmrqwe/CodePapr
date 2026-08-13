use serde::Serialize;
use std::{
    collections::VecDeque,
    process::{Child, ChildStdin},
    sync::{Arc, Mutex},
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandResult {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) status: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) timed_out: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundCommandResult {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) pid: Option<u32>,
    pub(crate) started: bool,
    pub(crate) preview_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundProcessEntry {
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
pub(crate) struct StopBackgroundProcessResult {
    pub(crate) pid: u32,
    pub(crate) stopped: bool,
    /// stopped=false 时的原因："not-found"（进程已退出，良性）；
    /// "kill-failed"（3 秒内未退出，可能仍在运行）。
    pub(crate) reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopAllBackgroundProcessesResult {
    pub(crate) stopped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellSessionResult {
    pub(crate) session_id: String,
    pub(crate) shell: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) output_tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellSessionEntry {
    pub(crate) session_id: String,
    pub(crate) shell: String,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) output_tail: String,
    pub(crate) active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellReadOutputResult {
    pub(crate) session_id: String,
    pub(crate) output_tail: String,
    pub(crate) active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellSendInputResult {
    pub(crate) session_id: String,
    pub(crate) accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellCloseSessionResult {
    pub(crate) session_id: String,
    pub(crate) closed: bool,
}

pub(crate) struct ManagedBackgroundProcess {
    pub(crate) child: Child,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) workspace_path: String,
    pub(crate) started_at: i64,
    pub(crate) preview_url: Option<String>,
    pub(crate) log_tail: Arc<Mutex<VecDeque<String>>>,
}

pub(crate) struct ManagedShellSession {
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
