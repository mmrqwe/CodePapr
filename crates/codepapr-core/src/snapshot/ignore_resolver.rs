use std::path::{Path, PathBuf};
use ignore::WalkBuilder;

const MAX_FILESIZE: u64 = 100 * 1024 * 1024;

/// libgit2 的仓库相对路径 API（`index.add_path` / `tree.get_path`）只按
/// `/` 解析树条目。Windows 上 `collect_files` 返回的相对路径含 `\`，直接
/// 传入会匹配失败：快照悄悄漏掉文件、恢复时 `get_path` 误判"不在目标树"
/// 而把刚恢复的文件删掉。交给 git2 前统一转成正斜杠。
/// 仅 Windows 需要转换：POSIX 上 `\` 是合法文件名字符而非分隔符。
pub fn git_relative_path(relative: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(relative.to_string_lossy().replace('\\', "/"))
    } else {
        relative.to_path_buf()
    }
}

pub struct IgnoreResolver {
    workspace: PathBuf,
}

impl IgnoreResolver {
    pub fn new(workspace: &Path) -> Self {
        Self { workspace: workspace.to_path_buf() }
    }

    pub fn collect_files(&self) -> Vec<PathBuf> {
        self.walk(MAX_FILESIZE, false).unwrap_or_default()
    }

    /// Backup before a hard reset. Files over [`MAX_FILESIZE`] are not silently
    /// omitted: the reset is refused so undo still has the bytes.
    pub fn collect_files_for_backup(&self) -> Result<Vec<PathBuf>, String> {
        self.walk(MAX_FILESIZE, true)
    }

    fn walk(&self, max_filesize: u64, fail_on_oversize: bool) -> Result<Vec<PathBuf>, String> {
        let mut builder = WalkBuilder::new(&self.workspace);
        builder
            .hidden(false)
            .require_git(false)
            .parents(true)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(true)
            .ignore(true)
            .follow_links(false);

        let mut files = Vec::new();
        let mut oversized_count = 0usize;
        let mut sample = Vec::new();
        for entry in builder.build() {
            let Ok(entry) = entry else { continue };
            let Some(ft) = entry.file_type() else { continue };
            if !ft.is_file() || ft.is_symlink() { continue; }
            let Ok(relative) = entry.path().strip_prefix(&self.workspace) else { continue };
            if relative.components().any(|c| {
                c == std::path::Component::ParentDir
                    || matches!(c.as_os_str().to_str(), Some(".git" | ".CodePapr" | ".codepapr_git_backup"))
            }) {
                continue;
            }
            let len = match entry.metadata() {
                Ok(meta) => meta.len(),
                Err(err) if fail_on_oversize => {
                    return Err(format!(
                        "备份快照不完整：无法读取 {} 的大小（{err}），已拒绝执行 reset",
                        relative.display()
                    ));
                }
                Err(_) => continue,
            };
            if len > max_filesize {
                if fail_on_oversize {
                    oversized_count += 1;
                    if sample.len() < 5 {
                        sample.push(relative.display().to_string());
                    }
                }
                continue;
            }
            files.push(relative.to_path_buf());
        }
        if oversized_count > 0 {
            return Err(format!(
                "备份快照不完整：{oversized_count} 个文件超过 {max_filesize} 字节，已拒绝执行 reset（{}）",
                sample.join(", ")
            ));
        }
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn backup_refuses_files_over_the_limit() {
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-backup-limit-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&workspace);
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("small.txt"), b"ok").unwrap();
        fs::write(workspace.join("big.bin"), vec![0u8; 32]).unwrap();

        let resolver = IgnoreResolver::new(&workspace);
        let err = resolver.walk(8, true).expect_err("oversize file must fail the backup");
        assert!(err.contains("已拒绝执行 reset"), "{err}");
        let files = resolver.walk(8, false).unwrap();
        assert!(files.iter().any(|path| path.ends_with("small.txt")));
        assert!(files.iter().all(|path| !path.ends_with("big.bin")));
        let _ = fs::remove_dir_all(&workspace);
    }
}
