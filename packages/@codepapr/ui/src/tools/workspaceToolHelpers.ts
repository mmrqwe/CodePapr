import { invoke } from '@tauri-apps/api/core';
import { asString } from '@codepapr/core';
import { useBrowserViewStore } from '../store/browserViewStore';
import { type PreviewSession } from '../store/previewStore';
import { type WorkspaceListEntry } from './workspaceToolUtils';

export interface RegisterWorkspaceToolsOptions {
  disableWebSearchTools?: boolean;
  multimodalEnabled?: boolean;
  /**
   * 是否把 graph 工具暴露给 LLM。默认 false：graph 对主代理软隐藏（项目结构改用 list、符号导航改用 lsp），
   * 但 handler 仍注册，供子代理（如 Explore）经白名单选取。子代理注册时应传 true。
   */
  exposeGraphToLlm?: boolean;
  /** 工作模式，用于按模式过滤工具可见性。默认 agent。 */
  mode?: 'ask' | 'plan' | 'agent' | 'app';
}

export interface ListFilesArgs {
  relativePath?: string;
  maxDepth?: number;
}

export interface ListFilesResult {
  root: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
}

export interface ReadFileArgs {
  relativePath: string;
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
  aroundLine?: number;
  contextLines?: number;
  symbol?: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByRange: boolean;
  truncatedByBytes: boolean;
  locationLine?: number;
  locationColumn?: number;
}

export interface FileSymbolInfo {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  containerName?: string;
}

// 整文件读取超过此行数时自动附带符号大纲
export const OUTLINE_LINE_THRESHOLD = 300;

// list 逐文件轻量符号：最多处理多少个代码文件、单文件字节上限、每文件保留的顶层符号数
export const LIST_SYMBOL_FILE_LIMIT = 40;
export const LIST_SYMBOL_FILE_MAX_BYTES = 200_000;
export const LIST_SYMBOLS_PER_FILE = 6;

// 用 AST 提取文件符号（含行范围）；语言无 AST 支持或解析失败时返回空数组（降级，不报错）。
export async function extractFileSymbols(languageId: string | null, content: string): Promise<FileSymbolInfo[]> {
  if (!languageId) return [];
  try {
    return await invoke<FileSymbolInfo[]>('extract_file_symbols', { languageId, content });
  } catch {
    return [];
  }
}

// 按名称查找符号：精确 → 忽略大小写 → 包含匹配（取最短名，最可能是目标）。
export function findSymbolByName(symbols: FileSymbolInfo[], name: string): FileSymbolInfo | undefined {
  const lower = name.toLowerCase();
  return (
    symbols.find((s) => s.name === name) ??
    symbols.find((s) => s.name.toLowerCase() === lower) ??
    symbols
      .filter((s) => s.name.toLowerCase().includes(lower))
      .sort((a, b) => a.name.length - b.name.length)[0]
  );
}

export function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join('\n');
}

export function formatOutline(symbols: FileSymbolInfo[]): string {
  return symbols
    .map((s) => `${s.containerName ? '  ' : ''}- ${s.name} (${s.kind}) L${s.line}-L${s.endLine}`)
    .join('\n');
}

export interface ReadImageFileArgs {
  relativePath: string;
  maxBytes?: number;
}

export interface ReadImageFileResult {
  path: string;
  mediaType: string;
  data: string;
  bytes: number;
}

export interface WriteFileArgs {
  relativePath: string;
  content: string;
}

export interface WriteTextFileResult {
  path: string;
  bytes: number;
  /** 非 UTF-8（或带 BOM）文件按原编码回写时的编码标识 */
  encoding?: string;
  change: WriteFileChangeSummary;
}

export interface WriteFileChangeSummary {
  kind: 'created' | 'updated';
  added: number;
  deleted: number;
  beforeLines: number;
  afterLines: number;
}

export interface RunCommandArgs {
  command: string;
  args?: string[];
  timeoutSeconds?: number;
}

export interface _CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BackgroundCommandArgs {
  command: string;
  args?: string[];
  previewUrl?: string;
}

export interface PreviewSessionArgs {
  command: string;
  args?: string[];
  previewUrl: string;
  title?: string;
}

export interface StopBackgroundProcessArgs {
  pid: number;
}

export interface SearchTextArgs {
  query: string;
  caseSensitive?: boolean;
  isRegexp?: boolean;
  contextLines?: number;
  maxResults?: number;
  maxMatchesPerFile?: number;
  maxBytesPerFile?: number;
  includeIgnoredDirs?: boolean;
}

export interface SearchFilesArgs {
  query: string;
  caseSensitive?: boolean;
  isRegexp?: boolean;
  maxResults?: number;
  includeIgnoredDirs?: boolean;
}


export interface SkillLoadArgs {
  name: string;
}


export interface WebSearchArgs {
  query: string;
  maxResults?: number;
  searxngCategory?: string;
  searxngTimeRange?: string;
  searxngLanguage?: string;
  searxngSafeSearch?: number;
}

export interface WebFetchArgs {
  url: string;
  maxBytes?: number;
}

export interface WebDownloadArgs {
  url: string;
  relativePath?: string;
}

export interface BrowserOpenPreviewArgs {
  url: string;
  title?: string;
  linkedPid?: number;
}

export interface BrowserNavigatePreviewArgs {
  url: string;
  title?: string;
}

export interface BrowserClosePreviewArgs {
  stopLinkedProcess?: boolean;
}

export interface BrowserOpenPageArgs {
  url: string;
  title?: string;
}

export interface BrowserNavigatePageArgs {
  url: string;
  title?: string;
}

export interface BrowserClickArgs {
  selector: string;
  selectorType?: string;
  waitForNavigation?: boolean;
  timeoutSeconds?: number;
}

export interface BrowserInputArgs {
  selector: string;
  text: string;
  selectorType?: string;
  clear?: boolean;
  submit?: boolean;
  waitForNavigation?: boolean;
  timeoutSeconds?: number;
}

export interface BrowserReadDomArgs {
  selector?: string;
  selectorType?: string;
  contentType?: string;
  timeoutSeconds?: number;
}

export interface BrowserScreenshotArgs {
  relativePath?: string;
  selector?: string;
  selectorType?: string;
  format?: string;
  timeoutSeconds?: number;
}

export interface BrowserClosePageArgs {
  stopLinkedProcess?: boolean;
}

export interface ShellOpenSessionArgs {
  shell?: string;
}

export interface ShellSessionIdArgs {
  sessionId: string;
}

export interface ShellSendInputArgs {
  sessionId: string;
  input?: string;
  command?: string;
  args?: string[];
}

export interface ProjectGraphArgs {
  view?: string;
  relativePath?: string;
  maxDepth?: number;
  maxFiles?: number;
  maxTreeEntries?: number;
  maxSymbolsPerFile?: number;
  maxEdges?: number;
  maxBytes?: number;
}

export interface _GitOperationResult {
  available: boolean;
  isRepo: boolean;
  ok: boolean;
  action: 'branch_checkout' | 'stage' | 'commit' | 'restore' | 'reset';
  message: string;
  raw: string;
  branch?: string;
  changedFiles?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  backupBranch?: string;
  stashRef?: string;
  target?: string;
}

export interface ApplyPatchArgs {
  relativePath: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
  expectedOccurrences?: number;
}

export interface ApplyPatchResult extends WriteTextFileResult {
  replacements: number;
  diagnostics?: unknown[];
  notes?: string[];
}

export interface WriteFileResult extends WriteTextFileResult {
  diagnostics?: unknown[];
  notes?: string[];
}

export interface ApplyDiffPatchArgs extends ApplyPatchArgs {
  relativePath: string;
}

export interface ApplyDiffArgs {
  patches: ApplyDiffPatchArgs[];
}

export interface ApplyDiffFileResult extends WriteTextFileResult {
  patches: number;
  replacements: number;
  diagnostics?: unknown[];
}

export interface ApplyDiffResult {
  files: ApplyDiffFileResult[];
  totalFiles: number;
  totalPatches: number;
  totalReplacements: number;
  notes?: string[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  abstract: string;
  abstractUrl: string;
  results: WebSearchResult[];
  /** SearXNG 不可用/返回空，已降级到内置多源聚合 */
  degraded?: boolean;
  /** 降级或源失败说明 */
  note?: string;
  /** 实际贡献了结果的搜索源 */
  sources?: string[];
}

export interface WebFetchUrlResult {
  url: string;
  status: number;
  content: string;
  truncated: boolean;
  contentType?: string | null;
}

export interface LocalTimeNowResult {
  iso: string;
  local: string;
  date: string;
  time: string;
  weekday: string;
  timeZone: string;
  offsetMinutes: number;
  unixMs: number;
}

export interface PathSearchMatch {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  preview: string;
  column?: number;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
  /** 正则编译失败后已降级为字面量搜索 */
  regexDegraded?: boolean;
  /** 因读取失败/解码失败（二进制）/超出大小限制而被跳过的文件数 */
  skippedFiles?: number;
  note?: string;
}

export interface PathSearchResult {
  query: string;
  matches: PathSearchMatch[];
  truncated: boolean;
  /** 正则编译失败后已降级为字面量搜索 */
  regexDegraded?: boolean;
  note?: string;
}

export interface DownloadFileResult {
  url: string;
  path: string;
  bytes: number;
  fileName: string;
  contentType?: string | null;
  /** 目标路径原本已有文件（被本次下载覆盖） */
  overwritten?: boolean;
}

export interface BackgroundCommandResult {
  command: string;
  args: string[];
  pid: number | null;
  started: boolean;
  previewUrl?: string | null;
}

export type WorkspaceMutationListener = (paths: string[]) => void;

export interface BackgroundProcessEntry {
  pid: number;
  command: string;
  args: string[];
  workspacePath: string;
  startedAt: number;
  previewUrl?: string | null;
  logTail: string;
}

export interface StopBackgroundProcessResult {
  pid: number;
  stopped: boolean;
  /** stopped=false 时的原因："not-found"（已退出，良性）/"kill-failed"（可能仍在运行）。 */
  reason?: string | null;
}

export interface StopAllBackgroundProcessesResult {
  stopped: number;
}

export interface BrowserPreviewStateResult {
  session: PreviewSession | null;
}

export interface BrowserClosePreviewResult {
  closed: boolean;
  stoppedLinkedProcess: boolean;
}

export interface BrowserPageSessionResult {
  url: string;
  title: string;
  workspacePath: string;
  startedAt: number;
  active: boolean;
}

export interface BrowserPageActionResult {
  action: string;
  url: string;
  title: string;
  selector?: string;
  selectorType?: string;
}

export interface BrowserPageDomResult {
  url: string;
  title: string;
  selector?: string;
  selectorType?: string;
  contentType: string;
  content: string;
  truncated: boolean;
}

export interface BrowserPageScreenshotResult {
  url: string;
  title: string;
  path: string;
  bytes: number;
  format: string;
  selector?: string;
  selectorType?: string;
}

export interface BrowserPageCloseResult {
  workspacePath: string;
  closed: boolean;
}

export interface ShellSessionResult {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
}

export interface ShellSessionEntry {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
  active: boolean;
}

export interface ShellReadOutputResult {
  sessionId: string;
  outputTail: string;
  active: boolean;
}

export interface ShellSendInputResult {
  sessionId: string;
  accepted: boolean;
}

export interface ShellCloseSessionResult {
  sessionId: string;
  closed: boolean;
}

export function requireWorkspace(workspacePath: string): string {
  if (!workspacePath.trim()) {
    throw new Error('请先在工作台选择项目文件夹');
  }
  return workspacePath;
}


export function syncPreviewWithPage(
  workspacePath: string,
  page: Pick<BrowserPageSessionResult | BrowserPageActionResult | BrowserPageDomResult | BrowserPageScreenshotResult, 'url' | 'title'>,
  titleOverride?: string
): PreviewSession {
  return {
    pid: null,
    url: page.url,
    title: titleOverride ?? page.title,
    workspacePath,
    openedAt: Date.now(),
  };
}

/** 把浏览器页面会话同步到内置浏览器视图 store（驱动工具栏指示与面板）。 */
export function syncBrowserViewPage(
  workspacePath: string,
  page: Pick<BrowserPageSessionResult | BrowserPageActionResult | BrowserPageDomResult | BrowserPageScreenshotResult, 'url' | 'title'>,
  titleOverride?: string
): void {
  useBrowserViewStore.getState().setPageSession({
    url: page.url,
    title: titleOverride ?? page.title,
    workspacePath,
    startedAt: Date.now(),
  });
}

export function asHttpOrHttpsUrl(value: unknown, name: string): string {
  const raw = asString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} 必须是有效 URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} 只允许 http:// 或 https:// URL`);
  }

  return parsed.toString();
}


