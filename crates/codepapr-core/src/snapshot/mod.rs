#![forbid(unsafe_code)]

mod diff_engine;
pub mod ignore_resolver;
mod restore_engine;
mod snapshot_engine;
pub mod types;

use std::path::PathBuf;

use crate::shared::run_blocking_workspace_task;
use crate::shared::{with_workspace_git_read_lock, with_workspace_git_write_lock};

pub use diff_engine::DiffEngine;
pub use restore_engine::RestoreEngine;
pub use snapshot_engine::SnapshotEngine;
pub use types::*;

// 所有命令都在阻塞线程池执行：git2 的仓库遍历/哈希/提交是重阻塞操作，
// 直接跑在 tokio 工作线程上会卡住共享 runtime（连累 MCP I/O 与超时）。

pub async fn snapshot_ensure(workspace_path: String) -> EnsureResult {
    run_blocking_workspace_task(move || -> Result<EnsureResult, String> {
        let workspace = PathBuf::from(workspace_path);
        Ok(with_workspace_git_write_lock(&workspace, || {
            let engine = SnapshotEngine::new(&workspace);
            engine.ensure()
        }))
    })
    .await
    .unwrap_or_else(|err| EnsureResult {
        ready: false,
        created_repo: false,
        rebuilt: false,
        head_sha: None,
        error: Some(err),
    })
}

pub async fn snapshot_create(
    workspace_path: String,
    label: String,
) -> Result<Option<SnapshotInfo>, String> {
    run_blocking_workspace_task(move || snapshot_create_blocking(&workspace_path, &label))
        .await
}

/// 同步创建检查点：供 sidecar 宿主在高危命令执行前 fail-closed 兜底使用
/// （dispatch 栈已是阻塞线程，不能 await 异步版本）。语义与 snapshot_create
/// 一致：空工作区/全忽略返回 None（无内容可保护，不算失败）。
pub fn snapshot_create_blocking(
    workspace_path: &str,
    label: &str,
) -> Result<Option<SnapshotInfo>, String> {
    let workspace = PathBuf::from(workspace_path);
    with_workspace_git_write_lock(&workspace, || {
        let engine = SnapshotEngine::new(&workspace);
        if !engine.has_snapshotable_files() {
            return Ok(None);
        }
        engine.create(label).map(Some)
    })
}

pub async fn snapshot_list(
    workspace_path: String,
    limit: Option<usize>,
) -> Result<Vec<SnapshotInfo>, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        Ok(with_workspace_git_read_lock(&workspace, || {
            let engine = SnapshotEngine::new(&workspace);
            engine.list(limit.unwrap_or(100))
        }))
    })
    .await
}

pub async fn snapshot_head_sha(workspace_path: String) -> Option<String> {
    run_blocking_workspace_task(move || -> Result<Option<String>, String> {
        let workspace = PathBuf::from(workspace_path);
        Ok(with_workspace_git_read_lock(&workspace, || {
            let engine = SnapshotEngine::new(&workspace);
            engine.head_sha()
        }))
    })
    .await
    .unwrap_or(None)
}

pub async fn restore_plan(
    workspace_path: String,
    target_sha: String,
) -> Result<RestorePlan, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_read_lock(&workspace, || {
            let engine = RestoreEngine::new(&workspace);
            engine.plan(&target_sha)
        })
    })
    .await
}

pub async fn restore_execute(
    workspace_path: String,
    target_sha: String,
) -> Result<RestoreResult, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_write_lock(&workspace, || {
            let engine = RestoreEngine::new(&workspace);
            engine.execute(&target_sha)
        })
    })
    .await
}

pub async fn restore_undo(
    workspace_path: String,
    expected_backup_sha: Option<String>,
) -> Result<(), String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_write_lock(&workspace, || {
            let engine = RestoreEngine::new(&workspace);
            engine.undo(expected_backup_sha.as_deref())
        })
    })
    .await
}

pub async fn snapshot_changed_files(
    workspace_path: String,
    sha: String,
) -> Result<CommitChangedFiles, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_read_lock(&workspace, || {
            let engine = DiffEngine::new(&workspace);
            engine.changed_files(&sha)
        })
    })
    .await
}

pub async fn diff_snapshots(
    workspace_path: String,
    from_sha: String,
    to_sha: String,
) -> Result<Vec<FileDiff>, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_read_lock(&workspace, || {
            let engine = DiffEngine::new(&workspace);
            engine.diff_snapshots(&from_sha, &to_sha)
        })
    })
    .await
}

pub async fn snapshot_file_content(
    workspace_path: String,
    sha: String,
    path: String,
) -> Result<String, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_read_lock(&workspace, || {
            let engine = DiffEngine::new(&workspace);
            engine.file_content(&sha, &path)
        })
    })
    .await
}

pub async fn snapshot_index_file_content(
    workspace_path: String,
    path: String,
) -> Result<String, String> {
    run_blocking_workspace_task(move || {
        let workspace = PathBuf::from(workspace_path);
        with_workspace_git_read_lock(&workspace, || {
            let engine = DiffEngine::new(&workspace);
            engine.index_file_content(&path)
        })
    })
    .await
}
