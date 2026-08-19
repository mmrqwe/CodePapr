use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::shared::{relative_string, resolve_existing_path, run_blocking_workspace_task};

use super::types::{FileEntry, ListFilesResult};
use super::{
    codepapr_apps_allowed, is_app_state_dir, is_generic_ignored_dir, should_ignore_file,
    DEFAULT_MAX_DEPTH, MAX_DEPTH, MAX_ENTRIES,
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
    // 调用方请求的深度超过硬上限时钳制，并通过 truncated 显式告知数据不完整，
    // 避免深层条目被静默丢弃（如 .CodePapr/skills 的 maxDepth=10 请求）。
    let requested_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    let (max_depth, depth_clamped) = if requested_depth > MAX_DEPTH {
        (MAX_DEPTH, true)
    } else {
        (requested_depth, false)
    };
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
    let mut truncated = depth_clamped;
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

/// 与遍历一致地判断单个子项是否对用户可见（app 模式白名单 / 忽略目录 / 忽略文件）。
/// 文件树与 list 工具默认列出通用忽略目录（node_modules/build/dist/.venv 等），
/// 但 collect_entries 不会递归进入它们；仅 `.git` 与应用自身状态目录始终隐藏。
fn child_visible(
    workspace: &Path,
    path: &Path,
    name: &str,
    is_dir: bool,
    include_codepapr_apps: bool,
    apply_codepapr_gate: bool,
) -> bool {
    // `.CodePapr` 子树整体受白名单管控：仅 app 模式放行 apps 子树，
    // 其余内部状态（git/、project.sqlite、memory.md 等）始终隐藏。
    // apply_codepapr_gate=false 表示遍历根就在 .CodePapr 内部（定向访问，
    // 如 skills/agents/commands 加载），保持原有按名过滤行为。
    let rel = relative_string(workspace, path);
    let in_codepapr = rel == ".CodePapr" || rel.starts_with(".CodePapr/");
    if apply_codepapr_gate && in_codepapr {
        codepapr_apps_allowed(&rel, include_codepapr_apps)
    } else if is_dir {
        !(name == ".git" || is_app_state_dir(name))
    } else {
        !should_ignore_file(name)
    }
}

/// 探测目录是否包含至少一个可见子项（供前端懒加载时渲染展开箭头）。
fn dir_has_visible_children(
    workspace: &Path,
    current: &Path,
    include_codepapr_apps: bool,
    apply_codepapr_gate: bool,
) -> bool {
    let children = match fs::read_dir(current) {
        Ok(children) => children,
        Err(_) => return false,
    };
    for child in children.flatten() {
        let path = child.path();
        // 个别条目元数据读取失败时跳过而不是视为有子项
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let name = child.file_name().to_string_lossy().to_string();
        if child_visible(
            workspace,
            &path,
            &name,
            metadata.is_dir(),
            include_codepapr_apps,
            apply_codepapr_gate,
        ) {
            return true;
        }
    }
    false
}

fn file_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
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

        if !child_visible(
            workspace,
            &path,
            &name,
            is_dir,
            include_codepapr_apps,
            apply_codepapr_gate,
        ) {
            continue;
        }

        let has_children = is_dir
            && dir_has_visible_children(
                workspace,
                &path,
                include_codepapr_apps,
                apply_codepapr_gate,
            );

        entries.push(FileEntry {
            path: relative_string(workspace, &path),
            name: name.clone(),
            is_dir,
            bytes: if is_dir { 0 } else { metadata.len() },
            has_children,
            mtime_ms: file_mtime_ms(&metadata),
        });

        // 通用忽略目录（node_modules/build/dist/.venv 等）只列出目录本身，
        // 绝不自动下钻：展开时由前端以 relativePath 定向拉取，避免巨型目录拖垮加载。
        if is_dir && depth < max_depth && !is_generic_ignored_dir(&name) {
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
