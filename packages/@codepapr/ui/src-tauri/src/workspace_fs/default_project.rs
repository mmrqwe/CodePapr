use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

use crate::shared::{home_dir, run_blocking_workspace_task};

const PROJECT_DIR_NAME: &str = "CodePapr";
const DEFAULT_PROJECT_NAME: &str = "Default Project";

#[derive(Serialize)]
pub(crate) struct DefaultProjectResult {
    pub(crate) path: String,
}

/// Ensure a default project folder exists and return its canonical path.
///
/// Idempotent and self-healing: `create_dir_all` recreates the folder if it
/// was deleted. The base directory is resolved through a multi-level fallback
/// (Documents → home → app local data) so the call only fails when none of
/// those locations is writable.
#[tauri::command]
pub(crate) async fn ensure_default_project(
    app: tauri::AppHandle,
) -> Result<DefaultProjectResult, String> {
    run_blocking_workspace_task(move || ensure_default_project_impl(&app)).await
}

fn ensure_default_project_impl(app: &tauri::AppHandle) -> Result<DefaultProjectResult, String> {
    let base = resolve_default_base_dir(app)?;
    let project = base.join(DEFAULT_PROJECT_NAME);
    fs::create_dir_all(&project).map_err(|err| format!("创建默认项目文件夹失败: {err}"))?;
    let canonical =
        fs::canonicalize(&project).map_err(|err| format!("无法访问默认项目文件夹: {err}"))?;
    Ok(DefaultProjectResult {
        path: canonical.to_string_lossy().into_owned(),
    })
}

fn resolve_default_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 1) <Documents>/CodePapr
    if let Ok(docs) = app.path().document_dir() {
        let candidate = docs.join(PROJECT_DIR_NAME);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    // 2) ~/CodePapr
    if let Ok(home) = home_dir() {
        let candidate = home.join(PROJECT_DIR_NAME);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    // 3) <app local data>/projects
    if let Ok(data) = app.path().app_local_data_dir() {
        let candidate = data.join("projects");
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("无法创建默认项目文件夹：Documents、主目录与应用数据目录均不可用".to_string())
}
