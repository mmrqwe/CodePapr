//! Cross-cutting utilities shared by all domain modules.
//!
//! These helpers are used by 3+ unrelated domains (db, fs, shell, browser, web)
//! and have no dependencies on any domain-specific crate.

pub(crate) mod paths;
pub(crate) mod runtime;
pub(crate) mod strings;
pub(crate) mod time;

pub(crate) use paths::{
    canonical_workspace, expanded_path, home_dir, normalize_relative_path,
    normalize_workspace_filter, parse_workspace_path_input, relative_string, resolve_existing_path,
    sanitize_workspace_path_input, PathLocationInput,
};
pub(crate) use runtime::run_blocking_workspace_task;
pub(crate) use strings::{parse_browser_url, truncate_utf8};
pub(crate) use time::unix_millis;
