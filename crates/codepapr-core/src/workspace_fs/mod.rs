//! Filesystem operations: list, read, write, delete, search.
//!
//! File I/O is workspace-scoped by default. Explicitly authorized external
//! paths and YOLO-approved paths are handled by the shared access policy;
//! canonicalisation and path traversal checks still apply.

#![forbid(unsafe_code)]

pub mod chat_images;
pub mod default_project;
pub mod diff;
pub mod access;
pub mod list;
pub mod read;
pub mod search;
pub mod stats;
pub mod types;
pub mod watcher;
pub mod write;

// Only re-export what external modules (task_queue, invoke_handler) actually need.
pub(crate) use list::list_workspace_files_impl;
pub(crate) use read::read_text_file_impl;
pub(crate) use types::{ListFilesResult, ReadFileResult};

// ── Shared constants ─────────────────────────────────────────────────

pub(crate) const DEFAULT_MAX_DEPTH: usize = 2;
pub(crate) const MAX_DEPTH: usize = 20;
pub(crate) const MAX_ENTRIES: usize = 10_000;
pub(crate) const DEFAULT_MAX_READ_BYTES: usize = 500_000;
// 与 MAX_WRITE_BYTES / MAX_RANGE_SOURCE_BYTES 对齐：整文件读取上限必须覆盖
// edit/patch 的"读全文 → 局部替换 → 写回"链路，否则 >1MB 文件会被静默截断后
// 整体写回，丢失尾部内容（工具契约与 ARCHITECTURE 文档均为 20MB）。
pub(crate) const MAX_READ_BYTES: usize = 20_000_000;
pub(crate) const MAX_RANGE_SOURCE_BYTES: usize = 20_000_000;
pub(crate) const DEFAULT_ANCHORED_CONTEXT_LINES: usize = 20;
pub(crate) const MAX_READ_CONTEXT_LINES: usize = 200;
pub(crate) const MAX_WRITE_BYTES: usize = 20_000_000;
pub(crate) const MAX_PATH_SEARCH_RESULTS: usize = 120;
pub(crate) const MAX_SEARCH_RESULTS: usize = 80;
pub(crate) const DEFAULT_SEARCH_MAX_FILE_BYTES: usize = 500_000;
pub(crate) const MAX_SEARCH_MAX_FILE_BYTES: usize = 1_000_000;
pub(crate) const DEFAULT_SEARCH_CONTEXT_LINES: usize = 0;
pub(crate) const MAX_SEARCH_CONTEXT_LINES: usize = 8;
pub(crate) const DEFAULT_SEARCH_MAX_MATCHES_PER_FILE: usize = 5;
pub(crate) const MAX_SEARCH_MAX_MATCHES_PER_FILE: usize = 20;

pub(crate) fn should_ignore_dir(name: &str) -> bool {
    // 仅排除 .git 与重型目录：.github/.vscode 等点目录允许被搜索与列出
    name == ".git" || APP_STATE_DIRS.contains(&name) || IGNORED_DIRS.contains(&name)
}

/// 应用自身的项目级状态目录：任何模式（含"显示被忽略目录"的文件树/搜索）都始终隐藏。
pub(crate) fn is_app_state_dir(name: &str) -> bool {
    APP_STATE_DIRS.contains(&name)
}

/// 通用重型/产物目录：文件树与 list 工具默认列出但不下钻，搜索工具需显式 includeIgnoredDirs。
pub(crate) fn is_generic_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// app 模式白名单：仅放行 `.CodePapr/apps` 子树（Papr 应用源码存放处）。
/// `.CodePapr` 其余内容（project.sqlite、git/、memory.md 等内部状态）始终屏蔽。
/// 非 app 模式（include_codepapr_apps=false）时一律不放行。
pub(crate) fn codepapr_apps_allowed(relative_path: &str, include_codepapr_apps: bool) -> bool {
    if !include_codepapr_apps {
        return false;
    }
    relative_path == ".CodePapr"
        || relative_path == ".CodePapr/apps"
        || relative_path.starts_with(".CodePapr/apps/")
}

/// Returns true when any path component is an ignored directory (e.g.
/// `node_modules`, `target`) or a dot-directory. Used by the native file
/// watcher to suppress noise from build outputs and dependency folders
/// without having to walk the tree.
pub(crate) fn path_touches_ignored_dir(path: &std::path::Path) -> bool {
    path.components().any(|component| match component {
        std::path::Component::Normal(name) => {
            let s = name.to_string_lossy();
            should_ignore_dir(&s)
        }
        _ => false,
    })
}

/// 内置 watcher 的放行白名单：#22——.CodePapr 下只有用户可见内容子树
/// （apps/skills/commands/agents）的变更值得通知前端刷新（app_render 与
/// skill 安装都在这里落盘）。project.sqlite / git / memory.md 等内部状态
/// 高频写入，继续静默，避免每轮对话都触发整树刷新。
pub(crate) fn path_touches_codepapr_content(path: &std::path::Path) -> bool {
    let mut saw_codepapr = false;
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if !saw_codepapr {
            if name == ".CodePapr" {
                saw_codepapr = true;
            }
            continue;
        }
        return matches!(name.as_ref(), "apps" | "skills" | "commands" | "agents");
    }
    false
}

/// Filters OS-generated noise files (e.g. macOS `.DS_Store`, Windows `Thumbs.db`)
/// so they never enter workspace listings or the project graph tree.
pub(crate) fn should_ignore_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_FILES.contains(&lower.as_str())
}

const IGNORED_FILES: &[&str] = &[".ds_store", "thumbs.db", "ehthumbs.db", "desktop.ini"];

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".venv",
    ".idea",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".gradle",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".parcel-cache",
];

// 应用自身的项目级状态目录（非 git 项目中无 gitignore 保护），任何模式始终隐藏
const APP_STATE_DIRS: &[&str] = &[".CodePapr", ".ProjectGraph", ".scratch"];

#[cfg(test)]
mod tests;
