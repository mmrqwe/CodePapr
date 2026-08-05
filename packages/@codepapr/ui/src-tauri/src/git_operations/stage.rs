use crate::snapshot::types::GitOperationResult;
use super::open_repo;

pub fn git_stage_impl(
    workspace: &std::path::Path,
    all: bool,
    pathspecs: &[String],
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "stage".to_string(), message: e, backup_ref: None,
        },
    };

    let mut index = match repo.index() {
        Ok(idx) => idx,
        Err(e) => return GitOperationResult {
            ok: false, action: "stage".to_string(),
            message: format!("index: {}", e.message()), backup_ref: None,
        },
    };

    if all || !pathspecs.is_empty() {
        if all || pathspecs.is_empty() {
            use crate::snapshot::ignore_resolver::{git_relative_path, IgnoreResolver};
            let resolver = IgnoreResolver::new(workspace);
            let files = resolver.collect_files();
            let mut added = 0;
            for file in &files {
                if index.add_path(&git_relative_path(file)).is_ok() {
                    added += 1;
                }
            }
            if let Err(e) = index.write() {
                return GitOperationResult {
                    ok: false, action: "stage".to_string(),
                    message: format!("write index: {}", e.message()), backup_ref: None,
                };
            }
            return GitOperationResult {
                ok: true, action: "stage".to_string(),
                message: format!("已暂存 {} 个文件", added), backup_ref: None,
            };
        }

        let mut added = 0;
        for path in pathspecs {
            let p = crate::snapshot::ignore_resolver::git_relative_path(std::path::Path::new(path));
            if workspace.join(&p).exists() {
                if let Err(e) = index.add_path(&p) {
                    return GitOperationResult {
                        ok: false, action: "stage".to_string(),
                        message: format!("add {:?}: {}", path, e.message()), backup_ref: None,
                    };
                }
            } else {
                // 文件已从工作区删除：add_path 只处理新增/修改，暂存删除必须
                // 用 remove_path（对齐 git add <path> 的语义），否则报错。
                if let Err(e) = index.remove_path(&p) {
                    return GitOperationResult {
                        ok: false, action: "stage".to_string(),
                        message: format!("remove {:?}: {}", path, e.message()), backup_ref: None,
                    };
                }
            }
            added += 1;
        }
        if let Err(e) = index.write() {
            return GitOperationResult {
                ok: false, action: "stage".to_string(),
                message: format!("write index: {}", e.message()), backup_ref: None,
            };
        }
        GitOperationResult {
            ok: true, action: "stage".to_string(),
            message: format!("已暂存 {} 个路径", added), backup_ref: None,
        }
    } else {
        GitOperationResult {
            ok: true, action: "stage".to_string(),
            message: "已暂存 0 个文件（未指定文件）".to_string(), backup_ref: None,
        }
    }
}

#[tauri::command]
pub async fn git_stage(
    workspace_path: String,
    all: Option<bool>,
    pathspecs: Option<Vec<String>>,
) -> GitOperationResult {
    // git2 暂存是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitOperationResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_stage_impl(&workspace, all.unwrap_or(false), &pathspecs.unwrap_or_default()))
    })
    .await
    .unwrap_or_else(|err| GitOperationResult {
        ok: false,
        action: "stage".to_string(),
        message: err,
        backup_ref: None,
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
            "codepapr-stage-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_stage_specific_pathspecs_only_adds_those() {
        let workspace = temp_workspace("pathspec");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("a.txt"), "a\n").unwrap();
        fs::write(workspace.join("b.txt"), "b\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::write(workspace.join("a.txt"), "a-v2\n").unwrap();
        fs::write(workspace.join("b.txt"), "b-v2\n").unwrap();

        // 只 stage a.txt
        let result = git_stage_impl(&workspace, false, &["a.txt".to_string()]);
        assert!(result.ok, "stage should succeed: {}", result.message);

        // 验证 staged diff 里只有 a.txt
        let diff_result = super::super::diff::git_diff_impl(&workspace, true, &[]);
        let staged_paths: Vec<&str> = diff_result.files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            staged_paths.iter().any(|p| *p == "a.txt"),
            "a.txt 应该已 staged: {:?}", staged_paths
        );
        // b.txt 不应该出现在 staged diff 里（它的改动未 stage）
        assert!(
            !staged_paths.iter().any(|p| *p == "b.txt"),
            "b.txt 不应该 staged: {:?}", staged_paths
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_stage_all_stages_every_changed_file() {
        let workspace = temp_workspace("all");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("x.txt"), "x\n").unwrap();
        engine.create("baseline").expect("baseline");
        fs::write(workspace.join("x.txt"), "x-v2\n").unwrap();
        fs::write(workspace.join("y.txt"), "y\n").unwrap();

        let result = git_stage_impl(&workspace, true, &[]);
        assert!(result.ok, "stage_all should succeed: {}", result.message);

        let diff_result = super::super::diff::git_diff_impl(&workspace, true, &[]);
        let paths: Vec<&str> = diff_result.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.iter().any(|p| *p == "x.txt"), "x.txt 应已 staged");
        assert!(paths.iter().any(|p| *p == "y.txt"), "y.txt 应已 staged");

        fs::remove_dir_all(&workspace).ok();
    }

    // P2-29：选择性 stage 必须能暂存「已删除」的文件（对齐 git add <path>）。
    // 旧实现对 pathspec 一律 add_path，文件已删除时报错而非暂存删除。
    #[test]
    fn test_stage_deleted_file_stages_the_deletion() {
        let workspace = temp_workspace("deleted");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("gone.txt"), "to be removed\n").unwrap();
        fs::write(workspace.join("keep.txt"), "stays\n").unwrap();
        engine.create("baseline").expect("baseline");

        // 从工作区删除 gone.txt
        fs::remove_file(workspace.join("gone.txt")).unwrap();

        let result = git_stage_impl(&workspace, false, &["gone.txt".to_string()]);
        assert!(result.ok, "暂存已删除文件应成功: {}", result.message);

        // staged diff 应把 gone.txt 标记为删除（D）
        let diff_result = super::super::diff::git_diff_impl(&workspace, true, &[]);
        let gone = diff_result.files.iter().find(|f| f.path == "gone.txt");
        assert!(gone.is_some(), "gone.txt 应出现在 staged diff: {:?}", diff_result.files);
        assert_eq!(gone.unwrap().status, "D", "gone.txt 应为删除状态");

        fs::remove_dir_all(&workspace).ok();
    }
}
