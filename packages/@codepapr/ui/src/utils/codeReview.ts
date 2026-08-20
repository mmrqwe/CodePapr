/**
 * 代码审查（对比）相关的最小类型定义。
 *
 * 历史背景：早期版本曾有"批准/请求修改/逐行评论"等 GitHub 风格的状态机，
 * 在单人 + AI 编程场景下没有实际价值，已经全部移除（2026-06）。
 * 现在 CodeReviewPanel 只是一个**只读**的 base..head 差异查看器，
 * 通过 Git 增量面板的 commit 行展开按钮触发。
 *
 * 对比数据必须走 `.CodePapr/git` 影子仓库（`diff_snapshots` /
 * `snapshot_file_content`），不能在工作区 cwd 跑 `git diff`：工作区常常
 * 不是 git 仓库，CLI 会把 SHA 当成路径并报 `--no-index`。
 */
export interface ReviewScope {
  /** 左侧 ref（"对比的起点"）。可以是 commit SHA、HEAD~1 这样的相对引用，或分支名。 */
  baseRef: string;
  /**
   * 右侧 ref（"对比的终点"）。
   * 特殊值 'WORKTREE' 表示"用户当前工作区文件"——这是与"已提交的某个历史版本"对比时使用。
   */
  headRef: string;
}

export const WORKTREE_REF = 'WORKTREE';

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ReviewFileEntry {
  path: string;
  status: ReviewFileStatus;
}

export function isWorktreeRef(ref: string): boolean {
  return ref === WORKTREE_REF;
}

export function mapSnapshotDiffStatus(status: string): ReviewFileStatus {
  if (status === 'A' || status === 'C' || status === 'U') {
    return 'added';
  }
  if (status === 'D') {
    return 'deleted';
  }
  if (status === 'R') {
    return 'renamed';
  }
  return 'modified';
}

export function fileEntriesFromSnapshotDiffs(
  files: ReadonlyArray<{ path: string; status: string }>
): ReviewFileEntry[] {
  return files
    .filter((file) => file.path.trim().length > 0)
    .map((file) => ({
      path: file.path,
      status: mapSnapshotDiffStatus(file.status),
    }));
}
