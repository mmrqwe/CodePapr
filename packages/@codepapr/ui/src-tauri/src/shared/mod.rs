//! Cross-cutting utilities shared by all domain modules.
//!
//! These helpers are used by 3+ unrelated domains (db, fs, shell, browser, web)
//! and have no dependencies on any domain-specific crate.

pub(crate) mod git_locks;
pub(crate) mod paths;
pub(crate) mod runtime;
pub(crate) mod strings;
pub(crate) mod sync;
pub(crate) mod time;

pub(crate) use git_locks::remove_stale_git_locks;
pub(crate) use paths::{
    canonical_workspace, expanded_path, home_dir, normalize_relative_path,
    ensure_path_accessible, ensure_write_path_accessible, is_protected_external_path,
    normalize_workspace_filter, parse_workspace_path_input, relative_string, resolve_existing_path,
    sanitize_workspace_path_input, path_is_same, path_is_same_or_child, PathLocationInput,
};
pub(crate) use runtime::run_blocking_workspace_task;
pub(crate) use strings::{parse_browser_url, truncate_utf8};
pub(crate) use sync::{lock, read, write};
pub(crate) use time::unix_millis;
