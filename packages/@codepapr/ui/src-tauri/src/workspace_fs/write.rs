use std::fs;
use std::path::PathBuf;

use crate::shared::{
    canonical_workspace, normalize_relative_path, relative_string, run_blocking_workspace_task,
    sanitize_workspace_path_input,
};

use super::diff::compute_line_change_summary;
use super::types::WriteFileResult;
use super::MAX_WRITE_BYTES;

#[tauri::command]
pub(crate) async fn write_text_file(
    workspace_path: String,
    relative_path: String,
    content: String,
) -> Result<WriteFileResult, String> {
    run_blocking_workspace_task(move || {
        write_text_file_impl(workspace_path, relative_path, content)
    })
    .await
}

fn write_text_file_impl(
    workspace_path: String,
    relative_path: String,
    content: String,
) -> Result<WriteFileResult, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("写入内容超过上限 {MAX_WRITE_BYTES} bytes"));
    }

    let workspace = canonical_workspace(&workspace_path)?;
    let raw = sanitize_workspace_path_input(Some(&relative_path));
    if raw.is_empty() || raw == "." {
        return Err("写入文件路径不能为空".to_string());
    }

    let target = {
        let raw_path = PathBuf::from(&raw);
        if raw_path.is_absolute() {
            raw_path
        } else {
            workspace.join(normalize_relative_path(Some(&raw))?)
        }
    };
    let existed_before = target.exists();
    let previous_content = if existed_before {
        fs::read_to_string(&target).ok()
    } else {
        None
    };
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定目标文件目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|err| format!("无法访问目标目录: {err}"))?;
    if !canonical_parent.starts_with(&workspace) {
        return Err("拒绝写入项目文件夹之外的路径".to_string());
    }

    let tmp = target.with_extension(format!(
        "{}.{}.tmp",
        target
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or(""),
        std::process::id()
    ));
    if let Err(err) = fs::write(&tmp, content.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入文件 {} 失败: {err}", target.display()));
    }
    fs::rename(&tmp, &target).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("写入文件 {} 失败: {err}", target.display())
    })?;

    Ok(WriteFileResult {
        path: relative_string(&workspace, &target),
        bytes: content.len(),
        change: compute_line_change_summary(existed_before, previous_content.as_deref(), &content),
    })
}

#[tauri::command]
pub(crate) fn delete_workspace_file(
    workspace_path: String,
    relative_path: String,
) -> Result<bool, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let raw = sanitize_workspace_path_input(Some(&relative_path));
    if raw.is_empty() || raw == "." {
        return Err("删除文件路径不能为空".to_string());
    }

    let target = {
        let raw_path = PathBuf::from(&raw);
        if raw_path.is_absolute() {
            raw_path
        } else {
            workspace.join(normalize_relative_path(Some(&raw))?)
        }
    };
    if !target.exists() {
        return Ok(false);
    }

    let parent = target
        .parent()
        .ok_or_else(|| "无法确定目标文件目录".to_string())?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|err| format!("无法访问目标目录: {err}"))?;
    if !canonical_parent.starts_with(&workspace) {
        return Err("拒绝删除项目文件夹之外的路径".to_string());
    }
    if !target.is_file() {
        return Err("仅支持删除文件".to_string());
    }

    fs::remove_file(&target).map_err(|err| format!("删除文件 {} 失败: {err}", target.display()))?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn delete_workspace_dir(
    workspace_path: String,
    relative_path: String,
) -> Result<bool, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let raw = sanitize_workspace_path_input(Some(&relative_path));
    if raw.is_empty() || raw == "." {
        return Err("删除目录路径不能为空".to_string());
    }

    let target = {
        let raw_path = PathBuf::from(&raw);
        if raw_path.is_absolute() {
            raw_path
        } else {
            workspace.join(normalize_relative_path(Some(&raw))?)
        }
    };
    if !target.exists() {
        return Ok(false);
    }
    if !target.is_dir() {
        return Err("仅支持删除目录".to_string());
    }

    let canonical_target =
        fs::canonicalize(&target).map_err(|err| format!("无法访问目标目录: {err}"))?;
    if !canonical_target.starts_with(&workspace) {
        return Err("拒绝删除项目文件夹之外的路径".to_string());
    }

    fs::remove_dir_all(&target)
        .map_err(|err| format!("删除目录 {} 失败: {err}", target.display()))?;
    Ok(true)
}
