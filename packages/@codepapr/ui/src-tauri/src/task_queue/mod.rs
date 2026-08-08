//! Serial workspace task queue.
//!
//! All heavy workspace I/O (git commands, file listing, file reads, command
//! execution) is funnelled through a single-consumer channel so tasks execute
//! strictly one-at-a-time.  Tauri commands enqueue tasks and return a task_id
//! immediately; the frontend polls `poll_workspace_task` for the result.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::shared::lock;
use crate::shell::background::run_workspace_command_impl;
use crate::shell::CommandResult;
use crate::workspace_fs::{ListFilesResult, ReadFileResult};

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) enum WorkspaceTask {
    ListFiles {
        id: u64,
        workspace_path: String,
        relative_path: Option<String>,
        max_depth: Option<usize>,
    },
    ReadFile {
        id: u64,
        workspace_path: String,
        relative_path: String,
        max_bytes: Option<usize>,
    },
    RunCommand {
        id: u64,
        workspace_path: String,
        command: String,
        args: Option<Vec<String>>,
        timeout_seconds: Option<u64>,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum WorkspaceTaskResult {
    ListFiles {
        id: u64,
        result: Result<ListFilesResult, String>,
    },
    ReadFile {
        id: u64,
        result: Result<ReadFileResult, String>,
    },
    RunCommand {
        id: u64,
        result: Result<CommandResult, String>,
    },
}

pub(crate) struct TaskQueueState {
    pub(crate) pending_results: HashMap<u64, WorkspaceTaskResult>,
    pub(crate) completed_order: VecDeque<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollResult {
    pub(crate) done: bool,
    pub(crate) result: Option<WorkspaceTaskResult>,
}

// ── Static state ─────────────────────────────────────────────────────

static TASK_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(crate) static TASK_TX: OnceLock<std::sync::mpsc::SyncSender<WorkspaceTask>> = OnceLock::new();

pub(crate) static TASK_RESULTS: OnceLock<Mutex<TaskQueueState>> = OnceLock::new();

const MAX_COMPLETED_BUFFER: usize = 200;

// ── Worker ───────────────────────────────────────────────────────────

/// Extract the task id from a `WorkspaceTaskResult` (used internally for
/// bookkeeping).
fn result_id(result: &WorkspaceTaskResult) -> u64 {
    match result {
        WorkspaceTaskResult::ListFiles { id, .. }
        | WorkspaceTaskResult::ReadFile { id, .. }
        | WorkspaceTaskResult::RunCommand { id, .. } => *id,
    }
}

pub(crate) fn task_worker(rx: std::sync::mpsc::Receiver<WorkspaceTask>) {
    for task in rx.iter() {
        let result = match task {
            WorkspaceTask::ListFiles {
                id,
                workspace_path,
                relative_path,
                max_depth,
            } => {
                let res = crate::workspace_fs::list_workspace_files_impl(
                    workspace_path,
                    relative_path,
                    max_depth,
                    None,
                );
                WorkspaceTaskResult::ListFiles { id, result: res }
            }
            WorkspaceTask::ReadFile {
                id,
                workspace_path,
                relative_path,
                max_bytes,
            } => {
                let res = crate::workspace_fs::read_text_file_impl(
                    workspace_path,
                    relative_path,
                    max_bytes,
                    None,
                    None,
                    None,
                    None,
                );
                WorkspaceTaskResult::ReadFile { id, result: res }
            }
            WorkspaceTask::RunCommand {
                id,
                workspace_path,
                command,
                args,
                timeout_seconds,
            } => {
                let res =
                    run_workspace_command_impl(workspace_path, command, args, timeout_seconds, None);
                WorkspaceTaskResult::RunCommand { id, result: res }
            }
        };

        if let Some(state) = TASK_RESULTS.get() {
            let mut guard = lock(state);
            let id = result_id(&result);
            guard.completed_order.push_back(id);
            guard.pending_results.insert(id, result);
            while guard.completed_order.len() > MAX_COMPLETED_BUFFER {
                if let Some(old_id) = guard.completed_order.pop_front() {
                    guard.pending_results.remove(&old_id);
                }
            }
        }
    }
}

fn next_task_id() -> u64 {
    TASK_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
}

// ── Tauri commands ───────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn enqueue_workspace_task(
    task_type: String,
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    max_bytes: Option<usize>,
    command: Option<String>,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
) -> Result<u64, String> {
    let tx = TASK_TX.get().ok_or("任务队列未初始化")?;
    let id = next_task_id();

    let task = match task_type.as_str() {
        "list_files" => WorkspaceTask::ListFiles {
            id,
            workspace_path,
            relative_path,
            max_depth,
        },
        "read_file" => WorkspaceTask::ReadFile {
            id,
            workspace_path,
            relative_path: relative_path.unwrap_or_default(),
            max_bytes,
        },
        "run_command" => WorkspaceTask::RunCommand {
            id,
            workspace_path,
            command: command.unwrap_or_default(),
            args,
            timeout_seconds,
        },
        _ => return Err(format!("未知任务类型: {task_type}")),
    };

    tx.send(task).map_err(|_| "任务队列已关闭")?;
    Ok(id)
}

#[tauri::command]
pub(crate) fn poll_workspace_task(task_id: u64) -> PollResult {
    let state = match TASK_RESULTS.get() {
        Some(s) => s,
        None => {
            return PollResult {
                done: false,
                result: None,
            }
        }
    };
    let mut guard = lock(state);
    match guard.pending_results.remove(&task_id) {
        Some(result) => {
            // 已消费的结果立即移除：旧实现一直挂到 200 条驱逐上限，既占内存，
            // 又挤占尚未轮询到的结果的缓冲位。
            if let Some(pos) = guard.completed_order.iter().position(|id| *id == task_id) {
                guard.completed_order.remove(pos);
            }
            PollResult {
                done: true,
                result: Some(result),
            }
        }
        None => PollResult {
            done: false,
            result: None,
        },
    }
}
