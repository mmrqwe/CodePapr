pub mod status;
pub mod diff;
pub mod log;
pub mod stage;
pub mod commit;
pub mod branch;
pub mod restore_files;

use std::path::{Path, PathBuf};
use git2::Repository;

pub(crate) fn open_repo(workspace: &Path) -> Result<Repository, String> {
    let git_path = workspace.join(".CodePapr/git");
    let repo = Repository::open(&git_path)
        .map_err(|e| format!("open repo: {}", e.message()))?;
    let _ = repo.set_workdir(workspace, true);
    Ok(repo)
}

pub(crate) fn ensure_signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }
    let mut config = repo.config().map_err(|e| format!("config: {}", e.message()))?;
    if config.get_string("user.email").is_err() {
        let _ = config.set_str("user.email", "codepapr@local");
    }
    if config.get_string("user.name").is_err() {
        let _ = config.set_str("user.name", "CodePapr");
    }
    repo.signature().map_err(|e| format!("signature: {}", e.message()))
}
