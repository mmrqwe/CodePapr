use std::fs;
use std::path::Path;

use crate::shared::{relative_string, resolve_existing_path, run_blocking_workspace_task};

use super::types::{FileEntry, ListFilesResult};
use super::{
    codepapr_apps_allowed, should_ignore_dir, should_ignore_file, DEFAULT_MAX_DEPTH, MAX_DEPTH,
    MAX_ENTRIES,
};

#[tauri::command]
pub(crate) async fn list_workspace_files(
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<ListFilesResult, String> {
    run_blocking_workspace_task(move || {
        list_workspace_files_impl(workspace_path, relative_path, max_depth, include_codepapr_apps)
    })
    .await
}

pub(crate) fn list_workspace_files_impl(
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<ListFilesResult, String> {
    let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH).min(MAX_DEPTH);
    let include_apps = include_codepapr_apps.unwrap_or(false);
    let (workspace, target) = resolve_existing_path(&workspace_path, relative_path.as_deref())?;
    if !target.is_dir() {
        return Err("列出文件需要传入目录路径".to_string());
    }

    // 显式列出 .CodePapr 内部子目录（skills/agents/commands/apps 等）属于定向访问，
    // 保持原有行为不受模式管控；仅从外部遍历时才按 app 模式白名单管控 .CodePapr。
    let target_rel = relative_string(&workspace, &target);
    let apply_codepapr_gate = !(target_rel == ".CodePapr" || target_rel.starts_with(".CodePapr/"));

    let mut entries = Vec::new();
    let mut truncated = false;
    collect_entries(
        &workspace,
        &target,
        0,
        max_depth,
        include_apps,
        apply_codepapr_gate,
        &mut entries,
        &mut truncated,
    )?;

    Ok(ListFilesResult {
        root: relative_string(&workspace, &target),
        entries,
        truncated,
    })
}

fn collect_entries(
    workspace: &Path,
    current: &Path,
    depth: usize,
    max_depth: usize,
    include_codepapr_apps: bool,
    apply_codepapr_gate: bool,
    entries: &mut Vec<FileEntry>,
    truncated: &mut bool,
) -> Result<(), String> {
    if entries.len() >= MAX_ENTRIES {
        *truncated = true;
        return Ok(());
    }

    let mut children = fs::read_dir(current)
        .map_err(|err| format!("无法读取目录 {}: {err}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取目录失败: {err}"))?;

    children.sort_by_key(|entry| entry.path());

    for child in children {
        if entries.len() >= MAX_ENTRIES {
            *truncated = true;
            break;
        }

        let path = child.path();
        // symlink_metadata 不跟随符号链接：坏软链不会让整个列表失败；
        // 个别条目元数据读取失败时跳过而不是报错
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let is_dir = metadata.is_dir();
        let name = child.file_name().to_string_lossy().to_string();
        let rel = relative_string(workspace, &path);

        // `.CodePapr` 子树整体受白名单管控：仅 app 模式放行 apps 子树，
        // 其余内部状态（git/、project.sqlite、memory.md 等）始终隐藏。
        // apply_codepapr_gate=false 表示遍历根就在 .CodePapr 内部（定向访问，
        // 如 skills/agents/commands 加载），保持原有按名过滤行为。
        let in_codepapr = rel == ".CodePapr" || rel.starts_with(".CodePapr/");
        if apply_codepapr_gate && in_codepapr {
            if !codepapr_apps_allowed(&rel, include_codepapr_apps) {
                continue;
            }
        } else {
            if is_dir && should_ignore_dir(&name) {
                continue;
            }

            if !is_dir && should_ignore_file(&name) {
                continue;
            }
        }

        entries.push(FileEntry {
            path: rel,
            name: name.clone(),
            is_dir,
            bytes: if is_dir { 0 } else { metadata.len() },
        });

        if is_dir && depth < max_depth {
            collect_entries(
                workspace,
                &path,
                depth + 1,
                max_depth,
                include_codepapr_apps,
                apply_codepapr_gate,
                entries,
                truncated,
            )?;
        }
    }

    Ok(())
}
