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
            .max_filesize(Some(MAX_FILESIZE));

        let mut files = Vec::new();
        for entry in builder.build() {
            if let Ok(entry) = entry {
                if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                    if let Ok(relative) = entry.path().strip_prefix(&self.workspace) {
                        files.push(relative.to_path_buf());
                    }
                }
            }
        }
        files
    }
}
