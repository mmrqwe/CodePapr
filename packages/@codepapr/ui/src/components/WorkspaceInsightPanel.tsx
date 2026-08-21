import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import { yieldToMainThread } from '../utils/taskScheduling';
import {
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMapSync,
  enrichWorkspaceProjectGraph,
  DEFAULT_LSP_ENRICH_SYMBOLS,
  buildGitDiffSummary,
  buildGitUnavailableDiff,
  buildGitUnavailableStatus,
  filterWorkspaceInsightEntries,
  parseGitRepositoryRootCommandResult,
  parseGitStatusCommandResult,
  selectProjectMapFiles,
  type GitDiffSummary,
  type GitStatusFile,
  type GitStatusSummary,
  type WorkspaceListEntry,
  type WorkspaceMapSymbolSummary,
  type WorkspaceProjectGraphResult,
} from '../tools/workspaceToolUtils';
import { resolveProjectMapSymbolOverrides } from '../tools/workspaceProjectMapLsp';
import { stopWorkspaceLsp } from '../utils/lspWarmup';
import { getTranslation, type Lang } from '../utils/i18n';
import { computeProjectGraphInsights } from '../utils/projectGraphInsights';
import type { CircularDependency, DeadCodeSymbol } from '@codepapr/core';
import {
  buildGitDiffClipboardText,
  buildGitDiffCommandArgs,
  buildSyntheticUntrackedGitDiff,
  gitDiffCacheKey,
  gitStatusCodeForMode,
  isUntrackedGitFile,
  listGitFilesForMode,
  type GitDiffMode,
} from '../utils/workspaceGitPanel';
import { isLspFamilyEnabled } from '../utils/lspFamilies';
import type { ProjectGraphWorkerBuildRequest, ProjectGraphWorkerMessage } from '../workers/projectGraphWorkerProtocol';
import { computeInsightCacheKey } from '../utils/projectGraphCacheKey';

const WORKER_AVAILABLE = typeof Worker !== 'undefined';
const WORKER_BUILD_TIMEOUT_MS = 60_000;

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}



interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface WorkspaceInsightPanelProps {
  workspacePath: string;
  entries: WorkspaceListEntry[];
  lang: Lang;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  showGitPanel?: boolean;
  canStartLoading?: boolean;
  onProgressChange?: (progress: ProjectGraphProgressState | null, isLoading: boolean) => void;
}

interface ProjectGraphProgressState {
  phase: 'reading-files' | 'resolving-symbols' | 'building' | 'enriching' | 'init-git' | 'prewarming-lsp';
  current: number;
  total: number;
}

interface GitDiffLoadState {
  summary: GitDiffSummary | null;
  error: string;
  isLoading: boolean;
}

const INSIGHT_LIST_MAX_DEPTH = 8;
const MAX_INSIGHT_FILE_BYTES = 50_000_000;
const MAX_INSIGHT_SYMBOLS = Number.MAX_SAFE_INTEGER;
const MAX_PROJECT_GRAPH_SOURCE_FILES = 500;
const MAX_GIT_CHANGED_FILES = 12;
const MAX_GIT_DIFF_PATHS = 12;
// 轮末自动刷新 ProjectGraph 的安定延迟：须大于 workspace 变更版本号防抖（150ms），
// 确保定时器触发时读到的是本轮全部写入落定后的版本号。
const PROJECT_GRAPH_AUTO_REFRESH_DELAY_MS = 500;

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

const INSIGHT_ITEM_CLASS =
  'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] text-fg-soft transition-colors hover:bg-base';

function InsightSection({
  title,
  tip,
  count,
  badgeClass,
  children,
}: {
  title: string;
  tip: string;
  count: number;
  badgeClass: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-1" title={tip}>
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
          {title}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] tabular-nums ${
            count > 0 ? badgeClass : 'border border-ok-bg bg-ok-bg text-ok'
          }`}
        >
          {count > 0 ? count : '✓'}
        </span>
      </div>
      {children}
    </div>
  );
}

function InsightFileList({
  items,
  emptyText,
  onPick,
}: {
  items: Array<{ id: string; path: string }>;
  emptyText: string;
  onPick: (path: string) => void;
}) {
  if (items.length === 0) {
    return <div className="px-1.5 text-[10px] text-fg-dim">{emptyText}</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onPick(item.path)}
          title={item.path}
          className={INSIGHT_ITEM_CLASS}
        >
          <span className="truncate">{item.path}</span>
        </button>
      ))}
    </div>
  );
}

export function WorkspaceInsightPanel(props: WorkspaceInsightPanelProps) {
  const { workspacePath, entries, lang, selectedPath, onSelectPath, showGitPanel = false, canStartLoading = true, onProgressChange } = props;
  const t = getTranslation(lang);
  const settings = useAgentStore((s) => s.settings);
  const agentIsLoading = useAgentStore((s) => s.isLoading);
  const resolveLimit = (value: number | undefined, fallback: number, zeroMeansUnlimited = false): number => {
    if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
    if (value <= 0) return zeroMeansUnlimited ? Number.MAX_SAFE_INTEGER : fallback;
    return value;
  };
  const insightMaxDepth = resolveLimit(settings?.projectGraphMaxDepth, INSIGHT_LIST_MAX_DEPTH);
  const insightMaxFileBytes = resolveLimit(settings?.projectGraphMaxFileBytes, MAX_INSIGHT_FILE_BYTES);
  const insightMaxSymbols = resolveLimit(settings?.projectGraphMaxSymbolsPerFile, MAX_INSIGHT_SYMBOLS);
  const insightMaxEdges = resolveLimit(settings?.projectGraphMaxEdges, Number.MAX_SAFE_INTEGER);
  const insightMaxSourceFiles = resolveLimit(settings?.projectGraphMaxFiles, MAX_PROJECT_GRAPH_SOURCE_FILES, true);
  const insightMaxTreeEntries = resolveLimit(settings?.projectGraphMaxTreeEntries, 320, true);
  const [projectGraph, setProjectGraph] = useState<WorkspaceProjectGraphResult | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const lastWorkspacePathRef = useRef<string | null>(null);
  const hasSignaledLoadingRef = useRef(false);
  const [loadingInProgress, setLoadingInProgress] = useState(false);
  const [prewarming, setPrewarming] = useState(false);
  const [prewarmingProgress, setPrewarmingProgress] = useState('');
  const appendDebug = (msg: string) => {
    if (!settings.debugEnabled) return;
    setDebugLog((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  };
  const [refreshVersion, setRefreshVersion] = useState(0);
  // 自动刷新 ProjectGraph：记录上一轮 agent 加载态，及本轮起始的 workspace 变更版本号。
  const prevAgentIsLoadingRef = useRef(agentIsLoading);
  const graphMutationVersionAtTurnStartRef = useRef(useAgentStore.getState().workspaceMutationVersion);
  // 本轮对话中 LLM 改过文件 → 轮末自动刷新。仅依赖 agentIsLoading；版本号经
  // getState() 读取（不进依赖），避免轮末定时器被晚到的版本 bump 清掉。
  useEffect(() => {
    const wasLoading = prevAgentIsLoadingRef.current;
    prevAgentIsLoadingRef.current = agentIsLoading;
    if (agentIsLoading && !wasLoading) {
      // 轮首：记录起始版本号，用于判断本轮是否有文件变更。
      graphMutationVersionAtTurnStartRef.current = useAgentStore.getState().workspaceMutationVersion;
      return;
    }
    if (!agentIsLoading && wasLoading) {
      // 轮末：等变更防抖落定后，若版本号变化则刷新。
      const timer = setTimeout(() => {
        const latest = useAgentStore.getState().workspaceMutationVersion;
        if (latest !== graphMutationVersionAtTurnStartRef.current) {
          setRefreshVersion((v) => v + 1);
        }
      }, PROJECT_GRAPH_AUTO_REFRESH_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [agentIsLoading]);
  const [projectGraphProgress, setProjectGraphProgress] = useState<ProjectGraphProgressState | null>(null);
  const [gitMode, setGitMode] = useState<GitDiffMode>('unstaged');
  const [gitModeDiffs, setGitModeDiffs] = useState<Record<GitDiffMode, GitDiffLoadState>>({
    unstaged: createEmptyGitDiffLoadState(),
    staged: createEmptyGitDiffLoadState(),
  });
  const [gitFileDiffs, setGitFileDiffs] = useState<Record<string, GitDiffLoadState>>({});
  const loadingDiffKeysRef = useRef<Set<string>>(new Set());
  const [expandedGitDiffKey, setExpandedGitDiffKey] = useState<string | null>(null);
  const [gitCopyState, setGitCopyState] = useState<{ key: string; success: boolean } | null>(null);
  const [isInitializingGit, setIsInitializingGit] = useState(false);
  const [gitActionMessage, setGitActionMessage] = useState('');
  const gitInitAttemptedRef = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const isMountedRef = useRef(true);
  const gitCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (gitCopyTimerRef.current) {
        clearTimeout(gitCopyTimerRef.current);
        gitCopyTimerRef.current = null;
      }
    };
  }, []);
  const loadGenerationRef = useRef(0);

  // 洞察全部由已构建的图同步纯计算得出（core 既有分析函数），无额外 IO。
  const projectGraphInsights = useMemo(
    () => (projectGraph ? computeProjectGraphInsights(projectGraph) : null),
    [projectGraph],
  );

  function handleInsightDeadCodeClick(symbol: DeadCodeSymbol) {
    onSelectPath(symbol.path);
  }

  function handleInsightCycleClick(cycle: CircularDependency) {
    const firstFile = cycle.files[0];
    if (firstFile) {
      onSelectPath(firstFile);
    }
  }

  useEffect(() => {
    gitInitAttemptedRef.current = false;
    setGitActionMessage('');
  }, [workspacePath]);

  useEffect(() => {
    const effectiveLoading = isLoading || prewarming || loadingInProgress;
    if (effectiveLoading) hasSignaledLoadingRef.current = true;
    // 去掉旧 guard `if (!effectiveLoading && !hasSignaledLoadingRef.current) return;`
    // 该 guard 在 canStartLoading 短暂变 false（文件树刷新等）导致 hasSignaledLoadingRef
    // 被重置后，会阻止 onProgressChange(null, false) 回调，使 store 中的
    // projectGraphLoading 永久卡在 true。handleProjectGraphProgress 内部已有
    // graphLoadStartedRef 保护，不会误触发。
    let progress: ProjectGraphProgressState | null = projectGraphProgress;
    if (!isLoading && !loadingInProgress && prewarming) {
      progress = { phase: 'prewarming-lsp', current: 0, total: 0 };
    }
    onProgressChange?.(progress, effectiveLoading);
  }, [projectGraphProgress, isLoading, prewarming, loadingInProgress, onProgressChange]);

  const prewarmingGenRef = useRef(0);
  const prevWorkspaceRef = useRef<string>('');
  const prewarmingInitializedRef = useRef(false);

  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (workspacePath) {
      prewarmingInitializedRef.current = false;
      prevWorkspaceRef.current = workspacePath;
      prewarmingGenRef.current += 1;
      setPrewarming(false);
      setPrewarmingProgress('');
    } else {
      prevWorkspaceRef.current = '';
    }
    if (prev && prev !== workspacePath) {
      void stopWorkspaceLsp(prev);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath || !entries || entries.length === 0 || prewarmingInitializedRef.current) return;
    const extToLang: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.rs': 'rust', '.go': 'go', '.swift': 'swift',
      '.cs': 'csharp', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
      '.sql': 'sql', '.md': 'markdown', '.sh': 'shellscript', '.bash': 'shellscript',
    };
    const langIds = new Set<string>();
    const lspFiles: Array<{ path: string; langId: string }> = [];
    for (const entry of entries) {
      const ext = entry.path.slice(entry.path.lastIndexOf('.')).toLowerCase();
      const lang = extToLang[ext];
      if (lang) {
        if (!isLspFamilyEnabled(settings.lspDisabledFamilies, lang)) {
          continue;
        }
        langIds.add(lang);
        if (!entry.path.includes('/.') && !entry.path.startsWith('.')) {
          lspFiles.push({ path: entry.path, langId: lang });
        }
      }
    }
    if (langIds.size === 0) {
      setPrewarming(false);
      setPrewarmingProgress('');
      return;
    }

    const gen = ++prewarmingGenRef.current;
    // 一旦开始预热就标记为已初始化，避免父组件传入新的 entries 数组引用时（如文件监听刷新）
    // 在预热进行中反复触发 cleanup→restart 循环，重复调用 lsp_start_server / lsp_open_document。
    prewarmingInitializedRef.current = true;
    setPrewarming(true);
    setPrewarmingProgress('');
    let cancelled = false;

    void (async () => {
      setPrewarmingProgress('启动服务器...');
      await Promise.allSettled([...langIds].map(async (langId) => {
        try { await invoke('lsp_start_server', { workspacePath, languageId: langId }); } catch { /* ok */ }
      }));
      if (cancelled || gen !== prewarmingGenRef.current) return;

      let processed = 0;
      const total = lspFiles.length;
      const batchSize = 6;
      for (let i = 0; i < lspFiles.length; i += batchSize) {
        if (cancelled || gen !== prewarmingGenRef.current) return;
        const batch = lspFiles.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (file) => {
          try {
            const result = await invoke<{ content: string }>('read_text_file', {
              workspacePath, relativePath: file.path, maxBytes: 120_000,
            });
            if (result.content) {
              await invoke('lsp_open_document', {
                workspacePath, languageId: file.langId, relativePath: file.path,
                content: result.content, version: 1, diagWaitMs: 0,
              });
            }
          } catch { /* skip */ }
        }));
        processed += batch.length;
        setPrewarmingProgress(`${processed}/${total}`);
      }
      if (cancelled || gen !== prewarmingGenRef.current) return;

      setPrewarmingProgress('等待分析...');
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled || gen !== prewarmingGenRef.current) return;

      setPrewarmingProgress('收集诊断...');
      for (const langId of langIds) {
        if (cancelled || gen !== prewarmingGenRef.current) return;
        try {
          const diagResult = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>('lsp_get_diagnostics', { workspacePath, languageId: langId });
          const uriCount = Object.keys(diagResult.diagnostics ?? {}).length;
          const diagCount = Object.values(diagResult.diagnostics ?? {}).reduce((s, d) => s + (d.diagnostics?.length ?? 0), 0);
          // eslint-disable-next-line no-console
          console.log(`[prewarm] ${langId}: ${uriCount} uris, ${diagCount} diagnostics`);
        } catch (e) { console.warn(`[prewarm] ${langId} diag failed:`, e); }
      }

      if (!cancelled && gen === prewarmingGenRef.current) {
        setPrewarming(false);
        setPrewarmingProgress('');
        prewarmingInitializedRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
      setPrewarming(false);
      setPrewarmingProgress('');
    };
  }, [workspacePath, entries]);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;
    let workerReject: ((reason: Error) => void) | null = null;

    if (!canStartLoading || !workspacePath) {
      appendDebug(`跳过: canStartLoading=${canStartLoading} workspacePath=${workspacePath?.slice(-20)}`);
      setIsLoading(false);
      setProjectGraphProgress(null);
      setLoadingInProgress(false);
      hasSignaledLoadingRef.current = false;
      if (lastWorkspacePathRef.current !== workspacePath) {
        setProjectGraph(null);
        setError('');
      }
      lastWorkspacePathRef.current = workspacePath ?? null;
      return;
    }

    lastWorkspacePathRef.current = workspacePath;

    appendDebug(`开始加载: path=${workspacePath.slice(-30)} entries=${entriesRef.current.length} depth=${insightMaxDepth} bytes=${insightMaxFileBytes} files=${insightMaxSourceFiles}`);

    const thisGeneration = ++loadGenerationRef.current;

    setLoadingInProgress(true);

    const computeGitStatus = async (): Promise<GitStatusSummary | null> => {
      if (!showGitPanel) return null;
      try {
        const repoRootResult = parseGitRepositoryRootCommandResult(
          await invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: ['rev-parse', '--show-toplevel'],
            timeoutSeconds: 15,
          })
        );

        if (!repoRootResult.available || !repoRootResult.isRepo) {
          return {
            available: repoRootResult.available,
            isRepo: false,
            files: [],
            raw: repoRootResult.raw,
            ...(repoRootResult.message ? { message: repoRootResult.message } : {}),
          };
        }
        const statusResult = await invoke<CommandResult>('run_workspace_command', {
          workspacePath,
          command: 'git',
          args: ['status', '--porcelain=1', '--branch', '--untracked-files=all'],
          timeoutSeconds: 15,
        });
        const parsedStatus = parseGitStatusCommandResult(statusResult);
        return parsedStatus.isRepo && repoRootResult.repoRoot
          ? { ...parsedStatus, repoRoot: repoRootResult.repoRoot }
          : parsedStatus;
      } catch (gitError) {
        return buildGitUnavailableStatus(gitError instanceof Error ? gitError.message : String(gitError));
      }
    };

    const loadInsights = async () => {
      let gitFingerprint = '';
      try {
        const [headResult, statusResult] = await Promise.all([
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: ['rev-parse', 'HEAD'],
            timeoutSeconds: 5,
          }).catch(() => null),
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: ['status', '--porcelain=1'],
            timeoutSeconds: 8,
          }).catch(() => null),
        ]);
        const headText = headResult?.status === 0 ? (headResult.stdout ?? '').trim() : '';
        const statusText = statusResult?.status === 0 ? (statusResult.stdout ?? '').trim() : '';
        gitFingerprint = `${headText}|${statusText}`;
      } catch {
        gitFingerprint = '';
      }

      const currentCacheKey = computeInsightCacheKey(
        workspacePath, entriesRef.current, {
          insightMaxDepth,
          insightMaxSourceFiles,
          insightMaxFileBytes,
          insightMaxSymbols,
          insightMaxEdges,
          insightMaxTreeEntries,
        },
        gitFingerprint,
      );

      try {
        const cachedRaw = await invoke<string | null>('load_projectgraph_cache', {
          workspacePath,
        }).catch(() => null);

        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw);
          if (cached.cacheKey === currentCacheKey && cached.projectGraph) {
            if (!cancelled) {
              setProjectGraph(cached.projectGraph as WorkspaceProjectGraphResult);
              setError('');
              hasSignaledLoadingRef.current = true;
              setLoadingInProgress(false);
              const cachedGitStatus = await computeGitStatus();
              if (!cancelled) {
                setGitStatus(cachedGitStatus);
              }
            }
            return;
          }
        }
      } catch { /* cache miss - rebuild */ }

      if (cancelled) {
        return;
      }

      setIsLoading(true);
      setError('');
      setExpandedGitDiffKey(null);
      setGitCopyState(null);
      setGitFileDiffs({});
      setGitModeDiffs({
        unstaged: createEmptyGitDiffLoadState(),
        staged: createEmptyGitDiffLoadState(),
      });
      setProjectGraphProgress({ phase: 'reading-files', current: 0, total: 5 });

      try {
        const insightRoot = '';
        const insightTruncated = false;
        const insightEntries = filterWorkspaceInsightEntries(entriesRef.current);
        const csFiles = insightEntries.filter(e => !e.isDir && e.path.endsWith('.cs'));
        appendDebug(`过滤后: ${insightEntries.length} 条目 其中.cs: ${csFiles.length}`);
        const projectGraphFiles = selectProjectMapFiles(insightEntries, insightMaxSourceFiles);
        appendDebug(`文件列表: ${projectGraphFiles.length} 个文件 [${projectGraphFiles.slice(0,5).map(f => f.path.split('/').pop()).join(', ')}...]`);

        if (projectGraphFiles.length === 0) {
          appendDebug('工作区没有可分析的源代码文件，跳过 ProjectGraph 构建');
          setIsLoading(false);
          return;
        }

        const BATCH_SIZE = 30;
        const fileContents: Record<string, { content: string; bytes: number }> = {};
        const totalBatches = Math.ceil(projectGraphFiles.length / BATCH_SIZE);

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          if (cancelled) return;

          const batch = projectGraphFiles.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
          const paths = batch.map((e) => e.path);

          try {
            const results = await invoke<Array<{ path: string; content: string; bytes: number }>>('read_text_files_batch', {
              workspacePath,
              relativePaths: paths,
              maxBytes: insightMaxFileBytes,
            });

            for (const r of results) {
              fileContents[r.path] = { content: r.content, bytes: r.bytes };
            }
          } catch {
            appendDebug(`批量读取失败 batch ${batchIndex + 1}/${totalBatches}, 回退到逐文件读取`);
            for (const entry of batch) {
              if (cancelled) return;
              try {
                const result = await invoke<{ content: string; bytes: number }>('read_text_file', {
                  workspacePath, relativePath: entry.path, maxBytes: insightMaxFileBytes,
                });
                fileContents[entry.path] = { content: result.content, bytes: result.bytes };
              } catch {
                // 跳过此文件
              }
            }
          }

          if (batchIndex < totalBatches - 1) {
            await yieldToMainThread();
          }
        }

        if (cancelled) {
          return;
        }

        const succeeded = Object.keys(fileContents).length;
        const entriesWithContent = Object.entries(fileContents);
        const firstOk = entriesWithContent[0];
        appendDebug(`文件读取: ${succeeded}/${projectGraphFiles.length} 成功 first=${firstOk?.[0]?.replace(/^.*\//,'')}:${firstOk?.[1]?.content?.length ?? 0}bytes`);
        if (succeeded === 0) {
          setError(`无法读取任何源文件 (${projectGraphFiles.length} 个文件, maxBytes=${insightMaxFileBytes})`);
          setIsLoading(false);
          return;
        }

        setProjectGraphProgress({ phase: 'resolving-symbols', current: 2, total: 5 });
        await yieldToMainThread();

        let symbolOverrides: Record<string, WorkspaceMapSymbolSummary[]> = {};
        try {
          symbolOverrides = await resolveProjectMapSymbolOverrides(
            workspacePath,
            fileContents,
            insightMaxSymbols,
            5,
            () => cancelled
          );
        } catch {
          // LSP symbol resolution failed, proceed with structural extraction
        }

        setProjectGraphProgress({ phase: 'building', current: 3, total: 5 });

        let rawProjectGraph: WorkspaceProjectGraphResult;

        const buildViaFallback = async (): Promise<WorkspaceProjectGraphResult> => {
          appendDebug('路径: 非Worker(fallback)');
          const projectGraphProjectMap = buildWorkspaceProjectMapSync({
            rootRelativePath: insightRoot,
            entries: insightEntries,
            fileContents,
            symbolOverrides,
            maxTreeEntries: insightMaxTreeEntries,
            maxStubsPerFile: insightMaxSymbols,
            truncated: insightTruncated,
          });

          await yieldToMainThread();

          return buildWorkspaceProjectGraph({
            projectMap: projectGraphProjectMap,
            entries: insightEntries,
            fileContents,
            symbolOverrides,
            maxEdges: insightMaxEdges,
          });
        };

        if (WORKER_AVAILABLE) {
          appendDebug('路径: Worker');
          const workerRequest: ProjectGraphWorkerBuildRequest = {
            type: 'build',
            projectMapParams: {
              rootRelativePath: insightRoot,
              entries: insightEntries,
              fileContents,
              symbolOverrides,
              maxTreeEntries: insightMaxTreeEntries,
              maxStubsPerFile: insightMaxSymbols,
              truncated: insightTruncated,
            },
            projectGraphParams: {
              entries: insightEntries,
              fileContents,
              symbolOverrides,
              maxEdges: insightMaxEdges,
            },
          };

          try {
            rawProjectGraph = await new Promise<WorkspaceProjectGraphResult>((resolve, reject) => {
              worker = new Worker(
                new URL('../workers/projectGraphWorker.ts', import.meta.url),
                { type: 'module' }
              );
              workerReject = reject;
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  reject(new Error('Worker 构建超时'));
                }
              }, WORKER_BUILD_TIMEOUT_MS);

              worker.onmessage = (event: MessageEvent<ProjectGraphWorkerMessage>) => {
                const msg = event.data;
                if (msg.type === 'progress') {
                  if (!cancelled) {
                    if (msg.phase === 'building-map') {
                      setProjectGraphProgress({ phase: 'building', current: 3, total: 5 });
                    } else if (msg.phase === 'building-graph') {
                      setProjectGraphProgress({ phase: 'building', current: 4, total: 5 });
                    }
                  }
                } else if (msg.type === 'result') {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(msg.projectGraph);
                  }
                } else if (msg.type === 'error') {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(msg.error));
                  }
                }
              };

              worker.onerror = (event: ErrorEvent) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  reject(new Error(event.message || 'Worker error'));
                }
              };

              worker.postMessage(workerRequest);
            });
          } catch (workerError) {
            if (cancelled) {
              return;
            }
            appendDebug(`Worker 失败，回退到主线程: ${(workerError as Error).message}`);
            if (worker) {
              worker.terminate();
              worker = null;
            }
            workerReject = null;
            rawProjectGraph = await buildViaFallback();
          }
        } else {
          rawProjectGraph = await buildViaFallback();
        }

        appendDebug(`原始图: ${rawProjectGraph.summary.files}f ${rawProjectGraph.summary.symbols}s ${rawProjectGraph.summary.imports}i ${rawProjectGraph.summary.extends}e ${rawProjectGraph.summary.calls}c`);

        setProjectGraphProgress({ phase: 'enriching', current: 5, total: 5 });

        const nextProjectGraph = await enrichWorkspaceProjectGraph(rawProjectGraph, fileContents, 4, DEFAULT_LSP_ENRICH_SYMBOLS, workspacePath).catch(() => rawProjectGraph);

        const s = nextProjectGraph.summary;
        appendDebug(`图完成: files=${s.files} symbols=${s.symbols} imports=${s.imports} extends=${s.extends} calls=${s.calls}`);

        setProjectGraphProgress(null);

        const nextGitStatus = await computeGitStatus();

        if (cancelled) {
          return;
        }

        setProjectGraph(nextProjectGraph);
        setGitStatus(nextGitStatus);

        try {
          await invoke('save_projectgraph_cache', {
            workspacePath,
            cacheData: JSON.stringify({ cacheKey: currentCacheKey, projectGraph: nextProjectGraph }),
          }).catch(() => undefined);
        } catch { /* cache save non-critical */ }
      } catch (loadError) {
        appendDebug(`致命错误: ${(loadError as Error).message}`);
        if (!cancelled) {
          setProjectGraph(null);
          setGitStatus(null);
          setError((loadError as Error).message);
        }
      } finally {
        if (loadGenerationRef.current === thisGeneration) {
          setIsLoading(false);
          setLoadingInProgress(false);
          setProjectGraphProgress(null);
        }
        if (worker) {
          worker.terminate();
          worker = null;
        }
        workerReject = null;
      }
    };

    void loadInsights();

    return () => {
      cancelled = true;
      if (workerReject) {
        workerReject(new DOMException('Aborted', 'AbortError'));
        workerReject = null;
      }
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };
  }, [canStartLoading, refreshVersion, workspacePath, showGitPanel, insightMaxDepth, insightMaxFileBytes, insightMaxSymbols, insightMaxEdges, insightMaxSourceFiles, insightMaxTreeEntries]);

  const stagedFiles =
    gitStatus?.available && gitStatus.isRepo ? listGitFilesForMode(gitStatus.files, 'staged') : [];
  const unstagedFiles =
    gitStatus?.available && gitStatus.isRepo
      ? listGitFilesForMode(gitStatus.files, 'unstaged')
      : [];
  const activeGitFiles =
    gitStatus?.available && gitStatus.isRepo
      ? listGitFilesForMode(gitStatus.files, gitMode)
      : [];
  const activeGitModeDiff = gitModeDiffs[gitMode];

  useEffect(() => {
    if (!showGitPanel) {
      return;
    }

    if (!gitStatus?.available || !gitStatus.isRepo) {
      return;
    }

    if (gitMode === 'unstaged' && unstagedFiles.length === 0 && stagedFiles.length > 0) {
      setGitMode('staged');
      return;
    }

    if (gitMode === 'staged' && stagedFiles.length === 0 && unstagedFiles.length > 0) {
      setGitMode('unstaged');
    }
  }, [gitMode, gitStatus, showGitPanel, stagedFiles.length, unstagedFiles.length]);

  useEffect(() => {
    setGitActionMessage('');
  }, [workspacePath]);

  async function initializeGitRepository(): Promise<void> {
    if (!workspacePath || isInitializingGit || gitInitAttemptedRef.current) {
      return;
    }

    gitInitAttemptedRef.current = true;
    setIsInitializingGit(true);
    setGitActionMessage('');
    setProjectGraphProgress({ phase: 'init-git', current: 0, total: 2 });
    try {
      await invoke<CommandResult>('run_workspace_command', {
        workspacePath,
        command: 'git',
        args: ['init'],
        timeoutSeconds: 30,
      });
      setProjectGraphProgress({ phase: 'init-git', current: 1, total: 2 });

      const defaultGitignore = [
        '.CodePapr/',
        'node_modules/',
        'dist/',
        'build/',
        '.env',
        '.env.local',
        '.DS_Store',
        '*.log',
        '.vscode/',
        '.idea/',
      ].join('\n') + '\n';

      await invoke('write_text_file', {
        workspacePath,
        relativePath: '.gitignore',
        content: defaultGitignore,
      });

      await invoke<CommandResult>('run_workspace_command', {
        workspacePath,
        command: 'git',
        args: ['add', '-A'],
        timeoutSeconds: 60,
      });
      await invoke<CommandResult>('run_workspace_command', {
        workspacePath,
        command: 'git',
        args: ['commit', '-m', 'Initial commit'],
        timeoutSeconds: 30,
      });

      setProjectGraphProgress(null);
      setGitActionMessage(t.workspaceGitInitDone);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setProjectGraphProgress(null);
      setGitActionMessage((error instanceof Error ? error.message : String(error)) || t.workspaceGitUnavailable);
    } finally {
      setIsInitializingGit(false);
    }
  }

  useEffect(() => {
    if (!gitStatus?.available || gitStatus.isRepo || isInitializingGit || gitInitAttemptedRef.current || gitActionMessage) {
      return;
    }
    const timer = window.setTimeout(() => void initializeGitRepository(), 5000);
    return () => window.clearTimeout(timer);
  }, [gitStatus?.available, gitStatus?.isRepo, isInitializingGit, gitActionMessage]);

  useEffect(() => {
    let cancelled = false;

    const loadModeDiff = async () => {
      if (!showGitPanel) {
        return;
      }

      if (!gitStatus?.available || !gitStatus.isRepo) {
        return;
      }

      if (activeGitModeDiff.summary || activeGitModeDiff.isLoading) {
        return;
      }

      const trackedFiles = activeGitFiles.filter((file) => !isUntrackedGitFile(file));
      if (trackedFiles.length === 0) {
        return;
      }

      setGitModeDiffs((current) => ({
        ...current,
        [gitMode]: {
          summary: current[gitMode].summary,
          error: '',
          isLoading: true,
        },
      }));

      const pathspecs = trackedFiles.slice(0, MAX_GIT_DIFF_PATHS).map((file) => file.path);
      const commandArgs = buildGitDiffCommandArgs({
        mode: gitMode,
        pathspecs,
      });

      try {
        const [statResult, diffResult] = await Promise.all([
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: commandArgs.statArgs,
            timeoutSeconds: 15,
          }),
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: commandArgs.diffArgs,
            timeoutSeconds: 20,
          }),
        ]);

        if (cancelled) {
          return;
        }

        setGitModeDiffs((current) => ({
          ...current,
          [gitMode]: {
            summary: buildGitDiffSummary({
              staged: commandArgs.staged,
              pathspecs,
              statResult,
              diffResult,
            }),
            error: '',
            isLoading: false,
          },
        }));
      } catch (gitError) {
        if (cancelled) {
          return;
        }

        setGitModeDiffs((current) => ({
          ...current,
          [gitMode]: {
            summary: buildGitUnavailableDiff(
              gitError instanceof Error ? gitError.message : String(gitError),
              commandArgs.staged,
              pathspecs
            ),
            error: '',
            isLoading: false,
          },
        }));
      }
    };

    void loadModeDiff();

    return () => {
      cancelled = true;
    };
  }, [
    activeGitFiles,
    activeGitModeDiff.isLoading,
    activeGitModeDiff.summary,
    gitMode,
    gitStatus,
    showGitPanel,
    workspacePath,
  ]);

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
        summary = buildSyntheticUntrackedGitDiff(file.path, result.content ?? '', 220);
      } else {
        const pathspecs = file.originalPath ? [file.originalPath, file.path] : [file.path];
        const commandArgs = buildGitDiffCommandArgs({
          mode,
          pathspecs,
          unified: 8,
          findRenames: Boolean(file.originalPath),
        });
        const [statResult, diffResult] = await Promise.all([
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: commandArgs.statArgs,
            timeoutSeconds: 15,
          }),
          invoke<CommandResult>('run_workspace_command', {
            workspacePath,
            command: 'git',
            args: commandArgs.diffArgs,
            timeoutSeconds: 20,
          }),
        ]);

        summary = buildGitDiffSummary({
          staged: commandArgs.staged,
          pathspecs,
          statResult,
          diffResult,
          truncationThreshold: 240_000,
        });
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
          summary: null,
          error: gitError instanceof Error ? gitError.message : String(gitError),
          isLoading: false,
        },
      }));
    } finally {
      loadingDiffKeysRef.current.delete(cacheKey);
    }
  }

  function toggleGitFileDiff(file: GitStatusFile): void {
    const cacheKey = gitDiffCacheKey(gitMode, file.path);
    const nextExpandedKey = expandedGitDiffKey === cacheKey ? null : cacheKey;

    onSelectPath(file.path);
    setExpandedGitDiffKey(nextExpandedKey);

    if (nextExpandedKey) {
      void loadGitFileDiff(file, gitMode);
    }
  }

  async function copyGitDiff(cacheKey: string, summary: GitDiffSummary): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildGitDiffClipboardText(summary));
      if (isMountedRef.current) setGitCopyState({ key: cacheKey, success: true });
    } catch {
      if (isMountedRef.current) setGitCopyState({ key: cacheKey, success: false });
    }

    if (gitCopyTimerRef.current) clearTimeout(gitCopyTimerRef.current);
    gitCopyTimerRef.current = setTimeout(() => {
      gitCopyTimerRef.current = null;
      if (isMountedRef.current) {
        setGitCopyState((current) => (current?.key === cacheKey ? null : current));
      }
    }, 1600);
  }

  const visibleGitFiles = activeGitFiles.slice(0, MAX_GIT_CHANGED_FILES);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable p-3">
        {isLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex items-center gap-2 text-xs text-accent-text">
              {projectGraphProgress ? (
                <>
                  <span>
                    {projectGraphProgress.phase === 'reading-files'
                      ? t.workspaceProjectGraphProgressFiles
                      : projectGraphProgress.phase === 'resolving-symbols'
                        ? t.workspaceProjectGraphProgressSymbols
                        : projectGraphProgress.phase === 'building'
                          ? t.workspaceProjectGraphProgressBuilding
                          : projectGraphProgress.phase === 'enriching'
                            ? t.workspaceProjectGraphProgressEnriching
                            : t.workspaceGitInitProgress}
                  </span>
                  {projectGraphProgress.total > 0 && (
                    <span className="inline-flex h-1.5 w-24 overflow-hidden rounded-full bg-raised">
                      <span
                        className="h-full rounded-full bg-accent transition-all duration-300"
                        style={{ width: `${Math.round((projectGraphProgress.current / projectGraphProgress.total) * 100)}%` }}
                      />
                    </span>
                  )}
                </>
              ) : (
                t.workspaceInsightsLoading
              )}
            </div>
            <div className="h-1 w-32 overflow-hidden rounded-full bg-raised">
              <div className="status-indicator-bar h-full w-8 rounded-full bg-accent-soft" />
            </div>
          </div>
        )}

        {!isLoading && prewarming && (
          <div className="rounded-xl border border-accent-soft bg-accent-soft px-3 py-3 text-xs leading-relaxed text-accent-text">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"></div>
              正在预热 LSP，逐个分析项目文件
              {prewarmingProgress && <span className="text-accent font-medium ml-1">{prewarmingProgress}</span>}
            </div>
            {prewarmingProgress && (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-base">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${(() => {
                    const [done, total] = prewarmingProgress.split('/').map(Number);
                    return total > 0 ? Math.round((done / total) * 100) : 0;
                  })()}%` }}
                />
              </div>
            )}
          </div>
        )}

        {debugLog.length > 0 && (
          <textarea
            readOnly
            value={debugLog.join('\n')}
            className="w-full rounded-xl border border-warn-bg bg-warn-bg px-3 py-2 text-[10px] leading-relaxed text-warn font-mono resize-none"
            rows={Math.min(debugLog.length, 10)}
          />
        )}

        {!isLoading && !prewarming && error && (
          <div className="rounded-xl border border-danger-bg bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
            {t.workspaceInsightsUnavailable}: {error}
          </div>
        )}

        {!isLoading && !error && (
          <div className="flex min-h-full flex-col space-y-3">
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-base p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-fg-muted">
                    {t.graphInsightsTitle}
                  </span>
                  {projectGraph?.truncated && (
                    <span className="text-[10px] text-warn">{t.workspaceProjectGraphTruncated}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRefreshVersion((value) => value + 1)}
                    disabled={isLoading}
                    className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t.workspaceInsightsRefresh}
                  </button>
                </div>
              </div>

              {!projectGraphInsights ? (
                <div className="mt-3 text-xs text-fg-dim">{t.workspaceProjectGraphEmpty}</div>
              ) : (
                <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable pr-1">
                  <InsightSection
                    title={t.graphInsightsCircular}
                    tip={t.graphInsightsCircularTip}
                    count={projectGraphInsights.circularDeps.total}
                    badgeClass="border border-danger-bg bg-danger-bg text-danger"
                  >
                    {projectGraphInsights.circularDeps.total === 0 ? (
                      <div className="px-1.5 text-[10px] text-fg-dim">{t.graphInsightsNone}</div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {projectGraphInsights.circularDeps.cycles.slice(0, 10).map((cycle, idx) => (
                          <button
                            key={`${cycle.files.join('|')}|${idx}`}
                            type="button"
                            onClick={() => handleInsightCycleClick(cycle)}
                            title={cycle.files.join(' → ')}
                            className={INSIGHT_ITEM_CLASS}
                          >
                            <span className="truncate">{cycle.files.map((f) => f.split('/').pop()).join(' → ')}</span>
                          </button>
                        ))}
                        {projectGraphInsights.circularDeps.total > 10 && (
                          <div className="px-1.5 text-[9px] text-fg-dim">+{projectGraphInsights.circularDeps.total - 10}</div>
                        )}
                      </div>
                    )}
                  </InsightSection>

                  <InsightSection
                    title={t.graphInsightsDeadCode}
                    tip={t.graphInsightsDeadCodeTip}
                    count={projectGraphInsights.deadCode.total}
                    badgeClass="border border-warn-bg bg-warn-bg text-warn"
                  >
                    {projectGraphInsights.deadCode.total === 0 && projectGraphInsights.deadCode.candidateTotal === 0 ? (
                      <div className="px-1.5 text-[10px] text-fg-dim">{t.graphInsightsNone}</div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {projectGraphInsights.deadCode.unusedSymbols.slice(0, 24).map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => handleInsightDeadCodeClick(s)}
                            title={`${s.path}:${s.line}`}
                            className={INSIGHT_ITEM_CLASS}
                          >
                            <span className="shrink-0 rounded bg-control px-1 text-[8px] uppercase text-fg-muted">{s.kind}</span>
                            <span className="truncate">{s.name}</span>
                            <span className="ml-auto shrink-0 text-[9px] text-fg-dim">{s.path.split('/').pop()}:L{s.line}</span>
                          </button>
                        ))}
                        {projectGraphInsights.deadCode.exportedCandidates.slice(0, 6).map((s) => (
                          <button
                            key={`export:${s.id}`}
                            type="button"
                            onClick={() => handleInsightDeadCodeClick(s)}
                            title={`${s.path}:${s.line} (${s.reason})`}
                            className={INSIGHT_ITEM_CLASS}
                          >
                            <span className="shrink-0 text-warn">★</span>
                            <span className="shrink-0 rounded bg-control px-1 text-[8px] uppercase text-fg-muted">{s.kind}</span>
                            <span className="truncate">{s.name}</span>
                            <span className="ml-auto shrink-0 text-[9px] text-fg-dim">{s.path.split('/').pop()}:L{s.line}</span>
                          </button>
                        ))}
                        {projectGraphInsights.deadCode.total > 24 && (
                          <div className="px-1.5 text-[9px] text-fg-dim">+{projectGraphInsights.deadCode.total - 24}</div>
                        )}
                      </div>
                    )}
                  </InsightSection>

                  <InsightSection
                    title={t.graphInsightsHubs}
                    tip={t.graphInsightsHubsTip}
                    count={projectGraphInsights.hubs.length}
                    badgeClass="border border-accent-soft bg-accent-soft text-accent-text"
                  >
                    {projectGraphInsights.hubs.length === 0 ? (
                      <div className="px-1.5 text-[10px] text-fg-dim">{t.graphInsightsNone}</div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {projectGraphInsights.hubs.map((hub) => (
                          <button
                            key={hub.nodeId}
                            type="button"
                            onClick={() => onSelectPath(hub.path)}
                            title={hub.path}
                            className={INSIGHT_ITEM_CLASS}
                          >
                            <span className="truncate">{hub.path}</span>
                            <span className="ml-auto shrink-0 text-[9px] text-fg-dim">{t.graphInsightsInDegree} {hub.inDegree}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </InsightSection>

                  <InsightSection
                    title={t.graphInsightsTestGaps}
                    tip={t.graphInsightsTestGapsTip}
                    count={projectGraphInsights.testGaps.length}
                    badgeClass="border border-orange-500/40 bg-orange-500/10 text-orange-300"
                  >
                    <InsightFileList
                      items={projectGraphInsights.testGaps.map((n) => ({ id: n.id, path: n.path }))}
                      emptyText={t.graphInsightsNone}
                      onPick={onSelectPath}
                    />
                  </InsightSection>

                  <InsightSection
                    title={t.graphInsightsOrphans}
                    tip={t.graphInsightsOrphansTip}
                    count={projectGraphInsights.orphans.length}
                    badgeClass="border border-line bg-raised text-fg-soft"
                  >
                    <InsightFileList
                      items={projectGraphInsights.orphans.map((n) => ({ id: n.id, path: n.path }))}
                      emptyText={t.graphInsightsNone}
                      onPick={onSelectPath}
                    />
                  </InsightSection>

                  <InsightSection
                    title={t.graphInsightsEntryPoints}
                    tip={t.graphInsightsEntryPointsTip}
                    count={projectGraphInsights.entryPoints.total}
                    badgeClass="border border-ok-bg bg-ok-bg text-ok"
                  >
                    <InsightFileList
                      items={projectGraphInsights.entryPoints.entries.map((e) => ({ id: e.nodeId, path: e.path }))}
                      emptyText={t.graphInsightsNone}
                      onPick={onSelectPath}
                    />
                  </InsightSection>
                </div>
              )}
            </div>

            {showGitPanel && (
              <div className="rounded-xl border border-line bg-base p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-muted">
                  {t.workspaceGit}
                </div>
              {gitStatus?.isRepo && gitStatus.branch && (
                  <span className="max-w-[150px] truncate rounded-full border border-ok-bg px-2 py-0.5 text-[10px] font-semibold text-ok">
                    {gitStatus.branch}
                  </span>
                )}
              </div>

              {!gitStatus && (
                <div className="mt-3 text-xs text-fg-dim">{t.workspaceInsightsUnavailable}</div>
              )}

              {gitStatus && !gitStatus.available && (
                <div className="mt-3 text-xs leading-relaxed text-fg-muted">
                  {gitStatus.message || t.workspaceGitUnavailable}
                </div>
              )}

              {gitStatus && gitStatus.available && !gitStatus.isRepo && (
                <div className="mt-3 space-y-2 rounded-lg border border-line bg-base px-3 py-3">
                  <div className="text-xs leading-relaxed text-fg-muted">
                    {gitStatus.message || t.workspaceGitNotRepo}
                  </div>
                  <div className="text-[11px] leading-relaxed text-fg-muted">{t.workspaceGitInitHint}</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void initializeGitRepository()}
                      disabled={isInitializingGit}
                      className="rounded-md border border-accent-soft px-2 py-1 text-[11px] text-accent-text transition-colors hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isInitializingGit ? t.workspaceGitInitRunning : t.workspaceGitInitRepo}
                    </button>
                    {gitActionMessage && (
                      <span className="text-[11px] text-fg-muted">{gitActionMessage}</span>
                    )}
                  </div>
                </div>
              )}

              {gitStatus && gitStatus.available && gitStatus.isRepo && gitStatus.repoRoot && (
                <div className="mt-3 rounded-lg border border-line bg-base px-3 py-2 text-[11px] text-fg-muted">
                  {t.workspaceGitRepoRoot}: {gitStatus.repoRoot}
                </div>
              )}

              {gitStatus && gitStatus.available && gitStatus.isRepo && gitStatus.files.length === 0 && (
                <div className="mt-3 text-xs text-fg-dim">{t.workspaceGitNoChanges}</div>
              )}

              {gitStatus && gitStatus.available && gitStatus.isRepo && gitStatus.files.length > 0 && (
                <>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setGitMode('unstaged');
                        setExpandedGitDiffKey(null);
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                        gitMode === 'unstaged'
                          ? 'border-accent-soft bg-accent-soft text-accent-text'
                          : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
                      }`}
                    >
                      <span>{t.workspaceGitUnstagedTab}</span>
                      <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[9px]">
                        {unstagedFiles.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGitMode('staged');
                        setExpandedGitDiffKey(null);
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                        gitMode === 'staged'
                          ? 'border-accent-soft bg-accent-soft text-accent-text'
                          : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
                      }`}
                    >
                      <span>{t.workspaceGitStagedTab}</span>
                      <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[9px]">
                        {stagedFiles.length}
                      </span>
                    </button>
                  </div>

                  {activeGitModeDiff.isLoading && (
                    <div className="mt-3 text-xs text-fg-dim">{t.workspaceGitLoading}</div>
                  )}

                  {!activeGitModeDiff.isLoading && activeGitModeDiff.summary?.stat && (
                    <div className="mt-3">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
                        {t.workspaceGitDiffStat}
                      </div>
                      <pre className="max-h-32 overflow-auto rounded-lg bg-base px-2 py-2 font-mono text-[10px] leading-5 text-fg-muted">
                        {activeGitModeDiff.summary.stat}
                      </pre>
                    </div>
                  )}

                  {!activeGitModeDiff.isLoading && visibleGitFiles.length === 0 && (
                    <div className="mt-3 text-xs text-fg-dim">
                      {gitMode === 'staged' ? t.workspaceGitNoStagedChanges : t.workspaceGitNoUnstagedChanges}
                    </div>
                  )}

                  {!activeGitModeDiff.isLoading && visibleGitFiles.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {visibleGitFiles.map((file) => {
                        const cacheKey = gitDiffCacheKey(gitMode, file.path);
                        const fileDiffState = gitFileDiffs[cacheKey] ?? createEmptyGitDiffLoadState();
                        const isExpanded = expandedGitDiffKey === cacheKey;
                        const rowLabel = gitFileLabel(file);
                        const copyLabel =
                          gitCopyState?.key === cacheKey
                            ? gitCopyState.success
                              ? t.workspaceGitCopyDone
                              : t.workspaceGitCopyFailed
                            : t.workspaceGitCopyDiff;

                        return (
                          <div
                            key={`${cacheKey}:${file.indexStatus}:${file.worktreeStatus}`}
                            className="rounded-lg border border-line bg-base"
                          >
                            <button
                              type="button"
                              onClick={() => toggleGitFileDiff(file)}
                              className={`grid w-full grid-cols-[42px_minmax(0,1fr)_42px] items-center gap-2 px-2 py-2 text-left text-[11px] transition-colors ${
                                selectedPath === file.path || isExpanded
                                  ? 'text-accent-text'
                                  : 'text-fg hover:text-fg'
                              }`}
                              title={rowLabel}
                            >
                              <span className="rounded border border-line px-1 py-0.5 text-center font-mono text-[9px] text-fg-muted">
                                {gitStatusCodeForMode(file, gitMode)}
                              </span>
                              <span className="truncate">{rowLabel}</span>
                              <span className="justify-self-end text-[10px] text-fg-muted">
                                {isExpanded ? t.workspaceGitCollapseDiff : t.workspaceGitExpandDiff}
                              </span>
                            </button>

                            {isExpanded && (
                              <div className="border-t border-line px-2 py-2">
                                {fileDiffState.isLoading && (
                                  <div className="text-xs text-fg-dim">{t.workspaceGitFileDiffLoading}</div>
                                )}

                                {!fileDiffState.isLoading && fileDiffState.error && (
                                  <div className="rounded-lg border border-danger-bg bg-danger-bg px-2 py-2 text-xs leading-relaxed text-danger">
                                    {t.workspaceGitFileDiffUnavailable}: {fileDiffState.error}
                                  </div>
                                )}

                                {!fileDiffState.isLoading && !fileDiffState.error && fileDiffState.summary && (
                                  <>
                                    <div className="mb-2 flex items-center justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() => onSelectPath(file.path)}
                                        className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                                      >
                                        {t.workspaceGitOpenFile}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void copyGitDiff(cacheKey, fileDiffState.summary!)}
                                        className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                                      >
                                        {copyLabel}
                                      </button>
                                    </div>

                                    {fileDiffState.summary.stat && (
                                      <div className="mb-2">
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
                                          {t.workspaceGitFileStat}
                                        </div>
                                        <pre className="overflow-x-auto rounded-lg bg-base px-2 py-2 font-mono text-[10px] leading-5 text-fg-muted">
                                          {fileDiffState.summary.stat}
                                        </pre>
                                      </div>
                                    )}

                                    {fileDiffState.summary.truncated && (
                                      <div className="mb-2 text-[10px] text-warn">{t.workspaceGitDiffTruncated}</div>
                                    )}

                                    {fileDiffState.summary.diff ? (
                                      <div>
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
                                          {t.workspaceGitDiffPreview}
                                        </div>
                                        <pre className="max-h-80 overflow-auto rounded-lg bg-base px-2 py-2 font-mono text-[10px] leading-5 text-fg-muted">
                                          {fileDiffState.summary.diff}
                                        </pre>
                                      </div>
                                    ) : (
                                      <div className="text-xs text-fg-dim">
                                        {fileDiffState.summary.message || t.workspaceGitFileDiffEmpty}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!activeGitModeDiff.isLoading && activeGitModeDiff.summary?.message && (
                    <div className="mt-3 text-xs leading-relaxed text-fg-muted">
                      {activeGitModeDiff.summary.message}
                    </div>
                  )}
                </>
              )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
