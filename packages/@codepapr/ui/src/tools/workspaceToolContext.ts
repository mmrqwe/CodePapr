import { invoke } from '@tauri-apps/api/core';
import {
  type ToolRegistry,
  type EditHistory,
  asOptionalString,
  asOptionalNumber,
  boundedNumber,
} from '@codepapr/core';
import { usePermissionStore, isAbsolutePath } from '../store/permissionStore';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { createUiWorkspaceHost } from './workspaceHost';
import { resolveProjectMapSymbolOverrides } from './workspaceProjectMapLsp';
import {
  locateSearchOccurrences,
  extractProjectMapSymbols,
  filterWorkspaceInsightEntries,
  selectProjectMapFiles,
  buildWorkspaceProjectGraph,
  enrichWorkspaceProjectGraph,
  buildWorkspaceProjectMap,
  buildGitUnavailableStatus,
  type WorkspaceMapSymbolSummary,
  type GitStatusSummary,
  type WorkspaceProjectGraphResult,
} from './workspaceToolUtils';
import {
  requireWorkspace,
  type ReadFileResult,
  type ListFilesResult,
  type ProjectGraphArgs,
  type WorkspaceMutationListener,
  type RegisterWorkspaceToolsOptions,
} from './workspaceToolHelpers';

export interface WorkspaceToolContextParams {
  registry: ToolRegistry;
  workspacePath: string;
  editHistory?: EditHistory;
  onWorkspaceMutated?: WorkspaceMutationListener;
  options: RegisterWorkspaceToolsOptions;
}

/**
 * 汇集 registerWorkspaceTools 内的共享基础设施：工作区访问、写前读取、AST 预检、
 * LSP 诊断钩子、外部路径授权、项目图缓存与工作区 git 状态。
 * 这些 helper 携带闭包状态（LSP 文档版本号、项目图缓存），每次注册创建一份实例。
 */
export function createWorkspaceToolContext(params: WorkspaceToolContextParams) {
  const { registry, workspacePath, editHistory, onWorkspaceMutated, options } = params;

  const workspace = () => requireWorkspace(workspacePath);
  const notifyWorkspaceMutation = (paths: string[]): void => {
    if (paths.length === 0) {
      return;
    }
    invalidateProjectGraphCache();
    onWorkspaceMutated?.(paths);
  };

  const readBeforeContent = async (relativePath: string): Promise<string | null> => {
    if (!editHistory) {
      return null;
    }
    try {
      const previous = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath,
        maxBytes: 20_000_000,
      });
      return previous.content;
    } catch {
      return null;
    }
  };

  const getWorkspaceHost = () =>
    createUiWorkspaceHost({
      workspacePath: workspace(),
      editHistory,
      notifyWorkspaceMutation,
    });

  const resolveLanguageId = (relativePath: string): string => {
    const languageId = lspLanguageFromPath(relativePath);
    if (!languageId) {
      throw new Error(`当前文件暂不支持语言服务操作: ${relativePath}`);
    }
    return languageId;
  };

  interface SyntaxCheckResult {
    supported: boolean;
    errorCount: number;
    errors: Array<{ line: number; column: number; kind: string }>;
  }

  const checkSyntax = async (languageId: string, content: string): Promise<SyntaxCheckResult> => {
    try {
      return await invoke<SyntaxCheckResult>('check_syntax', { languageId, content });
    } catch {
      return { supported: false, errorCount: 0, errors: [] };
    }
  };

  let lspDocumentVersion = 1;
  const nextLspDocumentVersion = (): number => {
    const current = lspDocumentVersion;
    lspDocumentVersion += 1;
    return current;
  };

  // AST 预检：比较编辑前后语法错误数，仅当错误数增加（改前合法→改后非法）时拦截、不落盘。
  // 语言无 tree-sitter 支持时降级跳过（返回 note），绝不报错。
  const astPreCheck = async (
    relativePath: string,
    before: string,
    after: string
  ): Promise<{ rejected?: string; note?: string }> => {
    const languageId = lspLanguageFromPath(relativePath);
    if (!languageId) {
      return { note: `AST 语法预检跳过：无法识别 ${relativePath} 的语言类型。` };
    }
    const [beforeCheck, afterCheck] = await Promise.all([
      checkSyntax(languageId, before),
      checkSyntax(languageId, after),
    ]);
    if (!beforeCheck.supported || !afterCheck.supported) {
      return { note: `AST 语法预检跳过：${languageId} 无 tree-sitter 语法支持。` };
    }
    if (afterCheck.errorCount > beforeCheck.errorCount) {
      const sample = afterCheck.errors
        .slice(0, 5)
        .map((e) => `L${e.line}:${e.column}(${e.kind})`)
        .join('、');
      return {
        rejected: `AST 语法预检拦截：修改后语法错误从 ${beforeCheck.errorCount} 增至 ${afterCheck.errorCount}（${sample || '未定位到具体位置'}）。修改已取消，请检查括号/引号闭合后重试。`,
      };
    }
    return {};
  };

  // LSP 诊断后置钩子：先把改后内容同步给 LSP，再等待并读取该文件的最新诊断。
  // 无可用 LSP 时降级跳过（返回 note），绝不报错。
  const lspDiagnosticsHook = async (
    relativePath: string,
    newContent: string
  ): Promise<{ diagnostics: unknown[]; note: string }> => {
    const languageId = lspLanguageFromPath(relativePath);
    if (!languageId) {
      return { diagnostics: [], note: `LSP 诊断跳过：无法识别 ${relativePath} 的语言类型。` };
    }
    try {
      await invoke('lsp_open_document', {
        workspacePath: workspace(),
        languageId,
        relativePath,
        content: newContent,
        version: nextLspDocumentVersion(),
      });
    } catch {
      return {
        diagnostics: [],
        note: `LSP 诊断跳过：${languageId} 文档同步失败或无可用 LSP，诊断可能不是最新。如需确证请运行 diagnostics。`,
      };
    }
    try {
      const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>(
        'lsp_get_diagnostics',
        { workspacePath: workspace(), languageId, relativePath }
      );
      const allDiags = result.diagnostics ?? {};
      const fileUri = Object.keys(allDiags).find(
        (uri) => uri.endsWith(relativePath) || uri.endsWith(relativePath.replace(/\\/g, '/'))
      );
      const fileDiags = fileUri ? (allDiags[fileUri]?.diagnostics ?? []) : [];
      if (fileDiags.length === 0) {
        return { diagnostics: [], note: 'LSP 检查通过，无编译错误。' };
      }
      return {
        diagnostics: fileDiags,
        note: `修改已应用，但触发 ${fileDiags.length} 个编译诊断，请检查并继续修复。`,
      };
    } catch {
      return { diagnostics: [], note: `LSP 诊断跳过：${languageId} 无可用 LSP。` };
    }
  };

  const AMBIGUITY_MATCH_LIMIT = 8;

  // 多处匹配消歧：当 search 命中多于一处且未用 replaceAll/expectedOccurrences 锁定时，
  // 返回带行号与所在符号的富错误文本；无歧义时返回 null，交由 applySearchReplacePatch 正常处理。
  const describeAmbiguousMatches = async (
    relativePath: string,
    content: string,
    search: string,
    replaceAll: boolean | undefined,
    expectedOccurrences: number | undefined
  ): Promise<string | null> => {
    const locations = locateSearchOccurrences(content, search);
    if (locations.length <= 1 || replaceAll) {
      return null;
    }
    if (typeof expectedOccurrences === 'number' && expectedOccurrences === locations.length) {
      return null;
    }

    let symbols: WorkspaceMapSymbolSummary[] = [];
    try {
      symbols = await extractProjectMapSymbols(relativePath, content);
    } catch {
      symbols = [];
    }
    const sortedSymbols = [...symbols].sort((left, right) => left.line - right.line);
    const enclosingSymbol = (line: number): string | null => {
      let found: WorkspaceMapSymbolSummary | null = null;
      for (const symbol of sortedSymbols) {
        if (symbol.line <= line) {
          found = symbol;
        } else {
          break;
        }
      }
      return found ? `${found.kind} ${found.name}` : null;
    };

    const limit = Math.min(locations.length, AMBIGUITY_MATCH_LIMIT);
    const detailLines = locations.slice(0, limit).map((loc) => {
      const symbol = enclosingSymbol(loc.line);
      return symbol ? `  L${loc.line}（位于 ${symbol}）` : `  L${loc.line}`;
    });
    const omitted =
      locations.length > limit ? `\n  …其余 ${locations.length - limit} 处省略` : '';

    return (
      `匹配到 ${locations.length} 处相同文本块，无法确定修改目标。` +
      `请加长 search 纳入上下唯一内容，或设置 expectedOccurrences / replaceAll：\n` +
      detailLines.join('\n') +
      omitted
    );
  };

  const ensureExternalPathAllowed = async (relativePath: string | undefined, operation: 'read' | 'list'): Promise<void> => {
    if (!relativePath || !isAbsolutePath(relativePath)) return;
    if (isWithinWorkspace(relativePath, workspace())) return;
    const { isExternalPathAllowed, requestExternalAccess } = usePermissionStore.getState();
    if (isExternalPathAllowed(relativePath)) return;
    const result = await requestExternalAccess(relativePath, operation);
    if (!result.approved) {
      throw new Error('用户拒绝访问外部路径');
    }
  };

  function isWithinWorkspace(absPath: string, ws: string): boolean {
    if (!absPath.startsWith(ws)) return false;
    if (absPath.length === ws.length) return true;
    return absPath[ws.length] === '/';
  }

  const PROJECT_GRAPH_CACHE_TTL_MS = 60_000;
  const PROJECT_GRAPH_CACHE_MAX_ENTRIES = 3;

  interface ProjectGraphCacheEntry {
    graph: WorkspaceProjectGraphResult;
    createdAt: number;
  }

  const projectGraphCache = new Map<string, ProjectGraphCacheEntry>();
  const projectGraphInflight = new Map<string, Promise<WorkspaceProjectGraphResult>>();

  const invalidateProjectGraphCache = (): void => {
    projectGraphCache.clear();
    projectGraphInflight.clear();
  };

  const projectGraphCacheKey = (parsed: ProjectGraphArgs): string =>
    JSON.stringify([
      workspace(),
      parsed.relativePath ?? '',
      parsed.maxDepth,
      parsed.maxFiles,
      parsed.maxTreeEntries,
      parsed.maxSymbolsPerFile,
      parsed.maxEdges,
      parsed.maxBytes,
    ]);

  const parseIntelligenceProjectGraphArgs = (args: Record<string, unknown>): ProjectGraphArgs => {
    const view = asOptionalString(args.view) === 'overview' ? 'overview' : 'full';
    return {
      view,
      relativePath: asOptionalString(args.relativePath),
      maxDepth: boundedNumber(asOptionalNumber(args.maxDepth), 16, 1, Number.MAX_SAFE_INTEGER),
      maxFiles: boundedNumber(asOptionalNumber(args.maxFiles), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxTreeEntries: boundedNumber(asOptionalNumber(args.maxTreeEntries), 320, 20, Number.MAX_SAFE_INTEGER),
      maxSymbolsPerFile: boundedNumber(asOptionalNumber(args.maxSymbolsPerFile), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxEdges: boundedNumber(asOptionalNumber(args.maxEdges), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), Number.MAX_SAFE_INTEGER, 10_000, Number.MAX_SAFE_INTEGER),
    };
  };

  const computeIntelligenceProjectGraph = async (parsed: ProjectGraphArgs): Promise<WorkspaceProjectGraphResult> => {
    const listResult = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxDepth: parsed.maxDepth,
    });

    const insightEntries = filterWorkspaceInsightEntries(listResult.entries);
    const selectedFiles = selectProjectMapFiles(insightEntries, parsed.maxFiles);
    const fileReads = await Promise.all(
      selectedFiles.map(async (entry) => {
        try {
          const file = await invoke<ReadFileResult>('read_text_file', {
            workspacePath: workspace(),
            relativePath: entry.path,
            maxBytes: parsed.maxBytes,
          });
          return [entry.path, { content: file.content, bytes: file.bytes }] as const;
        } catch {
          return null;
        }
      })
    );

    const fileContents = Object.fromEntries(
      fileReads.filter(
        (
          entry
        ): entry is readonly [string, { content: string; bytes: number }] => entry !== null
      )
    );
    const maxSymbolsPerFile = parsed.maxSymbolsPerFile ?? 24;

    const symbolOverrides = await resolveProjectMapSymbolOverrides(
      workspace(),
      fileContents,
      maxSymbolsPerFile
    );

    let projectMap: Awaited<ReturnType<typeof buildWorkspaceProjectMap>>;
    try {
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents,
        symbolOverrides,
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    } catch (mapError) {
      console.warn('buildWorkspaceProjectMap failed, falling back to tree-only map:', mapError);
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents: {},
        symbolOverrides: {},
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    }

    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: insightEntries,
      fileContents,
      symbolOverrides,
      maxEdges: parsed.maxEdges,
    });

    try {
      return await enrichWorkspaceProjectGraph(graph, fileContents, 3);
    } catch {
      return graph;
    }
  };

  // 建图缓存：同一组建图参数在 TTL 内复用结果（lookup→dependency→impact 三连只建一次图）；
  // 任一工作区写入会经 notifyWorkspaceMutation 清空缓存，TTL 作为带外变更的兜底。
  const buildIntelligenceProjectGraph = async (args: Record<string, unknown>): Promise<WorkspaceProjectGraphResult> => {
    const parsed = parseIntelligenceProjectGraphArgs(args);
    const key = projectGraphCacheKey(parsed);

    const cached = projectGraphCache.get(key);
    if (cached) {
      if (Date.now() - cached.createdAt < PROJECT_GRAPH_CACHE_TTL_MS) {
        return cached.graph;
      }
      projectGraphCache.delete(key);
    }

    const inflight = projectGraphInflight.get(key);
    if (inflight) {
      return inflight;
    }

    const pending = computeIntelligenceProjectGraph(parsed);
    projectGraphInflight.set(key, pending);
    try {
      const graph = await pending;
      if (projectGraphCache.size >= PROJECT_GRAPH_CACHE_MAX_ENTRIES) {
        const oldestKey = projectGraphCache.keys().next().value;
        if (oldestKey !== undefined) {
          projectGraphCache.delete(oldestKey);
        }
      }
      projectGraphCache.set(key, { graph, createdAt: Date.now() });
      return graph;
    } finally {
      projectGraphInflight.delete(key);
    }
  };

  const readGitStatus = async (): Promise<GitStatusSummary> => {
    try {
      const result = await invoke<import('../utils/snapshot').GitStatusResult>('git_status', {
        workspacePath: workspace(),
      });
      return {
        available: result.available,
        isRepo: result.isRepo,
        files: result.entries.map((e) => ({
          path: e.path,
          originalPath: e.oldPath ?? undefined,
          indexStatus: e.indexStatus,
          worktreeStatus: e.worktreeStatus,
          isUntracked: e.isUntracked,
        })),
        raw: '',
        ...(result.branch ? { branch: result.branch } : {}),
        ...(result.headShort ? { headShort: result.headShort } : {}),
        ...(result.message ? { message: result.message } : {}),
      } satisfies GitStatusSummary;
    } catch (error) {
      return buildGitUnavailableStatus((error as Error).message) satisfies GitStatusSummary;
    }
  };

  return {
    registry,
    options,
    editHistory,
    workspace,
    notifyWorkspaceMutation,
    readBeforeContent,
    getWorkspaceHost,
    resolveLanguageId,
    astPreCheck,
    lspDiagnosticsHook,
    describeAmbiguousMatches,
    ensureExternalPathAllowed,
    buildIntelligenceProjectGraph,
    invalidateProjectGraphCache,
    readGitStatus,
  };
}

export type WorkspaceToolContext = ReturnType<typeof createWorkspaceToolContext>;
