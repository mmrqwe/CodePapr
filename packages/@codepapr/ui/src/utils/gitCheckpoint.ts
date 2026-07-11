import { invoke } from '@tauri-apps/api/core';

export interface GitCheckpointEnsureResult {
  ready: boolean;
  createdRepo: boolean;
  headSha: string | null;
  error: string | null;
}

export interface GitCheckpointCreateResult {
  sha: string;
}

export interface GitCheckpointResetResult {
  filesChanged: number;
  headSha: string;
}

interface RawEnsureResult {
  ready: boolean;
  created_repo: boolean;
  head_sha: string | null;
  error: string | null;
}

interface RawCreateResult {
  sha: string;
}

interface RawResetResult {
  files_changed: number;
  head_sha: string;
}

export async function gitCheckpointEnsure(workspacePath: string): Promise<GitCheckpointEnsureResult> {
  const raw = await invoke<RawEnsureResult>('git_checkpoint_ensure', { workspacePath });
  return {
    ready: raw.ready,
    createdRepo: raw.created_repo,
    headSha: raw.head_sha,
    error: raw.error,
  };
}

export async function gitCheckpointCreate(
  workspacePath: string,
  label: string
): Promise<GitCheckpointCreateResult> {
  const raw = await invoke<RawCreateResult>('git_checkpoint_create', { workspacePath, label });
  // 每次成功创建 checkpoint 后，触发一次"软清理"机制（每 100 次实际跑一次 git gc --auto）。
  // fire-and-forget：清理失败不影响 checkpoint 创建本身。
  void maybeRunPeriodicGc(workspacePath);
  return { sha: raw.sha };
}

export async function gitCheckpointReset(
  workspacePath: string,
  targetSha: string
): Promise<GitCheckpointResetResult> {
  const raw = await invoke<RawResetResult>('git_checkpoint_reset', { workspacePath, targetSha });
  return { filesChanged: raw.files_changed, headSha: raw.head_sha };
}

export async function gitCheckpointHeadSha(workspacePath: string): Promise<string | null> {
  return (await invoke<string | null>('git_checkpoint_head_sha', { workspacePath })) ?? null;
}

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitChangedFiles {
  sha: string;
  parentSha: string | null;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
}

interface RawChangedFile {
  path: string;
  old_path: string | null;
  status: string;
  additions: number;
  deletions: number;
}

interface RawCommitChangedFiles {
  sha: string;
  parent_sha: string | null;
  files: RawChangedFile[];
  total_additions: number;
  total_deletions: number;
}

export async function gitCheckpointChangedFiles(
  workspacePath: string,
  sha: string
): Promise<CommitChangedFiles> {
  const raw = await invoke<RawCommitChangedFiles>('git_checkpoint_changed_files', {
    workspacePath,
    sha,
  });
  return {
    sha: raw.sha,
    parentSha: raw.parent_sha,
    files: raw.files.map((f) => ({
      path: f.path,
      oldPath: f.old_path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
    totalAdditions: raw.total_additions,
    totalDeletions: raw.total_deletions,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 周期性 git gc（方案 A 的"自然过期"机制）
//
// 背景：每发一条用户消息就创建一个 checkpoint commit，长期使用会积累上万个
// commit 对象 + 重复的 blob，导致 .git 目录无限增长。
//
// 策略：极轻量——每 100 次成功创建 checkpoint 后，触发一次
//   `git gc --auto --prune=2.weeks.ago`
// 让 Git 自己决定要不要 repack；同时回收 2 周前已被新 commit 替代的孤立 blob。
//
// 这是 fire-and-forget 调用：失败/超时都不影响 checkpoint 流程，最坏情况
// 就是这次没清理，下次再说。
//
// 计数器按 workspacePath 隔离，仅活在内存里——重启 App 后归零。
// 不持久化是有意为之：避免持久化错误造成永久不清理或永久反复清理。
// ────────────────────────────────────────────────────────────────────────────

const GC_INTERVAL = 100;
const checkpointCounters = new Map<string, number>();

async function maybeRunPeriodicGc(workspacePath: string): Promise<void> {
  const next = (checkpointCounters.get(workspacePath) ?? 0) + 1;
  if (next < GC_INTERVAL) {
    checkpointCounters.set(workspacePath, next);
    return;
  }
  // 命中阈值：归零计数器，跑一次 gc。
  checkpointCounters.set(workspacePath, 0);
  try {
    await invoke('run_workspace_command', {
      workspacePath,
      command: 'git',
      args: ['gc', '--auto', '--prune=2.weeks.ago'],
      timeoutSeconds: 120,
    });
  } catch {
    // 静默失败——下个 100 次后再试。
  }
}

/**
 * 测试钩子：清空所有 workspace 的 gc 计数器，让单测之间互不干扰。
 */
export function __resetCheckpointGcCounterForTest(): void {
  checkpointCounters.clear();
}

