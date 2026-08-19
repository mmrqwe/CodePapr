use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureResult {
    pub ready: bool,
    pub created_repo: bool,
    /// true 表示检测到既有 shadow repo 损坏，已把损坏目录改名保留并重建。
    #[serde(default)]
    pub rebuilt: bool,
    pub head_sha: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub sha: String,
    pub short_hash: String,
    pub label: String,
    pub timestamp: i64,
    pub file_count: usize,
    pub is_head: bool,
    /// 创建时未能加入索引的文件数（如超过大小上限）。>0 表示该快照不完整。
    #[serde(default)]
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub target_sha: String,
    pub target_label: String,
    pub target_file_count: usize,
    pub files_to_restore: Vec<FileChange>,
    pub files_to_delete: Vec<String>,
    pub files_unchanged: usize,
    /// 当前工作区中"不在目标树、也不被 gitignore 忽略"的未跟踪文件：
    /// execute 时会被删除（与 remove_untracked_not_in_tree 的行为一致）。
    /// 旧版 plan 不报告这部分，确认框对破坏性影响的预览不完整。
    #[serde(default)]
    pub untracked_to_delete: Vec<String>,
    /// 当前工作区中将被覆盖的未提交改动数（index/worktree 相对 HEAD 的改动，
    /// 不含未跟踪新文件）。这些改动会先进入备份快照（可 undo 找回），
    /// 但确认时必须让用户知情。
    #[serde(default)]
    pub dirty_overwritten: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub ok: bool,
    pub files_restored: usize,
    pub files_deleted: usize,
    pub backup_ref: Option<String>,
    /// 备份快照的 commit SHA。撤销时用它校验 BACKUP_REF 未被其它破坏性
    /// 操作覆盖——所有破坏性操作共用同一个 BACKUP_REF，不校验的话，
    /// 重置后又做了其它 git 操作时 undo 会静默恢复到错误状态。
    #[serde(default)]
    pub backup_sha: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub is_untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub available: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub entries: Vec<GitStatusEntry>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub available: bool,
    pub stat: String,
    pub diff: String,
    pub truncated: bool,
    pub files: Vec<FileDiff>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub message: String,
    pub refs: Vec<String>,
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub ok: bool,
    pub action: String,
    pub message: String,
    pub backup_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub target_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChangedFiles {
    pub sha: String,
    pub parent_sha: Option<String>,
    pub files: Vec<FileChange>,
    pub total_additions: usize,
    pub total_deletions: usize,
}
