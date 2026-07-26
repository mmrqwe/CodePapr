import { invoke } from '@tauri-apps/api/core';

export interface EnsureResult {
  ready: boolean;
  createdRepo: boolean;
  headSha: string | null;
  error: string | null;
}

export interface SnapshotInfo {
  sha: string;
  shortHash: string;
  label: string;
  timestamp: number;
  fileCount: number;
  isHead: boolean;
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
}

export interface RestorePlan {
  targetSha: string;
  targetLabel: string;
  targetFileCount: number;
  filesToRestore: FileChange[];
  filesToDelete: string[];
  filesUnchanged: number;
}

export interface RestoreResult {
  ok: boolean;
  filesRestored: number;
  filesDeleted: number;
  backupRef: string | null;
  error: string | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface GitStatusEntry {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  isUntracked: boolean;
}

export interface GitStatusResult {
  available: boolean;
  isRepo: boolean;
  branch: string | null;
  headShort: string | null;
  entries: GitStatusEntry[];
  message: string | null;
}

export interface GitDiffResult {
  available: boolean;
  stat: string;
  diff: string;
  truncated: boolean;
  files: FileDiff[];
  message: string | null;
}

export interface GitLogEntry {
  sha: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: number;
  message: string;
  refs: string[];
  isHead: boolean;
}

export interface GitOperationResult {
  ok: boolean;
  action: string;
  message: string;
  backupRef: string | null;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  targetSha: string;
}

export interface CommitChangedFiles {
  sha: string;
  parentSha: string | null;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
}

export async function snapshotEnsure(workspacePath: string): Promise<EnsureResult> {
  return invoke<EnsureResult>('snapshot_ensure', { workspacePath });
}

export async function snapshotCreate(workspacePath: string, label: string): Promise<SnapshotInfo> {
  return invoke<SnapshotInfo>('snapshot_create', { workspacePath, label });
}

export async function snapshotList(workspacePath: string, limit?: number): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>('snapshot_list', { workspacePath, limit: limit ?? null });
}

export async function snapshotHeadSha(workspacePath: string): Promise<string | null> {
  return invoke<string | null>('snapshot_head_sha', { workspacePath });
}

export async function restorePlan(workspacePath: string, targetSha: string): Promise<RestorePlan> {
  return invoke<RestorePlan>('restore_plan', { workspacePath, targetSha });
}

export async function restoreExecute(workspacePath: string, targetSha: string): Promise<RestoreResult> {
  return invoke<RestoreResult>('restore_execute', { workspacePath, targetSha });
}

export async function restoreUndo(workspacePath: string): Promise<void> {
  return invoke<void>('restore_undo', { workspacePath });
}

export async function snapshotChangedFiles(workspacePath: string, sha: string): Promise<CommitChangedFiles> {
  return invoke<CommitChangedFiles>('snapshot_changed_files', { workspacePath, sha });
}

export async function diffSnapshots(workspacePath: string, fromSha: string, toSha: string): Promise<FileDiff[]> {
  return invoke<FileDiff[]>('diff_snapshots', { workspacePath, fromSha, toSha });
}

export async function snapshotFileContent(workspacePath: string, sha: string, path: string): Promise<string> {
  return invoke<string>('snapshot_file_content', { workspacePath, sha, path });
}

export async function gitStatus(workspacePath: string): Promise<GitStatusResult> {
  return invoke<GitStatusResult>('git_status', { workspacePath });
}

export async function gitDiff(workspacePath: string, staged?: boolean, pathspecs?: string[]): Promise<GitDiffResult> {
  return invoke<GitDiffResult>('git_diff', { workspacePath, staged: staged ?? null, pathspecs: pathspecs ?? null });
}

export async function gitLog(workspacePath: string, limit?: number): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>('git_log', { workspacePath, limit: limit ?? null });
}

export async function gitStage(workspacePath: string, all?: boolean, pathspecs?: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>('git_stage', { workspacePath, all: all ?? null, pathspecs: pathspecs ?? null });
}

export async function gitCommit(
  workspacePath: string,
  message: string,
  stageAll?: boolean,
  pathspecs?: string[],
  allowEmpty?: boolean,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>('git_commit', {
    workspacePath, message,
    stageAll: stageAll ?? null,
    pathspecs: pathspecs ?? null,
    allowEmpty: allowEmpty ?? null,
  });
}

export async function gitBranchList(workspacePath: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>('git_branch_list', { workspacePath });
}

export async function gitBranchCheckout(
  workspacePath: string,
  branchName: string,
  create?: boolean,
  createIfMissing?: boolean,
  startPoint?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>('git_branch_checkout', {
    workspacePath, branchName,
    create: create ?? null,
    createIfMissing: createIfMissing ?? null,
    startPoint: startPoint ?? null,
  });
}

export async function gitRestoreFiles(workspacePath: string, pathspecs?: string[], source?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>('git_restore_files', {
    workspacePath,
    pathspecs: pathspecs ?? null,
    source: source ?? null,
  });
}

// ── Checkpoint Timeline ───────────────────────────────────────────────

export interface CheckpointRecord {
  id: number;
  sessionId: string;
  messageId: string;
  sha: string;
  label: string;
  fileCount: number;
  createdAt: number;
}

export async function saveCheckpointRecord(
  workspacePath: string,
  sessionId: string,
  messageId: string,
  sha: string,
  label: string,
  fileCount: number,
): Promise<void> {
  return invoke<void>('save_checkpoint_record', {
    workspacePath, sessionId, messageId, sha, label, fileCount,
  });
}

export async function loadCheckpointRecords(
  workspacePath: string,
  sessionId?: string,
): Promise<CheckpointRecord[]> {
  return invoke<CheckpointRecord[]>('load_checkpoint_records', {
    workspacePath,
    sessionId: sessionId ?? null,
  });
}

export async function deleteCheckpointByMessage(
  workspacePath: string,
  messageId: string,
): Promise<void> {
  return invoke<void>('delete_checkpoint_by_message', { workspacePath, messageId });
}

export async function deleteCheckpointsForSession(
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>('delete_checkpoints_for_session', { workspacePath, sessionId });
}
