import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import ignore, { type Ignore } from 'ignore';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGitBackupBranchName,
  buildGitBranchCheckoutPlans,
  buildGitCommitCommandArgs as buildSharedGitCommitCommandArgs,
  buildGitHistoryCommandArgs,
  buildGitLatestStashCommandArgs,
  buildGitResetCommandArgs,
  buildGitRestoreCommandPlans,
  buildGitSafetyStashMessage,
  buildGitStageCommandArgs,
  buildGitStashPushArgs,
  parseGitHistoryCommandResult,
  parseGitLatestStashCommandResult,
  type GitHistorySummary,
} from '@codepapr/common';
import { sanitizeSpawnEnv } from './spawnEnv';
import {
  applySearchReplaceDiff,
  applySearchReplacePatch,
  buildGitDiffSummary,
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMap,
  parseGitRepositoryRootCommandResult,
  parseGitStatusCommandResult,
  selectProjectMapFiles,
  type CommandResultLike,
  type GitDiffSummary,
  type GitStatusSummary,
  type WorkspaceProjectGraphResult,
  type WorkspaceListEntry,
  type WorkspaceProjectMapResult,
  type LspProjectGraphEnhancer,
} from './workspaceToolUtils';
import { WorkspaceProjectGraphCache } from './workspaceProjectGraphCache';

const MAX_DEPTH = 6;
const DEFAULT_MAX_DEPTH = 2;
const MAX_ENTRIES = 2_000;
const DEFAULT_MAX_READ_BYTES = 500_000;
const MAX_READ_BYTES = 1_000_000;
const MAX_PATCH_BYTES = 20_000_000;
const MAX_RANGE_SOURCE_BYTES = 20_000_000;
const DEFAULT_ANCHORED_CONTEXT_LINES = 20;
const MAX_READ_CONTEXT_LINES = 200;
const MAX_WRITE_BYTES = 20_000_000;
const MAX_OUTPUT_BYTES = 120_000;
const MAX_COMMAND_SECONDS = 600;
const MAX_SEARCH_RESULTS = 80;
const MAX_PATH_SEARCH_RESULTS = 120;
const DEFAULT_SEARCH_MAX_FILE_BYTES = 500_000;
const MAX_SEARCH_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_SEARCH_CONTEXT_LINES = 0;
const MAX_SEARCH_CONTEXT_LINES = 8;
const DEFAULT_SEARCH_MAX_MATCHES_PER_FILE = 5;
const MAX_SEARCH_MAX_MATCHES_PER_FILE = 20;
const GIT_DIFF_TRUNCATION_THRESHOLD = 190_000;

const IGNORED_DIRS = new Set([
  '.git',
  '.CodePapr',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
]);

const BLOCKED_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'sudo',
  'su',
  'doas',
  'login',
  'ssh',
  'scp',
  'sftp',
  'osascript',
]);

export interface ListFilesResult {
  root: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
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

export interface ReadFileOptions {
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
  aroundLine?: number;
  contextLines?: number;
}

export interface WriteFileChangeSummary {
  kind: 'created' | 'updated';
  added: number;
  deleted: number;
  beforeLines: number;
  afterLines: number;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  change: WriteFileChangeSummary;
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
}

export interface PathSearchMatch {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface PathSearchResult {
  query: string;
  matches: PathSearchMatch[];
  truncated: boolean;
}

export interface GitOperationResult {
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

export interface SearchTextOptions {
  caseSensitive?: boolean;
  isRegexp?: boolean;
  contextLines?: number;
  maxResults?: number;
  maxMatchesPerFile?: number;
  maxBytesPerFile?: number;
}

export interface SearchFilesOptions {
  caseSensitive?: boolean;
  isRegexp?: boolean;
  maxResults?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ApplyPatchArgs {
  relativePath: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
  expectedOccurrences?: number;
}

export interface ApplyPatchResult extends WriteFileResult {
  replacements: number;
}

export interface ApplyDiffPatchArgs extends ApplyPatchArgs {
  relativePath: string;
}

export interface ApplyDiffArgs {
  patches: ApplyDiffPatchArgs[];
}

export interface ApplyDiffFileResult extends WriteFileResult {
  patches: number;
  replacements: number;
}

export interface ApplyDiffResult {
  files: ApplyDiffFileResult[];
  totalFiles: number;
  totalPatches: number;
  totalReplacements: number;
}

interface PathLocationInput {
  path: string;
  line?: number;
  column?: number;
}

interface EffectiveReadWindow {
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByRange: boolean;
  locationLine?: number;
  locationColumn?: number;
}

interface PreparedSearchOptions {
  rawQuery: string;
  matcher: RegExp;
  caseSensitive: boolean;
  contextLines: number;
  maxResults: number;
  maxMatchesPerFile: number;
  maxBytesPerFile: number;
}

function trimOutput(value: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8');
}

function splitTextLines(content: string): { lines: string[]; totalLines: number; hasTrailingNewline: boolean } {
  if (!content) {
    return {
      lines: [],
      totalLines: 0,
      hasTrailingNewline: false,
    };
  }

  const normalized = content.replace(/\r\n/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  return {
    lines,
    totalLines: lines.length,
    hasTrailingNewline,
  };
}

function splitLines(content: string): string[] {
  return splitTextLines(content).lines;
}

function normalizeRelativePath(relativePath?: string): string {
  const raw = (relativePath ?? '').trim();
  if (!raw || raw === '.') return '';
  const parts = raw.split(/[\\/]+/);
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error('路径不能包含 ..');
    }
    normalized.push(part);
  }

  return normalized.join('/');
}

function parseWorkspacePathInput(relativePath?: string): PathLocationInput {
  let value = (relativePath ?? '').trim();
  if (!value) {
    return { path: '' };
  }

  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value);
    } catch (e) {
      console.warn('fileURLToPath failed, keeping raw value:', e);
    }
  }

  let line: number | undefined;
  let column: number | undefined;

  const hashIndex = value.lastIndexOf('#');
  if (hashIndex > 0) {
    const fragment = value.slice(hashIndex + 1);
    const match = fragment.match(/^L(\d+)(?:C(\d+))?/i);
    if (match) {
      line = Number(match[1]);
      column = match[2] ? Number(match[2]) : undefined;
      value = value.slice(0, hashIndex);
    }
  }

  if (line === undefined) {
    const lineSuffix = value.match(/^(.*?)(?::(\d+))(?:[:](\d+))?$/);
    if (lineSuffix?.[1]) {
      value = lineSuffix[1];
      line = Number(lineSuffix[2]);
      column = lineSuffix[3] ? Number(lineSuffix[3]) : undefined;
    }
  }

  const normalizedPath = value.trim();
  return {
    path: normalizedPath,
    line: Number.isFinite(line) && line && line > 0 ? line : undefined,
    column: Number.isFinite(column) && column && column > 0 ? column : undefined,
  };
}

function sanitizeWorkspacePathInput(relativePath?: string): string {
  return parseWorkspacePathInput(relativePath).path;
}

function clampLineNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function computeEffectiveReadWindow(
  totalLines: number,
  options: ReadFileOptions,
  hint: PathLocationInput
): EffectiveReadWindow {
  if (totalLines === 0) {
    return {
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      truncatedByRange: false,
      locationLine: hint.line,
      locationColumn: hint.column,
    };
  }

  const explicitAroundLine = clampLineNumber(options.aroundLine, 0);
  const effectiveAroundLine = explicitAroundLine > 0 ? explicitAroundLine : hint.line;
  const requestedContextLines = clampLineNumber(
    options.contextLines,
    DEFAULT_ANCHORED_CONTEXT_LINES
  );
  const contextLines = Math.min(MAX_READ_CONTEXT_LINES, Math.max(0, requestedContextLines));

  let startLine = 1;
  let endLine = totalLines;

  if (effectiveAroundLine) {
    const center = Math.min(totalLines, Math.max(1, effectiveAroundLine));
    startLine = Math.max(1, center - contextLines);
    endLine = Math.min(totalLines, center + contextLines);
  } else if (options.startLine !== undefined || options.endLine !== undefined) {
    startLine = Math.min(totalLines, clampLineNumber(options.startLine, 1));
    endLine = Math.min(totalLines, clampLineNumber(options.endLine, totalLines));
    if (endLine < startLine) {
      throw new Error('endLine 不能小于 startLine');
    }
  }

  return {
    startLine,
    endLine,
    totalLines,
    truncatedByRange: startLine !== 1 || endLine !== totalLines,
    locationLine: effectiveAroundLine ? Math.min(totalLines, Math.max(1, effectiveAroundLine)) : hint.line,
    locationColumn: hint.column,
  };
}

function sliceContentByWindow(
  content: string,
  window: EffectiveReadWindow
): { content: string; bytes: number } {
  if (!content || window.totalLines === 0 || window.startLine === 0 || window.endLine === 0) {
    return { content: '', bytes: 0 };
  }

  const { lines, hasTrailingNewline } = splitTextLines(content);
  const selected = lines.slice(window.startLine - 1, window.endLine);
  let nextContent = selected.join('\n');
  if (
    selected.length > 0 &&
    (window.endLine < window.totalLines || hasTrailingNewline)
  ) {
    nextContent += '\n';
  }

  return {
    content: nextContent,
    bytes: Buffer.byteLength(nextContent, 'utf8'),
  };
}

function isProbablyBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return true;
  }

  let suspicious = 0;
  for (const byte of bytes) {
    if ((byte >= 0x01 && byte <= 0x08) || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f)) {
      suspicious += 1;
    }
  }

  return suspicious > 0 && suspicious * 100 > Math.max(1, bytes.length);
}

function decodeTextBuffer(buffer: Buffer): string {
  if (isProbablyBinaryContent(buffer)) {
    throw new Error('文件包含二进制内容，拒绝作为文本读取');
  }

  const utf8Text = buffer.toString('utf8');
  if (!utf8Text.includes('\uFFFD')) {
    return utf8Text;
  }

  if (isProbablyBinaryContent(buffer)) {
    throw new Error('文件包含二进制内容，拒绝作为文本读取');
  }

  return utf8Text;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveCaseSensitivity(query: string, requested: boolean | undefined): boolean {
  if (requested !== undefined) {
    return requested;
  }

  return /[A-Z]/.test(query);
}

function buildSearchMatcher(query: string, isRegexp: boolean, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(isRegexp ? query : escapeRegexLiteral(query), caseSensitive ? 'g' : 'gi');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`搜索正则无效: ${message}`);
  }
}

function prepareSearchTextOptions(rawQuery: string, options: SearchTextOptions = {}): PreparedSearchOptions {
  const query = rawQuery.trim();
  if (query.length < 2 && !options.isRegexp) {
    throw new Error('搜索关键词至少需要 2 个字符');
  }
  if (!query) {
    throw new Error('搜索关键词不能为空');
  }

  const caseSensitive = resolveCaseSensitivity(query, options.caseSensitive);
  return {
    rawQuery: query,
    matcher: buildSearchMatcher(query, options.isRegexp ?? false, caseSensitive),
    caseSensitive,
    contextLines: Math.min(MAX_SEARCH_CONTEXT_LINES, Math.max(0, options.contextLines ?? DEFAULT_SEARCH_CONTEXT_LINES)),
    maxResults: Math.min(MAX_SEARCH_RESULTS, Math.max(1, options.maxResults ?? MAX_SEARCH_RESULTS)),
    maxMatchesPerFile: Math.min(
      MAX_SEARCH_MAX_MATCHES_PER_FILE,
      Math.max(1, options.maxMatchesPerFile ?? DEFAULT_SEARCH_MAX_MATCHES_PER_FILE)
    ),
    maxBytesPerFile: Math.min(
      MAX_SEARCH_MAX_FILE_BYTES,
      Math.max(1_000, options.maxBytesPerFile ?? DEFAULT_SEARCH_MAX_FILE_BYTES)
    ),
  };
}

function preparePathSearchOptions(rawQuery: string, options: SearchFilesOptions = {}): {
  rawQuery: string;
  matcher: RegExp;
  maxResults: number;
} {
  const query = rawQuery.trim();
  if (!query) {
    throw new Error('文件搜索关键词不能为空');
  }

  const caseSensitive = resolveCaseSensitivity(query, options.caseSensitive);
  return {
    rawQuery: query,
    matcher: buildSearchMatcher(query, options.isRegexp ?? false, caseSensitive),
    maxResults: Math.min(MAX_PATH_SEARCH_RESULTS, Math.max(1, options.maxResults ?? MAX_PATH_SEARCH_RESULTS)),
  };
}

async function buildWorkspaceIgnoreMatcher(workspace: string): Promise<Ignore> {
  const matcher = ignore();
  matcher.add(
    [...IGNORED_DIRS].flatMap((name) => [name, `${name}/**`])
  );

  for (const relativePath of ['.gitignore', '.ignore', '.git/info/exclude']) {
    try {
      const content = await fs.readFile(path.join(workspace, relativePath), 'utf8');
      matcher.add(content);
    } catch (e) {
      // ENOENT 是预期情况：并非每个仓库都有 .ignore / .git/info/exclude。
      // 只对其它真实错误（权限、IO 等）告警，避免在常规测试和 CI 输出里制造噪声。
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('Failed to read ignore file:', relativePath, e);
      }
    }
  }

  return matcher;
}

function isIgnoredByMatcher(matcher: Ignore, relative: string): boolean {
  return matcher.ignores(relative.split(path.sep).join('/'));
}

async function canonicalWorkspace(workspacePath: string): Promise<string> {
  const resolved = await fs.realpath(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error('项目文件夹不是目录');
  }
  return resolved;
}

function ensureInsideWorkspace(workspace: string, target: string): void {
  const relative = path.relative(workspace, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('拒绝访问项目文件夹之外的路径');
  }
}

async function resolveExistingPath(workspacePath: string, relativePath?: string): Promise<{ workspace: string; target: string }> {
  const workspace = await canonicalWorkspace(workspacePath);
  const rawPath = sanitizeWorkspacePathInput(relativePath);
  const candidate = !rawPath || rawPath === '.'
    ? workspace
    : path.isAbsolute(rawPath)
      ? rawPath
      : path.join(workspace, normalizeRelativePath(rawPath));
  const target = await fs.realpath(candidate);
  return { workspace, target };
}

async function resolveWritablePath(workspacePath: string, relativePath: string): Promise<{ workspace: string; target: string }> {
  const workspace = await canonicalWorkspace(workspacePath);
  const rawPath = sanitizeWorkspacePathInput(relativePath);
  if (!rawPath || rawPath === '.') {
    throw new Error('写入文件路径不能为空');
  }
  const target = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.join(workspace, normalizeRelativePath(rawPath));
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const canonicalParent = await fs.realpath(parent);
  ensureInsideWorkspace(workspace, canonicalParent);
  return { workspace, target };
}

function relativeString(workspace: string, target: string): string {
  return path.relative(workspace, target).split(path.sep).join('/');
}

async function collectEntries(
  workspace: string,
  current: string,
  depth: number,
  maxDepth: number,
  entries: WorkspaceListEntry[]
): Promise<boolean> {
  if (entries.length >= MAX_ENTRIES) {
    return true;
  }

  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  let truncated = false;

  for (const child of children) {
    if (entries.length >= MAX_ENTRIES) {
      return true;
    }

    if (child.isDirectory() && IGNORED_DIRS.has(child.name)) {
      continue;
    }

    const childPath = path.join(current, child.name);
    const stat = await fs.stat(childPath);
    entries.push({
      path: relativeString(workspace, childPath),
      name: child.name,
      isDir: child.isDirectory(),
      bytes: child.isDirectory() ? 0 : stat.size,
    });

    if (child.isDirectory() && depth < maxDepth) {
      truncated = (await collectEntries(workspace, childPath, depth + 1, maxDepth, entries)) || truncated;
    }
  }

  return truncated;
}

function computeLineDiffCounts(beforeLines: string[], afterLines: string[]): { added: number; deleted: number } {
  const beforeLength = beforeLines.length;
  const afterLength = afterLines.length;
  const maxDepth = beforeLength + afterLength;
  const frontier = new Map<number, number>();
  const trace: Map<number, number>[] = [];

  frontier.set(1, 0);

  for (let d = 0; d <= maxDepth; d += 1) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      const down = frontier.get(k + 1) ?? 0;
      const right = (frontier.get(k - 1) ?? 0) + 1;
      let x = k === -d || (k !== d && down > right) ? down : right;
      let y = x - k;

      while (x < beforeLength && y < afterLength && beforeLines[x] === afterLines[y]) {
        x += 1;
        y += 1;
      }

      frontier.set(k, x);
      if (x >= beforeLength && y >= afterLength) {
        let currentX = beforeLength;
        let currentY = afterLength;
        let added = 0;
        let deleted = 0;

        for (let depthIndex = trace.length - 1; depthIndex >= 0; depthIndex -= 1) {
          const currentK = currentX - currentY;
          const snapshot = trace[depthIndex]!;
          const previousK =
            currentK === -depthIndex || (currentK !== depthIndex && (snapshot.get(currentK + 1) ?? 0) > ((snapshot.get(currentK - 1) ?? 0) + 1))
              ? currentK + 1
              : currentK - 1;
          const previousX = snapshot.get(previousK) ?? 0;
          const previousY = previousX - previousK;

          while (currentX > previousX && currentY > previousY) {
            currentX -= 1;
            currentY -= 1;
          }

          if (depthIndex === 0) {
            break;
          }

          if (currentX === previousX) {
            added += 1;
            currentY -= 1;
          } else {
            deleted += 1;
            currentX -= 1;
          }
        }

        return { added, deleted };
      }
    }
  }

  return {
    added: Math.max(0, afterLength - beforeLength),
    deleted: Math.max(0, beforeLength - afterLength),
  };
}

function computeLineChangeSummary(existedBefore: boolean, before: string | undefined, after: string): WriteFileChangeSummary {
  const afterLines = splitLines(after);
  if (!existedBefore) {
    return {
      kind: 'created',
      added: afterLines.length,
      deleted: 0,
      beforeLines: 0,
      afterLines: afterLines.length,
    };
  }

  const beforeLines = splitLines(before ?? '');
  const { added, deleted } = computeLineDiffCounts(beforeLines, afterLines);
  return {
    kind: 'updated',
    added,
    deleted,
    beforeLines: beforeLines.length,
    afterLines: afterLines.length,
  };
}

function commandAllowed(command: string): boolean {
  const commandName = path.basename(command);
  return !BLOCKED_COMMANDS.has(commandName);
}

const SHELL_SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.command', '.ksh', '.fish']);

function shellScriptTokenLooksLikeVersionConstraint(token: string): boolean {
  if (/^=\d/.test(token)) {
    return true;
  }
  for (const op of ['>=', '<=', '==', '!=', '~=', '>', '<']) {
    const idx = token.indexOf(op);
    if (idx < 0) continue;
    const left = token.slice(0, idx);
    const right = token.slice(idx + op.length);
    if (!right) continue;
    if (left && !/[A-Za-z]/.test(left)) continue;
    if (!/^\d/.test(right)) continue;
    return true;
  }
  return false;
}

function findVersionConstraintInScriptLine(line: string): string | null {
  let token = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escapeNext = false;
  const flush = (): string | null => {
    if (!token) return null;
    const candidate = token;
    token = '';
    return shellScriptTokenLooksLikeVersionConstraint(candidate) ? candidate : null;
  };
  for (const ch of line) {
    if (escapeNext) {
      escapeNext = false;
      if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '\n') {
          const found = flush();
          if (found) return found;
        } else {
          token += ch;
        }
      }
      continue;
    }
    if (ch === '\\' && !inSingle) { escapeNext = true; continue; }
    if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inBacktick) { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle && !inDouble) { inBacktick = !inBacktick; continue; }
    if (inSingle || inDouble || inBacktick) continue;
    if (/\s/.test(ch) || ch === '|' || ch === '&' || ch === ';' || ch === '(' || ch === ')') {
      const found = flush();
      if (found) return found;
      continue;
    }
    token += ch;
  }
  return flush();
}

async function scanScriptFileForVersionConstraint(
  scriptPath: string
): Promise<string | null> {
  let content: string;
  try {
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile() || stat.size > 500_000) return null;
    content = await fs.readFile(scriptPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const found = findVersionConstraintInScriptLine(line);
    if (found) return found;
  }
  return null;
}

function looksLikeShellScript(command: string): boolean {
  const ext = path.extname(command).toLowerCase();
  return SHELL_SCRIPT_EXTENSIONS.has(ext);
}

export async function listWorkspaceFiles(
  workspacePath: string,
  relativePath?: string,
  maxDepth?: number
): Promise<ListFilesResult> {
  const depth = Math.min(MAX_DEPTH, Math.max(1, maxDepth ?? DEFAULT_MAX_DEPTH));
  const { workspace, target } = await resolveExistingPath(workspacePath, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new Error('列出文件需要传入目录路径');
  }

  const entries: WorkspaceListEntry[] = [];
  const truncated = await collectEntries(workspace, target, 0, depth, entries);
  return {
    root: relativeString(workspace, target),
    entries,
    truncated,
  };
}

export async function readWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  options?: number | ReadFileOptions
): Promise<ReadFileResult> {
  const normalizedOptions: ReadFileOptions =
    typeof options === 'number' ? { maxBytes: options } : (options ?? {});
  const byteLimit = Math.min(
    MAX_READ_BYTES,
    Math.max(1_000, normalizedOptions.maxBytes ?? DEFAULT_MAX_READ_BYTES)
  );
  const locationHint = parseWorkspacePathInput(relativePath);
  const { workspace, target } = await resolveExistingPath(workspacePath, locationHint.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error('读取文本需要传入文件路径');
  }

  const hasRequestedWindow =
    normalizedOptions.startLine !== undefined ||
    normalizedOptions.endLine !== undefined ||
    normalizedOptions.aroundLine !== undefined ||
    locationHint.line !== undefined;
  const sourceByteLimit = hasRequestedWindow ? MAX_RANGE_SOURCE_BYTES : byteLimit;

  let truncatedByBytes = stat.size > sourceByteLimit;

  const buffer = await fs.readFile(target);
  let content = decodeTextBuffer(buffer);
  if (truncatedByBytes) {
    content = content.slice(0, sourceByteLimit);
  }

  if (!hasRequestedWindow) {
    const fullBytes = Buffer.byteLength(content, 'utf8');
    if (fullBytes > byteLimit) {
      content = content.slice(0, byteLimit);
      truncatedByBytes = true;
    }
  }

  const split = splitTextLines(content);
  const window = computeEffectiveReadWindow(split.totalLines, normalizedOptions, locationHint);
  const ranged = sliceContentByWindow(content, window);
  if (hasRequestedWindow) {
    let selected = ranged.content;
    const selectedBytes = Buffer.byteLength(selected, 'utf8');
    if (selectedBytes > byteLimit) {
      selected = selected.slice(0, byteLimit);
      truncatedByBytes = true;
    }
    return {
      path: relativeString(workspace, target),
      content: selected,
      bytes: Buffer.byteLength(selected, 'utf8'),
      startLine: window.startLine,
      endLine: window.endLine,
      totalLines: window.totalLines,
      truncatedByRange: window.truncatedByRange,
      truncatedByBytes,
      locationLine: window.locationLine,
      locationColumn: window.locationColumn,
    };
  }

  return {
    path: relativeString(workspace, target),
    content: content,
    bytes: Buffer.byteLength(content, 'utf8'),
    startLine: window.startLine,
    endLine: window.endLine,
    totalLines: window.totalLines,
    truncatedByRange: window.truncatedByRange,
    truncatedByBytes,
    locationLine: window.locationLine,
    locationColumn: window.locationColumn,
  };
}

export interface WorkspaceEditRecord {
  path: string;
  before: string | null;
  after: string | null;
}

export async function writeWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  content: string,
  onEdit?: (record: WorkspaceEditRecord) => void
): Promise<WriteFileResult> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`写入内容超过上限 ${MAX_WRITE_BYTES} bytes`);
  }

  const { workspace, target } = await resolveWritablePath(workspacePath, relativePath);
  let previousContent: string | undefined;
  let existedBefore = false;

  try {
    previousContent = await fs.readFile(target, 'utf8');
    existedBefore = true;
  } catch {
    existedBefore = false;
  }

  const tmpPath = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, target);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* clean up */ }
    throw err;
  }

  const resolvedPath = relativeString(workspace, target);
  if (onEdit) {
    onEdit({
      path: resolvedPath,
      before: existedBefore ? previousContent ?? '' : null,
      after: content,
    });
  }
  return {
    path: resolvedPath,
    bytes,
    change: computeLineChangeSummary(existedBefore, previousContent, content),
  };
}

// ──── ripgrep 快速路径 ────

let _rgPath: string | null | undefined;

async function findRg(): Promise<string | null> {
  if (_rgPath !== undefined) return _rgPath;

  try {
    const result = execSync('command -v rg 2>/dev/null || which rg 2>/dev/null', {
      encoding: 'utf8',
      timeout: 3000,
    });
    const found = result.trim();
    if (found) {
      _rgPath = found;
      return _rgPath;
    }
  } catch {
    // not found
  }

  _rgPath = null;
  return null;
}

function buildRgExtraIgnores(): string[] {
  return ['-g', '!.CodePapr/**'];
}

interface RgJsonMatchLine {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

async function tryRgTextSearch(
  workspace: string,
  rawQuery: string,
  options: SearchTextOptions
): Promise<SearchResult | null> {
  const rg = await findRg();
  if (!rg) return null;

  const maxPerFile = options.maxMatchesPerFile ?? DEFAULT_SEARCH_MAX_MATCHES_PER_FILE;
  const contextLines = options.contextLines ?? 0;
  const maxFileSize = options.maxBytesPerFile ?? DEFAULT_SEARCH_MAX_FILE_BYTES;

  const args: string[] = [
    '--json',
    '--no-config',
    '--max-count', String(maxPerFile),
    '--max-filesize', String(maxFileSize),
    ...buildRgExtraIgnores(),
    '--regexp', rawQuery,
    workspace,
  ];

  if (!options.caseSensitive) {
    args.splice(1, 0, '--ignore-case');
  }

  if (options.isRegexp) {
    args.splice(1, 0, '--engine', 'auto');
    // always regex in rg, just pass through
  } else {
    // literal search → use -F flag
    args.splice(1, 0, '--fixed-strings');
  }

  if (contextLines > 0) {
    args.splice(1, 0, '--context', String(contextLines));
  }

  return new Promise((resolve) => {
    const proc = spawn(rg, args, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv(process.env),
    });

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    let done = false;
    const finish = (result: SearchResult | null) => {
      if (done) return;
      done = true;
      proc.kill();
      resolve(result);
    };

    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) { finish(null); return; }
      try {
        resolve(parseRgSearchResult(stdout, rawQuery, maxPerFile));
      } catch {
        resolve(null);
      }
    });

    proc.on('error', () => finish(null));

    setTimeout(() => finish(null), 30_000);
  });
}

function parseRgSearchResult(stdout: string, query: string, maxPerFile: number): SearchResult {
  const matches: SearchMatch[] = [];
  let fileMatchCount = 0;
  let _currentPath = '';
  let truncated = false;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let entry: RgJsonMatchLine;
    try {
      entry = JSON.parse(line) as RgJsonMatchLine;
    } catch {
      continue;
    }

    if (entry.type !== 'match') {
      if (entry.type === 'begin' && entry.data?.path?.text) {
        _currentPath = entry.data.path.text;
        fileMatchCount = 0;
      }
      continue;
    }

    if (fileMatchCount >= maxPerFile) continue;
    fileMatchCount += 1;

    if (matches.length >= MAX_SEARCH_RESULTS) {
      truncated = true;
      break;
    }

    const data = entry.data;
    const linesText = data.lines.text;
    const matchLineNum = data.line_number;
    const submatch = data.submatches?.[0];
    const column = submatch ? submatch.start + 1 : undefined;

    const allLines = linesText.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

    let matchIdx = -1;
    if (allLines.length === 1) {
      matchIdx = 0;
    } else {
      const subText = submatch?.match?.text ?? '';
      matchIdx = allLines.findIndex((l) => l.includes(subText));
      if (matchIdx < 0) matchIdx = Math.floor(allLines.length / 2);
    }

    const preview = allLines[matchIdx]?.trim().slice(0, 240) ?? allLines[0]?.trim().slice(0, 240) ?? '';
    const contextBefore = allLines.slice(0, matchIdx).length > 0 ? allLines.slice(0, matchIdx) : undefined;
    const contextAfter = allLines.slice(matchIdx + 1).length > 0 ? allLines.slice(matchIdx + 1) : undefined;

    matches.push({
      path: data.path.text,
      line: matchLineNum,
      preview,
      column,
      contextBefore,
      contextAfter,
    });
  }

  return { query, matches, truncated };
}

async function tryRgFileSearch(
  workspace: string,
  rawQuery: string,
  options: SearchFilesOptions
): Promise<PathSearchResult | null> {
  const rg = await findRg();
  if (!rg) return null;

  const maxResults = options.maxResults ?? MAX_PATH_SEARCH_RESULTS;

  // Use rg --files with -g to filter by pattern
  const globPattern = options.isRegexp ? undefined : rawQuery;

  const args: string[] = [
    '--files',
    '--no-config',
    ...buildRgExtraIgnores(),
  ];

  if (globPattern) {
    args.push('--glob', globPattern);
  }

  // For regex queries, pipe through rg --files | rg regex
  const isRegex = options.isRegexp === true;
  if (isRegex) {
    args.push('--glob', '*');
  }

  args.push(workspace);

  return new Promise((resolve) => {
    const proc = spawn(rg, args, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv(process.env),
    });

    let stdout = '';

    let done = false;
    const finish = (result: PathSearchResult | null) => {
      if (done) return;
      done = true;
      proc.kill();
      resolve(result);
    };

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) { finish(null); return; }

      const filePaths = stdout.trim().split('\n').filter(Boolean);

      // For regex queries, filter file paths by regex
      let filtered = filePaths;
      if (isRegex) {
        try {
          const flags = options.caseSensitive ? '' : 'i';
          const re = new RegExp(rawQuery, flags);
          filtered = filePaths.filter((p) => re.test(p));
        } catch {
          finish(null); return;
        }
      }

      const matches: PathSearchMatch[] = [];
      for (const filePath of filtered) {
        if (matches.length >= maxResults) break;
        matches.push({
          path: filePath,
          name: path.basename(filePath),
          isDir: false,
          bytes: 0,
        });
      }

      resolve({ query: rawQuery, matches, truncated: filtered.length > maxResults });
    });

    proc.on('error', () => finish(null));

    setTimeout(() => finish(null), 30_000);
  });
}

// ──── 搜索实现 ────

async function collectSearchMatches(
  workspace: string,
  current: string,
  matcher: Ignore,
  options: PreparedSearchOptions,
  matches: SearchMatch[]
): Promise<boolean> {
  if (matches.length >= options.maxResults) {
    return true;
  }

  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  let truncated = false;

  for (const child of children) {
    if (matches.length >= options.maxResults) {
      return true;
    }

    const childPath = path.join(current, child.name);
    const relative = relativeString(workspace, childPath);
    if (relative && isIgnoredByMatcher(matcher, relative)) {
      continue;
    }

    if (child.isDirectory()) {
      if (!IGNORED_DIRS.has(child.name)) {
        truncated =
          (await collectSearchMatches(workspace, childPath, matcher, options, matches)) ||
          truncated;
      }
      continue;
    }

    const stat = await fs.stat(childPath);
    if (stat.size > options.maxBytesPerFile) {
      continue;
    }

    let content: string;
    try {
      content = decodeTextBuffer(await fs.readFile(childPath));
    } catch {
      continue;
    }

    const { lines, totalLines } = splitTextLines(content);
    let matchedInFile = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= options.maxResults) {
        return true;
      }
      if (matchedInFile >= options.maxMatchesPerFile) {
        break;
      }

      const line = lines[index] ?? '';
      options.matcher.lastIndex = 0;
      const match = options.matcher.exec(line);
      if (!match) {
        continue;
      }

      matchedInFile += 1;
      matches.push({
        path: relative,
        line: index + 1,
        preview: line.trim().slice(0, 240),
        column: typeof match.index === 'number' ? match.index + 1 : undefined,
        contextBefore:
          options.contextLines > 0
            ? lines.slice(Math.max(0, index - options.contextLines), index)
            : undefined,
        contextAfter:
          options.contextLines > 0
            ? lines.slice(index + 1, Math.min(totalLines, index + 1 + options.contextLines))
            : undefined,
      });
    }
  }

  return truncated;
}

export async function searchWorkspaceText(
  workspacePath: string,
  rawQuery: string,
  options: SearchTextOptions = {}
): Promise<SearchResult> {
  const prepared = prepareSearchTextOptions(rawQuery, options);
  const workspace = await canonicalWorkspace(workspacePath);

  const rgResult = await tryRgTextSearch(workspace, rawQuery, options);
  if (rgResult) return rgResult;

  const ignoreMatcher = await buildWorkspaceIgnoreMatcher(workspace);
  const matches: SearchMatch[] = [];
  const truncated = await collectSearchMatches(workspace, workspace, ignoreMatcher, prepared, matches);
  return { query: prepared.rawQuery, matches, truncated };
}

async function collectPathMatches(
  workspace: string,
  current: string,
  matcher: Ignore,
  searchMatcher: RegExp,
  maxResults: number,
  matches: PathSearchMatch[]
): Promise<boolean> {
  if (matches.length >= maxResults) {
    return true;
  }

  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  let truncated = false;

  for (const child of children) {
    if (matches.length >= maxResults) {
      return true;
    }

    const childPath = path.join(current, child.name);
    const stat = await fs.stat(childPath);
    const relative = relativeString(workspace, childPath);
    if (relative && isIgnoredByMatcher(matcher, relative)) {
      continue;
    }

    searchMatcher.lastIndex = 0;
    const pathMatched = searchMatcher.test(relative);
    searchMatcher.lastIndex = 0;
    const nameMatched = searchMatcher.test(child.name);
    if (pathMatched || nameMatched) {
      matches.push({
        path: relative,
        name: child.name,
        isDir: child.isDirectory(),
        bytes: child.isDirectory() ? 0 : stat.size,
      });
    }

    if (child.isDirectory() && !IGNORED_DIRS.has(child.name)) {
      truncated =
        (await collectPathMatches(workspace, childPath, matcher, searchMatcher, maxResults, matches)) ||
        truncated;
    }
  }

  return truncated;
}

export async function searchWorkspaceFiles(
  workspacePath: string,
  rawQuery: string,
  options: SearchFilesOptions = {}
): Promise<PathSearchResult> {
  const workspace = await canonicalWorkspace(workspacePath);

  const rgResult = await tryRgFileSearch(workspace, rawQuery, options);
  if (rgResult) return rgResult;

  const prepared = preparePathSearchOptions(rawQuery, options);
  const ignoreMatcher = await buildWorkspaceIgnoreMatcher(workspace);
  const matches: PathSearchMatch[] = [];
  const truncated = await collectPathMatches(
    workspace,
    workspace,
    ignoreMatcher,
    prepared.matcher,
    prepared.maxResults,
    matches
  );
  return { query: prepared.rawQuery, matches, truncated };
}

export async function runWorkspaceCommand(
  workspacePath: string,
  command: string,
  args?: string[],
  timeoutSeconds?: number
): Promise<CommandResult> {
  if (!commandAllowed(command)) {
    throw new Error(
      `命令 \`${command}\` 被安全策略阻止。已阻止的入口: ${Array.from(BLOCKED_COMMANDS).join(', ')}`
    );
  }

  const workspace = await canonicalWorkspace(workspacePath);

  if (looksLikeShellScript(command)) {
    const scriptPath = path.isAbsolute(command) ? command : path.join(workspace, command);
    const constraint = await scanScriptFileForVersionConstraint(scriptPath);
    if (constraint) {
      throw new Error(
        `脚本 \`${command}\` 包含未加引号的版本约束 \`${constraint}\`，` +
        `shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。` +
        `请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。`
      );
    }
  }

  const commandArgs = args ?? [];
  const timeoutMs = Math.min(MAX_COMMAND_SECONDS, Math.max(1, timeoutSeconds ?? 30)) * 1_000;
  let spawnCommand = command;
  let spawnArgs = commandArgs;
  let useShell = false;

  if (process.platform === 'win32' && command.toLowerCase() === 'npm') {
    const npmCliCandidates = [
      typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath : '',
      path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ].filter(Boolean);
    const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));

    if (npmCliPath) {
      spawnCommand = process.execPath;
      spawnArgs = [npmCliPath, ...commandArgs];
    } else {
      spawnCommand = 'npm.cmd';
      spawnArgs = commandArgs;
      useShell = true;
    }
  }

  return await new Promise<CommandResult>((resolve, _reject) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      env: sanitizeSpawnEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args: spawnArgs,
        status: -1,
        stdout: '',
        stderr: `启动命令失败: ${error.message}`,
        timedOut: false,
      });
    });

    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args: spawnArgs,
        status,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        timedOut,
      });
    });
  });
}

const CODEPAPR_GIT_SUBDIR = '.CodePapr/git/.git';

const codepaprGitRepoReady = new Set<string>();

async function getCodepaprGitPaths(workspacePath: string): Promise<{ gitDir: string; workTree: string }> {
  const workTree = await canonicalWorkspace(workspacePath);
  const gitDir = path.join(workTree, CODEPAPR_GIT_SUBDIR);
  return { gitDir, workTree };
}

function codepaprGitEnv(
  gitDir: string,
  workTree: string
): Record<string, string | undefined> {
  return {
    ...sanitizeSpawnEnv(process.env),
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
  };
}

async function ensureCodepaprGitRepo(workspacePath: string): Promise<{ gitDir: string; workTree: string }> {
  const { gitDir, workTree } = await getCodepaprGitPaths(workspacePath);

  if (codepaprGitRepoReady.has(workTree) || existsSync(path.join(gitDir, 'HEAD'))) {
    codepaprGitRepoReady.add(workTree);
    return { gitDir, workTree };
  }

  await fs.mkdir(gitDir, { recursive: true });
  const env = codepaprGitEnv(gitDir, workTree);

  await new Promise<CommandResultLike>((resolve) => {
    const child = spawn('git', ['init'], { cwd: workTree, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', () => { resolve({ status: 0, stdout: '', stderr }); });
    child.on('error', (err) => { resolve({ status: -1, stdout: '', stderr: err.message }); });
  });

  const excludeDir = path.join(gitDir, 'info');
  await fs.mkdir(excludeDir, { recursive: true });
  await fs.writeFile(
    path.join(excludeDir, 'exclude'),
    '\n# codepapr:git-exclude\n.CodePapr/\n',
    'utf8'
  );

  await new Promise<CommandResultLike>((resolve) => {
    const child = spawn('git', ['add', '-A'], { cwd: workTree, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', () => { resolve({ status: 0, stdout: '', stderr }); });
    child.on('error', (err) => { resolve({ status: -1, stdout: '', stderr: err.message }); });
  });

  await new Promise<CommandResultLike>((resolve) => {
    const child = spawn('git', ['commit', '-m', 'codepapr:baseline', '--allow-empty'], {
      cwd: workTree,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', () => { resolve({ status: 0, stdout: '', stderr }); });
    child.on('error', (err) => { resolve({ status: -1, stdout: '', stderr: err.message }); });
  });

  codepaprGitRepoReady.add(workTree);
  return { gitDir, workTree };
}

async function runGitCommand(workspacePath: string, args: string[]): Promise<CommandResultLike> {
  const { gitDir, workTree } = await ensureCodepaprGitRepo(workspacePath);
  const env = codepaprGitEnv(gitDir, workTree);
  const timeoutMs = 30_000;

  return await new Promise<CommandResultLike>((resolve) => {
    const child = spawn('git', args, { cwd: workTree, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: timedOut ? '' : trimOutput(stdout),
        stderr: timedOut ? '命令超时' : trimOutput(stderr),
      });
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: -1, stdout: '', stderr: `启动 git 失败: ${error.message}` });
    });
  });
}

export async function buildWorkspaceGitStatus(workspacePath: string): Promise<GitStatusSummary> {
  const repoRootResult = parseGitRepositoryRootCommandResult(
    await runGitCommand(workspacePath, ['rev-parse', '--show-toplevel'])
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

  const result = await runGitCommand(workspacePath, ['status', '--short', '--branch']);
  const parsed = parseGitStatusCommandResult(result);
  return parsed.isRepo && repoRootResult.repoRoot
    ? {
        ...parsed,
        repoRoot: repoRootResult.repoRoot,
      }
    : parsed;
}

export async function buildWorkspaceGitDiff(
  workspacePath: string,
  staged: boolean = false,
  pathspecs: string[] = []
): Promise<GitDiffSummary> {
  const argsBase = staged ? ['diff', '--cached'] : ['diff'];
  const filterPathspecs = pathspecs.map((item) => normalizeRelativePath(item)).filter(Boolean);
  const args = filterPathspecs.length > 0 ? [...argsBase, '--', ...filterPathspecs] : argsBase;
  const statArgs = [...argsBase, '--stat', ...(filterPathspecs.length > 0 ? ['--', ...filterPathspecs] : [])];
  const [statResult, diffResult] = await Promise.all([
    runGitCommand(workspacePath, statArgs),
    runGitCommand(workspacePath, args),
  ]);

  return buildGitDiffSummary({
    staged,
    pathspecs: filterPathspecs,
    statResult,
    diffResult,
    truncationThreshold: GIT_DIFF_TRUNCATION_THRESHOLD,
  });
}

function summarizeGitStatusCounts(status: GitStatusSummary): {
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
} {
  let stagedFiles = 0;
  let unstagedFiles = 0;
  for (const file of status.files) {
    if (file.indexStatus && file.indexStatus !== '?') {
      stagedFiles += 1;
    }
    if (file.worktreeStatus || (file.indexStatus === '?' && file.worktreeStatus === '?')) {
      unstagedFiles += 1;
    }
  }

  return {
    changedFiles: status.files.length,
    stagedFiles,
    unstagedFiles,
  };
}

function buildGitActionUnavailableResult(
  action: GitOperationResult['action'],
  status: GitStatusSummary
): GitOperationResult {
  const counts = status.available && status.isRepo ? summarizeGitStatusCounts(status) : undefined;
  return {
    available: status.available,
    isRepo: status.isRepo,
    ok: false,
    action,
    message: status.message || '当前工作区不是 Git 仓库。',
    raw: status.raw,
    ...(status.branch ? { branch: status.branch } : {}),
    ...(counts ?? {}),
  };
}

async function runGitCommandPlan(
  workspacePath: string,
  plans: readonly string[][]
): Promise<{ args: string[]; result: CommandResultLike }> {
  let lastFailure: { args: string[]; result: CommandResultLike } | null = null;

  for (const args of plans) {
    const result = await runGitCommand(workspacePath, args);
    if ((result.status ?? 1) === 0) {
      return { args, result };
    }
    lastFailure = { args, result };
  }

  if (lastFailure) {
    return lastFailure;
  }

  throw new Error('Git 命令计划为空');
}

async function buildGitOperationResult(params: {
  workspacePath: string;
  action: GitOperationResult['action'];
  ok: boolean;
  message: string;
  rawParts: string[];
  backupBranch?: string;
  stashRef?: string;
  target?: string;
}): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(params.workspacePath);
  const counts = status.available && status.isRepo ? summarizeGitStatusCounts(status) : undefined;
  return {
    available: status.available,
    isRepo: status.isRepo,
    ok: params.ok,
    action: params.action,
    message: params.message,
    raw: params.rawParts.filter(Boolean).join('\n').trim(),
    ...(status.branch ? { branch: status.branch } : {}),
    ...(counts ?? {}),
    ...(params.backupBranch ? { backupBranch: params.backupBranch } : {}),
    ...(params.stashRef ? { stashRef: params.stashRef } : {}),
    ...(params.target ? { target: params.target } : {}),
  };
}

export async function buildWorkspaceGitHistory(
  workspacePath: string,
  limit: number = 20
): Promise<GitHistorySummary> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return {
      available: status.available,
      isRepo: status.isRepo,
      entries: [],
      raw: status.raw,
      ...(status.message ? { message: status.message } : {}),
    };
  }

  const result = await runGitCommand(workspacePath, buildGitHistoryCommandArgs(limit));
  return parseGitHistoryCommandResult(result);
}

export async function gitCheckoutWorkspaceBranch(
  workspacePath: string,
  params: {
    branchName: string;
    startPoint?: string;
    create?: boolean;
    createIfMissing?: boolean;
  }
): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return buildGitActionUnavailableResult('branch_checkout', status);
  }

  const plan = await runGitCommandPlan(
    workspacePath,
    buildGitBranchCheckoutPlans({
      branchName: params.branchName,
      startPoint: params.startPoint,
      create: params.create,
      createIfMissing: params.createIfMissing,
    })
  );

  const raw = [plan.result.stdout.trim(), plan.result.stderr.trim()].filter(Boolean).join('\n');
  if ((plan.result.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'branch_checkout',
      ok: false,
      message: raw || `切换分支 ${params.branchName} 失败。`,
      rawParts: [raw],
    });
  }

  return buildGitOperationResult({
    workspacePath,
    action: 'branch_checkout',
    ok: true,
    message: `已切换到分支 ${params.branchName}。`,
    rawParts: [raw],
  });
}

export async function gitStageWorkspaceChanges(
  workspacePath: string,
  params?: {
    all?: boolean;
    pathspecs?: string[];
  }
): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return buildGitActionUnavailableResult('stage', status);
  }

  const args = buildGitStageCommandArgs({ all: params?.all, pathspecs: params?.pathspecs });
  const result = await runGitCommand(workspacePath, args);
  const raw = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  if ((result.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'stage',
      ok: false,
      message: raw || '暂存 Git 改动失败。',
      rawParts: [raw],
    });
  }

  return buildGitOperationResult({
    workspacePath,
    action: 'stage',
    ok: true,
    message: params?.pathspecs?.length
      ? `已暂存 ${params.pathspecs.length} 个路径。`
      : '已暂存当前工作区改动。',
    rawParts: [raw],
  });
}

export async function gitCommitWorkspaceChanges(
  workspacePath: string,
  params: {
    message: string;
    stageAll?: boolean;
    pathspecs?: string[];
    allowEmpty?: boolean;
  }
): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return buildGitActionUnavailableResult('commit', status);
  }

  const rawParts: string[] = [];
  if (params.stageAll === true || (params.pathspecs?.length ?? 0) > 0) {
    const stageResult = await runGitCommand(
      workspacePath,
      buildGitStageCommandArgs({ all: params.stageAll, pathspecs: params.pathspecs })
    );
    rawParts.push(stageResult.stdout.trim(), stageResult.stderr.trim());
    if ((stageResult.status ?? 1) !== 0) {
      return buildGitOperationResult({
        workspacePath,
        action: 'commit',
        ok: false,
        message: stageResult.stderr.trim() || stageResult.stdout.trim() || '提交前暂存失败。',
        rawParts,
      });
    }
  }

  const commitResult = await runGitCommand(
    workspacePath,
    buildSharedGitCommitCommandArgs(params.message, { allowEmpty: params.allowEmpty })
  );
  rawParts.push(commitResult.stdout.trim(), commitResult.stderr.trim());
  if ((commitResult.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'commit',
      ok: false,
      message: commitResult.stderr.trim() || commitResult.stdout.trim() || 'Git 提交失败。',
      rawParts,
    });
  }

  return buildGitOperationResult({
    workspacePath,
    action: 'commit',
    ok: true,
    message: '已创建本地提交。',
    rawParts,
  });
}

export async function gitRestoreWorkspaceChanges(
  workspacePath: string,
  params?: {
    pathspecs?: string[];
    snapshot?: boolean;
    includeUntracked?: boolean;
    source?: string;
  }
): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return buildGitActionUnavailableResult('restore', status);
  }
  if (status.files.length === 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'restore',
      ok: true,
      message: '当前工作区已经是干净状态。',
      rawParts: [],
    });
  }

  const rawParts: string[] = [];
  let stashRef: string | undefined;
  if (params?.snapshot !== false) {
    const stashMessage = buildGitSafetyStashMessage(
      'restore',
      params?.pathspecs?.join(', ') || 'workspace'
    );
    const stashResult = await runGitCommand(
      workspacePath,
      buildGitStashPushArgs(stashMessage, {
        includeUntracked: params?.includeUntracked !== false,
        pathspecs: params?.pathspecs,
      })
    );
    rawParts.push(stashResult.stdout.trim(), stashResult.stderr.trim());
    if ((stashResult.status ?? 1) !== 0) {
      return buildGitOperationResult({
        workspacePath,
        action: 'restore',
        ok: false,
        message: stashResult.stderr.trim() || stashResult.stdout.trim() || '创建安全快照失败。',
        rawParts,
      });
    }
    const latestStash = parseGitLatestStashCommandResult(
      await runGitCommand(workspacePath, buildGitLatestStashCommandArgs())
    );
    stashRef = latestStash?.ref ?? undefined;
  }

  const restorePlan = await runGitCommandPlan(
    workspacePath,
    buildGitRestoreCommandPlans({
      pathspecs: params?.pathspecs,
      source: params?.source,
    })
  );
  rawParts.push(restorePlan.result.stdout.trim(), restorePlan.result.stderr.trim());
  if ((restorePlan.result.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'restore',
      ok: false,
      message: restorePlan.result.stderr.trim() || restorePlan.result.stdout.trim() || '恢复工作区失败。',
      rawParts,
      ...(stashRef ? { stashRef } : {}),
    });
  }

  return buildGitOperationResult({
    workspacePath,
    action: 'restore',
    ok: true,
    message: stashRef ? `已恢复工作区改动，安全快照保存在 ${stashRef}。` : '已恢复工作区改动。',
    rawParts,
    ...(stashRef ? { stashRef } : {}),
  });
}

export async function gitResetWorkspaceToCommit(
  workspacePath: string,
  params: {
    target: string;
    snapshot?: boolean;
    includeUntracked?: boolean;
    backupBranchPrefix?: string;
  }
): Promise<GitOperationResult> {
  const status = await buildWorkspaceGitStatus(workspacePath);
  if (!status.available || !status.isRepo) {
    return buildGitActionUnavailableResult('reset', status);
  }

  const rawParts: string[] = [];
  const backupBranch = buildGitBackupBranchName(params.backupBranchPrefix ?? 'codepapr/backup');
  const backupResult = await runGitCommand(workspacePath, ['branch', backupBranch, 'HEAD']);
  rawParts.push(backupResult.stdout.trim(), backupResult.stderr.trim());
  if ((backupResult.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'reset',
      ok: false,
      message: backupResult.stderr.trim() || backupResult.stdout.trim() || '创建备份分支失败。',
      rawParts,
      backupBranch,
      target: params.target,
    });
  }

  let stashRef: string | undefined;
  if (params.snapshot !== false && status.files.length > 0) {
    const stashMessage = buildGitSafetyStashMessage('reset', params.target);
    const stashResult = await runGitCommand(
      workspacePath,
      buildGitStashPushArgs(stashMessage, {
        includeUntracked: params.includeUntracked !== false,
      })
    );
    rawParts.push(stashResult.stdout.trim(), stashResult.stderr.trim());
    if ((stashResult.status ?? 1) !== 0) {
      return buildGitOperationResult({
        workspacePath,
        action: 'reset',
        ok: false,
        message: stashResult.stderr.trim() || stashResult.stdout.trim() || '创建回退前安全快照失败。',
        rawParts,
        backupBranch,
        target: params.target,
      });
    }
    const latestStash = parseGitLatestStashCommandResult(
      await runGitCommand(workspacePath, buildGitLatestStashCommandArgs())
    );
    stashRef = latestStash?.ref ?? undefined;
  }

  const resetResult = await runGitCommand(workspacePath, buildGitResetCommandArgs(params.target));
  rawParts.push(resetResult.stdout.trim(), resetResult.stderr.trim());
  if ((resetResult.status ?? 1) !== 0) {
    return buildGitOperationResult({
      workspacePath,
      action: 'reset',
      ok: false,
      message: resetResult.stderr.trim() || resetResult.stdout.trim() || '回退到目标提交失败。',
      rawParts,
      backupBranch,
      ...(stashRef ? { stashRef } : {}),
      target: params.target,
    });
  }

  return buildGitOperationResult({
    workspacePath,
    action: 'reset',
    ok: true,
    message: stashRef
      ? `已回退到 ${params.target}，备份分支 ${backupBranch}，安全快照 ${stashRef}。`
      : `已回退到 ${params.target}，备份分支 ${backupBranch}。`,
    rawParts,
    backupBranch,
    ...(stashRef ? { stashRef } : {}),
    target: params.target,
  });
}

export async function buildWorkspaceProjectMapSummary(
  workspacePath: string,
  relativePath?: string,
  maxDepth?: number,
  maxFiles?: number,
  maxTreeEntries?: number,
  maxStubsPerFile?: number,
  maxBytes?: number
): Promise<WorkspaceProjectMapResult> {
  const listResult = await listWorkspaceFiles(workspacePath, relativePath, maxDepth ?? 3);
  const selectedFiles = selectProjectMapFiles(listResult.entries, maxFiles ?? 24);
  const fileContents: Record<string, { content: string; bytes: number }> = {};
  const byteLimit = Math.min(300_000, Math.max(10_000, maxBytes ?? 120_000));

  for (const file of selectedFiles) {
    try {
      const content = await readWorkspaceFile(workspacePath, file.path, byteLimit);
      fileContents[file.path] = {
        content: content.content,
        bytes: content.bytes,
      };
    } catch {
      continue;
    }
  }

  return buildWorkspaceProjectMap({
    rootRelativePath: relativePath,
    entries: listResult.entries,
    fileContents,
    maxTreeEntries,
    maxStubsPerFile,
    truncated: listResult.truncated,
  });
}

export async function buildWorkspaceProjectGraphSummary(
  workspacePath: string,
  relativePath?: string,
  maxDepth?: number,
  maxFiles?: number,
  maxTreeEntries?: number,
  maxSymbolsPerFile?: number,
  maxEdges?: number,
  maxBytes?: number,
  useLsp?: boolean,
  lspEnhancer?: LspProjectGraphEnhancer,
  useCache: boolean = true
): Promise<WorkspaceProjectGraphResult> {
  const cache = new WorkspaceProjectGraphCache(workspacePath);
  const listResult = await listWorkspaceFiles(workspacePath, relativePath, maxDepth ?? 3);

  // Try to load from cache first
  if (useCache) {
    const cached = await cache.load();
    if (cached) {
      const changes = await cache.getChangedFiles(cached, listResult.entries);
      const hasStructuralChanges = changes.newFiles.length > 0 || changes.structuralFiles.length > 0 || changes.deletedFiles.length > 0;
      const hasAnyChanges = hasStructuralChanges || changes.cosmeticFiles.length > 0;

      if (!hasAnyChanges) {
        return cached.projectGraph;
      }

      if (!hasStructuralChanges) {
        return cached.projectGraph;
      }
    }
  }

  // Build new Project Graph
  const selectedFiles = selectProjectMapFiles(listResult.entries, maxFiles ?? 32);
  const fileContents: Record<string, { content: string; bytes: number }> = {};
  const byteLimit = Math.min(300_000, Math.max(10_000, maxBytes ?? 120_000));
  const symbolLimit = Math.min(30, Math.max(1, maxSymbolsPerFile ?? 12));
  const edgeLimit = Math.min(600, Math.max(1, maxEdges ?? 240));

  for (const file of selectedFiles) {
    try {
      const content = await readWorkspaceFile(workspacePath, file.path, byteLimit);
      fileContents[file.path] = {
        content: content.content,
        bytes: content.bytes,
      };
    } catch {
      continue;
    }
  }

  const projectMap = buildWorkspaceProjectMap({
    rootRelativePath: relativePath,
    entries: listResult.entries,
    fileContents,
    maxTreeEntries,
    maxStubsPerFile: symbolLimit,
    truncated: listResult.truncated,
  });

  const projectGraph = buildWorkspaceProjectGraph({
    projectMap,
    entries: listResult.entries,
    fileContents,
    maxEdges: edgeLimit,
    lspMode: useLsp ? (lspEnhancer ? 'full-integration' : 'overrides-only') : undefined,
    lspEnhancer,
  });

  // Save to cache
  if (useCache) {
    const fingerprints = await cache.computeFileFingerprints(listResult.entries);
    await cache.save({
      workspacePath,
      projectGraph,
      fingerprints,
      createdAt: Date.now(),
      version: 2,
    });
  }

  return projectGraph;
}

export async function applyWorkspacePatch(
  workspacePath: string,
  args: ApplyPatchArgs,
  onEdit?: (record: WorkspaceEditRecord) => void
): Promise<ApplyPatchResult> {
  const current = await readWorkspaceFile(workspacePath, args.relativePath, MAX_PATCH_BYTES);
  const patched = applySearchReplacePatch(current.content, {
    search: args.search,
    replace: args.replace,
    replaceAll: args.replaceAll,
    expectedOccurrences: args.expectedOccurrences,
  });
  if (Buffer.byteLength(patched.content, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`补丁结果超过上限 ${MAX_PATCH_BYTES} bytes`);
  }
  const writeResult = await writeWorkspaceFile(workspacePath, args.relativePath, patched.content, onEdit);

  // 写后验证
  const verified = await readWorkspaceFile(workspacePath, args.relativePath, {
    maxBytes: Math.max(patched.content.length + 1024, 16384),
  });
  if (verified.content !== patched.content) {
    throw new Error(
      `文件写入验证失败：${args.relativePath} 写入后内容与预期不一致，请重试。`
    );
  }

  return {
    ...writeResult,
    replacements: patched.replacements,
  };
}

export async function applyWorkspaceDiff(
  workspacePath: string,
  args: ApplyDiffArgs,
  onEdit?: (record: WorkspaceEditRecord) => void
): Promise<ApplyDiffResult> {
  const uniquePaths = [...new Set(args.patches.map((patch) => patch.relativePath))];
  const fileContents: Record<string, string> = {};

  for (const relativePath of uniquePaths) {
    const current = await readWorkspaceFile(workspacePath, relativePath, MAX_PATCH_BYTES);
    fileContents[relativePath] = current.content;
  }

  const diff = applySearchReplaceDiff(fileContents, args.patches);
  const files: ApplyDiffFileResult[] = [];
  const tmpPaths: Array<{ tmp: string; target: string }> = [];

  try {
    for (const file of diff.files) {
      if (Buffer.byteLength(file.content, 'utf8') > MAX_PATCH_BYTES) {
        throw new Error(`${file.path}: 补丁结果超过上限 ${MAX_PATCH_BYTES} bytes`);
      }
      const { target } = await resolveWritablePath(workspacePath, file.path);
      const tmpPath = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, file.content, 'utf8');
      tmpPaths.push({ tmp: tmpPath, target });
    }

    for (const { tmp, target } of tmpPaths) {
      await fs.rename(tmp, target);
    }
  } catch (err) {
    for (const { tmp } of tmpPaths) {
      try { await fs.unlink(tmp); } catch { /* clean up */ }
    }
    throw err;
  }

  for (const file of diff.files) {
    const verified = await readWorkspaceFile(workspacePath, file.path, {
      maxBytes: Math.max(file.content.length + 1024, 16384),
    });
    if (verified.content !== file.content) {
      throw new Error(
        `文件写入验证失败：${file.path} 写入后内容与预期不一致，请重试。`
      );
    }
    const { workspace, target } = await resolveWritablePath(workspacePath, file.path);
    const resolvedPath = relativeString(workspace, target);
    if (onEdit) {
      const before = fileContents[file.path];
      onEdit({ path: resolvedPath, before: before ?? null, after: file.content });
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    const existedBefore = fileContents[file.path] !== undefined;
    files.push({
      path: resolvedPath,
      bytes,
      change: computeLineChangeSummary(existedBefore, fileContents[file.path], file.content),
      patches: file.patches,
      replacements: file.replacements,
    });
  }

  return {
    files,
    totalFiles: diff.totalFiles,
    totalPatches: diff.totalPatches,
    totalReplacements: diff.totalReplacements,
  };
}
