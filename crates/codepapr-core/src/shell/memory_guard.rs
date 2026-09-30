//! Rolls back shell edits to `.CodePapr/MEMORY.md`.
//!
//! macOS sandbox-exec already denies that tree. This guard is the backstop
//! when the profile does not hold, including Windows and Linux where the
//! process sandbox is not enforced. A trusted write bumps
//! [`crate::memory_write_seq`] and is left in place.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::types::CommandResult;
use crate::memory_write_seq;

pub const MEMORY_SHELL_GUARD_NOTE: &str =
    "[memory-guard] 检测到 shell 命令改动了 .CodePapr/MEMORY.md，已回滚——该文件仅由记忆管家与用户在记忆面板维护。";

const ROLLBACK_FAILED_NOTE: &str =
    "[memory-guard] 检测到 shell 命令改动了 .CodePapr/MEMORY.md，但回滚失败。请检查该文件。";

#[derive(Clone)]
pub struct MemorySnapshot {
    seq: u64,
    workspace: PathBuf,
    path: PathBuf,
    content: Option<Vec<u8>>,
}

pub fn snapshot(workspace: &Path) -> MemorySnapshot {
    let path = memory_file_path(workspace);
    MemorySnapshot {
        seq: memory_write_seq::current(workspace),
        workspace: workspace.to_path_buf(),
        content: read_regular_file(&path),
        path,
    }
}

/// Restores a shell-tampered memory file. Returns a note to attach when the
/// command result is still available.
pub fn rollback_if_needed(snapshot: &MemorySnapshot) -> Option<String> {
    if memory_write_seq::current(&snapshot.workspace) != snapshot.seq {
        return None;
    }
    let after = read_regular_file(&snapshot.path);
    if after == snapshot.content {
        return None;
    }
    let Some(before) = snapshot.content.as_ref() else {
        if after.is_some() {
            eprintln!(
                "[memory-shell-guard] shell 命令新建了 .CodePapr/MEMORY.md，未删除（无法确认命令前文件是否本就不存在）"
            );
        }
        return None;
    };
    match restore_regular_file(&snapshot.path, before) {
        Ok(()) => Some(MEMORY_SHELL_GUARD_NOTE.to_string()),
        Err(err) => {
            eprintln!("[memory-shell-guard] 回滚失败: {err}");
            Some(ROLLBACK_FAILED_NOTE.to_string())
        }
    }
}

pub fn attach_note(result: &mut CommandResult, note: Option<String>) {
    let Some(note) = note else {
        return;
    };
    if result.stderr.is_empty() {
        result.stderr = note;
    } else {
        result.stderr.push('\n');
        result.stderr.push_str(&note);
    }
}

fn memory_file_path(workspace: &Path) -> PathBuf {
    workspace.join(".CodePapr").join("MEMORY.md")
}

fn read_regular_file(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    fs::read(path).ok()
}

fn restore_regular_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            fs::remove_file(path).map_err(|err| format!("移除符号链接失败: {err}"))?;
        }
    }
    write_nofollow(path, bytes)
}

fn write_nofollow(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|err| format!("回滚写入失败: {err}"))?;
        file.write_all(bytes)
            .map_err(|err| format!("回滚写入失败: {err}"))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).map_err(|err| format!("回滚写入失败: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "codepapr-memory-guard-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join(".CodePapr")).unwrap();
        path
    }

    #[test]
    fn shell_rewrite_is_restored() {
        let workspace = workspace();
        let file = workspace.join(".CodePapr").join("MEMORY.md");
        fs::write(&file, b"hello\n").unwrap();
        let snap = snapshot(&workspace);
        fs::write(&file, b"hacked\n").unwrap();
        let note = rollback_if_needed(&snap);
        assert_eq!(note.as_deref(), Some(MEMORY_SHELL_GUARD_NOTE));
        assert_eq!(fs::read(&file).unwrap(), b"hello\n");
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn trusted_write_during_the_command_is_kept() {
        let workspace = workspace();
        let file = workspace.join(".CodePapr").join("MEMORY.md");
        fs::write(&file, b"hello\n").unwrap();
        let snap = snapshot(&workspace);
        fs::write(&file, b"from-curator\n").unwrap();
        memory_write_seq::note_trusted_memory_write(&workspace);
        assert!(rollback_if_needed(&snap).is_none());
        assert_eq!(fs::read(&file).unwrap(), b"from-curator\n");
        let _ = fs::remove_dir_all(&workspace);
    }
}
