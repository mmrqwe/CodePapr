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
        let mut builder = WalkBuilder::new(&self.workspace);
        builder
            .hidden(false)
            .require_git(false)
            .parents(true)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(true)
            .ignore(true)
            .follow_links(false)
            .max_filesize(Some(MAX_FILESIZE));

        let mut files = Vec::new();
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
            files.push(relative.to_path_buf());
        }
        files
    }
}
