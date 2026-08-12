import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  type GitHistoryEntry,
  type GitHistorySummary,
} from '@codepapr/common';
import {
  type GitDiffSummary,
  type GitStatusFile,
  type GitStatusSummary,
} from '../tools/workspaceToolUtils';
import {
  buildGitDiffClipboardText,
  buildGitFileSelection,
  buildSyntheticUntrackedGitDiff,
  canOpenGitFileWorkspaceVersion,
  describeGitChange,
  filterVisibleGitFiles,
  formatCheckpointSubject,
  gitDiffCacheKey,
  gitStatusCodeForChange,
  listAllChangedGitFiles,
  summarizeGitDiff,
  type CommitKind,
  type GitDiffMode,
  type GitFileSelection,
} from '../utils/workspaceGitPanel';
import { pushDebugLog } from '../store/debugLogStore';
import { useAgentStore } from '../store/agentStore';
import {
  snapshotChangedFiles,
  snapshotEnsure,
  restoreUndo,
  gitStatus as gitStatusCmd,
  gitLog as gitLogCmd,
  gitDiff as gitDiffCmd,
  gitCommit as gitCommitCmd,
  gitBranchCheckout as gitBranchCheckoutCmd,
  gitRestoreFiles as gitRestoreFilesCmd,
  type CommitChangedFiles,
  type RestoreResult,
} from '../utils/snapshot';
import { getTranslation, type Lang } from '../utils/i18n';
import { GitDiffPreview } from './GitDiffPreview';
import { RestoreConfirmDialog } from './RestoreConfirmDialog';

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}

interface GitDiffLoadState {
  summary: GitDiffSummary | null;
  error: string;
  isLoading: boolean;
}

export interface WorkspaceGitPanelProps {
  workspacePath: string;
  lang?: Lang;
  selectedPath?: string | null;
  selectedGitFile?: GitFileSelection | null;
  onSelectPath?: (path: string) => void;
  onSelectGitFile?: (selection: GitFileSelection | null) => void;
  /**
   * 打开代码审查面板，对比指定的两个 git ref。
   * 用法：
   *   - 与当前对比：`{ baseRef: <commit-sha>, headRef: 'WORKTREE' }`
   *   - 与上一次对比：`{ baseRef: <commit-sha>~1, headRef: <commit-sha> }`
   */
  onOpenCommitReview?: (scope: { baseRef: string; headRef: string }) => void;
  isExpanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
}

const MAX_GIT_CHANGED_FILES = 24;

function createEmptyGitDiffLoadState(): GitDiffLoadState {
  return {
    summary: null,
    error: '',
    isLoading: false,
  };
}

function gitFileLabel(file: GitStatusFile): string {
  return file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path;
}

function gitFileDisplayName(file: GitStatusFile): string {
  const currentName = file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path;
  if (!file.originalPath) {
    return currentName;
  }

  const originalName = file.originalPath.split(/[\\/]/).filter(Boolean).pop() ?? file.originalPath;
  return `${originalName} -> ${currentName}`;
}

function isUntrackedGitFile(file: GitStatusFile): boolean {
  return file.indexStatus === '?' && file.worktreeStatus === '?';
}

function formatLocalTime(isoString: string): string {
  const d = new Date(isoString);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusBadgeClassName(kind: ReturnType<typeof describeGitChange>['kind']): string {
  switch (kind) {
    case 'added':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'deleted':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
    case 'renamed':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'untracked':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'modified':
    default:
      return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200';
  }
}

export function WorkspaceGitPanel(props: WorkspaceGitPanelProps) {
  const { workspacePath, lang, selectedPath, onSelectPath, onSelectGitFile, onOpenCommitReview } = props;
  const t = getTranslation(lang);
  const gitChangesTabText = t.workspaceGitChangesTab || (lang === 'en' ? 'Changes' : '改动');
  const gitSelectAllText = t.workspaceGitSelectAll || (lang === 'en' ? 'Select All' : '全选');
  const gitDeselectAllText =
    t.workspaceGitDeselectAll || (lang === 'en' ? 'Deselect All' : '全不选');
  const gitCommitSelectedActionText =
    t.workspaceGitCommitSelectedAction || (lang === 'en' ? 'Commit Selected' : '提交所选');
  const gitCompareWithCurrentText =
    t.workspaceGitCompareWithCurrent ||
    (lang === 'en' ? 'Compare with current' : '与当前对比');
  const gitCompareWithParentText =
    t.workspaceGitCompareWithParent ||
    (lang === 'en' ? 'Compare with previous' : '与上一次对比');
  const gitCommitTitleText = t.workspaceGitCommit || (lang === 'en' ? 'Local Commit' : '本地提交');
  const gitCommitPlaceholderText =
    t.workspaceGitCommitPlaceholder ||
    (lang === 'en'
      ? 'Enter a local commit message. This only creates a local commit.'
      : '输入这次本地提交的说明，提交后仅保留在本地仓库。');
  const gitCommitRunningText =
    t.workspaceGitCommitRunning || (lang === 'en' ? 'Committing...' : '提交中...');
  const gitCommitMessageRequiredText =
    t.workspaceGitCommitMessageRequired || (lang === 'en' ? 'Enter a commit message first.' : '请先输入提交说明。');
  const gitCommitNoSelectionText =
    lang === 'en' ? 'Select at least one file to commit.' : '请先勾选要提交的文件。';
  const gitCommitDoneText =
    t.workspaceGitCommitDone || (lang === 'en' ? 'Local commit completed.' : '本地提交已完成。');
  const gitActionFailedText = t.workspaceGitActionFailed || (lang === 'en' ? 'Git action failed.' : 'Git 操作失败。');
  const gitBranchLabelText = t.workspaceGitBranchLabel || (lang === 'en' ? 'Branch & Checkout' : '分支与切换');
  const gitBranchPlaceholderText =
    t.workspaceGitBranchPlaceholder || (lang === 'en' ? 'feature/sandbox' : '例如 feature/sandbox');
  const gitBranchActionText = t.workspaceGitBranchAction || (lang === 'en' ? 'Create / Switch' : '创建 / 切换');
  const gitBranchRunningText = t.workspaceGitBranchRunning || (lang === 'en' ? 'Switching...' : '切换中...');
  const gitBranchHintText =
    t.workspaceGitBranchHint ||
    (lang === 'en'
      ? 'Creates a sandbox branch if missing. If you select a commit below, the new branch starts there.'
      : '若分支不存在则会自动创建。若下方已选择提交，新分支将从该提交创建。');
  const gitBranchNameRequiredText =
    t.workspaceGitBranchNameRequired || (lang === 'en' ? 'Enter a branch name first.' : '请先输入分支名。');
  const gitBranchDonePrefixText =
    t.workspaceGitBranchDonePrefix || (lang === 'en' ? 'Switched to branch' : '已切换到分支');
  const gitHistoryTitleText = t.workspaceGitHistoryTitle || (lang === 'en' ? 'Recent Commits' : '最近提交');
  const gitHistoryLoadingText =
    t.workspaceGitHistoryLoading || (lang === 'en' ? 'Loading recent commits...' : '正在读取最近提交...');
  const gitHistoryEmptyText =
    t.workspaceGitHistoryEmpty || (lang === 'en' ? 'No commit history yet.' : '当前还没有提交历史。');
  const gitHistoryHeadLabelText = t.workspaceGitHistoryHeadLabel || 'HEAD';
  const gitHistorySelectedText =
    t.workspaceGitHistorySelected || (lang === 'en' ? 'Selected commit' : '已选择提交');
  const gitResetActionText = t.workspaceGitResetAction || (lang === 'en' ? 'Rollback to Selected' : '回退到所选提交');
  const gitResetSelectRequiredText =
    t.workspaceGitResetSelectRequired || (lang === 'en' ? 'Select a commit first.' : '请先选择一个提交。');
  const gitResetDonePrefixText =
    t.workspaceGitResetDonePrefix || (lang === 'en' ? 'Rolled back to' : '已回退到');
  const gitRestoreActionText =
    t.workspaceGitRestoreAction || (lang === 'en' ? 'Discard Local Changes' : '擦除本地改动');
  const gitRestoreRunningText =
    t.workspaceGitRestoreRunning || (lang === 'en' ? 'Restoring...' : '恢复中...');
  const gitRestoreDoneText =
    t.workspaceGitRestoreDone || (lang === 'en' ? 'Local changes were discarded safely.' : '本地改动已安全擦除。');
  const gitBackupBranchSavedPrefixText =
    t.workspaceGitBackupBranchSavedPrefix || (lang === 'en' ? 'Backup branch' : '备份分支');
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = props.isExpanded ?? internalExpanded;
  const setIsExpanded = (updater: boolean | ((value: boolean) => boolean)) => {
    const next = typeof updater === 'function' ? updater(isExpanded) : updater;
    if (props.isExpanded === undefined) {
      setInternalExpanded(next);
    }
    props.onExpandedChange?.(next);
  };
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [gitHistory, setGitHistory] = useState<GitHistorySummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [gitFileDiffs, setGitFileDiffs] = useState<Record<string, GitDiffLoadState>>({});
  const loadingDiffKeysRef = useRef<Set<string>>(new Set());
  const [expandedGitDiffKey, setExpandedGitDiffKey] = useState<string | null>(null);
  const [gitCopyState, setGitCopyState] = useState<{ key: string; success: boolean } | null>(null);
  const [isInitializingGit, setIsInitializingGit] = useState(false);
  const [activeGitActionKey, setActiveGitActionKey] = useState<string | null>(null);
  const [gitActionMessage, setGitActionMessage] = useState('');
  // N8：历史回退的确认目标（RestoreConfirmDialog 打开时非空）与撤销入口。
  const [restoreTarget, setRestoreTarget] = useState<GitHistoryEntry | null>(null);
  const [undoResetAvailable, setUndoResetAvailable] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedHistoryHash, setSelectedHistoryHash] = useState<string | null>(null);
  const [expandedHistoryHashes, setExpandedHistoryHashes] = useState<Set<string>>(new Set());
  const [commitFilesCache, setCommitFilesCache] = useState<Map<string, CommitChangedFiles>>(
    new Map()
  );
  const [commitFilesLoading, setCommitFilesLoading] = useState<Set<string>>(new Set());
  const [commitFilesError, setCommitFilesError] = useState<Map<string, string>>(new Map());
  const [historyFilter, setHistoryFilter] = useState<'all' | 'user' | 'checkpoint'>('all');
  const [historyLimit, setHistoryLimit] = useState(20);
  // 方案 A（去暂存概念）：UI 不再区分 staged / unstaged，
  // 改为"未提交改动列表 + 每行 checkbox（默认全选）"。
  // deselectedPaths 记录"用户主动取消勾选"的路径——比白名单更稳健，
  // 因为新进入的改动文件会自动被勾选。
  const [deselectedPaths, setDeselectedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const loadGitStatus = async (retryCount = 0) => {
      if (!workspacePath) {
        setGitStatus(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      pushDebugLog('git', 'loadGitStatus start', { workspacePath, retryCount, cancelled });
      try {
        const [statusResult, logResult] = await Promise.all([
          gitStatusCmd(workspacePath),
          gitLogCmd(workspacePath, historyLimit),
        ]);

        pushDebugLog('git', 'gitStatusCmd returned', {
          available: statusResult.available,
          isRepo: statusResult.isRepo,
          entries: statusResult.entries?.length,
          message: statusResult.message,
          branch: statusResult.branch,
        });

        if (!cancelled) {
          if (statusResult.available && statusResult.isRepo) {
            const files: GitStatusFile[] = statusResult.entries.map((e) => ({
              path: e.path,
              originalPath: e.oldPath ?? undefined,
              indexStatus: e.indexStatus,
              worktreeStatus: e.worktreeStatus,
            }));
            setGitStatus({
              available: true,
              isRepo: true,
              files,
              raw: '',
              ...(statusResult.branch ? { branch: statusResult.branch } : {}),
              ...(statusResult.headShort ? { headShort: statusResult.headShort } : {}),
              ...(statusResult.message ? { message: statusResult.message } : {}),
            } satisfies GitStatusSummary);
            setGitHistory({
              available: true,
              isRepo: true,
              entries: logResult.map((e): GitHistoryEntry => ({
                hash: e.sha,
                shortHash: e.shortHash,
                committedAt: new Date(e.timestamp * 1000).toISOString(),
                authorName: e.author,
                refNames: e.refs,
                subject: e.message,
                isHead: e.isHead,
              })),
              raw: '',
            } satisfies GitHistorySummary);
          } else if (retryCount < 1) {
            // 自动初始化 Shadow Git 仓库（最多重试 1 次，防止无限递归）
            pushDebugLog('git', 'auto-init branch', { available: statusResult.available, isRepo: statusResult.isRepo });
            try {
              const ensureResult = await snapshotEnsure(workspacePath);
              pushDebugLog('git', 'snapshotEnsure returned', { ready: ensureResult.ready, error: ensureResult.error });
              if (!cancelled && ensureResult.ready) {
                void loadGitStatus(retryCount + 1);
                return;
              }
            } catch (e) {
              pushDebugLog('git/error', 'snapshotEnsure failed', e instanceof Error ? e.message : String(e));
            }
            if (!cancelled) {
              setGitHistory(null);
              setGitStatus({
                available: statusResult.available,
                isRepo: false,
                files: [],
                raw: '',
                ...(statusResult.message ? { message: statusResult.message } : {}),
              } satisfies GitStatusSummary);
            }
          } else {
            // 重试后仍然不可用，直接展示错误状态
            pushDebugLog('git', 'retry exhausted', { available: statusResult.available, isRepo: statusResult.isRepo });
            if (!cancelled) {
              setGitHistory(null);
              setGitStatus({
                available: statusResult.available,
                isRepo: false,
                files: [],
                raw: '',
                ...(statusResult.message ? { message: statusResult.message } : {}),
              } satisfies GitStatusSummary);
            }
          }
        }
      } catch (gitError) {
        pushDebugLog('git/error', 'loadGitStatus error', gitError instanceof Error ? gitError.message : String(gitError));
        if (!cancelled) {
          setGitHistory(null);
          setGitStatus({
            available: false,
            isRepo: false,
            files: [],
            raw: '',
            message: gitError instanceof Error ? gitError.message : String(gitError),
          } satisfies GitStatusSummary);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadGitStatus();

     return () => {
      cancelled = true;
    };
  }, [refreshVersion, workspacePath, historyLimit]);

  useEffect(() => {
    setExpandedGitDiffKey(null);
    setGitCopyState(null);
    setGitFileDiffs({});
    setGitActionMessage('');
    setGitHistory(null);
    setGitStatus(null);
    setIsLoading(false);
    setBranchName('');
    setCommitMessage('');
    setSelectedHistoryHash(null);
    setExpandedHistoryHashes(new Set());
    setCommitFilesCache(new Map());
    setCommitFilesLoading(new Set());
    setCommitFilesError(new Map());
    setHistoryFilter('all');
    setHistoryLimit(20);
    setDeselectedPaths(new Set());
  }, [workspacePath]);

  useEffect(() => {
    if (!selectedHistoryHash || !gitHistory?.entries.some((entry) => entry.hash === selectedHistoryHash)) {
      if (selectedHistoryHash !== null && gitHistory) {
        setSelectedHistoryHash(null);
      }
    }
  }, [gitHistory, selectedHistoryHash]);

  const visibleGitFiles =
    gitStatus?.available && gitStatus.isRepo ? filterVisibleGitFiles(gitStatus.files) : [];
  // 方案 A：单一"未提交改动"列表，不再分 staged / unstaged。
  const changedGitFiles =
    gitStatus?.available && gitStatus.isRepo ? listAllChangedGitFiles(visibleGitFiles) : [];
  const visibleChangedFiles = changedGitFiles.slice(0, MAX_GIT_CHANGED_FILES);
  const changedCount = changedGitFiles.length;
  const selectedChangedFiles = changedGitFiles.filter((file) => !deselectedPaths.has(file.path));
  const selectedCount = selectedChangedFiles.length;
  const allSelected = selectedCount === changedGitFiles.length && changedGitFiles.length > 0;
  const historyEntries = gitHistory?.entries ?? [];
  const filteredHistoryEntries = historyEntries.filter((entry) => {
    if (historyFilter === 'all') return true;
    const info = formatCheckpointSubject(entry.subject);
    if (historyFilter === 'user') return info.kind === 'user';
    if (historyFilter === 'checkpoint') {
      return info.kind === 'checkpoint' || info.kind === 'legacy-checkpoint';
    }
    return true;
  });
  const selectedHistoryEntry = historyEntries.find((entry) => entry.hash === selectedHistoryHash) ?? null;

  function queueGitRefresh(message: string, nextSelection?: GitFileSelection | null): void {
    setGitActionMessage(message);
    setExpandedGitDiffKey(null);
    setGitCopyState(null);
    setGitFileDiffs({});
    if (nextSelection !== undefined) {
      onSelectGitFile?.(nextSelection ?? null);
    }
    setRefreshVersion((value) => value + 1);
  }

  async function loadGitFileDiff(file: GitStatusFile, mode: GitDiffMode): Promise<void> {
    const cacheKey = gitDiffCacheKey(mode, file.path);
    const existing = gitFileDiffs[cacheKey];
    if (existing?.summary || existing?.isLoading || loadingDiffKeysRef.current.has(cacheKey)) {
      return;
    }
    loadingDiffKeysRef.current.add(cacheKey);

    setGitFileDiffs((current) => ({
      ...current,
      [cacheKey]: {
        summary: current[cacheKey]?.summary ?? null,
        error: '',
        isLoading: true,
      },
    }));

    try {
      let summary: GitDiffSummary;

      if (mode === 'unstaged' && isUntrackedGitFile(file)) {
        const result = await invoke<ReadFileResult>('read_text_file', {
          workspacePath,
          relativePath: file.path,
          maxBytes: 180_000,
        });
        summary = buildSyntheticUntrackedGitDiff(file.path, result.content, 180);
      } else {
        const pathspecs = file.originalPath ? [file.originalPath, file.path] : [file.path];
        const diffResult = await gitDiffCmd(
          workspacePath,
          mode === 'staged' ? true : false,
          pathspecs,
        );
        summary = {
          available: diffResult.available,
          isRepo: true,
          staged: mode === 'staged',
          pathspecs,
          stat: diffResult.stat,
          diff: diffResult.diff,
          truncated: diffResult.truncated,
          ...(diffResult.message ? { message: diffResult.message } : {}),
        } satisfies GitDiffSummary;
      }

      setGitFileDiffs((current) => ({
        ...current,
        [cacheKey]: {
          summary,
          error: '',
          isLoading: false,
        },
      }));
    } catch (gitError) {
      setGitFileDiffs((current) => ({
        ...current,
        [cacheKey]: {
          summary: {
            available: false,
            isRepo: false,
            staged: false,
            pathspecs: [file.path],
            stat: '',
            diff: '',
            truncated: false,
            message: gitError instanceof Error ? gitError.message : String(gitError),
          } satisfies GitDiffSummary,
          error: '',
          isLoading: false,
        },
      }));
    } finally {
      loadingDiffKeysRef.current.delete(cacheKey);
    }
  }

  function toggleGitFileDiff(file: GitStatusFile, mode: GitDiffMode): void {
    const cacheKey = gitDiffCacheKey(mode, file.path);
    const nextExpandedKey = expandedGitDiffKey === cacheKey ? null : cacheKey;
    setExpandedGitDiffKey(nextExpandedKey);

    if (nextExpandedKey) {
      void loadGitFileDiff(file, mode);
    }
  }

  async function copyGitDiff(cacheKey: string, summary: GitDiffSummary): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildGitDiffClipboardText(summary));
      setGitCopyState({ key: cacheKey, success: true });
    } catch {
      setGitCopyState({ key: cacheKey, success: false });
    }

    window.setTimeout(() => {
      setGitCopyState((current) => (current?.key === cacheKey ? null : current));
    }, 1600);
  }

  async function initializeGitRepository(): Promise<void> {
    if (!workspacePath || isInitializingGit) {
      return;
    }

    setIsInitializingGit(true);
    setGitActionMessage('');
    try {
      const result = await snapshotEnsure(workspacePath);
      if (result.ready) {
        setGitActionMessage(t.workspaceGitInitDone);
        setRefreshVersion((value) => value + 1);
      } else {
        throw new Error(result.error ?? t.workspaceGitUnavailable);
      }
    } catch (error) {
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || t.workspaceGitUnavailable);
    } finally {
      setIsInitializingGit(false);
    }
  }

  function toggleGitFileSelected(path: string): void {
    setDeselectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function selectAllGitFiles(): void {
    setDeselectedPaths(new Set());
  }

  function deselectAllGitFiles(): void {
    setDeselectedPaths(new Set(changedGitFiles.map((file) => file.path)));
  }

  async function commitGitChanges(): Promise<void> {
    const trimmedMessage = commitMessage.trim();
    if (!trimmedMessage) {
      setGitActionMessage(gitCommitMessageRequiredText);
      return;
    }

    if (selectedChangedFiles.length === 0) {
      setGitActionMessage(gitCommitNoSelectionText);
      return;
    }

    setActiveGitActionKey('commit');
    setGitActionMessage('');
    try {
      const result = await gitCommitCmd(
        workspacePath,
        trimmedMessage,
        false,
        selectedChangedFiles.map((f) => f.path),
        false,
      );
      if (result.ok) {
        setCommitMessage('');
        setDeselectedPaths(new Set());
        queueGitRefresh(gitCommitDoneText);
      } else {
        throw new Error(result.message);
      }
    } catch (error) {
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || gitActionFailedText);
    } finally {
      setActiveGitActionKey(null);
    }
  }

  async function checkoutGitBranch(): Promise<void> {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      setGitActionMessage(gitBranchNameRequiredText);
      return;
    }

    setActiveGitActionKey('branch-checkout');
    setGitActionMessage('');
    try {
      const result = await gitBranchCheckoutCmd(
        workspacePath,
        trimmedBranchName,
        false,
        true,
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      setBranchName('');
      queueGitRefresh(`${gitBranchDonePrefixText} ${trimmedBranchName}`);
      // N4：分支切换会改写磁盘文件，必须走 mutation 通道失效预览缓存，
      // 否则已打开文件永久显示旧内容。
      useAgentStore.getState().noteWorkspaceMutation();
    } catch (error) {
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || gitActionFailedText);
    } finally {
      setActiveGitActionKey(null);
    }
  }

  async function restoreGitWorkspace(): Promise<void> {
    if (visibleGitFiles.length === 0) {
      setGitActionMessage(t.workspaceGitNoChanges);
      return;
    }

    setActiveGitActionKey('restore');
    setGitActionMessage('');
    try {
      const result = await gitRestoreFilesCmd(workspacePath);
      if (!result.ok) {
        throw new Error(result.message);
      }
      queueGitRefresh(gitRestoreDoneText);
      // N4：restore 改写磁盘文件，必须走 mutation 通道失效预览缓存。
      useAgentStore.getState().noteWorkspaceMutation(
        visibleGitFiles.map((file) => file.path)
      );
    } catch (error) {
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || gitActionFailedText);
    } finally {
      setActiveGitActionKey(null);
    }
  }

  async function resetGitToHistoryEntry(entry: GitHistoryEntry): Promise<void> {
    // N8：回退是破坏性操作，先弹带预览的确认框（restorePlan 预览 + 确认后
    // 才执行 restoreExecute），确认回调见 handleRestoreConfirmed。
    setRestoreTarget(entry);
  }

  /** RestoreConfirmDialog 确认后的执行结果处理：刷新 git 状态、bump mutation
   *  （N4）、并提供 restore_undo 撤销入口（N8）。 */
  function handleRestoreConfirmed(result: RestoreResult): void {
    const entry = restoreTarget;
    setRestoreTarget(null);
    if (!result.ok) {
      setGitActionMessage(result.error ?? gitActionFailedText);
      return;
    }
    const msgs: string[] = [];
    if (entry) {
      msgs.push(`${gitResetDonePrefixText} ${entry.shortHash}`);
    }
    if (result.backupRef) {
      msgs.push(`${gitBackupBranchSavedPrefixText} ${result.backupRef}`);
    }
    if (result.filesRestored > 0) {
      msgs.push(`${lang === 'en' ? 'Restored' : '恢复了'} ${result.filesRestored} ${lang === 'en' ? 'files' : '个文件'}`);
    }
    queueGitRefresh(msgs.join(' · '));
    useAgentStore.getState().noteWorkspaceMutation();
    setUndoResetAvailable(result.backupRef !== null);
  }

  /** N8：回退撤销——restore_undo 恢复到回退前的工作区状态（BACKUP_REF）。 */
  async function undoHistoryReset(): Promise<void> {
    setActiveGitActionKey('undo-reset');
    setGitActionMessage('');
    try {
      await restoreUndo(workspacePath);
      setUndoResetAvailable(false);
      queueGitRefresh(
        lang === 'en' ? 'Rollback undone · workspace restored.' : lang === 'zh-TW' ? '已撤銷回退 · 工作區已恢復。' : '已撤销回退 · 工作区已恢复。'
      );
      useAgentStore.getState().noteWorkspaceMutation();
    } catch (error) {
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || gitActionFailedText);
    } finally {
      setActiveGitActionKey(null);
    }
  }

  async function toggleGitHistoryEntry(sha: string): Promise<void> {
    const wasExpanded = expandedHistoryHashes.has(sha);
    setExpandedHistoryHashes((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
    if (wasExpanded) return;
    if (commitFilesCache.has(sha) || commitFilesLoading.has(sha)) return;
    setCommitFilesLoading((prev) => {
      const next = new Set(prev);
      next.add(sha);
      return next;
    });
    setCommitFilesError((prev) => {
      const next = new Map(prev);
      next.delete(sha);
      return next;
    });
    try {
      const result = await snapshotChangedFiles(workspacePath, sha);
      setCommitFilesCache((prev) => {
        const next = new Map(prev);
        next.set(sha, result);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCommitFilesError((prev) => {
        const next = new Map(prev);
        next.set(sha, message);
        return next;
      });
    } finally {
      setCommitFilesLoading((prev) => {
        const next = new Set(prev);
        next.delete(sha);
        return next;
      });
    }
  }

  function commitKindBadgeStyle(kind: CommitKind): string {
    switch (kind) {
      case 'user':
        return 'border-emerald-500/40 text-emerald-200';
      case 'baseline':
        return 'border-slate-600 text-slate-500';
      case 'legacy-checkpoint':
        return 'border-amber-500/40 text-amber-200';
      case 'checkpoint':
      default:
        return 'border-[#2a2d3a] text-slate-400';
    }
  }

  function commitKindIcon(kind: CommitKind): string {
    switch (kind) {
      case 'user':
        return '✓';
      case 'baseline':
        return '⊙';
      case 'legacy-checkpoint':
        return '⚠';
      case 'checkpoint':
      default:
        return '🕓';
    }
  }

  function changedFileStatusClass(status: string): string {
    switch (status) {
      case 'A':
        return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
      case 'D':
        return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
      case 'R':
      case 'C':
        return 'border-sky-500/40 bg-sky-500/10 text-sky-200';
      case 'T':
        return 'border-violet-500/40 bg-violet-500/10 text-violet-200';
      case 'M':
      default:
        return 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200';
    }
  }

  function renderGitHistoryList(entries: readonly GitHistoryEntry[]) {
    if (isLoading && !gitHistory) {
      return <div className="text-xs text-slate-500">{gitHistoryLoadingText}</div>;
    }

    if (entries.length === 0) {
      return (
        <div className="rounded-xl border border-dashed border-[#2a2d3a] px-3 py-3 text-xs text-slate-500">
          {gitHistory?.message || gitHistoryEmptyText}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {entries.map((entry) => {
          const isSelected = entry.hash === selectedHistoryHash;
          const isExpanded = expandedHistoryHashes.has(entry.hash);
          const secondaryRefs = entry.refNames.filter((value) => !value.startsWith('HEAD -> '));
          const subjectInfo = formatCheckpointSubject(entry.subject);
          const cachedFiles = commitFilesCache.get(entry.hash);
          const isFilesLoading = commitFilesLoading.has(entry.hash);
          const filesError = commitFilesError.get(entry.hash);
          const isAuto = subjectInfo.kind !== 'user';
          const isRootCommit = entry === entries[entries.length - 1];
          const titleTone =
            subjectInfo.kind === 'user'
              ? 'text-slate-100 font-semibold'
              : subjectInfo.kind === 'baseline'
              ? 'text-slate-500 italic'
              : subjectInfo.kind === 'legacy-checkpoint'
              ? 'text-amber-200'
              : 'text-slate-300';

          return (
            <div
              key={entry.hash}
              className={`rounded-xl border transition-colors ${
                isSelected
                  ? 'border-indigo-500/50 bg-indigo-500/10'
                  : 'border-[#202432] bg-[#10141d]'
              }`}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => void toggleGitHistoryEntry(entry.hash)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void toggleGitHistoryEntry(entry.hash);
                  }
                }}
                className="block w-full cursor-pointer px-3 py-2 text-left"
              >
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  <span className="rounded-full border border-[#2a2d3a] px-2 py-0.5 font-mono text-[9px] text-slate-400">
                    {entry.shortHash}
                  </span>
                  <span aria-hidden className="text-[10px]">
                    {commitKindIcon(subjectInfo.kind)}
                  </span>
                  {isAuto && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[9px] ${commitKindBadgeStyle(subjectInfo.kind)}`}
                    >
                      {subjectInfo.kind === 'baseline'
                        ? 'baseline'
                        : subjectInfo.kind === 'legacy-checkpoint'
                        ? 'legacy'
                        : 'auto'}
                    </span>
                  )}
                  {entry.isHead && (
                    <span className="rounded-full border border-emerald-500/30 px-2 py-0.5 text-emerald-200">
                      {gitHistoryHeadLabelText}
                    </span>
                  )}
                  {secondaryRefs.slice(0, 1).map((refName) => (
                    <span
                      key={refName}
                      className="rounded-full border border-[#2a2d3a] px-2 py-0.5 text-slate-400"
                    >
                      {refName}
                    </span>
                  ))}
                  <span aria-hidden className="ml-auto text-[10px] text-slate-500">
                    {isExpanded ? '▾' : '▸'}
                  </span>
                </div>
                <div
                  className={`mt-1 truncate text-[11px] ${titleTone}`}
                  title={entry.subject}
                >
                  {subjectInfo.display}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  <span>{entry.authorName}</span>
                  <span aria-hidden>·</span>
                  <span>{formatLocalTime(entry.committedAt)}</span>
                  {cachedFiles && (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        {cachedFiles.files.length} {lang === 'en' ? 'files' : '个文件'}
                      </span>
                      <span className="text-emerald-400">+{cachedFiles.totalAdditions}</span>
                      <span className="text-rose-400">−{cachedFiles.totalDeletions}</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedHistoryHash(isSelected ? null : entry.hash);
                    }}
                    className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                      isSelected
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
                        : 'border-[#2a2d3a] text-slate-400 hover:border-amber-500/50 hover:text-slate-200'
                    }`}
                  >
                    {isSelected
                      ? lang === 'en'
                        ? '✓ Reset target'
                        : '✓ 回滚目标'
                      : lang === 'en'
                      ? 'Set as reset target'
                      : '选作回滚目标'}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-[#202432] px-3 py-2">
                  {onOpenCommitReview && (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenCommitReview({
                            baseRef: entry.hash,
                            headRef: 'WORKTREE',
                          });
                        }}
                        title={
                          lang === 'en'
                            ? 'Compare this commit against your current working tree.'
                            : '对比该提交与你当前工作区的差异。'
                        }
                        className="rounded-md border border-indigo-500/40 px-2 py-1 text-[10px] text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10"
                      >
                        {gitCompareWithCurrentText}
                      </button>
                      <button
                        type="button"
                        disabled={isRootCommit}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenCommitReview({
                            baseRef: `${entry.hash}~1`,
                            headRef: entry.hash,
                          });
                        }}
                        title={
                          isRootCommit
                            ? (lang === 'en' ? 'This is the initial commit; no parent to compare.' : '这是初始提交，没有父提交可对比。')
                            : lang === 'en'
                            ? 'Compare this commit against its parent commit.'
                            : '对比该提交与它的上一次提交。'
                        }
                        className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-300 transition-colors hover:border-indigo-500/50 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#2a2d3a] disabled:hover:text-slate-300"
                      >
                        {gitCompareWithParentText}
                      </button>
                    </div>
                  )}
                  {isFilesLoading && (
                    <div className="text-[10px] text-slate-500">
                      {lang === 'en' ? 'Loading changed files...' : '正在读取改动文件...'}
                    </div>
                  )}
                  {filesError && (
                    <div className="text-[10px] text-rose-300">
                      {(lang === 'en' ? 'Failed to load: ' : '加载失败：') + filesError}
                    </div>
                  )}
                  {!isFilesLoading && !filesError && cachedFiles && cachedFiles.files.length === 0 && (
                    <div className="text-[10px] text-slate-500">
                      {lang === 'en' ? 'No file changes.' : '此提交没有文件改动。'}
                    </div>
                  )}
                  {!isFilesLoading && !filesError && cachedFiles && cachedFiles.files.length > 0 && (
                    <ul className="space-y-1">
                      {cachedFiles.files.map((file) => (
                        <li
                          key={`${entry.hash}:${file.path}`}
                          className="flex items-center gap-2 text-[10px]"
                        >
                          <span
                            className={`inline-flex w-5 justify-center rounded border px-1 py-0.5 font-mono text-[9px] ${changedFileStatusClass(file.status)}`}
                            title={file.status}
                          >
                            {file.status}
                          </span>
                          <span
                            className="flex-1 truncate text-slate-300"
                            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          >
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          </span>
                          {file.additions > 0 && (
                            <span className="text-emerald-400">+{file.additions}</span>
                          )}
                          {file.deletions > 0 && (
                            <span className="text-rose-400">−{file.deletions}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function renderGitFileList(files: readonly GitStatusFile[]) {
    if (files.length === 0) {
      return (
        <div className="rounded-xl border border-dashed border-[#2a2d3a] px-3 py-3 text-xs text-slate-500">
          {t.workspaceGitNoChanges}
        </div>
      );
    }

    // 方案 A（去暂存概念）：单一 diff mode，统一为 "unstaged"（即 HEAD vs WORKTREE）。
    const mode: GitDiffMode = 'unstaged';

    return (
      <div className="space-y-2">
        {files.map((file) => {
          const cacheKey = gitDiffCacheKey(mode, file.path);
          const fileDiffState = gitFileDiffs[cacheKey] ?? createEmptyGitDiffLoadState();
          const isExpandedDiff = expandedGitDiffKey === cacheKey;
          const isWorkspaceFileSelected = selectedPath === file.path;
          const fileStatus = describeGitChange(file);
          const diffMetrics = fileDiffState.summary ? summarizeGitDiff(fileDiffState.summary.diff) : null;
          const canOpenWorkspaceFile = canOpenGitFileWorkspaceVersion(file, mode);
          const copyLabel =
            gitCopyState?.key === cacheKey
              ? gitCopyState.success
                ? t.workspaceGitCopyDone
                : t.workspaceGitCopyFailed
              : t.workspaceGitCopyDiff;
          const isChecked = !deselectedPaths.has(file.path);

          return (
            <div
              key={`${cacheKey}:${file.indexStatus}:${file.worktreeStatus}`}
              className="rounded-xl border border-[#202432] bg-[#111623]"
            >
              <div
                className={`grid w-full grid-cols-[20px_36px_minmax(0,1fr)_58px] items-center gap-2 px-2.5 py-2 text-[11px] transition-colors ${
                  isExpandedDiff
                    ? 'text-indigo-100'
                    : isWorkspaceFileSelected
                      ? 'text-slate-100'
                      : 'text-slate-200'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleGitFileSelected(file.path)}
                  disabled={activeGitActionKey !== null}
                  aria-label={
                    lang === 'en'
                      ? `Include ${file.path} in next commit`
                      : `将 ${file.path} 加入下次提交`
                  }
                  className="h-3.5 w-3.5 cursor-pointer accent-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => toggleGitFileDiff(file, mode)}
                  className="contents text-left"
                  title={gitFileLabel(file)}
                >
                  <span className="rounded border border-[#2a2d3a] px-1 py-0.5 text-center font-mono text-[9px] text-slate-500">
                    {gitStatusCodeForChange(file)}
                  </span>
                  <span className="truncate hover:text-white">{gitFileDisplayName(file)}</span>
                  <span className="justify-self-end text-[10px] text-slate-500">
                    {isExpandedDiff ? t.workspaceGitCollapseDiff : t.workspaceGitExpandDiff}
                  </span>
                </button>
              </div>

              {isExpandedDiff && (
                <div className="space-y-2 border-t border-[#202432] px-2.5 py-2">
                  {fileDiffState.isLoading && (
                    <div className="text-xs text-slate-500">{t.workspaceGitFileDiffLoading}</div>
                  )}

                  {!fileDiffState.isLoading && fileDiffState.summary && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-[10px]">
                        <span className={`rounded-full border px-2 py-0.5 font-semibold ${statusBadgeClassName(fileStatus.kind)}`}>
                          {(() => {
                            switch (fileStatus.kind) {
                              case 'added':
                                return t.workspaceGitStatusAdded;
                              case 'deleted':
                                return t.workspaceGitStatusDeleted;
                              case 'renamed':
                                return t.workspaceGitStatusRenamed;
                              case 'untracked':
                                return t.workspaceGitStatusUntracked;
                              case 'modified':
                              default:
                                return t.workspaceGitStatusModified;
                            }
                          })()}
                        </span>
                        <span className="rounded-full border border-emerald-500/20 px-2 py-0.5 text-emerald-200">
                          +{diffMetrics?.additions ?? 0}
                        </span>
                        <span className="rounded-full border border-rose-500/20 px-2 py-0.5 text-rose-200">
                          -{diffMetrics?.deletions ?? 0}
                        </span>
                        <span className="rounded-full border border-sky-500/20 px-2 py-0.5 text-sky-200">
                          {diffMetrics?.hunks ?? 0} {t.workspaceGitHunks}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {onSelectGitFile && (
                          <button
                            type="button"
                            onClick={() => onSelectGitFile(buildGitFileSelection(file, mode))}
                            className="rounded-md border border-indigo-500/40 px-2 py-1 text-[10px] text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10"
                          >
                            {lang === 'en'
                              ? 'Diff in editor'
                              : lang === 'zh-TW'
                                ? '在編輯器中並排對比'
                                : '在编辑器中并排对比'}
                          </button>
                        )}
                        {canOpenWorkspaceFile && onSelectPath && (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectGitFile?.(null);
                              onSelectPath(file.path);
                            }}
                            className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200"
                          >
                            {t.workspaceGitOpenFile}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void copyGitDiff(cacheKey, fileDiffState.summary as GitDiffSummary)}
                          className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200"
                        >
                          {copyLabel}
                        </button>
                      </div>

                      {fileDiffState.summary.stat && (
                        <pre className="overflow-x-auto rounded-lg bg-[#0b0d13] px-2 py-2 font-mono text-[10px] leading-5 text-slate-400">
                          {fileDiffState.summary.stat}
                        </pre>
                      )}

                      {fileDiffState.summary.truncated && (
                        <div className="text-[10px] text-amber-300">{t.workspaceGitDiffTruncated}</div>
                      )}

                      {fileDiffState.summary.diff ? (
                        <GitDiffPreview diff={fileDiffState.summary.diff} />
                      ) : (
                        <div className="text-xs text-slate-500">
                          {fileDiffState.summary.message || t.workspaceGitFileDiffEmpty}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden border-t border-[#202432] bg-[#0d1118]">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={isExpanded}
          aria-label={t.workspaceGit}
        >
          <span className="text-[10px] text-slate-500">{isExpanded ? '▾' : '▸'}</span>
          <span className="text-xs font-semibold text-slate-300">{t.workspaceGit}</span>
          <span className="rounded-full border border-[#2a2d3a] px-1.5 py-0.5 text-[10px] text-slate-500">
            {changedCount}
          </span>
          {gitStatus?.available && gitStatus.isRepo && gitStatus.branch && (
            <span className="min-w-0 truncate rounded-full border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-200">
              {gitStatus.branch}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          {isExpanded && workspacePath && (
            <button
              type="button"
              onClick={() => setRefreshVersion((value) => value + 1)}
              disabled={isLoading || activeGitActionKey !== null}
              className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.workspaceInsightsRefresh}
            </button>
          )}
          <span className="text-[10px] text-slate-500">{isExpanded ? t.collapse : t.expand}</span>
        </div>
      </div>

      {isExpanded && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable border-t border-[#202432] px-3 py-3">
          {!workspacePath && (
            <div className="rounded-xl border border-[#202432] bg-[#10141d] px-3 py-3 text-xs leading-relaxed text-slate-500">
              {t.projectEmptyDesc}
            </div>
          )}

          {workspacePath && isLoading && (
            <div className="text-xs text-slate-500">{t.workspaceGitLoading}</div>
          )}

          {workspacePath && !isLoading && !gitStatus && (
            <div className="text-xs text-slate-500">{t.workspaceInsightsUnavailable}</div>
          )}

          {gitStatus && !gitStatus.available && (
            <div className="text-xs leading-relaxed text-slate-500">
              {gitStatus.message || t.workspaceGitUnavailable}
            </div>
          )}

          {gitStatus && gitStatus.available && !gitStatus.isRepo && (
            <div className="space-y-2 rounded-xl border border-[#202432] bg-[#10141d] px-3 py-3">
              <div className="text-xs leading-relaxed text-slate-500">
                {gitStatus.message || t.workspaceGitNotRepo}
              </div>
              <div className="text-[11px] leading-relaxed text-slate-500">{t.workspaceGitInitHint}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void initializeGitRepository()}
                  disabled={isInitializingGit}
                  className="rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isInitializingGit ? t.workspaceGitInitRunning : t.workspaceGitInitRepo}
                </button>
                {gitActionMessage && (
                  <span className="text-[11px] text-slate-500">{gitActionMessage}</span>
                )}
              </div>
            </div>
          )}

          {gitStatus && gitStatus.available && gitStatus.isRepo && (
            <div className="space-y-3">
              {gitActionMessage && (
                <div className="rounded-lg border border-[#202432] bg-[#10141d] px-2.5 py-2 text-[11px] text-slate-400">
                  {gitActionMessage}
                </div>
              )}

              <div className="space-y-2 rounded-xl border border-[#202432] bg-[#10141d] px-3 py-3">
                <div className="text-[11px] font-semibold text-slate-300">{gitBranchLabelText}</div>
                <div className="text-[10px] leading-relaxed text-slate-500">{gitBranchHintText}</div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={branchName}
                    onChange={(event) => setBranchName(event.currentTarget.value)}
                    placeholder={gitBranchPlaceholderText}
                    className="min-w-0 flex-1 rounded-lg border border-[#2a2d3a] bg-[#0b0d13] px-3 py-2 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-indigo-500/60"
                  />
                  <button
                    type="button"
                    onClick={() => void checkoutGitBranch()}
                    disabled={activeGitActionKey !== null || !branchName.trim()}
                    className="rounded-md border border-indigo-500/40 px-3 py-1.5 text-[11px] text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {activeGitActionKey === 'branch-checkout' ? gitBranchRunningText : gitBranchActionText}
                  </button>
                </div>
                {selectedHistoryEntry && (
                  <div className="text-[10px] text-slate-500">
                    {gitHistorySelectedText}: {selectedHistoryEntry.shortHash}
                  </div>
                )}
              </div>

              <div className="space-y-2 rounded-xl border border-[#202432] bg-[#10141d] px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold text-slate-300">{gitHistoryTitleText}</div>
                  <button
                    type="button"
                    onClick={() => void restoreGitWorkspace()}
                    disabled={activeGitActionKey !== null || visibleGitFiles.length === 0}
                    className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-400 transition-colors hover:border-rose-500/50 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {activeGitActionKey === 'restore' ? gitRestoreRunningText : gitRestoreActionText}
                  </button>
                </div>

                {historyEntries.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[10px]">
                    {([
                      { key: 'all', cnLabel: '全部', enLabel: 'All' },
                      { key: 'user', cnLabel: '手动提交', enLabel: 'Manual' },
                      { key: 'checkpoint', cnLabel: '自动快照', enLabel: 'Auto' },
                    ] as const).map((opt) => {
                      const isActive = historyFilter === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setHistoryFilter(opt.key)}
                          className={`rounded-md border px-2 py-0.5 transition-colors ${
                            isActive
                              ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-100'
                              : 'border-[#2a2d3a] text-slate-400 hover:border-[#2f3650] hover:text-slate-200'
                          }`}
                        >
                          {lang === 'en' ? opt.enLabel : opt.cnLabel}
                        </button>
                      );
                    })}
                    <span className="ml-auto text-slate-500">
                      {filteredHistoryEntries.length} / {historyEntries.length}
                    </span>
                  </div>
                )}

                {renderGitHistoryList(filteredHistoryEntries)}

                {historyEntries.length >= historyLimit && historyLimit < 50 && (
                  <button
                    type="button"
                    onClick={() => setHistoryLimit((n) => Math.min(n + 20, 50))}
                    disabled={isLoading}
                    className="w-full rounded-md border border-[#2a2d3a] py-1 text-[10px] text-slate-400 transition-colors hover:border-[#2f3650] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {lang === 'en' ? 'Load more' : '加载更多'}
                  </button>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#202432] pt-2">
                  <div className="text-[10px] text-slate-500">
                    {selectedHistoryEntry
                      ? `${gitHistorySelectedText}: ${selectedHistoryEntry.shortHash}`
                      : gitResetSelectRequiredText}
                  </div>
                  <div className="flex items-center gap-2">
                    {undoResetAvailable && (
                      <button
                        type="button"
                        onClick={() => void undoHistoryReset()}
                        disabled={activeGitActionKey !== null}
                        className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-[11px] text-emerald-100 transition-colors hover:border-emerald-400 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {activeGitActionKey === 'undo-reset'
                          ? (lang === 'en' ? 'Undoing...' : '撤销中...')
                          : (lang === 'en' ? 'Undo rollback' : '撤销回退')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => selectedHistoryEntry && void resetGitToHistoryEntry(selectedHistoryEntry)}
                      disabled={activeGitActionKey !== null || !selectedHistoryEntry}
                      className="rounded-md border border-amber-500/40 px-3 py-1.5 text-[11px] text-amber-100 transition-colors hover:border-amber-400 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {gitResetActionText}
                    </button>
                  </div>
                </div>
              </div>

              {changedGitFiles.length === 0 && (
                <div className="text-xs text-slate-500">{t.workspaceGitNoChanges}</div>
              )}

              {changedGitFiles.length > 0 && (
                <div className="space-y-2">
                  {/* 方案 A：单一"未提交改动"列表 + checkbox + 一键提交所选。
                      不再展示 "暂存 / 未暂存" 两个分区。 */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="text-[11px] font-semibold text-slate-300">
                        {gitChangesTabText}
                      </div>
                      <span className="rounded-lg border border-[#2a2d3a] px-2 py-0.5 text-[10px] text-slate-400">
                        {(t.workspaceGitSelectedCount ||
                          (lang === 'en' ? '{{count}} of {{total}} selected' : '已选 {{count}} / {{total}}'))
                          .replace('{{count}}', String(selectedCount))
                          .replace('{{total}}', String(changedGitFiles.length))}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={allSelected ? deselectAllGitFiles : selectAllGitFiles}
                        disabled={activeGitActionKey !== null}
                        className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {allSelected ? gitDeselectAllText : gitSelectAllText}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2 rounded-xl border border-[#202432] bg-[#10141d] px-3 py-3">
                    <label className="block text-[11px] font-medium text-slate-300" htmlFor="workspace-git-commit-message">
                      {gitCommitTitleText}
                    </label>
                    <textarea
                      id="workspace-git-commit-message"
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.currentTarget.value)}
                      placeholder={gitCommitPlaceholderText}
                      rows={2}
                      className="w-full rounded-lg border border-[#2a2d3a] bg-[#0b0d13] px-3 py-2 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-indigo-500/60"
                    />
                    <div className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => void commitGitChanges()}
                        disabled={
                          activeGitActionKey !== null ||
                          selectedCount === 0 ||
                          !commitMessage.trim()
                        }
                        className="rounded-md border border-indigo-500/40 px-3 py-1.5 text-[11px] text-indigo-100 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {activeGitActionKey === 'commit'
                          ? gitCommitRunningText
                          : `${gitCommitSelectedActionText} (${selectedCount})`}
                      </button>
                    </div>
                  </div>

                  {changedGitFiles.length > visibleChangedFiles.length && (
                    <div className="text-[10px] text-slate-500">
                      +{changedGitFiles.length - visibleChangedFiles.length}
                    </div>
                  )}
                  {renderGitFileList(visibleChangedFiles)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {restoreTarget && (
        <RestoreConfirmDialog
          workspacePath={workspacePath}
          targetSha={restoreTarget.hash}
          targetLabel={restoreTarget.subject}
          lang={lang ?? 'zh-CN'}
          onConfirm={handleRestoreConfirmed}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </section>
  );
}
