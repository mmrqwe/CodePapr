use std::path::PathBuf;
use git2::DiffOptions;
use crate::snapshot::types::{GitDiffResult, FileDiff};
use super::open_repo;

fn delta_status(delta: &git2::DiffDelta) -> &'static str {
    match delta.status() {
        git2::Delta::Added => "A",
        git2::Delta::Deleted => "D",
        git2::Delta::Modified => "M",
        git2::Delta::Renamed => "R",
        git2::Delta::Copied => "C",
        _ => "U",
    }
}

const MAX_DIFF_BYTES: usize = 160_000;

pub fn git_diff_impl(
    workspace: &std::path::Path,
    staged: bool,
    pathspecs: &[String],
) -> GitDiffResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitDiffResult {
            available: false, stat: String::new(), diff: String::new(),
            truncated: false, files: vec![], message: Some(e),
        },
    };

    let mut opts = DiffOptions::new();
    if staged {
        opts.include_untracked(false);
    } else {
        opts.include_untracked(true);
    }
    for spec in pathspecs {
        opts.pathspec(spec);
    }

    let diff = if staged {
        let head_tree = repo.head().ok()
            .and_then(|h| h.target())
            .and_then(|oid| repo.find_commit(oid).ok())
            .and_then(|c| c.tree().ok());
        match repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)) {
            Ok(d) => d,
            Err(e) => return GitDiffResult {
                available: true, stat: String::new(), diff: String::new(),
                truncated: false, files: vec![], message: Some(e.message().to_string()),
            },
        }
    } else {
        match repo.diff_index_to_workdir(None, Some(&mut opts)) {
            Ok(d) => d,
            Err(e) => return GitDiffResult {
                available: true, stat: String::new(), diff: String::new(),
                truncated: false, files: vec![], message: Some(e.message().to_string()),
            },
        }
    };

    let mut stat = String::new();
    let mut diff_text = String::new();

    let deltas: Vec<_> = diff.deltas().collect();
    for (i, delta) in deltas.iter().enumerate() {
        let status = delta_status(delta).to_string();
        let path = delta.new_file().path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = if delta.status() == git2::Delta::Renamed {
            delta.old_file().path().map(|p| p.to_string_lossy().to_string())
        } else { None };
        let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
            let (a, _d2, d) = patch.line_stats().unwrap_or((0, 0, 0));
            (a, d)
        } else { (0, 0) };

        stat.push_str(&format!(" {} | {} +{} -{}\n", path, status, additions, deletions));

        if diff_text.len() < MAX_DIFF_BYTES {
            if let Ok(Some(mut patch)) = git2::Patch::from_diff(&diff, i) {
                let mut buf = Vec::new();
                let _ = patch.print(&mut |_d: git2::DiffDelta, _h: Option<git2::DiffHunk>, line: git2::DiffLine| {
                    buf.extend_from_slice(line.content());
                    true
                });
                diff_text.push_str(&String::from_utf8_lossy(&buf));
            }
        }
    }

    let truncated = diff_text.len() >= MAX_DIFF_BYTES;

    let mut files = Vec::new();
    for (i, delta) in deltas.iter().enumerate() {
        let status = delta_status(delta).to_string();
        let path = delta.new_file().path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = if delta.status() == git2::Delta::Renamed {
            delta.old_file().path().map(|p| p.to_string_lossy().to_string())
        } else { None };
        let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
            let (a, _d2, d) = patch.line_stats().unwrap_or((0, 0, 0));
            (a, d)
        } else { (0, 0) };
        files.push(FileDiff { path, old_path, status, additions, deletions, patch: None });
    }

    GitDiffResult {
        available: true,
        stat,
        diff: diff_text,
        truncated,
        files,
        message: None,
    }
}

#[tauri::command]
pub async fn git_diff(
    workspace_path: String,
    staged: Option<bool>,
    pathspecs: Option<Vec<String>>,
) -> GitDiffResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_diff_impl(&workspace, staged.unwrap_or(false), &pathspecs.unwrap_or_default())
}
