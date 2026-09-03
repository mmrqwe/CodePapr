//! Serial workspace task queue hosted inside codepapr-server.
//!
//! Mirrors the former Tauri `task_queue` so the desktop UI can keep polling
//! `task/enqueue` / `task/poll` while the work runs on the host process.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

use codepapr_core::shared::lock;
use codepapr_core::shell::background::run_workspace_command;
use codepapr_core::workspace_fs::list::list_workspace_files;
use codepapr_core::workspace_fs::read::read_text_file;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
enum WorkspaceTaskResult {
    ListFiles {
        id: u64,
        result: Result<Value, String>,
    },
    ReadFile {
        id: u64,
        result: Result<Value, String>,
    },
    RunCommand {
        id: u64,
        result: Result<Value, String>,
    },
}

struct TaskQueueState {
    pending_results: HashMap<u64, WorkspaceTaskResult>,
    completed_order: VecDeque<u64>,
}

static TASK_ID: AtomicU64 = AtomicU64::new(1);
static TASK_TX: OnceLock<std::sync::mpsc::SyncSender<TaskJob>> = OnceLock::new();
static TASK_RESULTS: OnceLock<Mutex<TaskQueueState>> = OnceLock::new();

enum TaskJob {
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

fn results() -> &'static Mutex<TaskQueueState> {
    TASK_RESULTS.get_or_init(|| Mutex::new(TaskQueueState {
        pending_results: HashMap::new(),
        completed_order: VecDeque::new(),
    }))
}

fn ensure_worker() {
    if TASK_TX.get().is_some() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<TaskJob>(256);
    if TASK_TX.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        let Ok(rt) = rt else {
            return;
        };
        while let Ok(job) = rx.recv() {
            rt.block_on(process_job(job));
        }
    });
}

async fn process_job(job: TaskJob) {
    let stored = match job {
        TaskJob::ListFiles {
            id,
            workspace_path,
            relative_path,
            max_depth,
        } => {
            let result = list_workspace_files(workspace_path, relative_path, max_depth, None)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()));
            WorkspaceTaskResult::ListFiles { id, result }
        }
        TaskJob::ReadFile {
            id,
            workspace_path,
            relative_path,
            max_bytes,
        } => {
            let result = read_text_file(
                workspace_path,
                relative_path,
                max_bytes,
                None,
                None,
                None,
                None,
            )
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()));
            WorkspaceTaskResult::ReadFile { id, result }
        }
        TaskJob::RunCommand {
            id,
            workspace_path,
            command,
            args,
            timeout_seconds,
        } => {
            let result = run_workspace_command(
                workspace_path,
                command,
                args,
                timeout_seconds,
                None,
                None,
            )
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()));
            WorkspaceTaskResult::RunCommand { id, result }
        }
    };
    let id = match &stored {
        WorkspaceTaskResult::ListFiles { id, .. }
        | WorkspaceTaskResult::ReadFile { id, .. }
        | WorkspaceTaskResult::RunCommand { id, .. } => *id,
    };
    let mut guard = lock(results());
    guard.pending_results.insert(id, stored);
    guard.completed_order.push_back(id);
    while guard.completed_order.len() > 200 {
        if let Some(old) = guard.completed_order.pop_front() {
            guard.pending_results.remove(&old);
        }
    }
}

pub fn enqueue(
    task_type: &str,
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    max_bytes: Option<usize>,
    command: Option<String>,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
) -> Result<u64, String> {
    ensure_worker();
    let tx = TASK_TX.get().ok_or("任务队列未初始化")?;
    let id = TASK_ID.fetch_add(1, Ordering::Relaxed);
    let job = match task_type {
        "list_files" => TaskJob::ListFiles {
            id,
            workspace_path,
            relative_path,
            max_depth,
        },
        "read_file" => TaskJob::ReadFile {
            id,
            workspace_path,
            relative_path: relative_path.unwrap_or_default(),
            max_bytes,
        },
        "run_command" => TaskJob::RunCommand {
            id,
            workspace_path,
            command: command.unwrap_or_default(),
            args,
            timeout_seconds,
        },
        other => return Err(format!("未知任务类型: {other}")),
    };
    tx.try_send(job).map_err(|e| match e {
        std::sync::mpsc::TrySendError::Full(_) => "任务队列已满,请稍后重试".to_string(),
        std::sync::mpsc::TrySendError::Disconnected(_) => "任务队列已关闭".to_string(),
    })?;
    Ok(id)
}

pub fn poll(task_id: u64) -> Value {
    let mut guard = lock(results());
    match guard.pending_results.remove(&task_id) {
        Some(result) => {
            if let Some(pos) = guard.completed_order.iter().position(|id| *id == task_id) {
                guard.completed_order.remove(pos);
            }
            serde_json::json!({ "done": true, "result": result })
        }
        None => serde_json::json!({ "done": false, "result": null }),
    }
}
