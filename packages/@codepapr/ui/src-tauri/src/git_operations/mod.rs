pub mod branch;
pub mod commit;
pub mod diff;
pub mod log;
pub mod restore_files;
pub mod stage;
pub mod status;

use git2::Repository;
use std::path::{Path, PathBuf};

pub(crate) fn open_repo(workspace: &Path) -> Result<Repository, String> {
    let git_path = workspace.join(".CodePapr/git");
    // 清理可能因崩溃遗留的锁文件（config/index/HEAD/packed-refs .lock）。
    // 只删可证明陈旧的（存活超阈值）：无条件删除会把并发操作正在使用的
    // 活锁删掉，破坏写到一半的 index/ref。
    crate::shared::remove_stale_git_locks(&git_path.join(".git"));
    let repo = Repository::open(&git_path).map_err(|e| format!("open repo: {}", e.message()))?;
    let _ = repo.set_workdir(workspace, false);
    Ok(repo)
}

/// 校验 git 引用（分支名、tag、SHA、HEAD 等），作为纵深防御。
/// 对齐 TS 侧 `assertValidGitReference`：拒绝空、以 `-` 开头、含空白、
/// 含控制字符（<=0x1f 或 ==0x7f）的输入。
pub(crate) fn validate_git_ref(value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{} 必须是非空字符串", field_name));
    }
    if trimmed.starts_with('-') {
        return Err(format!("非法 {}: {} (不能以 - 开头)", field_name, value));
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || (c as u32) < 0x20 || (c as u32) == 0x7f)
    {
        return Err(format!("非法 {}: {}", field_name, value));
    }
    Ok(())
}

pub(crate) fn ensure_signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }
    let mut config = repo
        .config()
        .map_err(|e| format!("config: {}", e.message()))?;
    if config.get_string("user.email").is_err() {
        let _ = config.set_str("user.email", "codepapr@local");
    }
    if config.get_string("user.name").is_err() {
        let _ = config.set_str("user.name", "CodePapr");
    }
    repo.signature()
        .map_err(|e| format!("signature: {}", e.message()))
}
