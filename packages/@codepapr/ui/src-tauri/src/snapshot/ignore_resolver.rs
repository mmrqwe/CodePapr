use std::path::{Path, PathBuf};
use ignore::WalkBuilder;

const MAX_FILESIZE: u64 = 100 * 1024 * 1024;

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
