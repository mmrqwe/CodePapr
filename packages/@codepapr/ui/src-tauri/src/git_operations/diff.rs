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
        // 「未提交改动」= HEAD vs 工作区（含未跟踪文件）。旧实现用
        // index→workdir：index 与 HEAD 分叉时（例如 agent 调过 stage），
        // 已暂存的改动会从 diff 里消失，与面板"去暂存概念"的语义矛盾。
        let head_tree = repo.head().ok()
            .and_then(|h| h.target())
            .and_then(|oid| repo.find_commit(oid).ok())
            .and_then(|c| c.tree().ok());
        match repo.diff_tree_to_workdir(head_tree.as_ref(), Some(&mut opts)) {
            Ok(d) => d,
            Err(e) => return GitDiffResult {
                available: true, stat: String::new(), diff: String::new(),
                truncated: false, files: vec![], message: Some(e.message().to_string()),
            },
        }
    };

    let mut stat = String::new();
    let mut diff_text = String::new();
    let mut truncated = false;

    let deltas: Vec<_> = diff.deltas().collect();
    for (i, delta) in deltas.iter().enumerate() {
        let status = delta_status(delta).to_string();
        let path = delta.new_file().path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
            let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
            (additions, deletions)
        } else { (0, 0) };

        stat.push_str(&format!(" {} | {} +{} -{}\n", path, status, additions, deletions));

        if !truncated && diff_text.len() < MAX_DIFF_BYTES {
            if let Ok(Some(mut patch)) = git2::Patch::from_diff(&diff, i) {
                let mut buf = Vec::new();
                let _ = patch.print(&mut |_d: git2::DiffDelta, _h: Option<git2::DiffHunk>, line: git2::DiffLine| {
                    // content() 不含行首的 +/-/空格 前缀（origin 单独存放）：
                    // 不补前缀的话，面板 diff 无法按 unified diff 着色，
                    // summarizeGitDiff 也统计不出增删行数。
                    // 文件头/hunk 头（F/H/B）的 content 自带完整文本，不加前缀。
                    let prefix: &[u8] = match line.origin() {
                        '+' => b"+",
                        '-' => b"-",
                        ' ' => b" ",
                        _ => b"",
                    };
                    buf.extend_from_slice(prefix);
                    buf.extend_from_slice(line.content());
                    true
                });
                // 非 UTF-8 文件（GBK 等）的 diff 走编码探测兜底，避免整段替换字符
                let patch_text = crate::workspace_fs::read::decode_text_bytes(buf.clone())
                    .unwrap_or_else(|_| String::from_utf8_lossy(&buf).into_owned());
                diff_text.push_str(&patch_text);
            }
        } else if diff_text.len() >= MAX_DIFF_BYTES && i < deltas.len() {
            truncated = true;
        }
    }

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
            let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
            (additions, deletions)
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
    // git2 diff 是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitDiffResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_diff_impl(&workspace, staged.unwrap_or(false), &pathspecs.unwrap_or_default()))
    })
    .await
    .unwrap_or_else(|err| GitDiffResult {
        available: false,
        stat: String::new(),
        diff: String::new(),
        truncated: false,
        files: Vec::new(),
        message: Some(err),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::SnapshotEngine;
    use std::fs;

    fn temp_workspace(label: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "codepapr-git-diff-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// 回归 #1：line_stats() 返回 (context, additions, deletions)，
    /// 之前代码把 context 当 additions 返回。这里用真实 diff 验证 additions 计数正确。
    #[test]
    fn test_diff_line_stats_additions_deletions() {
        let workspace = temp_workspace("stats");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        // 基线快照：a.txt 3 行，b.txt 1 行。
        // engine.create 会 stage 所有文件并提交，提交后 index 持有基线内容。
        fs::write(workspace.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        fs::write(workspace.join("b.txt"), "to-remove\n").unwrap();
        engine.create("baseline").expect("create baseline");

        // 在工作区修改 a.txt（+2 行，不删除旧行），删除 b.txt。
        // 不再 engine.create，让 index 保留基线，这样 unstaged diff (index vs workdir)
        // 才能看到 a.txt 的修改和 b.txt 的删除。
        fs::write(
            workspace.join("a.txt"),
            "line1\nline2\nline3\nadded1\nadded2\n",
        )
        .unwrap();
        fs::remove_file(workspace.join("b.txt")).unwrap();

        let result = git_diff_impl(&workspace, false, &[]);
        assert!(result.available, "diff should be available");

        // a.txt 修改：additions=2, deletions=0
        let a_entry = result.files.iter().find(|f| f.path == "a.txt");
        assert!(a_entry.is_some(), "a.txt should appear in diff");
        let a_entry = a_entry.unwrap();
        assert_eq!(
            a_entry.additions, 2,
            "a.txt additions should be 2 (got {} - line_stats bug regression?)",
            a_entry.additions
        );
        assert_eq!(a_entry.deletions, 0, "a.txt deletions should be 0");

        // b.txt 被删除：additions=0, deletions=1
        let b_entry = result.files.iter().find(|f| f.path == "b.txt");
        assert!(b_entry.is_some(), "b.txt should appear in diff");
        let b_entry = b_entry.unwrap();
        assert_eq!(b_entry.additions, 0, "b.txt additions should be 0");
        assert_eq!(b_entry.deletions, 1, "b.txt deletions should be 1");

        fs::remove_dir_all(&workspace).ok();
    }

    /// 验证 staged=true 走 HEAD→index 路径不 panic，且返回结构完整。
    #[test]
    fn test_diff_staged_mode_smoke() {
        let workspace = temp_workspace("staged");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("x.txt"), "hello\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::write(workspace.join("x.txt"), "hello world\n").unwrap();
        // stage_all 路径
        super::super::stage::git_stage_impl(&workspace, true, &[]);

        let result = git_diff_impl(&workspace, true, &[]);
        assert!(result.available, "staged diff should be available");
        assert!(result.files.iter().any(|f| f.path == "x.txt"));

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：stage 使 index 与 HEAD 分叉后，unstaged diff 仍必须相对 HEAD
    /// 计算（展示完整未提交改动）。旧实现用 index→workdir，已暂存的改动
    /// 会从 diff 里消失，与面板"去暂存概念"（HEAD vs 工作区）语义矛盾。
    #[test]
    fn test_unstaged_diff_shows_staged_changes_against_head() {
        let workspace = temp_workspace("staged-vs-head");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("x.txt"), "v1\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::write(workspace.join("x.txt"), "v2\n").unwrap();
        super::super::stage::git_stage_impl(&workspace, false, &["x.txt".to_string()]);

        // 此时 index == worktree != HEAD：旧实现（index→workdir）得到空 diff
        let result = git_diff_impl(&workspace, false, &[]);
        assert!(result.available);
        assert!(
            result.files.iter().any(|f| f.path == "x.txt"),
            "stage 之后 unstaged diff 仍应显示相对 HEAD 的改动: {:?}",
            result.files
        );
        assert!(
            result.diff.contains("+v2"),
            "diff 内容应包含工作区版本: {}",
            result.diff
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
