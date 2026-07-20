pub mod types;
pub mod ignore_resolver;
mod snapshot_engine;
mod restore_engine;
mod diff_engine;

use std::path::PathBuf;
use serde::Deserialize;

pub use types::*;
pub use snapshot_engine::SnapshotEngine;
pub use restore_engine::RestoreEngine;
pub use diff_engine::DiffEngine;

#[tauri::command]
pub async fn snapshot_ensure(workspace_path: String) -> EnsureResult {
    let workspace = PathBuf::from(workspace_path);
    let engine = SnapshotEngine::new(&workspace);
    engine.ensure()
}

#[tauri::command]
pub async fn snapshot_create(
    workspace_path: String,
    label: String,
) -> Result<SnapshotInfo, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = SnapshotEngine::new(&workspace);
    engine.create(&label)
}

#[tauri::command]
pub async fn snapshot_list(
    workspace_path: String,
    limit: Option<usize>,
) -> Result<Vec<SnapshotInfo>, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = SnapshotEngine::new(&workspace);
    Ok(engine.list(limit.unwrap_or(100)))
}

#[tauri::command]
pub async fn snapshot_head_sha(workspace_path: String) -> Option<String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = SnapshotEngine::new(&workspace);
    engine.head_sha()
}

#[tauri::command]
pub async fn restore_plan(
    workspace_path: String,
    target_sha: String,
) -> Result<RestorePlan, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = RestoreEngine::new(&workspace);
    engine.plan(&target_sha)
}

#[tauri::command]
pub async fn restore_execute(
    workspace_path: String,
    target_sha: String,
) -> Result<RestoreResult, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = RestoreEngine::new(&workspace);
    engine.execute(&target_sha)
}

#[tauri::command]
pub async fn restore_undo(workspace_path: String) -> Result<(), String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = RestoreEngine::new(&workspace);
    engine.undo()
}

#[tauri::command]
pub async fn snapshot_changed_files(
    workspace_path: String,
    sha: String,
) -> Result<CommitChangedFiles, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = DiffEngine::new(&workspace);
    engine.changed_files(&sha)
}

#[tauri::command]
pub async fn diff_snapshots(
    workspace_path: String,
    from_sha: String,
    to_sha: String,
) -> Result<Vec<FileDiff>, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = DiffEngine::new(&workspace);
    engine.diff_snapshots(&from_sha, &to_sha)
}

#[tauri::command]
pub async fn snapshot_file_content(
    workspace_path: String,
    sha: String,
    path: String,
) -> Result<String, String> {
    let workspace = PathBuf::from(workspace_path);
    let engine = DiffEngine::new(&workspace);
    engine.file_content(&sha, &path)
}
