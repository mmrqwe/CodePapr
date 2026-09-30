//! Per-workspace counter for trusted `.CodePapr/MEMORY.md` writes.
//!
//! Shell commands can change the file without going through the file API.
//! The shell guard compares this counter before and after a command: a move
//! in the same workspace means a trusted writer (panel, curator, migration)
//! won the race. Other workspaces do not affect the comparison.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

static SEQS: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn note_trusted_memory_write(workspace: &Path) {
    let mut map = SEQS.lock().unwrap_or_else(|err| err.into_inner());
    *map.entry(workspace.to_path_buf()).or_insert(0) += 1;
}

pub fn current(workspace: &Path) -> u64 {
    let map = SEQS.lock().unwrap_or_else(|err| err.into_inner());
    map.get(workspace).copied().unwrap_or(0)
}
