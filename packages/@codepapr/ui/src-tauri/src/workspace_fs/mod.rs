//! Filesystem operations: list, read, write, delete, search.
//!
//! All file I/O is workspace-scoped — paths are resolved relative to a
//! canonicalised workspace root and path traversal is rejected.

pub(crate) mod diff;
pub(crate) mod list;
pub(crate) mod read;
pub(crate) mod search;
pub(crate) mod stats;
pub(crate) mod types;
pub(crate) mod watcher;
pub(crate) mod write;

// Only re-export what external modules (task_queue, invoke_handler) actually need.
pub(crate) use list::list_workspace_files_impl;
pub(crate) use read::read_text_file_impl;
pub(crate) use types::{ListFilesResult, ReadFileResult};

// ── Shared constants ─────────────────────────────────────────────────

pub(crate) const DEFAULT_MAX_DEPTH: usize = 2;
pub(crate) const MAX_DEPTH: usize = 6;
pub(crate) const MAX_ENTRIES: usize = 800;
pub(crate) const DEFAULT_MAX_READ_BYTES: usize = 500_000;
pub(crate) const MAX_READ_BYTES: usize = 1_000_000;
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
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// Returns true when any path component is an ignored directory (e.g.
/// `node_modules`, `target`) or a dot-directory. Used by the native file
/// watcher to suppress noise from build outputs and dependency folders
/// without having to walk the tree.
pub(crate) fn path_touches_ignored_dir(path: &std::path::Path) -> bool {
    path.components().any(|component| {
        match component {
            std::path::Component::Normal(name) => {
                let s = name.to_string_lossy();
                should_ignore_dir(&s)
            }
            _ => false,
        }
    })
}

/// Filters OS-generated noise files (e.g. macOS `.DS_Store`, Windows `Thumbs.db`)
/// so they never enter workspace listings or the project graph tree.
pub(crate) fn should_ignore_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_FILES.contains(&lower.as_str())
}

const IGNORED_FILES: &[&str] = &[
    ".ds_store",
    "thumbs.db",
    "ehthumbs.db",
    "desktop.ini",
];

pub(crate) const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
];

#[cfg(test)]
mod tests;
