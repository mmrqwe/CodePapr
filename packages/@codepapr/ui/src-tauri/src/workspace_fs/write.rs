use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::shared::{
    canonical_workspace, ensure_path_accessible, ensure_write_path_accessible,
    normalize_relative_path, relative_string, run_blocking_workspace_task,
    sanitize_workspace_path_input,
};

use super::diff::compute_line_change_summary;
use super::read::{decode_text_bytes, detect_text_encoding, encode_text_with_encoding};
use super::types::WriteFileResult;
use super::MAX_WRITE_BYTES;

static TMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

pub(crate) fn write_text_file_impl(
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
    ensure_write_path_accessible(&workspace, &target)?;
    let existed_before = target.exists();
    // 原文件内容与编码：变更摘要需要解码后的文本；编码用于按原编码回写，
    // 避免编辑 GBK/UTF-16/BOM 文件时静默转码
    let (previous_content, original_encoding) = match fs::read(&target) {
        Ok(bytes) => {
            let encoding = detect_text_encoding(&bytes);
            (decode_text_bytes(bytes).ok(), encoding)
        }
        Err(_) => (None, None),
    };
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定目标文件目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|err| format!("无法访问目标目录: {err}"))?;
    if target.exists() {
        let canonical_target =
            fs::canonicalize(&target).map_err(|err| format!("无法访问目标文件: {err}"))?;
        ensure_path_accessible(&workspace, &canonical_target)?;
    } else {
        ensure_path_accessible(&workspace, &canonical_parent)?;
    }

    let (bytes_to_write, encoding_label) = match original_encoding {
        Some(encoding) => (
            encode_text_with_encoding(&content, encoding),
            Some(encoding.label().to_string()),
        ),
        None => (content.as_bytes().to_vec(), None),
    };

    let sequence = TMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = target.with_extension(format!(
        "{}.{}.{}.tmp",
        target
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or(""),
        std::process::id(),
        sequence
    ));
    if let Err(err) = fs::write(&tmp, &bytes_to_write) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入文件 {} 失败: {err}", target.display()));
    }
    fs::rename(&tmp, &target).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("写入文件 {} 失败: {err}", target.display())
    })?;

    Ok(WriteFileResult {
        path: relative_string(&workspace, &target),
        bytes: bytes_to_write.len(),
        encoding: encoding_label,
        change: compute_line_change_summary(existed_before, previous_content.as_deref(), &content),
    })
}

#[tauri::command]
pub(crate) async fn delete_workspace_file(
    workspace_path: String,
    relative_path: String,
) -> Result<bool, String> {
    run_blocking_workspace_task(move || {
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

        ensure_path_accessible(&workspace, &fs::canonicalize(&target).map_err(|err| format!("无法访问目标文件: {err}"))?)?;
        if !target.is_file() {
            return Err("仅支持删除文件".to_string());
        }

        fs::remove_file(&target).map_err(|err| format!("删除文件 {} 失败: {err}", target.display()))?;
        Ok(true)
    }).await
}

#[tauri::command]
pub(crate) async fn delete_workspace_dir(
    workspace_path: String,
    relative_path: String,
) -> Result<bool, String> {
    run_blocking_workspace_task(move || {
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
        ensure_path_accessible(&workspace, &canonical_target)?;

        fs::remove_dir_all(&target)
            .map_err(|err| format!("删除目录 {} 失败: {err}", target.display()))?;
        Ok(true)
    }).await
}
