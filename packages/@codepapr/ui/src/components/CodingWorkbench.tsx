import { errorMessage } from '@codepapr/common';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { SplitPane } from './SplitPane';
import { WorkspaceInsightPanel } from './WorkspaceInsightPanel';
import { AppDockPanel } from './AppDockPanel';
import { getTranslation } from '../utils/i18n';

// Code-split: only rendered when previewPlacement === 'split', and the code
// preview pulls in Monaco-flavored syntax highlighting and large helpers.
const CodePreviewPanel = lazy(() =>
  import('./CodePreviewPanel').then((m) => ({ default: m.CodePreviewPanel }))
);
import {
  buildFileTree,
  collectAncestorDirectories,
  collectDirectoryPaths,
  flattenVisibleFileTree,
  hasSamePathSet,
  type FileTreeNode,
  type VisibleFileTreeRow,
} from '../utils/fileTree';
import { type GitFileSelection } from '../utils/workspaceGitPanel';
import { clearLanguageIntelligenceWorkspace } from '../utils/languageIntelligence';
import type { PreviewLocation } from '../utils/projectDiagnosticLocations';
import { hasAnyProjectMapCandidate } from '../tools/workspaceToolUtils';

interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
  hasChildren?: boolean;
}

interface ListFilesResult {
  root: string;
  entries: FileEntry[];
  truncated: boolean;
}

// 初始加载深度：根 + 5 层（兼顾 ProjectGraph 候选检测）；更深目录按需懒加载。
const INITIAL_TREE_MAX_DEPTH = 6;
// 懒加载单个目录时的遍历深度（目录本身 + 两层子项）。
const LAZY_DIR_MAX_DEPTH = 2;

// 合并浅层扫描与各懒加载目录子树为一张扁平条目表（按 path 去重）。
function mergeFlatFileEntries(
  shallow: readonly FileEntry[],
  dirBuckets: Readonly<Record<string, readonly FileEntry[]>>
): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const entry of shallow) {
    byPath.set(entry.path, entry);
  }
  for (const bucket of Object.values(dirBuckets)) {
    for (const entry of bucket) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TreeChevronIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`h-3.5 w-3.5 flex-shrink-0 text-slate-500 transition-transform ${
        isExpanded ? 'rotate-90 text-slate-300' : ''
      }`}
    >
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function FolderIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 flex-shrink-0">
      <path
        d="M1.75 4.75A1.75 1.75 0 0 1 3.5 3h2.15c.46 0 .9.183 1.226.51l.764.764c.14.14.33.219.528.219h4.327A1.75 1.75 0 0 1 14.25 6.25v.6H1.75z"
        fill={isExpanded ? '#cda56a' : '#b8894d'}
      />
      <path
        d="M1.75 6.1h12.5v5.15A1.75 1.75 0 0 1 12.5 13H3.5a1.75 1.75 0 0 1-1.75-1.75z"
        fill={isExpanded ? '#e5c48a' : '#d2a96b'}
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 flex-shrink-0">
      <path d="M4 1.75h5.2l2.8 2.8v9.7H4z" fill="#c7d0de" opacity="0.24" />
      <path d="M4 1.75h5.2l2.8 2.8v9.7H4z" fill="none" stroke="#c7d0de" strokeWidth="1" />
      <path d="M9.2 1.75v2.8H12" fill="none" stroke="#c7d0de" strokeWidth="1" />
    </svg>
  );
}

interface FileTreeRowProps {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  activePath: string | null;
  expandedDirectorySet: ReadonlySet<string>;
  registerRowRef: (path: string, element: HTMLButtonElement | null) => void;
  onFocusPath: (path: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, path: string) => void;
  onActivatePath: (path: string) => void;
  onSelectPath: (path: string) => void;
  onToggleDirectory: (path: string) => void;
}

function FileTreeRow({
  node,
  depth,
  selectedPath,
  activePath,
  expandedDirectorySet,
  registerRowRef,
  onFocusPath,
  onKeyDown,
  onActivatePath,
  onSelectPath,
  onToggleDirectory,
}: FileTreeRowProps) {
  const isSelected = !node.isDir && selectedPath === node.path;
  const isActive = activePath === node.path;
  const isExpanded = node.isDir && expandedDirectorySet.has(node.path);

  return (
    <div>
      <button
        type="button"
        ref={(element) => registerRowRef(node.path, element)}
        onClick={() => {
          onActivatePath(node.path);

          if (node.isDir) {
            onToggleDirectory(node.path);
            return;
          }

          onSelectPath(node.path);
        }}
        onFocus={() => onFocusPath(node.path)}
        onKeyDown={(event) => onKeyDown(event, node.path)}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={node.isDir ? isExpanded : undefined}
        aria-selected={!node.isDir ? isSelected : undefined}
        tabIndex={isActive ? 0 : -1}
        title={node.path}
        className={`group flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] leading-none transition-colors focus:outline-none ${
          isSelected
            ? 'bg-[#114a88] text-slate-50 shadow-[inset_2px_0_0_0_rgba(191,219,254,0.95),inset_0_0_0_1px_rgba(96,165,250,0.42)]'
            : isActive
            ? 'bg-[#1a2232] text-slate-100 shadow-[inset_2px_0_0_0_rgba(148,163,184,0.45)]'
            : node.isDir
            ? 'text-slate-200 hover:bg-[#171c29]'
            : 'text-slate-300 hover:bg-[#171c29] hover:text-slate-100'
        } ${isActive ? 'ring-1 ring-sky-400/55 ring-inset' : ''} focus-visible:ring-1 focus-visible:ring-sky-300/80 focus-visible:ring-inset`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {node.isDir && (node.children.length > 0 || node.hasChildren) ? (
            <TreeChevronIcon isExpanded={isExpanded} />
          ) : (
            <span className="h-3.5 w-3.5" />
          )}
        </span>
        {node.isDir ? <FolderIcon isExpanded={isExpanded} /> : <FileIcon />}
        <span className={`min-w-0 truncate ${node.isDir ? 'font-medium text-slate-100' : ''}`}>
          {node.name}
        </span>
      </button>

      {node.isDir && isExpanded && node.children.length > 0 && (
        <div>
          {node.children.map((childNode) => (
            <FileTreeRow
              key={childNode.path}
              node={childNode}
              depth={depth + 1}
              selectedPath={selectedPath}
              activePath={activePath}
              expandedDirectorySet={expandedDirectorySet}
              registerRowRef={registerRowRef}
              onFocusPath={onFocusPath}
              onKeyDown={onKeyDown}
              onActivatePath={onActivatePath}
              onSelectPath={onSelectPath}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CodingWorkbenchProps {
  selectedPath: string | null;
  selectedGitFile: GitFileSelection | null;
  selectedLocation?: PreviewLocation | null;
  hideWorkspaceHeader?: boolean;
  hideProjectSummary?: boolean;
  previewPlacement?: 'split' | 'hidden';
  onSelectPath: (path: string | null) => void;
  onNavigateToLocation?: (location: PreviewLocation) => void;
}

type HiddenSidebarTab = 'tree' | 'projectgraph' | 'apps';

export function CodingWorkbench({
  selectedPath,
  selectedGitFile,
  selectedLocation,
  hideWorkspaceHeader = false,
  hideProjectSummary = false,
  previewPlacement = 'split',
  onSelectPath,
  onNavigateToLocation,
}: CodingWorkbenchProps) {
  const settings = useAgentStore((state) => state.settings);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const openWorkspace = useAgentStore((state) => state.openWorkspace);
  const t = getTranslation(settings.lang);
  const appCount = useAppRuntimeStore((state) => state.apps.length);
  const appMountSignal = useAppRuntimeStore((state) => state.mountSignal);
  const [shallowEntries, setShallowEntries] = useState<FileEntry[]>([]);
  const [dirEntries, setDirEntries] = useState<Record<string, FileEntry[]>>({});
  const [loadedDirectories, setLoadedDirectories] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(selectedPath);
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [hiddenSidebarTab, setHiddenSidebarTab] = useState<HiddenSidebarTab>('tree');
  const [projectGraphProgress, setProjectGraphProgress] = useState<{ phase: string; current: number; total: number } | null>(null);
  const [projectGraphLoading, setProjectGraphLoading] = useState(false);
  const [isWorkspaceSwitching, setIsWorkspaceSwitching] = useState(false);
  const workspaceSwitchingPathRef = useRef<string | null>(null);
  const workspaceSwitchingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 始终指向最新 workspacePath（懒加载在飞响应用它做取消守卫；闭包捕获的
  // workspacePath 在切换后仍是旧值，无法比较）。
  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;
  const isInitialGraphLoadRef = useRef(true);
  const graphLoadStartedRef = useRef(false);
  const graphLoadSawLoadingRef = useRef(false);
  const projectGraphLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultHealAttemptedRef = useRef<string | null>(null);
  const [isInitialGraphPreload, setIsInitialGraphPreload] = useState(false);
  const loadedDirectoriesRef = useRef<string[]>([]);
  const expandedDirectoriesRef = useRef<string[]>([]);
  const shallowEntriesRef = useRef<FileEntry[]>([]);
  const dirEntriesRef = useRef<Record<string, FileEntry[]>>({});

  useEffect(() => {
    expandedDirectoriesRef.current = expandedDirectories;
  }, [expandedDirectories]);

  useEffect(() => {
    loadedDirectoriesRef.current = loadedDirectories;
  }, [loadedDirectories]);

  useEffect(() => {
    if (appMountSignal > 0) {
      setHiddenSidebarTab('apps');
    }
  }, [appMountSignal]);

  const handleProjectGraphProgress = useCallback((progress: { phase: string; current: number; total: number } | null, isLoading: boolean) => {
    setProjectGraphProgress(progress);
    setProjectGraphLoading(isLoading);
    if (isInitialGraphLoadRef.current) {
      if (isLoading) {
        graphLoadStartedRef.current = true;
        graphLoadSawLoadingRef.current = true;
        useAgentStore.getState().setProjectGraphLoading(true, progress ?? undefined);
      } else if (graphLoadSawLoadingRef.current) {
        // 仅当本回调确实观察到过 isLoading=true（即 effectiveLoading 真正点亮过，
        // 含 prewarming/loadingInProgress）后才 finalize。否则挂载初期 effectiveLoading
        // 会短暂为 false（prewarming/loadingInProgress 的状态更新尚未应用），若此时提前
        // 关闭遮罩，LSP 预热会在遮罩关闭后继续运行造成卡顿。
        isInitialGraphLoadRef.current = false;
        graphLoadStartedRef.current = false;
        graphLoadSawLoadingRef.current = false;
        useAgentStore.getState().setProjectGraphLoading(false);
        setIsInitialGraphPreload(false);
      }
    }
  }, []);

  const projectName = workspacePath ? basename(workspacePath) : t.unselected;
  const entries = useMemo(
    () => mergeFlatFileEntries(shallowEntries, dirEntries),
    [shallowEntries, dirEntries]
  );
  const fileCount = useMemo(() => entries.filter((entry) => !entry.isDir).length, [entries]);
  const directoryCount = useMemo(() => entries.filter((entry) => entry.isDir).length, [entries]);
  const treeNodes = useMemo(() => buildFileTree(entries), [entries]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(entries), [entries]);
  const expandedDirectorySet = useMemo(() => new Set(expandedDirectories), [expandedDirectories]);
  const visibleRows = useMemo(
    () => flattenVisibleFileTree(treeNodes, expandedDirectorySet),
    [treeNodes, expandedDirectorySet]
  );
  const visibleRowIndexByPath = useMemo(
    () => new Map(visibleRows.map((row, index) => [row.path, index])),
    [visibleRows]
  );
  const entryByPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const previewPrewarmPaths = useMemo(() => {
    const nextPaths: string[] = [];
    const seen = new Set<string>();

    if (selectedPath) {
      seen.add(selectedPath);
      nextPaths.push(selectedPath);
    }

    for (const row of visibleRows) {
      if (row.isDir || seen.has(row.path)) {
        continue;
      }

      const entry = entryByPath.get(row.path);
      if (!entry || entry.bytes > 300_000) {
        continue;
      }

      seen.add(row.path);
      nextPaths.push(row.path);
      if (nextPaths.length >= 12) {
        break;
      }
    }

    return nextPaths;
  }, [entryByPath, selectedPath, visibleRows]);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousWorkspacePathRef = useRef<string | null>(null);
  const pendingFocusPathRef = useRef<string | null>(null);
  const pendingFocusBehaviorRef = useRef<ScrollBehavior>('auto');
  const lastTreeSignatureRef = useRef('');

  const computeTreeSignature = useCallback((result: ListFilesResult): string => {
    const entries = result?.entries ?? [];
    const normalizedEntries = [...entries].sort((left, right) => {
      if (left.path === right.path) {
        return 0;
      }
      return left.path < right.path ? -1 : 1;
    });

    return `${result?.truncated ? '1' : '0'}|${normalizedEntries
      .map((entry) => `${entry.path}|${entry.isDir ? 'd' : 'f'}|${entry.bytes}`)
      .join('||')}`;
  }, []);

  const loadProject = useCallback(async (path: string) => {
    setFolderError('');
    setTreeTruncated(false);
    loadedDirectoriesRef.current = [];
    dirEntriesRef.current = {};
    setLoadedDirectories([]);
    setDirEntries({});

    if (!path) {
      shallowEntriesRef.current = [];
      setShallowEntries([]);
      return;
    }

    shallowEntriesRef.current = [];
    setShallowEntries([]);
    setIsLoadingTree(true);
    try {
      const result = await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath: path,
        maxDepth: INITIAL_TREE_MAX_DEPTH,
      });
      lastTreeSignatureRef.current = computeTreeSignature({ root: result.root, entries: result.entries, truncated: result.truncated });
      shallowEntriesRef.current = result.entries;
      setShallowEntries(result.entries);
      setTreeTruncated(result.truncated);
    } catch (err) {
      shallowEntriesRef.current = [];
      setShallowEntries([]);
      setFolderError(errorMessage(err));
    } finally {
      setIsLoadingTree(false);
    }
  }, [computeTreeSignature]);

  useEffect(() => {
    void loadProject(workspacePath);
  }, [loadProject, workspacePath]);

  // 自愈：若当前打开的正是默认项目，且它在运行期间被删除（loadProject 报错），
  // 调用 ensure_default_project 重建文件夹后重新加载。仅对默认项目生效，避免误
  // 重建用户的真实项目；同一 workspace 仅在报错期间尝试一次，错误清除后复位。
  useEffect(() => {
    if (!folderError) {
      defaultHealAttemptedRef.current = null;
      return;
    }
    if (!workspacePath) return;
    if (defaultHealAttemptedRef.current === workspacePath) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await invoke<{ path: string }>('ensure_default_project');
        if (cancelled) return;
        const defaultPath = result?.path?.trim() ?? '';
        if (!defaultPath || defaultPath !== workspacePath) return;
        defaultHealAttemptedRef.current = workspacePath;
        await loadProject(workspacePath);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderError, workspacePath, loadProject]);

  useEffect(() => {
    isInitialGraphLoadRef.current = true;
    graphLoadStartedRef.current = false;
    graphLoadSawLoadingRef.current = false;
    setIsInitialGraphPreload(false);
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) {
      lastTreeSignatureRef.current = '';
      return;
    }

    let disposed = false;
    let inFlight = false;

    const refreshFromWatcher = async () => {
      if (disposed || inFlight || document.hidden) {
        return;
      }

      inFlight = true;
      try {
        // 浅层全量刷新 + 并行重取所有“已展开且已加载”目录，保证可见子树内容新鲜；
        // 已加载但折叠的目录保留缓存，重新展开时再取（toggleDirectory 每次展开都会拉取）。
        const expandedLoadedDirs = loadedDirectoriesRef.current.filter((dir) =>
          expandedDirectoriesRef.current.includes(dir)
        );

        const [shallowResult, ...subtreeResults] = await Promise.all([
          invoke<ListFilesResult>('list_workspace_files', {
            workspacePath,
            maxDepth: INITIAL_TREE_MAX_DEPTH,
          }),
          ...expandedLoadedDirs.map((dir) =>
            invoke<ListFilesResult>('list_workspace_files', {
              workspacePath,
              relativePath: dir,
              maxDepth: LAZY_DIR_MAX_DEPTH,
            })
          ),
        ]);

        if (disposed) {
          return;
        }

        if (!shallowResult || !Array.isArray(shallowResult.entries)) {
          return;
        }

        const nextShallow = shallowResult.entries;
        const nextDirEntries: Record<string, FileEntry[]> = {};
        expandedLoadedDirs.forEach((dir, index) => {
          const subResult = subtreeResults[index];
          if (subResult && Array.isArray(subResult.entries)) {
            nextDirEntries[dir] = subResult.entries;
          }
        });
        const mergedDirEntries = { ...dirEntriesRef.current, ...nextDirEntries };
        const mergedEntries = mergeFlatFileEntries(nextShallow, mergedDirEntries);
        const nextTruncated =
          Boolean(shallowResult.truncated) ||
          subtreeResults.some((subResult) => Boolean(subResult?.truncated));

        const nextSignature = computeTreeSignature({
          root: '',
          entries: mergedEntries,
          truncated: nextTruncated,
        });
        if (nextSignature === lastTreeSignatureRef.current) {
          return;
        }

        lastTreeSignatureRef.current = nextSignature;
        // N4：原生层文件变化（git 面板操作、外部编辑器等未走 agent 写入
        // 通道的改动）也必须 bump mutation version，让已打开文件的预览与
        // 预暖按 version 失效重读。无路径列表：不调度后台诊断/自动修复
        // （agent 写入路径已单独调度），避免外部编辑器每次保存触发全量诊断。
        useAgentStore.getState().noteWorkspaceMutation(undefined, {
          scheduleDiagnostics: false,
          autoRepair: false,
        });
        shallowEntriesRef.current = nextShallow;
        dirEntriesRef.current = mergedDirEntries;
        setFolderError('');
        setShallowEntries(nextShallow);
        setDirEntries(mergedDirEntries);
        setTreeTruncated(nextTruncated);
      } catch (e) {
        console.warn('File watcher refresh failed:', e);
      } finally {
        inFlight = false;
      }
    };

    const handleWindowFocus = () => {
      void refreshFromWatcher();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshFromWatcher();
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Native OS-level file watcher: emits `workspace-files-changed` whenever
    // something under the workspace changes, replacing the old 1.5s polling
    // loop that kept the process perpetually active (macOS "后台运行").
    let unlisten: (() => void) | null = null;
    void invoke('start_workspace_watcher', { workspacePath }).catch((e) => {
      console.warn('Failed to start workspace watcher:', e);
    });
    void listen<void>('workspace-files-changed', () => {
      void refreshFromWatcher();
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });

    void refreshFromWatcher();

    return () => {
      disposed = true;
      unlisten?.();
      void invoke('stop_workspace_watcher').catch(() => {});
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [computeTreeSignature, workspacePath]);

  useEffect(() => {
    if (workspacePath === workspaceSwitchingPathRef.current) {
      return;
    }
    workspaceSwitchingPathRef.current = workspacePath;
    if (workspaceSwitchingTimerRef.current) {
      clearTimeout(workspaceSwitchingTimerRef.current);
      workspaceSwitchingTimerRef.current = null;
    }
    if (workspacePath) {
      setIsWorkspaceSwitching(true);
      shallowEntriesRef.current = [];
      dirEntriesRef.current = {};
      loadedDirectoriesRef.current = [];
      setShallowEntries([]);
      setDirEntries({});
      setLoadedDirectories([]);
      workspaceSwitchingTimerRef.current = setTimeout(() => {
        setIsWorkspaceSwitching(false);
      }, 30_000);
    } else {
      setIsWorkspaceSwitching(false);
    }
    return () => {
      // 卸载时清理：否则陈旧定时器会对已卸载组件 setState。
      if (workspaceSwitchingTimerRef.current) {
        clearTimeout(workspaceSwitchingTimerRef.current);
        workspaceSwitchingTimerRef.current = null;
      }
    };
  }, [workspacePath]);

  const canStartProjectGraph = !isLoadingTree && hasAnyProjectMapCandidate(entries) && !!workspacePath;

  useEffect(() => {
    if (canStartProjectGraph && isInitialGraphLoadRef.current) {
      setIsInitialGraphPreload(true);
      graphLoadStartedRef.current = true;
      useAgentStore.getState().setProjectGraphLoading(true);

      // 安全超时：如果 15 秒内 handleProjectGraphProgress 没有回调 false，
      // 强制关闭 loading 浮层，防止 UI 永久卡住。
      if (projectGraphLoadTimeoutRef.current) {
        clearTimeout(projectGraphLoadTimeoutRef.current);
      }
      projectGraphLoadTimeoutRef.current = setTimeout(() => {
        if (useAgentStore.getState().projectGraphLoading) {
          console.warn('[CodePapr] projectGraphLoading 超时 15s，强制关闭');
          isInitialGraphLoadRef.current = false;
          graphLoadStartedRef.current = false;
          graphLoadSawLoadingRef.current = false;
          setIsInitialGraphPreload(false);
          useAgentStore.getState().setProjectGraphLoading(false);
        }
      }, 15_000);
    } else if (!canStartProjectGraph && graphLoadStartedRef.current) {
      graphLoadStartedRef.current = false;
      isInitialGraphLoadRef.current = false;
      setIsInitialGraphPreload(false);
      useAgentStore.getState().setProjectGraphLoading(false);
      if (projectGraphLoadTimeoutRef.current) {
        clearTimeout(projectGraphLoadTimeoutRef.current);
        projectGraphLoadTimeoutRef.current = null;
      }
    }
    return () => {
      // 卸载时清理：否则陈旧回调会强制清掉新实例的 loading 标志。
      if (projectGraphLoadTimeoutRef.current) {
        clearTimeout(projectGraphLoadTimeoutRef.current);
        projectGraphLoadTimeoutRef.current = null;
      }
    };
  }, [canStartProjectGraph]);

  useEffect(() => {
    if (isWorkspaceSwitching && !isLoadingTree) {
      if (workspaceSwitchingTimerRef.current) {
        clearTimeout(workspaceSwitchingTimerRef.current);
        workspaceSwitchingTimerRef.current = null;
      }
      setIsWorkspaceSwitching(false);
    }
  }, [isWorkspaceSwitching, isLoadingTree, entries.length]);

  useEffect(() => {
    const previousWorkspacePath = previousWorkspacePathRef.current;
    if (previousWorkspacePath && previousWorkspacePath !== workspacePath) {
      clearLanguageIntelligenceWorkspace(previousWorkspacePath);
    }
    previousWorkspacePathRef.current = workspacePath || null;
  }, [workspacePath]);

  useEffect(() => {
    if (selectedPath) {
      setActivePath(selectedPath);
      return;
    }

    setActivePath((current) => current ?? visibleRows[0]?.path ?? null);
  }, [selectedPath, visibleRows]);

  useEffect(() => {
    const directoryPathSet = new Set(directoryPaths);

    setExpandedDirectories((current) => {
      const nextPaths = current.filter((path) => directoryPathSet.has(path));

      if (selectedPath) {
        for (const ancestorPath of collectAncestorDirectories(selectedPath)) {
          if (directoryPathSet.has(ancestorPath) && !nextPaths.includes(ancestorPath)) {
            nextPaths.push(ancestorPath);
          }
        }
      }

      return hasSamePathSet(current, nextPaths) ? current : nextPaths;
    });
  }, [directoryPaths, selectedPath]);

  useEffect(() => {
    if (activePath && visibleRowIndexByPath.has(activePath)) {
      return;
    }

    setActivePath(selectedPath && visibleRowIndexByPath.has(selectedPath) ? selectedPath : visibleRows[0]?.path ?? null);
  }, [activePath, selectedPath, visibleRowIndexByPath, visibleRows]);

  useEffect(() => {
    if (!selectedPath || !visibleRowIndexByPath.has(selectedPath)) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const row = rowRefs.current.get(selectedPath);
      row?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [selectedPath, visibleRowIndexByPath]);

  useEffect(() => {
    if (!activePath || pendingFocusPathRef.current !== activePath) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const row = rowRefs.current.get(activePath);
      if (!row) {
        return;
      }

      row.focus({ preventScroll: true });
      row.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: pendingFocusBehaviorRef.current,
      });
      pendingFocusPathRef.current = null;
      pendingFocusBehaviorRef.current = 'auto';
    });

    return () => cancelAnimationFrame(frame);
  }, [activePath, visibleRows]);

  const registerRowRef = useCallback((path: string, element: HTMLButtonElement | null) => {
    if (element) {
      rowRefs.current.set(path, element);
      return;
    }

    rowRefs.current.delete(path);
  }, []);

  const requestPathFocus = useCallback((path: string | null, behavior: ScrollBehavior = 'smooth') => {
    if (!path) {
      return;
    }

    pendingFocusPathRef.current = path;
    pendingFocusBehaviorRef.current = behavior;
    setActivePath(path);
  }, []);

  const loadDirectoryChildren = useCallback(async (dir: string) => {
    if (!workspacePath) {
      return;
    }
    const capturedPath = workspacePath;
    try {
      const result = await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath: capturedPath,
        relativePath: dir,
        maxDepth: LAZY_DIR_MAX_DEPTH,
      });
      // 取消守卫：await 期间用户切换了工作区 → 旧目录的迟到响应必须丢弃。
      // 旧实现无守卫，旧工作区的在飞加载结果会无条件 merge 进新树，
      // 跨工作区数据互相污染（目录、truncated 标志、tree 签名全部错乱）。
      if (capturedPath !== workspacePathRef.current) {
        return;
      }
      const nextDirEntries: Record<string, FileEntry[]> = {
        ...dirEntriesRef.current,
        [dir]: result?.entries ?? [],
      };
      dirEntriesRef.current = nextDirEntries;
      if (!loadedDirectoriesRef.current.includes(dir)) {
        loadedDirectoriesRef.current = [...loadedDirectoriesRef.current, dir];
      }
      setDirEntries(nextDirEntries);
      setLoadedDirectories([...loadedDirectoriesRef.current]);
      if (result?.truncated) {
        setTreeTruncated(true);
      }
      const mergedEntries = mergeFlatFileEntries(shallowEntriesRef.current, nextDirEntries);
      lastTreeSignatureRef.current = computeTreeSignature({
        root: '',
        entries: mergedEntries,
        truncated: Boolean(result?.truncated),
      });
    } catch (err) {
      setFolderError(errorMessage(err));
    }
  }, [computeTreeSignature, workspacePath]);

  const toggleDirectory = useCallback(async (path: string) => {
    const isExpanded = expandedDirectories.includes(path);
    const hasVisibleChildren = entries.some(
      (entry) => entry.path !== path && entry.path.startsWith(`${path}/`)
    );
    const isLoaded = loadedDirectories.includes(path);
    const entry = entryByPath.get(path);
    const isKnownEmpty = entry?.hasChildren === false && !hasVisibleChildren;

    if (isExpanded && (isLoaded || hasVisibleChildren || isKnownEmpty)) {
      setExpandedDirectories((current) => current.filter((currentPath) => currentPath !== path));
      return;
    }

    if (isExpanded || isLoaded) {
      await loadDirectoryChildren(path);
    } else if (hasVisibleChildren || isKnownEmpty) {
      setExpandedDirectories((current) => (current.includes(path) ? current : [...current, path]));
      return;
    } else {
      await loadDirectoryChildren(path);
    }
    setExpandedDirectories((current) => (current.includes(path) ? current : [...current, path]));
  }, [entries, entryByPath, expandedDirectories, loadedDirectories, loadDirectoryChildren]);

  const handleTreeRowKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    path: string
  ) => {
    const currentRowIndex = visibleRowIndexByPath.get(path);
    if (currentRowIndex === undefined) {
      return;
    }

    const currentRow = visibleRows[currentRowIndex] as VisibleFileTreeRow;
    const nextRow = visibleRows[currentRowIndex + 1] ?? null;
    const previousRow = visibleRows[currentRowIndex - 1] ?? null;
    const isExpanded = currentRow.isDir && expandedDirectorySet.has(currentRow.path);

    switch (event.key) {
      case 'ArrowDown':
        if (!nextRow) return;
        event.preventDefault();
        requestPathFocus(nextRow.path);
        return;
      case 'ArrowUp':
        if (!previousRow) return;
        event.preventDefault();
        requestPathFocus(previousRow.path);
        return;
      case 'ArrowRight':
        if (!currentRow.isDir) {
          return;
        }

        event.preventDefault();
        if (!isExpanded && currentRow.hasChildren) {
          toggleDirectory(currentRow.path);
          return;
        }

        if (nextRow && nextRow.parentPath === currentRow.path) {
          requestPathFocus(nextRow.path);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (currentRow.isDir && isExpanded && currentRow.hasChildren) {
          toggleDirectory(currentRow.path);
          return;
        }

        if (currentRow.parentPath) {
          requestPathFocus(currentRow.parentPath);
        }
        return;
      case 'Home':
        if (!visibleRows[0]) return;
        event.preventDefault();
        requestPathFocus(visibleRows[0].path);
        return;
      case 'End':
        if (!visibleRows[visibleRows.length - 1]) return;
        event.preventDefault();
        requestPathFocus(visibleRows[visibleRows.length - 1].path);
        return;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (currentRow.isDir) {
          toggleDirectory(currentRow.path);
          return;
        }

        onSelectPath(currentRow.path);
        requestPathFocus(currentRow.path, 'auto');
        return;
      }
      default:
        return;
    }
  }, [expandedDirectorySet, onSelectPath, requestPathFocus, toggleDirectory, visibleRowIndexByPath, visibleRows]);

  const chooseFolder = async () => {
    setFolderError('');
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t.projectFolder,
      });
      if (typeof selected === 'string') {
        await openWorkspace(selected);
      }
    } catch (err) {
      setFolderError(`${t.openFolderFailed}: ${errorMessage(err)}`);
    }
  };

  const fileTreeContent = (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-2 py-2" role="tree" aria-label={t.fileTree}>
      {isLoadingTree && entries.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-slate-500">
          <span>{t.loadingProject}</span>
          <span className="inline-flex h-1 w-16 overflow-hidden rounded-full bg-[#1a1f2b]">
            <span className="status-indicator-bar h-full w-3 rounded-full bg-indigo-500/60" />
          </span>
        </div>
      )}
      {!isLoadingTree && entries.length === 0 && (
        <div className="px-2 py-6 text-center text-xs text-slate-600">{t.noFiles}</div>
      )}
      {treeNodes.map((node) => (
        <FileTreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          activePath={activePath}
          expandedDirectorySet={expandedDirectorySet}
          registerRowRef={registerRowRef}
          onFocusPath={setActivePath}
          onKeyDown={handleTreeRowKeyDown}
          onActivatePath={setActivePath}
          onSelectPath={onSelectPath}
          onToggleDirectory={toggleDirectory}
        />
      ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col select-none">
      {!hideWorkspaceHeader && (
        <div className="border-b border-[#2a2d3a] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-300">{t.workbench}</h2>
              <p className="mt-0.5 truncate text-[11px] text-slate-600">{workspacePath || t.projectEmptyDesc}</p>
            </div>
            <button
              type="button"
              onClick={chooseFolder}
              title={workspacePath ? t.changeFolderTip : t.selectFolderTip}
              className="h-8 flex-shrink-0 rounded-lg border border-indigo-500/40 px-2.5 text-xs font-medium text-indigo-200
                         transition-colors hover:border-indigo-400 hover:text-white"
            >
              {workspacePath ? t.changeFolder : t.selectFolder}
            </button>
          </div>
        </div>
      )}

      {!workspacePath ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-slate-500">
          <div className="text-sm font-semibold text-slate-300">{t.projectEmptyTitle}</div>
            <p className="mt-2 max-w-[260px] text-xs leading-relaxed text-slate-600">{t.projectEmptyDesc}</p>
          <button
            type="button"
            onClick={chooseFolder}
            className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-500"
          >
            {t.selectFolder}
          </button>
          {folderError && <p className="mt-3 text-xs text-red-300">{folderError}</p>}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {(isWorkspaceSwitching || (isLoadingTree && entries.length === 0)) && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0f1117]/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-10 py-8 shadow-2xl">
                <div className="text-sm font-semibold text-slate-200">{t.workspaceInitLoading}</div>
                <div className="flex flex-col items-center gap-2">
                   <span className="text-[11px] text-indigo-300">
                     {isLoadingTree
                       ? t.loadingProject
                       : settings.debugEnabled && projectGraphProgress
                         ? projectGraphProgress.phase === 'reading-files'
                           ? t.workspaceProjectGraphProgressFiles
                           : projectGraphProgress.phase === 'resolving-symbols'
                             ? t.workspaceProjectGraphProgressSymbols
                             : projectGraphProgress.phase === 'building'
                               ? t.workspaceProjectGraphProgressBuilding
                               : projectGraphProgress.phase === 'enriching'
                                 ? t.workspaceProjectGraphProgressEnriching
                                 : t.workspaceGitInitProgress
                         : t.workspaceInsightsLoading}
                  </span>
                  <div className="h-1.5 w-48 overflow-hidden rounded-full bg-[#1a1f2b]">
                    <div className="status-indicator-bar h-full w-10 rounded-full bg-indigo-500/70" />
                  </div>
                </div>
              </div>
            </div>
          )}
          {!hideProjectSummary && (
            <div className="border-b border-[#2a2d3a] px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-200">{projectName}</div>
                  <div className="mt-0.5 text-[10px] text-slate-600">
                    {directoryCount} {t.directoriesLabel} · {fileCount} {t.filesLabel}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isLoadingTree && (
                    <span className="text-[10px] text-slate-500">{t.loadingProject}</span>
                  )}
                   {settings.debugEnabled && projectGraphLoading && !projectGraphProgress && (
                    <span className="flex items-center gap-1.5 text-[10px] text-indigo-400">
                      <span>{t.workspaceInsightsLoading}</span>
                      <span className="inline-flex h-1 w-12 overflow-hidden rounded-full bg-[#1a1f2b]">
                        <span className="status-indicator-bar h-full w-3 rounded-full bg-indigo-500/60" />
                      </span>
                    </span>
                  )}
                   {settings.debugEnabled && projectGraphLoading && projectGraphProgress && (
                    <span className="flex items-center gap-1.5 text-[10px] text-indigo-400">
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
                        <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-[#1a1f2b]">
                          <span
                            className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${Math.round((projectGraphProgress.current / projectGraphProgress.total) * 100)}%` }}
                          />
                        </span>
                      )}
                    </span>
                  )}
                  <span className="flex-shrink-0 rounded-full border border-green-500/40 px-2 py-0.5 text-[10px] font-semibold text-green-300">
                    {t.projectLoaded}
                  </span>
                </div>
              </div>
              {folderError && <div className="mt-2 text-xs text-red-300">{folderError}</div>}
              {treeTruncated && <div className="mt-2 text-xs text-amber-300">{t.fileTreeTruncated}</div>}
            </div>
          )}

          {previewPlacement === 'hidden' ? (
            <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#10141d]">
              <div className="flex items-center justify-between border-b border-[#2a2d3a] px-4 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setHiddenSidebarTab('tree')}
                    aria-pressed={hiddenSidebarTab === 'tree'}
                     className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                      hiddenSidebarTab === 'tree'
                        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                        : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/50 hover:text-slate-100'
                    }`}
                   >
                     {t.fileTree}
                   </button>
                  <button
                    type="button"
                    onClick={() => setHiddenSidebarTab('projectgraph')}
                    aria-pressed={hiddenSidebarTab === 'projectgraph'}
                    className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                      hiddenSidebarTab === 'projectgraph'
                        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                        : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/50 hover:text-slate-100'
                    }`}
                  >
                    {t.workspaceProjectGraph}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHiddenSidebarTab('apps')}
                    aria-pressed={hiddenSidebarTab === 'apps'}
                    title={t.appDockTabTip}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                      hiddenSidebarTab === 'apps'
                        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                        : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/50 hover:text-slate-100'
                    }`}
                  >
                    {t.appDockTab}
                    {appCount > 0 && (
                      <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-indigo-500/80 px-1 text-[10px] font-semibold text-white">
                        {appCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>
              {hiddenSidebarTab === 'tree' && isLoadingTree && entries.length > 0 && (
                <div className="flex items-center gap-2 border-b border-[#2a2d3a] px-4 py-2 text-[10px] text-slate-500">
                  <span>{t.loadingProject}</span>
                  <span className="inline-flex h-1 w-10 overflow-hidden rounded-full bg-[#1a1f2b]">
                    <span className="status-indicator-bar h-full w-3 rounded-full bg-indigo-500/60" />
                  </span>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-hidden relative">
                <div className={
                  hiddenSidebarTab === 'projectgraph' ? 'h-full' :
                  isInitialGraphPreload ? 'absolute inset-0 opacity-0 pointer-events-none' :
                  'hidden'
                }>
                  <WorkspaceInsightPanel
                    workspacePath={workspacePath}
                    entries={entries}
                    lang={settings.lang ?? 'zh-CN'}
                    selectedPath={selectedPath}
                    onSelectPath={onSelectPath}
                    canStartLoading={canStartProjectGraph}
                    onProgressChange={handleProjectGraphProgress}
                  />
                </div>
                {hiddenSidebarTab === 'tree' && (
                  <div className="flex h-full flex-col">{fileTreeContent}</div>
                )}
                {hiddenSidebarTab === 'apps' && (
                  <div className="flex h-full flex-col">
                    <AppDockPanel lang={settings.lang} />
                  </div>
                )}
              </div>
            </section>
          ) : (
            <SplitPane
              direction="horizontal"
              defaultRatio={0.34}
              minFirstSize={220}
              minSecondSize={320}
              className="min-h-0 flex-1"
              first={
                <section className="flex h-full min-h-0 flex-col overflow-hidden border-r border-[#202432] bg-[#10141d]">
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{fileTreeContent}</div>
                </section>
              }
              second={
                <Suspense fallback={null}>
                  <CodePreviewPanel
                    workspacePath={workspacePath}
                    selectedPath={selectedPath}
                    selectedGitFile={selectedGitFile}
                    selectedLocation={selectedLocation}
                    onNavigateToLocation={onNavigateToLocation}
                    lang={settings.lang}
                    prewarmPaths={previewPrewarmPaths}
                  />
                </Suspense>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
