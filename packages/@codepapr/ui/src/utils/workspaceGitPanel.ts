import type { GitDiffSummary, GitStatusFile } from '../tools/workspaceToolUtils';

export type GitDiffMode = 'unstaged' | 'staged';

export interface GitFileSelection {
  path: string;
  mode: GitDiffMode;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
}

export interface GitDiffContentSource {
  kind: 'empty' | 'workspace' | 'git';
  path: string;
  revision?: 'HEAD' | 'INDEX';
}

export interface GitDiffContentPlan {
  original: GitDiffContentSource;
  modified: GitDiffContentSource;
}

export interface GitDiffMetrics {
  additions: number;
  deletions: number;
  hunks: number;
  files: number;
}

export type GitDisplayStatusKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface GitDisplayStatus {
  code: string;
  kind: GitDisplayStatusKind;
}

const HIDDEN_GIT_PANEL_BASENAMES = new Set([
  '.ds_store',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  'thumbs.db',
]);

function isInternalProjectStatePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return (
    normalized === '.CodePapr/state.json' ||
    normalized === '.CodePapr/project.json' ||
    /^\.CodePapr\/project\.sqlite(?:[-.].+)?$/i.test(normalized)
  );
}

function isHiddenGitPanelNoisePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const basename = normalized.split('/').pop()?.toLowerCase() ?? '';
  return HIDDEN_GIT_PANEL_BASENAMES.has(basename);
}

export function isVisibleGitPanelFile(file: GitStatusFile): boolean {
  const normalizedPath = file.path.trim().replace(/\\/g, '/');
  const normalizedOriginalPath = file.originalPath?.trim().replace(/\\/g, '/');

  if (!normalizedPath || normalizedPath.endsWith('/')) {
    return false;
  }
  if (normalizedOriginalPath?.endsWith('/')) {
    return false;
  }
  if (isInternalProjectStatePath(normalizedPath)) {
    return false;
  }
  if (normalizedOriginalPath && isInternalProjectStatePath(normalizedOriginalPath)) {
    return false;
  }
  if (isHiddenGitPanelNoisePath(normalizedPath)) {
    return false;
  }
  if (normalizedOriginalPath && isHiddenGitPanelNoisePath(normalizedOriginalPath)) {
    return false;
  }

  return true;
}

export function filterVisibleGitFiles(files: readonly GitStatusFile[]): GitStatusFile[] {
  return files.filter((file) => isVisibleGitPanelFile(file));
}

export function listGitFilesForMode(
  files: readonly GitStatusFile[],
  mode: GitDiffMode
): GitStatusFile[] {
  return filterVisibleGitFiles(files).filter((file) => {
    if (mode === 'staged') {
      return Boolean(file.indexStatus && file.indexStatus !== '?');
    }

    return Boolean(file.worktreeStatus) || (file.indexStatus === '?' && file.worktreeStatus === '?');
  });
}

/**
 * 列出工作区中所有"有改动的"文件（不再区分暂存/未暂存）。
 * 包含：
 * - 工作区有修改（worktreeStatus 非空）
 * - 已暂存但未提交（indexStatus 非空且非 '?'）
 * - 未跟踪（?? 的新文件）
 *
 * 这是方案 A（去暂存概念）的核心：UI 只展示"未提交的全部改动"。
 */
export function listAllChangedGitFiles(files: readonly GitStatusFile[]): GitStatusFile[] {
  return filterVisibleGitFiles(files).filter((file) => {
    const indexTrimmed = file.indexStatus?.trim() ?? '';
    const worktreeTrimmed = file.worktreeStatus?.trim() ?? '';
    const hasIndexChange = indexTrimmed.length > 0 && indexTrimmed !== '?';
    const hasWorktreeChange = worktreeTrimmed.length > 0 && worktreeTrimmed !== '?';
    const isUntracked = file.isUntracked ?? (
      (indexTrimmed === '?' || indexTrimmed === '') &&
      (worktreeTrimmed === '?' || (worktreeTrimmed === '' && indexTrimmed === '?'))
    );
    return hasIndexChange || hasWorktreeChange || isUntracked;
  });
}

/**
 * 根据"未提交改动"语义返回展示用的 status code：
 * - 未跟踪：'??'
 * - 否则优先用 worktreeStatus（如果有），否则用 indexStatus。
 */
export function gitStatusCodeForChange(file: GitStatusFile): string {
  if (file.isUntracked ?? (file.indexStatus === '?' && file.worktreeStatus === '?')) {
    return '??';
  }
  if (file.worktreeStatus && file.worktreeStatus.trim()) {
    return file.worktreeStatus.trim();
  }
  return (file.indexStatus?.trim()) || '??';
}

/** 与 describeGitFileStatus 类似，但不需要区分模式（统一从"未提交改动"角度判定）。 */
export function describeGitChange(file: GitStatusFile): GitDisplayStatus {
  if (file.isUntracked ?? (file.indexStatus === '?' && file.worktreeStatus === '?')) {
    return { code: '??', kind: 'untracked' };
  }

  const code = gitStatusCodeForChange(file);
  if (code === 'A') return { code, kind: 'added' };
  if (code === 'D') return { code, kind: 'deleted' };
  if (code === 'R' || Boolean(file.originalPath)) return { code: code || 'R', kind: 'renamed' };
  return { code: code || 'M', kind: 'modified' };
}

export function gitStatusCodeForMode(file: GitStatusFile, mode: GitDiffMode): string {
  if (mode === 'staged') {
    return file.indexStatus || '??';
  }

  if (file.indexStatus === '?' && file.worktreeStatus === '?') {
    return '??';
  }

  return file.worktreeStatus || '??';
}

export function describeGitFileStatus(file: GitStatusFile, mode: GitDiffMode): GitDisplayStatus {
  if (mode === 'unstaged' && file.indexStatus === '?' && file.worktreeStatus === '?') {
    return { code: '??', kind: 'untracked' };
  }

  const code = gitStatusCodeForMode(file, mode);
  if (code === 'A') {
    return { code, kind: 'added' };
  }
  if (code === 'D') {
    return { code, kind: 'deleted' };
  }
  if (code === 'R' || Boolean(file.originalPath)) {
    return { code: code || 'R', kind: 'renamed' };
  }

  return { code: code || 'M', kind: 'modified' };
}

export function buildGitDiffCommandArgs(params: {
  mode: GitDiffMode;
  pathspecs?: readonly string[];
  unified?: number;
  findRenames?: boolean;
}): {
  staged: boolean;
  statArgs: string[];
  diffArgs: string[];
} {
  const staged = params.mode === 'staged';
  const statArgs = ['diff', '--no-ext-diff'];
  const diffArgs = ['diff', '--no-ext-diff'];

  if (staged) {
    statArgs.push('--cached');
    diffArgs.push('--cached');
  } else {
    // 方案 A（去暂存概念）：未提交改动 diff 统一相对 HEAD，
    // 这样无论文件是否处于 INDEX 都能看到完整改动。
    statArgs.push('HEAD');
    diffArgs.push('HEAD');
  }

  if (params.findRenames) {
    statArgs.push('--find-renames');
    diffArgs.push('--find-renames');
  }

  statArgs.push('--stat');
  diffArgs.push(`--unified=${Math.max(0, params.unified ?? 0)}`);

  if (params.pathspecs && params.pathspecs.length > 0) {
    statArgs.push('--', ...params.pathspecs);
    diffArgs.push('--', ...params.pathspecs);
  }

  return {
    staged,
    statArgs,
    diffArgs,
  };
}

export function gitDiffCacheKey(mode: GitDiffMode, path: string): string {
  return `${mode}:${path}`;
}

export type CommitKind = 'user' | 'checkpoint' | 'baseline' | 'legacy-checkpoint';

export interface CheckpointSubjectInfo {
  kind: CommitKind;
  display: string;
  sequence: number | null;
  preview: string | null;
}

const CHECKPOINT_SUBJECT_PATTERN = /^checkpoint #(\d+)\s*·\s*(.*)$/;
const LEGACY_CHECKPOINT_PATTERN = /^codepapr:checkpoint:[0-9a-f-]{36}$/i;
const CODEPAPR_CHECKPOINT_ID_TRAILER = /^CodePapr-Checkpoint-Id:\s*([^\s]+)$/im;
const CODEPAPR_MESSAGE_ID_TRAILER = /^CodePapr-Message-Id:\s*([^\s]+)$/im;

const SUBJECT_DISPLAY_MAX = 80;

function truncateForDisplay(value: string, max: number = SUBJECT_DISPLAY_MAX): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** 解析 commit subject，返回展示文案和分类。仅看第一行，所以多行 commit message 也安全。 */
export function formatCheckpointSubject(rawSubject: string): CheckpointSubjectInfo {
  const subject = (rawSubject ?? '').split('\n')[0]?.trim() ?? '';

  if (!subject) {
    return { kind: 'user', display: '(no message)', sequence: null, preview: null };
  }

  if (subject === 'codepapr:baseline') {
    return { kind: 'baseline', display: '初始快照', sequence: null, preview: null };
  }

  if (LEGACY_CHECKPOINT_PATTERN.test(subject)) {
    return {
      kind: 'legacy-checkpoint',
      display: 'checkpoint (legacy)',
      sequence: null,
      preview: null,
    };
  }

  const match = subject.match(CHECKPOINT_SUBJECT_PATTERN);
  if (match) {
    const seq = Number.parseInt(match[1] ?? '', 10);
    const tail = (match[2] ?? '').trim();
    return {
      kind: 'checkpoint',
      display: truncateForDisplay(subject),
      sequence: Number.isFinite(seq) ? seq : null,
      preview: tail || null,
    };
  }

  return {
    kind: 'user',
    display: truncateForDisplay(subject),
    sequence: null,
    preview: null,
  };
}

/** 给定用户消息文本，构建 auto-checkpoint 的 commit message（subject + trailer）。 */
export function buildCheckpointCommitMessage(params: {
  sequence: number;
  userMessageId: string;
  userMessageText: string;
  previewLength?: number;
}): string {
  const previewLength = params.previewLength ?? 24;
  const cleaned = (params.userMessageText ?? '').replace(/\s+/g, ' ').trim();
  let subject: string;
  if (!cleaned) {
    subject = `checkpoint #${params.sequence} · (empty)`;
  } else {
    const truncated = cleaned.length > previewLength
      ? `${cleaned.slice(0, previewLength)}…`
      : cleaned;
    subject = `checkpoint #${params.sequence} · "${truncated}"`;
  }
  return [
    subject,
    '',
    `CodePapr-Checkpoint-Id: ${params.userMessageId}`,
    `CodePapr-Message-Id: ${params.userMessageId}`,
  ].join('\n');
}

/** 从一组 commit subject 推断下一个 checkpoint 序号。没有找到则返回 1。 */
export function nextCheckpointSequence(subjects: readonly string[]): number {
  let max = 0;
  for (const subject of subjects) {
    const info = formatCheckpointSubject(subject);
    if (info.kind === 'checkpoint' && info.sequence !== null && info.sequence > max) {
      max = info.sequence;
    }
  }
  return max + 1;
}

/** 解析多行 commit message body 中的 CodePapr-Message-Id trailer，用于反查映射。 */
export function parseCheckpointTrailers(rawMessage: string): {
  checkpointId: string | null;
  messageId: string | null;
} {
  const checkpoint = rawMessage.match(CODEPAPR_CHECKPOINT_ID_TRAILER);
  const message = rawMessage.match(CODEPAPR_MESSAGE_ID_TRAILER);
  return {
    checkpointId: checkpoint ? checkpoint[1] ?? null : null,
    messageId: message ? message[1] ?? null : null,
  };
}

export function buildGitFileSelection(file: GitStatusFile, mode: GitDiffMode): GitFileSelection {
  return {
    path: file.path,
    mode,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
  };
}

function gitPathspecsForFile(file: Pick<GitStatusFile, 'path' | 'originalPath'>): string[] {
  return file.originalPath ? [file.originalPath, file.path] : [file.path];
}

export function buildStageGitFileCommandArgs(file: Pick<GitStatusFile, 'path' | 'originalPath'>): string[] {
  return ['add', '-A', '--', ...gitPathspecsForFile(file)];
}

export function buildStageAllGitCommandArgs(): string[] {
  return ['add', '-A', '--', '.'];
}

export function buildUnstageGitFileCommandPlans(
  file: Pick<GitStatusFile, 'path' | 'originalPath' | 'indexStatus'>
): string[][] {
  const pathspecs = gitPathspecsForFile(file);
  const plans: string[][] = [
    ['restore', '--staged', '--', ...pathspecs],
    ['reset', 'HEAD', '--', ...pathspecs],
  ];

  if (file.indexStatus === 'A') {
    plans.push(['rm', '--cached', '--ignore-unmatch', '--', file.path]);
  }

  return plans;
}

export function buildUnstageAllGitCommandPlans(): string[][] {
  return [
    ['restore', '--staged', '.'],
    ['reset', 'HEAD', '--', '.'],
    ['rm', '-r', '--cached', '--ignore-unmatch', '.'],
  ];
}

export function buildGitCommitCommandArgs(message: string): string[] {
  return ['commit', '-m', message.trim()];
}

/** 一键提交流程第一步：清空暂存区。
 *  避免因为之前残留的 staged 状态（例如 AI 工具调用了 stage）污染本次提交。 */
export function buildGitResetIndexCommandPlans(): string[][] {
  return [
    ['reset', 'HEAD', '--', '.'],
    ['rm', '-r', '--cached', '--ignore-unmatch', '.'],
  ];
}

/** 一键提交流程第二步：把指定路径加入暂存区。
 *  传入空数组时返回 null，表示"没有要提交的文件"——上层应直接终止流程。 */
export function buildGitAddPathsCommandArgs(
  files: ReadonlyArray<Pick<GitStatusFile, 'path' | 'originalPath'>>
): string[] | null {
  if (files.length === 0) return null;
  const pathspecs: string[] = [];
  for (const file of files) {
    if (file.originalPath) pathspecs.push(file.originalPath);
    pathspecs.push(file.path);
  }
  return ['add', '-A', '--', ...pathspecs];
}

export function canOpenGitFileWorkspaceVersion(file: GitStatusFile, mode: GitDiffMode): boolean {
  if (mode === 'staged') {
    return file.indexStatus !== 'D';
  }

  if (file.indexStatus === '?' && file.worktreeStatus === '?') {
    return true;
  }

  return file.worktreeStatus !== 'D';
}

export function buildGitDiffContentPlan(selection: GitFileSelection): GitDiffContentPlan {
  const basePath = selection.originalPath ?? selection.path;

  if (selection.mode === 'staged') {
    if (selection.indexStatus === 'A') {
      return {
        original: { kind: 'empty', path: basePath },
        modified: { kind: 'git', path: selection.path, revision: 'INDEX' },
      };
    }

    if (selection.indexStatus === 'D') {
      return {
        original: { kind: 'git', path: basePath, revision: 'HEAD' },
        modified: { kind: 'empty', path: selection.path },
      };
    }

    return {
      original: { kind: 'git', path: basePath, revision: 'HEAD' },
      modified: { kind: 'git', path: selection.path, revision: 'INDEX' },
    };
  }

  if (selection.indexStatus === '?' && selection.worktreeStatus === '?') {
    return {
      original: { kind: 'empty', path: selection.path },
      modified: { kind: 'workspace', path: selection.path },
    };
  }

  if (selection.worktreeStatus === 'D') {
    return {
      original: { kind: 'git', path: basePath, revision: 'HEAD' },
      modified: { kind: 'empty', path: selection.path },
    };
  }

  // 方案 A（去暂存概念）：未提交改动统一展示 HEAD vs 工作区，
  // 不再区分 INDEX vs WORKTREE 与 HEAD vs INDEX 两种半成品视图。
  return {
    original: { kind: 'git', path: basePath, revision: 'HEAD' },
    modified: { kind: 'workspace', path: selection.path },
  };
}

export function buildGitDiffClipboardText(summary: GitDiffSummary): string {
  const parts = [summary.stat.trim(), summary.diff.trim()].filter(Boolean);

  if (parts.length === 0 && summary.message?.trim()) {
    parts.push(summary.message.trim());
  }

  return parts.join('\n\n');
}

export function summarizeGitDiff(diff: string): GitDiffMetrics {
  if (!diff.trim()) {
    return {
      additions: 0,
      deletions: 0,
      hunks: 0,
      files: 0,
    };
  }

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let files = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      hunks += 1;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
      continue;
    }
    if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return {
    additions,
    deletions,
    hunks,
    files: Math.max(files, diff.trim() ? 1 : 0),
  };
}

export function buildSyntheticUntrackedGitDiff(
  path: string,
  content: string,
  maxLines: number = 160
): GitDiffSummary {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  const visibleLines = lines.slice(0, Math.max(1, maxLines));
  const truncated = lines.length > visibleLines.length;
  const additions = Math.max(lines.length, 1);
  const statBar = `${'+'.repeat(Math.min(additions, 20))}${additions > 20 ? '+' : ''}`;
  const diffLines = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
  ];

  if (visibleLines.length > 0) {
    diffLines.push(`@@ -0,0 +1,${visibleLines.length} @@`);
    diffLines.push(...visibleLines.map((line) => `+${line}`));
  }

  if (truncated) {
    diffLines.push('+...');
  }

  return {
    available: true,
    isRepo: true,
    staged: false,
    pathspecs: [path],
    stat: `${path} | ${additions} ${statBar}`,
    diff: diffLines.join('\n'),
    truncated,
    ...(lines.length === 0 ? { message: 'Git 未返回 patch；该新文件当前为空。' } : {}),
  };
}
