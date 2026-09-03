use std::{fs, path::{Path, PathBuf}};

use serde::Deserialize;

use crate::papr_runtime;

fn is_valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty()
        && app_id.len() <= 128
        && app_id != "."
        && app_id != ".."
        && !app_id.contains("..")
        && !app_id.contains('/')
        && !app_id.contains('\\')
}

fn is_unservable_app_file(file_path: &str) -> bool {
    let lower = file_path.to_ascii_lowercase();
    lower.ends_with(".sqlite") || lower.ends_with(".sqlite-wal") || lower.ends_with(".sqlite-shm")
}

fn global_apps_dir() -> Result<PathBuf, String> {
    codepapr_core::db::global_apps_dir()
}

fn workspace_plugin_data_dir(workspace: &Path, app_id: &str) -> PathBuf {
    workspace.join(".CodePapr").join("plugin-data").join(app_id)
}

#[derive(Debug, Deserialize)]
pub struct AppInstallFileItem {
    pub relative_path: String,
    pub content: String,
}

#[tauri::command]
pub fn papr_install_app_files(
    workspace_path: Option<String>,
    scope: String,
    app_id: String,
    files: Vec<AppInstallFileItem>,
) -> Result<String, String> {
    if !is_valid_app_id(&app_id) {
        return Err("invalid app id".to_string());
    }

    let target_dir = if scope == "global" {
        global_apps_dir()?.join(&app_id)
    } else {
        let ws = workspace_path
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "workspace_path is required for workspace scope".to_string())?;
        let canonical_ws = codepapr_core::shared::canonical_workspace(&ws)?;
        canonical_ws.join(".CodePapr").join("apps").join(&app_id)
    };

    if !target_dir.exists() {
        fs::create_dir_all(&target_dir)
            .map_err(|err| format!("创建应用目录 {} 失败: {err}", target_dir.display()))?;
    }

    let canonical_base = target_dir
        .canonicalize()
        .map_err(|err| format!("获取应用目录规范路径失败: {err}"))?;

    for file in files {
        let rel = file.relative_path.trim_start_matches('/');
        if rel.is_empty()
            || rel.contains("..")
            || rel.contains('\\')
            || rel == "__papr_sdk.js"
            || rel.ends_with("/__papr_sdk.js")
            || is_unservable_app_file(rel)
        {
            continue;
        }
        let dest = target_dir.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建子目录失败: {err}"))?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|err| format!("校验子目录失败: {err}"))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err("path traversal blocked in installation".to_string());
            }
        }
        fs::write(&dest, file.content.as_bytes())
            .map_err(|err| format!("写入文件 {} 失败: {err}", dest.display()))?;
    }

    Ok(target_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn papr_uninstall_app(
    workspace_path: Option<String>,
    scope: String,
    app_id: String,
    remove_data: bool,
) -> Result<(), String> {
    if !is_valid_app_id(&app_id) {
        return Err("invalid app id".to_string());
    }

    let target_dir = if scope == "global" {
        global_apps_dir()?.join(&app_id)
    } else {
        let ws = workspace_path
            .as_deref()
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "workspace_path is required for workspace scope".to_string())?;
        let canonical_ws = codepapr_core::shared::canonical_workspace(ws)?;
        canonical_ws.join(".CodePapr").join("apps").join(&app_id)
    };

    if target_dir.exists() {
        if remove_data {
            fs::remove_dir_all(&target_dir)
                .map_err(|err| format!("删除应用目录失败: {err}"))?;
        } else {
            let entries = fs::read_dir(&target_dir)
                .map_err(|err| format!("读取应用目录失败: {err}"))?;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "data" || name == "db.sqlite" || name.starts_with("db.sqlite-") {
                    continue;
                }
                let p = entry.path();
                if p.is_dir() {
                    let _ = fs::remove_dir_all(&p);
                } else {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }

    if remove_data {
        if let Some(ws) = workspace_path.as_deref().filter(|w| !w.is_empty()) {
            if let Ok(workspace) = codepapr_core::shared::canonical_workspace(ws) {
                let data_dir = workspace_plugin_data_dir(&workspace, &app_id);
                if data_dir.exists() && data_dir != target_dir {
                    let _ = fs::remove_dir_all(&data_dir);
                }
            }
        }
    }

    papr_runtime::manifest::clear_manifest(&app_id);
    papr_runtime::app_context::unregister(&app_id);
    Ok(())
}
