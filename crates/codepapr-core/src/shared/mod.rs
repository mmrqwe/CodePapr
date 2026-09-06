//! Cross-cutting utilities shared by all domain modules.
//!
//! These helpers are used by 3+ unrelated domains (db, fs, shell, browser, web)
//! and have no dependencies on any domain-specific crate.

pub mod git_guard;
pub mod git_locks;
pub mod paths;
pub mod runtime;
pub mod strings;
pub mod sync;
pub mod time;

pub use git_guard::{with_workspace_git_read_lock, with_workspace_git_write_lock};
pub use git_locks::remove_stale_git_locks;
#[cfg(test)]
pub use paths::TEST_HOME_LOCK;
pub use paths::{
    arm_once_grant, canonical_workspace, clear_once_grants, expanded_path, home_dir,
    normalize_relative_path, ensure_path_accessible, ensure_path_accessible_with_policy,
    ensure_write_path_accessible, is_protected_external_path, normalize_workspace_filter,
    parse_workspace_path_input, relative_string, resolve_existing_path,
    sanitize_workspace_path_input, path_is_same, path_is_same_or_child,
    write_file_rejecting_symlink, PathLocationInput,
};
pub use runtime::{
    child_reap_timeout, enter_fast_child_reap, is_fast_child_reap, run_blocking_workspace_task,
};
pub use strings::parse_browser_url;
pub use sync::{lock, read, write};
pub use time::unix_millis;
