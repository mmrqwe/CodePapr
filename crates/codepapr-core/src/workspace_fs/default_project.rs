use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::shared::{home_dir, run_blocking_workspace_task};

const PROJECT_DIR_NAME: &str = "CodePapr";
const DEFAULT_PROJECT_NAME: &str = "Default Project";

#[derive(Serialize)]
pub struct DefaultProjectResult {
    pub path: String,
}

/// Ensure a default project folder exists and return its canonical path.
pub async fn ensure_default_project(
    base_override: Option<PathBuf>,
) -> Result<DefaultProjectResult, String> {
    run_blocking_workspace_task(move || ensure_default_project_impl(base_override)).await
}

pub fn ensure_default_project_impl(base_override: Option<PathBuf>) -> Result<DefaultProjectResult, String> {
    let base = resolve_default_base_dir(base_override)?;
    let project = base.join(DEFAULT_PROJECT_NAME);
    fs::create_dir_all(&project).map_err(|err| format!("创建默认项目文件夹失败: {err}"))?;
    let canonical =
        fs::canonicalize(&project).map_err(|err| format!("无法访问默认项目文件夹: {err}"))?;
    Ok(DefaultProjectResult {
        path: canonical.to_string_lossy().into_owned(),
    })
}

fn resolve_default_base_dir(base_override: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(base) = base_override {
        let candidate = base.join(PROJECT_DIR_NAME);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    // ~/CodePapr
    if let Ok(home) = home_dir() {
        let candidate = home.join(PROJECT_DIR_NAME);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("无法创建默认项目文件夹：主目录不可用".to_string())
}
