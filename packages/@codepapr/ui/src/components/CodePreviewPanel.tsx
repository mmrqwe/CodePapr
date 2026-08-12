import { errorMessage } from '@codepapr/common';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { useAgentStore } from '../store/agentStore';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import { MonacoTextEditor } from './MonacoTextEditor';
import { MarkdownRenderer } from './MarkdownRenderer';
import {
  type MonacoEditorNavigationLocation,
  type MonacoExternalMarker,
  type MonacoLspHoverResult,
} from '@codepapr/editor';
import { languageFromPath, lspLanguageFromPath } from '../utils/editorLanguage';
import {
  parseDeclaredModuleNames,
  parseWorkspacePackageJsonPaths,
} from '../utils/editorWorkspaceModules';
import { getTranslation, type Lang } from '../utils/i18n';
import { computeLineDiffStats } from '../utils/lineDiffStats';
import {
  describeLspSupport,
  isLikelyMissingLspServer,
  type LspSupportDescriptor,
} from '../utils/lspSupport';
import {
  getCachedLanguageIntelligence,
  scheduleLanguageIntelligenceRefresh,
  subscribeLanguageIntelligence,
  type LspServerDetails,
} from '../utils/languageIntelligence';
import {
  buildGitDiffContentPlan,
  type GitDiffContentSource,
  type GitFileSelection,
} from '../utils/workspaceGitPanel';
import type { PreviewLocation } from '../utils/projectDiagnosticLocations';

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  /** 内容超过 maxBytes 被截断（Rust 侧返回）。预览必须提示用户，
   *  否则把不完整的文件当全文展示（#7）。 */
  truncatedByBytes: boolean;
}

interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface LspRequestEnvelope<T> {
  message: {
    result?: T;
  };
}

interface LspPosition {
  line?: number;
  character?: number;
}

interface LspRange {
  start?: LspPosition;
  end?: LspPosition;
}

type ManagedLspPhase = 'idle' | 'checking' | 'downloading' | 'extracting' | 'ready' | 'failed';

interface ManagedLspStatusEventPayload {
  workspacePath: string;
  languageId: string;
  phase: string;
  toolLabel: string;
  detail: string;
  cachePath?: string | null;
}

interface ManagedLspActivityState {
  phase: ManagedLspPhase;
  toolLabel: string;
  detail: string;
  cachePath: string;
}

interface LspMarkupContent {
  kind?: string;
  value?: string;
}

interface LspMarkedString {
  language?: string;
  value?: string;
}

interface LspHover {
  contents?: string | LspMarkupContent | LspMarkedString | Array<string | LspMarkupContent | LspMarkedString>;
  range?: LspRange;
}

interface LspLocationLike {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

interface GitDiffViewState {
  originalContent: string;
  modifiedContent: string;
  isLoading: boolean;
  error: string;
}

type PreviewView = 'code' | 'diff';

interface LspStatusState {
  status: 'idle' | 'starting' | 'ready' | 'unavailable';
  diagnostics: number;
  message: string;
  detail: string;
  installHint: LspSupportDescriptor | null;
}

interface CodePreviewPanelProps {
  workspacePath: string;
  selectedPath: string | null;
  selectedGitFile: GitFileSelection | null;
  selectedLocation?: PreviewLocation | null;
  onNavigateToLocation?: (location: PreviewLocation) => void;
  lang?: Lang;
  prewarmPaths?: readonly string[];
}

const PREVIEW_MAX_BYTES = 300_000;
const PREVIEW_PREWARM_LIMIT = 12;
const PREVIEW_PREWARM_START_DELAY_MS = 80;
const PREVIEW_PREWARM_GAP_MS = 24;
const SELECTED_FILE_LSP_WARMUP_DELAY_MS = 120;

interface PreviewFileContent {
  content: string;
  truncated: boolean;
}

const previewContentCache = new Map<string, PreviewFileContent>();
const previewWarmPromises = new Map<string, Promise<PreviewFileContent | null>>();

function previewCacheKey(workspacePath: string, relativePath: string): string {
  return `${workspacePath}\u0000${relativePath}`;
}

function getCachedPreviewContent(workspacePath: string, relativePath: string): PreviewFileContent | null {
  return previewContentCache.get(previewCacheKey(workspacePath, relativePath)) ?? null;
}

function formatCodeCheckProblemMessage(lang: Lang, count: number): string {
  if (lang === 'en') {
    return `Code checks found ${count} ${count === 1 ? 'issue' : 'issues'}.`;
  }
  if (lang === 'zh-TW') {
    return `代碼檢測發現 ${count} 個問題。`;
  }
  return `代码检测发现 ${count} 个问题。`;
}

function clearPreviewCacheForWorkspace(workspacePath: string): void {
  if (!workspacePath) {
    return;
  }

  const prefix = `${workspacePath}\u0000`;
  for (const key of previewContentCache.keys()) {
    if (key.startsWith(prefix)) {
      previewContentCache.delete(key);
    }
  }
  for (const key of previewWarmPromises.keys()) {
    if (key.startsWith(prefix)) {
      previewWarmPromises.delete(key);
    }
  }
}

async function warmPreviewFile(
  workspacePath: string,
  relativePath: string
): Promise<PreviewFileContent | null> {
  const cacheKey = previewCacheKey(workspacePath, relativePath);
  const cachedContent = previewContentCache.get(cacheKey);
  if (cachedContent !== undefined) {
    return cachedContent;
  }

  const pending = previewWarmPromises.get(cacheKey);
  if (pending) {
    const content = await pending;
    return previewContentCache.get(cacheKey) ?? content;
  }

  const promise = (async () => {
    const result = await invoke<ReadFileResult>('read_text_file', {
      workspacePath,
      relativePath,
      maxBytes: PREVIEW_MAX_BYTES,
    });

    const entry: PreviewFileContent = { content: result.content, truncated: result.truncatedByBytes === true };
    if (!previewContentCache.has(cacheKey)) {
      previewContentCache.set(cacheKey, entry);
    }

    return entry;
  })()
    .finally(() => {
      previewWarmPromises.delete(cacheKey);
    });

  previewWarmPromises.set(cacheKey, promise);
  return promise;
}

async function readPreviewFileNow(workspacePath: string, relativePath: string): Promise<PreviewFileContent> {
  const result = await invoke<ReadFileResult>('read_text_file', {
    workspacePath,
    relativePath,
    maxBytes: PREVIEW_MAX_BYTES,
  });
  const entry: PreviewFileContent = { content: result.content, truncated: result.truncatedByBytes === true };
  previewContentCache.set(previewCacheKey(workspacePath, relativePath), entry);
  return entry;
}

function createEmptyGitDiffViewState(): GitDiffViewState {
  return {
    originalContent: '',
    modifiedContent: '',
    isLoading: false,
    error: '',
  };
}

function createIdleLspStatus(): LspStatusState {
  return {
    status: 'idle',
    diagnostics: 0,
    message: '',
    detail: '',
    installHint: null,
  };
}

function createIdleManagedLspActivity(): ManagedLspActivityState {
  return {
    phase: 'idle',
    toolLabel: '',
    detail: '',
    cachePath: '',
  };
}

function normalizeManagedLspPhase(phase: string | null | undefined): ManagedLspPhase {
  switch (phase) {
    case 'checking':
    case 'downloading':
    case 'extracting':
    case 'ready':
    case 'failed':
      return phase;
    default:
      return 'idle';
  }
}

function formatTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (current, [key, value]) => current.replaceAll(`{${key}}`, value),
    template
  );
}

function workspaceFileUri(workspacePath: string, relativePath: string): string {
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRelativePath = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
  return encodeURI(`file://${normalizedWorkspacePath}/${normalizedRelativePath}`).replace(/#/g, '%23');
}

function decodeFileUri(value: string): string {
  if (value.startsWith('file://')) {
    return decodeURIComponent(value.replace(/^file:\/\/+/i, '/'));
  }
  return value;
}

function toLspPosition(lineNumber: number, column: number): Required<LspPosition> {
  return {
    line: Math.max(Math.floor(lineNumber) - 1, 0),
    character: Math.max(Math.floor(column) - 1, 0),
  };
}

function toPreviewRange(range: LspRange | undefined): MonacoLspHoverResult['range'] | undefined {
  if (!range?.start) {
    return undefined;
  }

  const startLineNumber = Math.max((range.start.line ?? 0) + 1, 1);
  const startColumn = Math.max((range.start.character ?? 0) + 1, 1);
  const endLineNumber = Math.max((range.end?.line ?? range.start.line ?? 0) + 1, startLineNumber);
  const endColumn = Math.max((range.end?.character ?? range.start.character ?? 0) + 1, startColumn);
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
  };
}

function toMarkdownSnippet(value: string | LspMarkupContent | LspMarkedString): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value?.value === 'string' &&
    'language' in value &&
    typeof value.language === 'string' &&
    value.language.trim()
  ) {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }

  if (typeof value?.value === 'string') {
    return value.value;
  }

  return null;
}

function normalizeLspHover(hover: LspHover | null | undefined): MonacoLspHoverResult | null {
  if (!hover) {
    return null;
  }

  const rawContents = Array.isArray(hover.contents)
    ? hover.contents
    : hover.contents
    ? [hover.contents]
    : [];
  const contents = rawContents
    .map((entry) => toMarkdownSnippet(entry))
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

  if (contents.length === 0) {
    return null;
  }

  return {
    contents,
    range: toPreviewRange(hover.range),
  };
}

function normalizeDefinitionLocations(result: unknown): MonacoEditorNavigationLocation[] {
  const rawLocations = Array.isArray(result)
    ? result
    : result && typeof result === 'object'
    ? [result]
    : [];

  const seen = new Set<string>();
  const locations: MonacoEditorNavigationLocation[] = [];
  for (const rawLocation of rawLocations) {
    const location = rawLocation as LspLocationLike;
    const uri = typeof location.targetUri === 'string'
      ? location.targetUri
      : typeof location.uri === 'string'
      ? location.uri
      : null;
    const range = location.targetSelectionRange ?? location.targetRange ?? location.range;
    const previewRange = toPreviewRange(range);
    if (!uri || !previewRange) {
      continue;
    }

    const key = `${uri}:${previewRange.startLineNumber}:${previewRange.startColumn}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push({
      uri,
      lineNumber: previewRange.startLineNumber,
      column: previewRange.startColumn,
      endLineNumber: previewRange.endLineNumber,
      endColumn: previewRange.endColumn,
    });
  }

  return locations;
}

function buildManagedLspActivityMessage(
  activity: ManagedLspActivityState,
  labels: {
    checking: string;
    downloading: string;
    extracting: string;
    failed: string;
  }
): string {
  const replacements = { tool: activity.toolLabel || 'LSP' };
  switch (activity.phase) {
    case 'checking':
      return formatTemplate(labels.checking, replacements);
    case 'downloading':
      return formatTemplate(labels.downloading, replacements);
    case 'extracting':
      return formatTemplate(labels.extracting, replacements);
    case 'failed':
      return formatTemplate(labels.failed, replacements);
    default:
      return '';
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

async function buildImagePreviewUrl(workspacePath: string, relativePath: string, version = 0): Promise<string> {
  const fullPath = await join(workspacePath, relativePath);
  // 权衡说明（#67）：tauri.conf.json 的 assetProtocol scope 为 $HOME/** + /**，
  // 全盘可读——工作区可能位于 $HOME 之外（外置盘/自定义目录），收紧会破坏
  // 非 HOME 工作区的图片预览。风险面受 CSP 约束：asset: 仅出现在 img-src
  // （script/style/media/font 均不含），外部页面无法借 asset 协议执行脚本。
  // 若未来需要收紧，可改为 $HOME/** + $TMPDIR/** 并接受外置盘预览降级。
  // N4：同名文件内容被改写后 URL 不变，WebView 可能命中图片缓存；
  // 追加版本 query 强制换缓存键（asset 协议按 path 解析，query 无影响）。
  const url = convertFileSrc(fullPath);
  return version > 0 ? `${url}?v=${version}` : url;
}

export function CodePreviewPanel({
  workspacePath,
  selectedPath,
  selectedGitFile,
  selectedLocation,
  onNavigateToLocation,
  lang,
  prewarmPaths = [],
}: CodePreviewPanelProps) {
  const settings = useAgentStore((state) => state.settings);
  const workspaceMutationVersion = useAgentStore((state) => state.workspaceMutationVersion) ?? 0;
  const activeLang: Lang = lang ?? settings.lang ?? 'zh-CN';
  const t = getTranslation(activeLang);
  const lspMissingServerSummaryText =
    t.lspMissingServerSummary ||
    (activeLang === 'en' ? 'Missing {language} LSP server' : '缺少 {language} LSP server');
  const lspMissingServerBannerText =
    t.lspMissingServerBanner ||
    (activeLang === 'en'
      ? 'No working LSP server was found for the current language.'
      : '当前语言缺少可用的 LSP server。');
  const lspRecommendedServersText =
    t.lspRecommendedServers || (activeLang === 'en' ? 'Recommended servers' : '推荐服务');
  const lspCandidateCommandsText =
    t.lspCandidateCommands || (activeLang === 'en' ? 'Candidate commands' : '候选命令');
  const lspInstallHintNpmText =
    t.lspInstallHintNpm ||
    (activeLang === 'en'
      ? 'This server is usually provided by repo dependencies. Run npm install first, or make sure the command is available on PATH.'
      : '通常由仓库依赖提供；请先执行 npm install，或确保这些命令已在 PATH 中。');
  const lspInstallHintSystemText =
    t.lspInstallHintSystem ||
    (activeLang === 'en'
      ? 'Install the server on this machine and make sure it is available on PATH.'
      : '请先在本机安装并加入 PATH。');
  const lspInstallHintManagedText =
    t.lspInstallHintManaged ||
    (activeLang === 'en'
      ? 'CodePapr will try to download and cache this language tool automatically. If that fails, check network access, disk permissions, or your local PATH.'
      : 'CodePapr 会优先托管下载并缓存该语言工具；如果失败，再检查网络、磁盘权限或本地 PATH。');
  const lspErrorDetailsText =
    t.lspErrorDetails || (activeLang === 'en' ? 'Error details' : '错误详情');
  const lspManagedCheckingText =
    t.lspManagedChecking ||
    (activeLang === 'en' ? 'Preparing managed LSP: {tool}' : '正在准备托管 LSP: {tool}');
  const lspManagedDownloadingText =
    t.lspManagedDownloading ||
    (activeLang === 'en' ? 'Downloading managed LSP: {tool}' : '正在下载托管 LSP: {tool}');
  const lspManagedExtractingText =
    t.lspManagedExtracting ||
    (activeLang === 'en' ? 'Extracting managed LSP: {tool}' : '正在解压托管 LSP: {tool}');
  const lspManagedInstallFailedText =
    t.lspManagedInstallFailed ||
    (activeLang === 'en' ? 'Managed LSP install failed: {tool}' : '托管 LSP 安装失败: {tool}');
  const lspManagedFallbackActiveText =
    t.lspManagedFallbackActive ||
    (activeLang === 'en' ? 'Currently using the built-in symbol fallback.' : '当前已回退到内建符号能力。');
  const lspManagedCachePathText =
    t.lspManagedCachePath || (activeLang === 'en' ? 'Cache path' : '缓存目录');
  const [activeView, setActiveView] = useState<PreviewView>('code');
  const [previewContent, setPreviewContent] = useState('');
  const [previewContentPath, setPreviewContentPath] = useState<string | null>(null);
  const [declaredModuleNames, setDeclaredModuleNames] = useState<string[]>([]);
  const [gitDiffView, setGitDiffView] = useState<GitDiffViewState>(createEmptyGitDiffViewState());
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [lspStatus, setLspStatus] = useState<LspStatusState>(createIdleLspStatus());
  const [managedLspActivity, setManagedLspActivity] = useState<ManagedLspActivityState>(
    createIdleManagedLspActivity()
  );
  const [lspMarkers, setLspMarkers] = useState<MonacoExternalMarker[]>([]);
  const [lspServerDetails, setLspServerDetails] = useState<LspServerDetails | null>(null);
  const [showLspProblems, setShowLspProblems] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [mdPreviewMode, setMdPreviewMode] = useState(false);

  const isMarkdownPath = (selectedPath ?? '').toLowerCase().endsWith('.md');

  const activeGitSelection = selectedGitFile && selectedPath === selectedGitFile.path ? selectedGitFile : null;
  const diffStats = useMemo(
    () => computeLineDiffStats(gitDiffView.originalContent, gitDiffView.modifiedContent),
    [gitDiffView.modifiedContent, gitDiffView.originalContent]
  );
  const lspLanguageId = useMemo(
    () => (selectedPath ? lspLanguageFromPath(selectedPath) : null),
    [selectedPath]
  );
  const lspFileUri = useMemo(
    () => (workspacePath && selectedPath ? workspaceFileUri(workspacePath, selectedPath) : null),
    [selectedPath, workspacePath]
  );
  const normalizedPrewarmPaths = useMemo(() => {
    const seen = new Set<string>();
    const nextPaths: string[] = [];

    for (const candidate of prewarmPaths) {
      const relativePath = candidate.trim();
      if (!relativePath || seen.has(relativePath)) {
        continue;
      }
      seen.add(relativePath);
      nextPaths.push(relativePath);
      if (nextPaths.length >= PREVIEW_PREWARM_LIMIT) {
        break;
      }
    }

    return nextPaths;
  }, [prewarmPaths]);
  const managedLspActivityMessage = useMemo(
    () =>
      buildManagedLspActivityMessage(managedLspActivity, {
        checking: lspManagedCheckingText,
        downloading: lspManagedDownloadingText,
        extracting: lspManagedExtractingText,
        failed: lspManagedInstallFailedText,
      }),
    [
      lspManagedCheckingText,
      lspManagedDownloadingText,
      lspManagedExtractingText,
      lspManagedInstallFailedText,
      managedLspActivity,
    ]
  );
  const codeCheckProblemMessage = useMemo(
    () => formatCodeCheckProblemMessage(activeLang, lspStatus.diagnostics),
    [activeLang, lspStatus.diagnostics]
  );
  const lspMarkersBySeverity = useMemo(() => {
    const groups = { error: [] as MonacoExternalMarker[], warning: [] as MonacoExternalMarker[], info: [] as MonacoExternalMarker[], hint: [] as MonacoExternalMarker[] };
    for (const marker of lspMarkers) {
      groups[marker.severity].push(marker);
    }
    for (const group of Object.values(groups)) {
      group.sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    }
    return groups;
  }, [lspMarkers]);
  useEffect(() => {
    setShowLspProblems(false);
  }, [selectedPath]);
  useEffect(() => {
    clearPreviewCacheForWorkspace(workspacePath);
  }, [workspaceMutationVersion, workspacePath]);

  useEffect(() => {
    setManagedLspActivity(createIdleManagedLspActivity());
    if (!workspacePath || !lspLanguageId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<ManagedLspStatusEventPayload>('codepapr://lsp-managed-status', (event) => {
      if (disposed) {
        return;
      }

      const payload = event.payload;
      if (payload.workspacePath !== workspacePath || payload.languageId !== lspLanguageId) {
        return;
      }

      setManagedLspActivity({
        phase: normalizeManagedLspPhase(payload.phase),
        toolLabel: payload.toolLabel ?? '',
        detail: payload.detail ?? '',
        cachePath: payload.cachePath ?? '',
      });
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [lspLanguageId, workspacePath]);

  const handleNavigateToPreviewLocation = useCallback(
    (location: PreviewLocation) => {
      onNavigateToLocation?.(location);
    },
    [onNavigateToLocation]
  );

  const handleOpenEditorLocation = useCallback(
    (location: MonacoEditorNavigationLocation) => {
      handleNavigateToPreviewLocation({
        path: decodeFileUri(location.uri),
        line: location.lineNumber,
        column: location.column,
      });
    },
    [handleNavigateToPreviewLocation]
  );

  const provideLspHover = useCallback(
    async ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      if (!workspacePath || !selectedPath || !lspLanguageId || !lspFileUri || lspStatus.status !== 'ready') {
        return null;
      }

      try {
        const response = await invoke<LspRequestEnvelope<LspHover | null>>('lsp_request', {
          workspacePath,
          languageId: lspLanguageId,
          method: 'textDocument/hover',
          params: {
            textDocument: { uri: lspFileUri },
            position: toLspPosition(lineNumber, column),
          },
        });
        return normalizeLspHover(response.message.result);
      } catch {
        return null;
      }
    },
    [lspFileUri, lspLanguageId, lspStatus.status, selectedPath, workspacePath]
  );

  const provideLspDefinition = useCallback(
    async ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      if (!workspacePath || !selectedPath || !lspLanguageId || !lspFileUri || lspStatus.status !== 'ready') {
        return [];
      }

      try {
        const response = await invoke<LspRequestEnvelope<unknown>>('lsp_request', {
          workspacePath,
          languageId: lspLanguageId,
          method: 'textDocument/definition',
          params: {
            textDocument: { uri: lspFileUri },
            position: toLspPosition(lineNumber, column),
          },
        });
        return normalizeDefinitionLocations(response.message.result);
      } catch {
        return [];
      }
    },
    [lspFileUri, lspLanguageId, lspStatus.status, selectedPath, workspacePath]
  );

  useEffect(() => {
    let cancelled = false;

    const loadWorkspaceModules = async () => {
      if (!workspacePath) {
        setDeclaredModuleNames([]);
        return;
      }

      try {
        const result = await invoke<ReadFileResult>('read_text_file', {
          workspacePath,
          relativePath: 'package.json',
          maxBytes: 100_000,
        });

        const workspacePackageJsonPaths = parseWorkspacePackageJsonPaths(result.content);
        const workspacePackageJsonResults = await Promise.allSettled(
          workspacePackageJsonPaths.map((relativePath) =>
            invoke<ReadFileResult>('read_text_file', {
              workspacePath,
              relativePath,
              maxBytes: 40_000,
            })
          )
        );
        const workspacePackageJsonContents = workspacePackageJsonResults.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value.content] : []
        );

        if (!cancelled) {
          setDeclaredModuleNames(parseDeclaredModuleNames(result.content, workspacePackageJsonContents));
        }
      } catch {
        if (!cancelled) {
          setDeclaredModuleNames([]);
        }
      }
    };

    void loadWorkspaceModules();

    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath || normalizedPrewarmPaths.length === 0) {
      return;
    }

    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void (async () => {
        for (const relativePath of normalizedPrewarmPaths) {
          if (cancelled) {
            return;
          }

          await warmPreviewFile(workspacePath, relativePath).catch(() => undefined);

          if (cancelled) {
            return;
          }

          await new Promise<void>((resolve) => {
            const gapTimer = setTimeout(resolve, PREVIEW_PREWARM_GAP_MS);
            if (cancelled) {
              clearTimeout(gapTimer);
              resolve();
            }
          });
        }
      })();
    }, PREVIEW_PREWARM_START_DELAY_MS);

    return () => {
      cancelled = true;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
    };
  }, [normalizedPrewarmPaths, workspaceMutationVersion, workspacePath]);

  useEffect(() => {
    setActiveView(activeGitSelection ? 'diff' : 'code');
  }, [activeGitSelection]);

  useEffect(() => {
    let cancelled = false;

    const readSelectedFile = async () => {
      setMdPreviewMode(false);
      if (!workspacePath || !selectedPath) {
        setIsReadingFile(false);
        setPreviewContent('');
        setPreviewContentPath(null);
        setPreviewError('');
        setPreviewTruncated(false);
        setImagePreviewUrl(null);
        return;
      }

      if (activeGitSelection) {
        setIsReadingFile(false);
        setPreviewContent('');
        setPreviewContentPath(null);
        setPreviewError('');
        setPreviewTruncated(false);
        setImagePreviewUrl(null);
        return;
      }

      if (isImagePath(selectedPath)) {
        setIsReadingFile(false);
        setPreviewContent('');
        setPreviewContentPath(selectedPath);
        setPreviewError('');
        setPreviewTruncated(false);
        const url = await buildImagePreviewUrl(workspacePath, selectedPath, workspaceMutationVersion);
        if (!cancelled) {
          setImagePreviewUrl(url);
        }
        return;
      }

      const cachedContent = getCachedPreviewContent(workspacePath, selectedPath);
      if (cachedContent !== null) {
        setIsReadingFile(false);
        setPreviewContent(cachedContent.content);
        setPreviewContentPath(selectedPath);
        setPreviewError('');
        setPreviewTruncated(cachedContent.truncated);
        setImagePreviewUrl(null);
        return;
      }

      setIsReadingFile(true);
      setPreviewContent('');
      setPreviewContentPath(null);
      setPreviewError('');
      setPreviewTruncated(false);
      setImagePreviewUrl(null);
      try {
        const loaded = await readPreviewFileNow(workspacePath, selectedPath);
        if (!cancelled) {
          setPreviewContent(loaded.content);
          setPreviewContentPath(selectedPath);
          setPreviewError('');
          setPreviewTruncated(loaded.truncated);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewContent('');
          setPreviewContentPath(null);
          setPreviewError(errorMessage(err));
          setPreviewTruncated(false);
        }
      } finally {
        if (!cancelled) {
          setIsReadingFile(false);
        }
      }
    };

    void readSelectedFile();

    return () => {
      cancelled = true;
    };
    // N4：依赖 workspaceMutationVersion——agent 写入/回退等文件变更后，
    // 已打开文件必须重读刷新（此前只清缓存不重读，预览保持旧内容）。
    // effect 声明顺序保证清缓存（mutation 版本 effect 在前）先于本读取执行。
  }, [activeGitSelection, selectedPath, workspaceMutationVersion, workspacePath]);

  useEffect(() => {
    if (
      !workspacePath ||
      !selectedPath ||
      !lspLanguageId ||
      previewError ||
      isReadingFile ||
      previewContentPath !== selectedPath ||
      isImagePath(selectedPath)
    ) {
      return;
    }

    scheduleLanguageIntelligenceRefresh({
      invoke,
      workspacePath,
      paths: [selectedPath],
      delayMs: SELECTED_FILE_LSP_WARMUP_DELAY_MS,
      maxFiles: 1,
    });
  }, [
    isReadingFile,
    lspLanguageId,
    previewContentPath,
    previewError,
    selectedPath,
    workspacePath,
  ]);

  useEffect(() => {
    const applyCachedLanguageIntelligence = () => {
      if (
        !workspacePath ||
        !selectedPath ||
        !lspLanguageId ||
        previewError ||
        isReadingFile ||
        previewContentPath !== selectedPath
      ) {
        setLspStatus(createIdleLspStatus());
        setManagedLspActivity(createIdleManagedLspActivity());
        setLspMarkers([]);
        setLspServerDetails(null);
        return;
      }

      const snapshot = getCachedLanguageIntelligence(workspacePath, selectedPath);
      if (!snapshot || snapshot.status === 'analyzing') {
        setLspStatus(createIdleLspStatus());
        setManagedLspActivity(createIdleManagedLspActivity());
        setLspMarkers([]);
        setLspServerDetails(null);
        return;
      }

      if (snapshot.status === 'ready') {
        const server = snapshot.server;
        setLspServerDetails(server);
        setManagedLspActivity((current) => {
          if (server?.toolOrigin === 'managed') {
            return {
              phase: 'ready',
              toolLabel: server.toolLabel ?? current.toolLabel,
              detail: '',
              cachePath: server.managedCachePath ?? current.cachePath,
            };
          }

          return current.phase === 'failed' ? current : createIdleManagedLspActivity();
        });
        setLspStatus({
          status: 'ready',
          diagnostics: snapshot.diagnostics,
          message: t.lspConnected,
          detail: '',
          installHint: null,
        });
        setLspMarkers(snapshot.markers);
        return;
      }

      const detail = snapshot.detail;
      const installHint =
        isLikelyMissingLspServer(detail) && lspLanguageId ? describeLspSupport(lspLanguageId) : null;
      setLspServerDetails(null);
      setLspStatus({
        status: 'unavailable',
        diagnostics: 0,
        message: installHint
          ? lspMissingServerSummaryText.replace('{language}', installHint.languageLabel)
          : detail,
        detail,
        installHint,
      });
      setLspMarkers([]);
    };

    applyCachedLanguageIntelligence();
    return subscribeLanguageIntelligence((snapshot) => {
      if (snapshot.workspacePath === workspacePath && snapshot.relativePath === selectedPath) {
        applyCachedLanguageIntelligence();
      }
    });
  }, [
    isReadingFile,
    lspLanguageId,
    previewContentPath,
    previewError,
    selectedPath,
    t.lspConnected,
    lspMissingServerSummaryText,
    workspacePath,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadDiffSource = async (source: GitDiffContentSource): Promise<string> => {
      if (source.kind === 'empty') {
        return '';
      }

      if (source.kind === 'workspace') {
        const result = await invoke<ReadFileResult>('read_text_file', {
          workspacePath,
          relativePath: source.path,
          maxBytes: 300_000,
        });
        return result.content ?? '';
      }

      const revisionPrefix = source.revision === 'HEAD' ? 'HEAD:' : ':';
      const commandResult = await invoke<CommandResult>('run_workspace_command', {
        workspacePath,
        command: 'git',
        args: ['show', `${revisionPrefix}${source.path}`],
        timeoutSeconds: 15,
      });

      if ((commandResult.status ?? 1) !== 0) {
        throw new Error(
          (commandResult.stderr ?? '').trim() ||
            (commandResult.stdout ?? '').trim() ||
            t.workspaceGitFileDiffUnavailable
        );
      }

      return commandResult.stdout ?? '';
    };

    const loadGitDiffView = async () => {
      if (!workspacePath || !activeGitSelection) {
        setGitDiffView(createEmptyGitDiffViewState());
        return;
      }

      setGitDiffView((current) => ({
        ...current,
        isLoading: true,
        error: '',
      }));

      try {
        const plan = buildGitDiffContentPlan(activeGitSelection);
        const [originalContent, modifiedContent] = await Promise.all([
          loadDiffSource(plan.original),
          loadDiffSource(plan.modified),
        ]);

        if (!cancelled) {
          setGitDiffView({
            originalContent,
            modifiedContent,
            isLoading: false,
            error: '',
          });
        }
      } catch (err) {
        if (!cancelled) {
          setGitDiffView({
            originalContent: '',
            modifiedContent: '',
            isLoading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    void loadGitDiffView();

    return () => {
      cancelled = true;
    };
  }, [activeGitSelection, t.workspaceGitFileDiffUnavailable, workspacePath]);

  if (!selectedPath) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-600">
        {t.selectFileToPreview}
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0f1117]">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {activeView === 'code' && previewError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
              {t.previewUnavailable}: {previewError}
            </div>
          )}
          {activeView === 'code' && !previewError && previewTruncated && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
              {t.previewTruncated}
            </div>
          )}
          {activeView === 'code' &&
            !previewError &&
            ['checking', 'downloading', 'extracting'].includes(managedLspActivity.phase) && (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-100">
                <div className="font-semibold text-sky-50">{managedLspActivityMessage}</div>
                {managedLspActivity.cachePath && (
                  <div className="mt-1 font-mono text-[11px] text-sky-100/85">
                    {lspManagedCachePathText}: {managedLspActivity.cachePath}
                  </div>
                )}
              </div>
            )}
          {activeView === 'code' &&
            !previewError &&
            managedLspActivity.phase === 'failed' && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                <div className="font-semibold text-amber-100">{managedLspActivityMessage}</div>
                {managedLspActivity.detail && (
                  <div className="mt-1 font-mono text-[11px] text-amber-100/85">
                    {lspErrorDetailsText}: {managedLspActivity.detail}
                  </div>
                )}
                {managedLspActivity.cachePath && (
                  <div className="mt-1 font-mono text-[11px] text-amber-100/85">
                    {lspManagedCachePathText}: {managedLspActivity.cachePath}
                  </div>
                )}
                {lspStatus.status === 'ready' && lspServerDetails?.toolOrigin === 'builtin' && (
                  <div className="mt-1 text-amber-100/90">{lspManagedFallbackActiveText}</div>
                )}
              </div>
            )}
          {activeView === 'code' &&
            !previewError &&
            lspStatus.status === 'unavailable' &&
            lspStatus.installHint && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                <div className="font-semibold text-amber-100">
                  {lspMissingServerSummaryText.replace('{language}', lspStatus.installHint.languageLabel)}
                </div>
                <div className="mt-1">{lspMissingServerBannerText}</div>
                <div className="mt-1">
                  {lspStatus.installHint.installMode === 'npm'
                    ? lspInstallHintNpmText
                    : lspStatus.installHint.installMode === 'managed'
                    ? lspInstallHintManagedText
                    : lspInstallHintSystemText}
                </div>
                <div className="mt-1">
                  {lspRecommendedServersText}: {lspStatus.installHint.recommendedServers.join(' / ')}
                </div>
                <div className="mt-1 font-mono text-[11px] text-amber-100/90">
                  {lspCandidateCommandsText}: {lspStatus.installHint.candidateCommands.join(', ')}
                </div>
                {lspStatus.detail && (
                  <div className="mt-2 font-mono text-[11px] text-amber-100/80">
                    {lspErrorDetailsText}: {lspStatus.detail}
                  </div>
                )}
              </div>
            )}
          {activeView === 'code' &&
            !previewError &&
            lspStatus.status === 'unavailable' &&
            !lspStatus.installHint &&
            lspStatus.detail && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                {t.lspUnavailable}: {lspStatus.detail}
              </div>
            )}
          {activeView === 'code' &&
            !previewError &&
            lspStatus.status === 'ready' &&
            lspStatus.diagnostics > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowLspProblems((v) => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200 transition-colors hover:border-amber-500/50 hover:bg-amber-500/15"
                >
                  <span>{codeCheckProblemMessage}</span>
                  <svg
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    className={`ml-2 h-3.5 w-3.5 flex-shrink-0 text-amber-300 transition-transform ${showLspProblems ? 'rotate-180' : ''}`}
                  >
                    <path d="M4 6 8 10 12 6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
                  </svg>
                </button>
                {showLspProblems && (
                  <div className="mt-2 rounded-xl border border-[#2a2d3a] bg-[#10131b] p-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {t.lspDiagnosticDetails}
                    </div>
                    <div className="max-h-[320px] space-y-3 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable">
                      {(['error', 'warning', 'info', 'hint'] as const).map((severity) =>
                        lspMarkersBySeverity[severity].length > 0 ? (
                          <div key={severity}>
                            <div className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-medium ${
                              severity === 'error' ? 'text-red-300' :
                              severity === 'warning' ? 'text-amber-300' :
                              severity === 'info' ? 'text-sky-300' :
                              'text-slate-400'
                            }`}>
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                                severity === 'error' ? 'bg-red-400' :
                                severity === 'warning' ? 'bg-amber-400' :
                                severity === 'info' ? 'bg-sky-400' :
                                'bg-slate-500'
                              }`} />
                              {severity === 'error' ? t.editorErrors :
                               severity === 'warning' ? t.editorWarnings :
                               severity === 'info' ? t.lspDiagnosticDetails :
                               'Hints'}
                              <span className="tabular-nums text-slate-600">
                                {lspMarkersBySeverity[severity].length}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {lspMarkersBySeverity[severity].map((marker, index) => (
                                <div
                                  key={index}
                                  className="flex items-start gap-2 rounded-md border border-[#2a2d3a]/50 px-2 py-1.5 text-[11px] leading-snug text-slate-300 hover:border-[#3a3d4a] hover:bg-[#161a24] transition-colors cursor-default"
                                >
                                  <span className="mt-px flex-shrink-0 rounded-full border border-slate-600 px-1.5 py-0 text-[10px] tabular-nums text-slate-500">
                                    {marker.startLineNumber}
                                  </span>
                                  <span className="min-w-0 break-words">{marker.message}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          {activeView === 'code' && !previewError && isMarkdownPath && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMdPreviewMode(false)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  !mdPreviewMode
                    ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                    : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200'
                }`}
              >
                {t.markdownSource}
              </button>
              <button
                type="button"
                onClick={() => setMdPreviewMode(true)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  mdPreviewMode
                    ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                    : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200'
                }`}
              >
                {t.markdownPreviewLabel}
              </button>
            </div>
          )}
          {activeView === 'code' && !previewError && mdPreviewMode && isMarkdownPath && (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-stable rounded-xl border border-[#2a2d3a] bg-[#0b0d12] px-5 py-4">
              <MarkdownRenderer content={previewContent} copyLabel={t.copy} className="text-slate-200" />
            </div>
          )}
          {activeView === 'code' && !previewError && isImagePath(selectedPath) && imagePreviewUrl && (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-xl border border-[#2a2d3a] bg-[#0b0d12]/70">
              <img
                src={imagePreviewUrl}
                alt={selectedPath}
                className="max-h-full max-w-full object-contain"
                style={{ imageRendering: 'auto' }}
                // #8：损坏/不支持的图片此前只显示空白区域、无任何提示。
                onError={() => {
                  setImagePreviewUrl(null);
                  setPreviewError(t.imagePreviewLoadFailed);
                }}
              />
            </div>
          )}
          {activeView === 'code' && !previewError && !mdPreviewMode && !isImagePath(selectedPath) && (
            <div className="min-h-0 flex-1">
              <MonacoTextEditor
                value={previewContent}
                language={languageFromPath(selectedPath)}
                declaredModuleNames={declaredModuleNames}
                minHeight={220}
                readOnly
                ariaLabel={t.codePreview}
                modelPath={selectedPath}
                revealLineNumber={selectedLocation?.path === selectedPath ? selectedLocation.line : undefined}
                revealColumn={selectedLocation?.path === selectedPath ? selectedLocation.column : undefined}
                externalMarkers={lspMarkers}
                externalMarkerOwner="codepapr-lsp"
                excludedDiagnosticMarkerOwners={["codepapr-lsp"]}
                lspHoverProvider={provideLspHover}
                lspDefinitionProvider={provideLspDefinition}
                onOpenLocation={handleOpenEditorLocation}
              />
            </div>
          )}
          {activeView === 'diff' && activeGitSelection && gitDiffView.error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
              {t.workspaceGitFileDiffUnavailable}: {gitDiffView.error}
            </div>
          )}
          {activeView === 'diff' && activeGitSelection && !gitDiffView.error && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="rounded-md border border-[#2a2d3a] px-2 py-1">
                  {t.workspaceGitDiffStat}: +{diffStats.added}/-{diffStats.deleted}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <MonacoDiffEditor
                  originalValue={gitDiffView.originalContent}
                  modifiedValue={gitDiffView.modifiedContent}
                  language={languageFromPath(selectedPath)}
                  minHeight={220}
                  ariaLabel={t.codeDiffTab}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
