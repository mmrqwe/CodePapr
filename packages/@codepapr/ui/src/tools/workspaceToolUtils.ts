import {
  buildWorkspaceProjectGraph as buildCoreWorkspaceProjectGraph,
  enrichProjectGraphEdges,
  extractStructuralSymbols,
  SymbolProviderRegistry,
  UnifiedSymbolDispatcher,
  type ProjectGraphSymbolSource,
  type LspProjectGraphEnhancer,
  type WorkspaceProjectGraphResult,
  type SymbolProvider,
  type UnifiedSymbolDefinition,
  type SymbolSource,
  type ProviderCapability,
  type StructuralSymbol,
} from '@codepapr/core';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { WorkspaceSymbolProvider, isProviderSupportedLanguage } from '../utils/workspaceSymbolProvider';
import { extractTypeScriptProjectMapSymbols } from './workspaceProjectMapAst';

export interface WorkspaceListEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface WorkspaceMapSymbolSummary {
  name: string;
  kind: string;
  signature: string;
  line: number;
  containerName?: string;
  exported: boolean;
  async?: boolean;
}

export interface WorkspaceMapFileSummary {
  path: string;
  language: string;
  bytes: number;
  symbols: WorkspaceMapSymbolSummary[];
  stubs: string[];
}

export interface WorkspaceProjectMapResult {
  root: string;
  tree: string;
  files: WorkspaceMapFileSummary[];
  truncated: boolean;
}

export interface GitStatusFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
  isUntracked?: boolean;
}

export interface GitStatusSummary {
  available: boolean;
  isRepo: boolean;
  branch?: string;
  repoRoot?: string;
  files: GitStatusFile[];
  raw: string;
  message?: string;
}

export interface GitDiffSummary {
  available: boolean;
  isRepo: boolean;
  staged: boolean;
  pathspecs: string[];
  stat: string;
  diff: string;
  truncated: boolean;
  message?: string;
}

export interface CommandResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
}

export {
  applySearchReplaceDiff,
  applySearchReplacePatch,
} from '@codepapr/core';
export type {
  ApplySearchReplaceDiffFile,
  ApplySearchReplaceDiffPatch,
  ApplySearchReplaceDiffResult,
  ApplySearchReplacePatchPlan,
} from '@codepapr/core';

interface BuildWorkspaceProjectMapParams {
  rootRelativePath?: string;
  entries: WorkspaceListEntry[];
  fileContents: Record<string, { content: string; bytes: number }>;
  symbolOverrides?: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
  maxTreeEntries?: number;
  maxStubsPerFile?: number;
  truncated?: boolean;
}

interface BuildWorkspaceProjectGraphParams {
  projectMap: WorkspaceProjectMapResult;
  entries: WorkspaceListEntry[];
  fileContents: Record<string, { content: string; bytes: number }>;
  symbolOverrides?: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
  maxEdges?: number;
}

const PROJECT_MAP_FILE_BYTE_LIMIT = 120_000;

const INSIGHT_IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  '.pytest_cache',
  '.swiftpm',
  '.venv',
  '__pycache__',
  '.build',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'node_modules',
  'out',
  'pods',
  'release',
  'target',
  'vendor',
  'venv',
  '.godot',
  '.mono',
  'obj',
  'bin',
  '.ds_store',
  'thumbs.db',
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JSX',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  rs: 'Rust',
  py: 'Python',
  cs: 'C#',
  c: 'C / C++',
  cc: 'C / C++',
  cpp: 'C / C++',
  cxx: 'C / C++',
  h: 'C / C++',
  hh: 'C / C++',
  hpp: 'C / C++',
  hxx: 'C / C++',
  go: 'Go',
  java: 'Java',
  swift: 'Swift',
};

const STUB_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^(export\s+)?class\s+\w+/,
    /^(export\s+)?interface\s+\w+/,
    /^(export\s+)?type\s+\w+/,
    /^(export\s+)?const\s+\w+\s*=/,
  ],
  js: [
    /^(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^(export\s+)?class\s+\w+/,
    /^(export\s+)?const\s+\w+\s*=/,
  ],
  rs: [/^(pub\s+)?(struct|enum|trait)\s+\w+/, /^(pub\s+)?(async\s+)?fn\s+\w+/],
  py: [/^(async\s+def|def|class)\s+\w+/],
  cs: [
    /^(public|internal|private|protected|sealed|abstract|partial|static|\s)*(class|record|interface|enum)\s+\w+/i,
    /^(public|internal|private|protected|static|sealed|abstract|virtual|override|async|partial|\s)+[\w<>[\],?.]+\s+\w+\s*\([^)]*\)/i,
  ],
  cpp: [
    /^(template\s*<[^>]+>\s*)?(class|struct|enum|namespace)\s+\w+/i,
    /^(?:inline\s+|static\s+|constexpr\s+|virtual\s+|explicit\s+|friend\s+|extern\s+|mutable\s+|consteval\s+|constinit\s+)*[\w:<>~*&\s]+\s+\w+\s*\([^;{}]*\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override|final)?\s*(?:\{|;)?/i,
  ],
  go: [/^(func|type)\s+\w+/],
  java: [
    /^(public|private|protected|static|final|abstract|sealed|non-sealed|\s)*(class|record|interface|enum)\s+\w+/i,
    /^(public|private|protected|static|final|abstract|synchronized|native|\s)+[\w<>[\],?.]+\s+\w+\s*\([^)]*\)/i,
  ],
  swift: [
    /^(?:@\w+(?:\([^)]*\))?\s*)*(?:public|internal|private|fileprivate|open|final|indirect|\s)*(class|struct|enum|protocol|actor)\s+\w+/i,
    /^(?:@\w+(?:\([^)]*\))?\s*)*(?:public|internal|private|fileprivate|open|final|static|class|mutating|nonmutating|override|convenience|required|async|throws|rethrows|\s)*func\s+\w+\s*\(/i,
    /^(?:@\w+(?:\([^)]*\))?\s*)*(?:public|internal|private|fileprivate|open|static|lazy|\s)*(?:let|var)\s+\w+/i,
  ],
  html: [
    /<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/,
    /<style\b[^>]*>/,
  ],
  css: [
    /([.#])([A-Za-z][A-Za-z0-9_-]*)\s*\{/,
    /@(media|keyframes|supports|container)\b/,
  ],
  json: [
    /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*[{[]/,
    /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"/,
  ],
  yaml: [
    /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/,
    /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*[^|>-]/,
  ],
  rb: [
    /^\s*(class|module)\s+[A-Z]/,
    /^\s*def\s+(self\.)?\w+/,
    /^\s*(attr_accessor|attr_reader|attr_writer)\s+/,
  ],
  php: [
    /^\s*(abstract\s+|final\s+)?(class|interface|trait|enum)\s+\w+/i,
    /^\s*(public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+\w+\s*\(/i,
    /^\s*(use|namespace)\s+\S+/,
  ],
  kt: [
    /^\s*(public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+|data\s+|sealed\s+|inner\s+)*(class|object|interface|enum)\s+\w+/i,
    /^\s*(public\s+|private\s+|internal\s+|protected\s+|override\s+|open\s+|suspend\s+|tailrec\s+|inline\s+)*fun\s+\w+\s*\(/i,
    /^\s*(val|var)\s+\w+/,
  ],
  dart: [
    /^\s*(abstract\s+|sealed\s+|base\s+|final\s+|mixin\s+)*(class|enum|mixin|extension)\s+\w+/i,
    /^\s*(static\s+|async\s+)?\w+\s+(\w+)\s*\(/,
    /^\s*(final\s+|const\s+|late\s+|static\s+)*(var|int|String|bool|double|num|dynamic)\s+\w+/,
  ],
};

type ProjectMapStubFamily = keyof typeof STUB_PATTERNS;

const TYPESCRIPT_AST_FAMILIES = new Set<ProjectMapStubFamily>(['ts', 'js']);
const STRUCTURAL_AST_FAMILIES = new Set<ProjectMapStubFamily>(['py', 'rs', 'go', 'java', 'cs', 'cpp', 'swift']);

export type { ProjectGraphSymbolSource, WorkspaceProjectGraphResult };

function normalizeRootLabel(rootRelativePath: string | undefined): string {
  const trimmed = rootRelativePath?.trim();
  return trimmed ? trimmed.replace(/^\.\//, '') : '.';
}

function stripRootPrefix(path: string, rootRelativePath: string | undefined): string {
  const normalizedRoot = normalizeRootLabel(rootRelativePath);
  if (normalizedRoot === '.') return path;
  if (path === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateLine(value: string, maxLength: number = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeStubLine(line: string): string {
  return truncateLine(
    collapseWhitespace(line)
      .replace(/\s*\{$/, ' {')
      .replace(/\s*=>\s*\{$/, ' => {')
  );
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('--')
  );
}

function pathSegments(path: string): string[] {
  return path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function isInsightIgnoredPath(path: string): boolean {
  return pathSegments(path).some((segment) => INSIGHT_IGNORED_PATH_SEGMENTS.has(segment));
}

export function filterWorkspaceInsightEntries(
  entries: readonly WorkspaceListEntry[]
): WorkspaceListEntry[] {
  return entries.filter((entry) => !isInsightIgnoredPath(entry.path));
}

export function detectProjectMapLanguage(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension ? LANGUAGE_ALIASES[extension] : undefined;
}

function stubPatternFamily(path: string): ProjectMapStubFamily | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  if (!extension) return undefined;
  if (extension === 'ts' || extension === 'tsx' || extension === 'mts' || extension === 'cts') {
    return 'ts';
  }
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') {
    return 'js';
  }
  if (
    extension === 'c' ||
    extension === 'cc' ||
    extension === 'cpp' ||
    extension === 'cxx' ||
    extension === 'h' ||
    extension === 'hh' ||
    extension === 'hpp' ||
    extension === 'hxx'
  ) {
    return 'cpp';
  }
  if (
    extension === 'rs' ||
    extension === 'py' ||
    extension === 'cs' ||
    extension === 'go' ||
    extension === 'java' ||
    extension === 'swift'
  ) {
    return extension;
  }
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'css' || extension === 'scss' || extension === 'less') return 'css';
  if (extension === 'json' || extension === 'jsonc') return 'json';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'rb') return 'rb';
  if (extension === 'php') return 'php';
  if (extension === 'kt' || extension === 'kts') return 'kt';
  if (extension === 'dart') return 'dart';
  return undefined;
}

function isProjectMapCandidate(entry: WorkspaceListEntry): boolean {
  if (entry.isDir || entry.bytes > PROJECT_MAP_FILE_BYTE_LIMIT || isInsightIgnoredPath(entry.path)) {
    return false;
  }
  return stubPatternFamily(entry.path) !== undefined;
}

/**
 * 快速判断 entries 中是否存在至少一个源代码文件。
 * 用于在显示 ProjectGraph 加载浮层之前做预判，避免无源码项目（如纯数据目录）
 * 也弹出"正在初始化工作区"浮层。
 */
export function hasAnyProjectMapCandidate(entries: readonly WorkspaceListEntry[]): boolean {
  return entries.some(isProjectMapCandidate);
}

function projectMapPriority(path: string): number {
  const lower = path.toLowerCase();
  let score = lower.split('/').length * 10 + lower.length;
  if (/(^|\/)(src|packages|app|lib|server|client)\//.test(lower)) score -= 30;
  if (/(^|\/)(agent|session|app|main|index|router|store)\./.test(lower)) score -= 20;
  if (/test|spec/.test(lower)) score += 20;
  return score;
}

export function selectProjectMapFiles(
  entries: readonly WorkspaceListEntry[],
  maxFiles: number = Number.MAX_SAFE_INTEGER
): WorkspaceListEntry[] {
  return [...entries]
    .filter(isProjectMapCandidate)
    .sort((left, right) => {
      const scoreDiff = projectMapPriority(left.path) - projectMapPriority(right.path);
      return scoreDiff !== 0 ? scoreDiff : left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, maxFiles));
}

function fallbackSymbolName(stub: string): string {
  const matchers = [
    /\b(?:class|record|interface|enum|struct|trait|type|protocol|actor)\s+([A-Za-z_][\w$]*)/,
    /\b(?:fn|function|def|func)\s+([A-Za-z_][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_][\w$]*)/,
    /([A-Za-z_][\w$]*)\s*\([^)]*\)/,
  ];

  for (const matcher of matchers) {
    const match = stub.match(matcher);
    if (match?.[1]) {
      return match[1];
    }
  }

  return stub;
}

function fallbackSymbolKind(stub: string): string {
  if (/\bprotocol\b/i.test(stub)) return 'interface';
  if (/\binterface\b/i.test(stub)) return 'interface';
  if (/\btype\b/i.test(stub)) return 'type';
  if (/\benum\b/i.test(stub)) return 'enum';
  if (/\b(?:class|record|struct|actor)\b/i.test(stub)) return 'class';
  if (/\btrait\b/i.test(stub)) return 'trait';
  if (/\b(?:fn|function|def|func)\b/i.test(stub)) return 'function';
  if (/\b(?:const|let|var)\b/i.test(stub)) return 'variable';
  return 'symbol';
}

function extractPatternSymbols(path: string, content: string, maxSymbols: number): WorkspaceMapSymbolSummary[] {
  const family = stubPatternFamily(path);
  if (!family) return [];

  const patterns = STUB_PATTERNS[family];
  const stubs: WorkspaceMapSymbolSummary[] = [];
  const seen = new Set<string>();

  let lineNumber = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    lineNumber += 1;
    const trimmed = rawLine.trim();
    if (!trimmed || isCommentLine(trimmed)) {
      continue;
    }

    if (!patterns.some((pattern) => pattern.test(trimmed))) {
      continue;
    }

    const normalized = normalizeStubLine(trimmed);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    stubs.push({
      name: fallbackSymbolName(normalized),
      kind: fallbackSymbolKind(normalized),
      signature: normalized,
      line: lineNumber,
      exported: /^export\b/.test(normalized),
    });
    if (stubs.length >= Math.max(1, maxSymbols)) {
      break;
    }
  }

  return stubs;
}
async function extractTypeScriptSymbols(path: string, content: string, maxSymbols: number): Promise<WorkspaceMapSymbolSummary[]> {
  return extractTypeScriptProjectMapSymbols(path, content, maxSymbols);
}

export async function extractProjectMapSymbols(path: string, content: string, maxSymbols: number = Number.MAX_SAFE_INTEGER): Promise<WorkspaceMapSymbolSummary[]> {
  const family = stubPatternFamily(path);
  if (!family) {
    return [];
  }

  const lspLang = lspLanguageFromPath(path);
  const dispatcherLang = lspLang && isProviderSupportedLanguage(lspLang) ? lspLang : family;

  try {
    const dispatcher = getOrCreateDispatcher();
    const result = await dispatcher.extractSymbols(dispatcherLang, path, content);
    if (result.symbols.length > 0) {
      return result.symbols.slice(0, maxSymbols).map(unifiedToSummary);
    }
  } catch (e) {
    console.warn('Unified symbol dispatcher unavailable:', e);
  }

  if (TYPESCRIPT_AST_FAMILIES.has(family)) {
    try {
      return await extractTypeScriptSymbols(path, content, maxSymbols);
    } catch (e) {
      console.warn('TypeScript AST symbol extraction failed, falling back to regex:', e);
    }
  }

  if (STRUCTURAL_AST_FAMILIES.has(family)) {
    try {
      const symbols = extractStructuralSymbols(path, content);
      if (symbols.length > 0) {
        return symbols.slice(0, maxSymbols).map(structuralToSummary);
      }
    } catch { /* fallback below */ }
  }

  try {
    return extractPatternSymbols(path, content, maxSymbols);
  } catch {
    return [];
  }
}

export async function extractCodeStubs(path: string, content: string, maxStubs: number = 8): Promise<string[]> {
  return (await extractProjectMapSymbols(path, content, maxStubs)).map((symbol) => symbol.signature);
}

function buildWorkspaceTree(
  entries: readonly WorkspaceListEntry[],
  rootRelativePath: string | undefined,
  maxTreeEntries: number
): { tree: string; truncated: boolean } {
  const root = normalizeRootLabel(rootRelativePath);
  const lines = [root];
  let truncated = false;

  for (const entry of entries) {
    const localPath = stripRootPrefix(entry.path, rootRelativePath);
    if (!localPath) {
      continue;
    }

    if (lines.length >= maxTreeEntries + 1) {
      truncated = true;
      break;
    }

    const depth = Math.max(0, localPath.split('/').length - 1);
    lines.push(`${'  '.repeat(depth)}- ${entry.name}${entry.isDir ? '/' : ''}`);
  }

  return {
    tree: lines.join('\n'),
    truncated,
  };
}

export async function buildWorkspaceProjectMap(
  params: BuildWorkspaceProjectMapParams
): Promise<WorkspaceProjectMapResult> {
  const treeResult = buildWorkspaceTree(
    [...params.entries].sort((left, right) => left.path.localeCompare(right.path)),
    params.rootRelativePath,
    Math.max(20, params.maxTreeEntries ?? 120)
  );

  const files = (await Promise.all(
    Object.entries(params.fileContents).map(async ([path, file]) => {
      const language = detectProjectMapLanguage(path);
      const hasSymbolOverride = Object.prototype.hasOwnProperty.call(params.symbolOverrides ?? {}, path);
      const symbols = hasSymbolOverride
        ? params.symbolOverrides?.[path] ?? []
        : await extractProjectMapSymbols(path, file.content, params.maxStubsPerFile ?? Number.MAX_SAFE_INTEGER);
      const stubs = symbols.map((symbol) => symbol.signature);
      if (!language || (!hasSymbolOverride && stubs.length === 0)) {
        return null;
      }

      return {
        path,
        language,
        bytes: file.bytes,
        symbols,
        stubs,
      } satisfies WorkspaceMapFileSummary;
    })
  ))
    .filter((entry): entry is WorkspaceMapFileSummary => entry !== null)
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    root: normalizeRootLabel(params.rootRelativePath),
    tree: treeResult.tree,
    files,
    truncated: Boolean(params.truncated) || treeResult.truncated,
  };
}

function isProjectGraphContextCandidate(path: string, content: string): boolean {
  const lowerPath = path.toLowerCase();
  if (isInsightIgnoredPath(path)) {
    return false;
  }

  return (
    /(^|\/)(main|index|app|program|server|client|entry|bootstrap|cli)\./.test(lowerPath) ||
    /\b(?:import|export)\s+[\s\S]*?\bfrom\s+['"]/.test(content) ||
    /^\s*from\s+[.\w]+\s+import\s+/m.test(content) ||
    /^\s*import\s+[A-Za-z_][\w.]*/m.test(content) ||
    /\bimport\s*\(/.test(content) ||
    /\brequire\s*\(/.test(content) ||
    /^\s*from\s+\w[\w.]*\s+import\s+/m.test(content) ||
    /^\s*import\s+\w/m.test(content) ||
    /^\s*use\s+/m.test(content) ||
    /^\s*using\s+/m.test(content) ||
    /^\s*#\s*include\s+/m.test(content) ||
    /^\s*extern\s+crate\s+/m.test(content)
  );
}

export function createLspProjectGraphEnhancer(
  fileContents: Record<string, { content: string; bytes: number }>,
): LspProjectGraphEnhancer {
  const findSymbolColumn = (content: string, zeroBasedLine: number, name: string): number => {
    const lineText = content.split(/\r?\n/)[zeroBasedLine] ?? '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = lineText.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`));
    return match && typeof match.index === 'number' ? match.index : 0;
  };
  const resolveRelativePath = (uri: string): string => {
    let path = uri.startsWith('file://') ? uri.replace(/^file:\/\//, '') : uri;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep raw */
    }
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const key of Object.keys(fileContents)) {
      const nk = key.replace(/^\/+/, '');
      if (normalized === nk || normalized.endsWith(`/${nk}`)) return nk;
    }
    return normalized;
  };
  return {
    enhanceReferences: async (
      filePath: string,
      _content: string,
      symbols: Array<{ name: string; line: number; kind: string }>,
    ) => {
      const results: Array<{ filePath: string; line: number; character: number; fromSymbol?: string; toSymbol?: string }> = [];
      for (const sym of symbols) {
        const lang = lspLanguageFromPath(filePath);
        if (!lang) continue;
        const fileContent = fileContents[filePath]?.content;
        if (!fileContent) continue;
        try {
          const column = findSymbolColumn(fileContent, sym.line - 1, sym.name);
          const refs = await WorkspaceSymbolProvider.references(lang, filePath, fileContent, sym.line - 1, column);
          for (const ref of refs) {
            results.push({
              filePath: resolveRelativePath(ref.uri),
              line: ref.line,
              character: ref.character,
              fromSymbol: sym.name,
              toSymbol: sym.name,
            });
          }
        } catch {
          continue;
        }
      }
      return results;
    },
    enhanceInheritance: async (
      filePath: string,
      _content: string,
      symbols: Array<{ name: string; line: number; kind: string }>,
    ) => {
      const results: Array<{ fromSymbol: string; toSymbol: string; kind: 'extends' | 'implements'; toFilePath?: string }> = [];
      for (const sym of symbols) {
        if (sym.kind !== 'class' && sym.kind !== 'interface') continue;
        const lang = lspLanguageFromPath(filePath);
        if (!lang) continue;
        const fileContent = fileContents[filePath]?.content;
        if (!fileContent) continue;
        try {
          const column = findSymbolColumn(fileContent, sym.line - 1, sym.name);
          const defs = await WorkspaceSymbolProvider.definition(lang, filePath, fileContent, sym.line - 1, column);
          if (defs.length === 0) continue;
          const hoverResult = await WorkspaceSymbolProvider.hover(lang, filePath, fileContent, sym.line - 1, column);
          if (!hoverResult) continue;
          const extendsMatch = hoverResult.contents.match(/\bextends\s+(\w+)/i);
          if (extendsMatch) {
            results.push({
              fromSymbol: sym.name,
              toSymbol: extendsMatch[1],
              kind: 'extends',
            });
          }
          const implementsMatch = hoverResult.contents.match(/\bimplements\s+([\w,\s]+)/i);
          if (implementsMatch) {
            for (const iface of implementsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)) {
              results.push({
                fromSymbol: sym.name,
                toSymbol: iface,
                kind: 'implements',
              });
            }
          }
        } catch {
          continue;
        }
      }
      return results;
    },
  };
}

const KIND_LABEL_TO_NUMBER: Record<string, number> = {
  file: 1, module: 2, namespace: 3, package: 4,
  class: 5, method: 6, property: 7, field: 8,
  constructor: 9, enum: 10, interface: 11, function: 12,
  variable: 13, constant: 14, struct: 23, event: 24,
  operator: 25, 'type-parameter': 26, trait: 23, accessor: 6,
  type: 26,
};

function mapSummaryToUnified(symbol: WorkspaceMapSymbolSummary, source: SymbolSource): UnifiedSymbolDefinition {
  return {
    name: symbol.name,
    kind: KIND_LABEL_TO_NUMBER[symbol.kind] ?? 13,
    signature: symbol.signature,
    detail: '',
    line: symbol.line - 1,
    column: 0,
    endColumn: symbol.signature.length,
    containerName: symbol.containerName,
    exported: symbol.exported,
    symbolSource: source,
  };
}

const LSP_KIND_NUMBER_TO_LABEL: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package',
  5: 'class', 6: 'method', 7: 'property', 8: 'field',
  9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function',
  13: 'variable', 14: 'constant', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type-parameter',
};

function unifiedToSummary(def: UnifiedSymbolDefinition): WorkspaceMapSymbolSummary {
  return {
    name: def.name,
    kind: LSP_KIND_NUMBER_TO_LABEL[def.kind] ?? 'symbol',
    signature: def.signature,
    line: def.line + 1,
    containerName: def.containerName,
    exported: def.exported,
    async: /\basync\b/.test(def.signature),
  };
}

function structuralToSummary(symbol: StructuralSymbol): WorkspaceMapSymbolSummary {
  return {
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signature,
    line: symbol.line,
    containerName: symbol.containerName,
    exported: symbol.exported,
    async: symbol.async,
  };
}

class LspSymbolProviderAdapter implements SymbolProvider {
  readonly languageId: string;
  readonly providerName = 'lsp-tauri';
  readonly source: SymbolSource = 'lsp';
  readonly capability: ProviderCapability[] = ['symbols', 'definition', 'hover', 'references'];

  constructor(languageId: string) {
    this.languageId = languageId;
  }

  async extractSymbols(path: string, content: string): Promise<UnifiedSymbolDefinition[]> {
    const summaries = await WorkspaceSymbolProvider.extractSymbols(this.languageId, path, content);
    return summaries.map((s) => mapSummaryToUnified(s, 'lsp'));
  }

  async hover(path: string, content: string, line: number, character: number): Promise<import('@codepapr/core').HoverResult | null> {
    return await WorkspaceSymbolProvider.hover(this.languageId, path, content, line, character);
  }

  async definition(path: string, content: string, line: number, character: number): Promise<import('@codepapr/core').SymbolLocation[]> {
    return await WorkspaceSymbolProvider.definition(this.languageId, path, content, line, character);
  }

  async references(path: string, content: string, line: number, character: number): Promise<import('@codepapr/core').SymbolLocation[]> {
    return await WorkspaceSymbolProvider.references(this.languageId, path, content, line, character);
  }
}

class TypeScriptAstSymbolProvider implements SymbolProvider {
  readonly languageId = 'typescript';
  readonly providerName = 'typescript-ast';
  readonly source: SymbolSource = 'ast';
  readonly capability: ProviderCapability[] = ['symbols'];

  async extractSymbols(path: string, content: string): Promise<UnifiedSymbolDefinition[]> {
    const summaries = await extractTypeScriptSymbols(path, content, 30);
    return summaries.map((s) => mapSummaryToUnified(s, 'ast'));
  }
}

class RegexSymbolProvider implements SymbolProvider {
  readonly languageId: string;
  readonly providerName: string;
  readonly source: SymbolSource = 'regex';
  readonly capability: ProviderCapability[] = ['symbols'];
  private family: string;

  constructor(languageId: string, family: string) {
    this.languageId = languageId;
    this.providerName = `regex-${languageId}`;
    this.family = family;
  }

  async extractSymbols(path: string, content: string): Promise<UnifiedSymbolDefinition[]> {
    const summaries = extractPatternSymbols(path, content, 30);
    return summaries.map((s) => mapSummaryToUnified(s, 'regex'));
  }
}

class StructuralAstSymbolProvider implements SymbolProvider {
  readonly languageId: string;
  readonly providerName: string;
  readonly source: SymbolSource = 'ast';
  readonly capability: ProviderCapability[] = ['symbols'];

  constructor(languageId: string) {
    this.languageId = languageId;
    this.providerName = `structural-ast-${languageId}`;
  }

  async extractSymbols(path: string, content: string): Promise<UnifiedSymbolDefinition[]> {
    const symbols = extractStructuralSymbols(path, content);
    return symbols.map((s) => structuralSymbolToUnified(s, 'ast'));
  }
}

function structuralSymbolToUnified(symbol: StructuralSymbol, source: SymbolSource): UnifiedSymbolDefinition {
  return {
    name: symbol.name,
    kind: KIND_LABEL_TO_NUMBER[symbol.kind] ?? 13,
    signature: symbol.signature,
    detail: '',
    line: symbol.line - 1,
    column: 0,
    endColumn: symbol.signature.length,
    containerName: symbol.containerName,
    exported: symbol.exported,
    symbolSource: source,
  };
}

let globalDispatcher: UnifiedSymbolDispatcher | null = null;

function getOrCreateDispatcher(): UnifiedSymbolDispatcher {
  if (globalDispatcher) return globalDispatcher;

  const registry = new SymbolProviderRegistry();

  const LSP_LANGUAGE_IDS = [
    'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
    'python', 'rust', 'go', 'java', 'c', 'cpp', 'csharp',
    'html', 'css', 'scss', 'less', 'json', 'jsonc', 'yaml',
    'shellscript', 'swift', 'ruby', 'php', 'kotlin', 'dart', 'sql', 'markdown',
  ];

  for (const langId of LSP_LANGUAGE_IDS) {
    registry.register(langId, new LspSymbolProviderAdapter(langId));
  }

  registry.register('typescript', new TypeScriptAstSymbolProvider());
  registry.register('typescriptreact', new TypeScriptAstSymbolProvider());
  registry.register('javascript', new TypeScriptAstSymbolProvider());
  registry.register('javascriptreact', new TypeScriptAstSymbolProvider());

  registry.register('python', new StructuralAstSymbolProvider('python'));
  registry.register('rust', new StructuralAstSymbolProvider('rust'));
  registry.register('go', new StructuralAstSymbolProvider('go'));
  registry.register('csharp', new StructuralAstSymbolProvider('csharp'));

  const REGEX_LANGUAGES: Array<[string, string]> = [
    ['typescript', 'ts'], ['typescriptreact', 'ts'], ['javascript', 'js'], ['javascriptreact', 'js'],
    ['python', 'py'], ['rust', 'rs'], ['go', 'go'], ['java', 'java'],
    ['csharp', 'cs'], ['cpp', 'cpp'], ['c', 'cpp'], ['swift', 'swift'],
  ];

  for (const [langId, family] of REGEX_LANGUAGES) {
    registry.register(langId, new RegexSymbolProvider(langId, family));
  }

  globalDispatcher = new UnifiedSymbolDispatcher(registry);
  return globalDispatcher;
}

export { getOrCreateDispatcher, unifiedToSummary };

export function buildWorkspaceProjectGraph(params: BuildWorkspaceProjectGraphParams): WorkspaceProjectGraphResult {
  const overrides = params.symbolOverrides ?? {};
  const projectGraphFiles = new Map(
    params.projectMap.files.map((file) => {
      const family = stubPatternFamily(file.path);
      const hasSymbolOverride = Object.prototype.hasOwnProperty.call(overrides, file.path);
      const symbolSource: ProjectGraphSymbolSource = hasSymbolOverride
        ? 'lsp'
        : family && TYPESCRIPT_AST_FAMILIES.has(family)
          ? 'ast'
          : 'pattern';

      return [
        file.path,
        {
          ...file,
          symbolSource,
        },
      ] as const;
    })
  );

  for (const [path, file] of Object.entries(params.fileContents)) {
    if (projectGraphFiles.has(path) || !isProjectGraphContextCandidate(path, file.content)) {
      continue;
    }

    const language = detectProjectMapLanguage(path);
    if (!language) {
      continue;
    }

    const family = stubPatternFamily(path);
    const hasSymbolOverride = Object.prototype.hasOwnProperty.call(overrides, path);
    const symbolSource: ProjectGraphSymbolSource = hasSymbolOverride
      ? 'lsp'
      : family && TYPESCRIPT_AST_FAMILIES.has(family)
        ? 'ast'
        : 'pattern';

    projectGraphFiles.set(path, {
      path,
      language,
      bytes: file.bytes,
      symbols: overrides[path] ?? [],
      stubs: [],
      symbolSource,
    });
  }

  return buildCoreWorkspaceProjectGraph({
    root: params.projectMap.root,
    tree: params.projectMap.tree,
    files: [...projectGraphFiles.values()],
    allFiles: params.entries,
    fileContents: params.fileContents,
    maxEdges: params.maxEdges,
    truncated: params.projectMap.truncated,
  });
}

export async function enrichWorkspaceProjectGraph(
  graph: WorkspaceProjectGraphResult,
  fileContents: Record<string, { content: string; bytes: number }>,
  concurrency: number = 3,
  maxSymbols: number = 30,
): Promise<WorkspaceProjectGraphResult> {
  try {
    const enhancer = createLspProjectGraphEnhancer(fileContents);
    return await enrichProjectGraphEdges(graph, enhancer, fileContents, concurrency, maxSymbols);
  } catch {
    return graph;
  }
}

function combineCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();
}

function isNotGitRepositoryMessage(message: string): boolean {
  return /not a git repository/i.test(message);
}

export function parseGitRepositoryRootCommandResult(result: CommandResultLike): {
  available: boolean;
  isRepo: boolean;
  repoRoot?: string;
  raw: string;
  message?: string;
} {
  const raw = combineCommandOutput(result.stdout, result.stderr);
  if ((result.status ?? 1) !== 0) {
    if (isNotGitRepositoryMessage(raw)) {
      return {
        available: true,
        isRepo: false,
        raw,
        message: '当前工作区不是 Git 仓库。',
      };
    }

    return {
      available: false,
      isRepo: false,
      raw,
      message: raw || 'Git 仓库根读取失败。',
    };
  }

  const repoRoot = result.stdout.trim();
  return {
    available: true,
    isRepo: true,
    ...(repoRoot ? { repoRoot } : {}),
    raw,
  };
}

export function buildGitUnavailableStatus(message: string): GitStatusSummary {
  return {
    available: false,
    isRepo: false,
    files: [],
    raw: '',
    message: (message ?? '').trim() || 'Git 不可用。',
  };
}

export function buildGitUnavailableDiff(message: string, staged: boolean, pathspecs: string[]): GitDiffSummary {
  return {
    available: false,
    isRepo: false,
    staged,
    pathspecs,
    stat: '',
    diff: '',
    truncated: false,
    message: (message ?? '').trim() || 'Git 不可用。',
  };
}

export function parseGitStatusCommandResult(result: CommandResultLike): GitStatusSummary {
  const raw = combineCommandOutput(result.stdout, result.stderr);
  if ((result.status ?? 1) !== 0) {
    if (isNotGitRepositoryMessage(raw)) {
      return {
        available: true,
        isRepo: false,
        files: [],
        raw,
        message: '当前工作区不是 Git 仓库。',
      };
    }

    return {
      available: true,
      isRepo: false,
      files: [],
      raw,
      message: raw || 'Git 状态读取失败。',
    };
  }

  let branch: string | undefined;
  const files: GitStatusFile[] = [];
  const MAX_GIT_STATUS_FILES = 200;

  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith('## ')) {
      branch = line.slice(3).trim();
      continue;
    }

    if (line.length < 3) {
      continue;
    }

    if (files.length >= MAX_GIT_STATUS_FILES) {
      break;
    }

    const indexStatus = line[0] === ' ' ? '' : line[0];
    const worktreeStatus = line[1] === ' ' ? '' : line[1];
    const target = line.slice(3).trim();
    const [originalPath, path] = target.includes(' -> ')
      ? (target.split(' -> ', 2) as [string, string])
      : [undefined, target];

    files.push({
      path,
      indexStatus,
      worktreeStatus,
      ...(originalPath ? { originalPath } : {}),
    });
  }

  return {
    available: true,
    isRepo: true,
    ...(branch ? { branch } : {}),
    files,
    raw,
    ...(files.length >= MAX_GIT_STATUS_FILES ? { message: `Git 状态文件过多，已截断至前 ${MAX_GIT_STATUS_FILES} 个。` } : {}),
  };
}

export function buildGitDiffSummary(params: {
  staged: boolean;
  pathspecs: string[];
  statResult: CommandResultLike;
  diffResult: CommandResultLike;
  truncationThreshold?: number;
}): GitDiffSummary {
  const raw = [
    combineCommandOutput(params.statResult.stdout, params.statResult.stderr),
    combineCommandOutput(params.diffResult.stdout, params.diffResult.stderr),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  if ((params.statResult.status ?? 1) !== 0 || (params.diffResult.status ?? 1) !== 0) {
    if (isNotGitRepositoryMessage(raw)) {
      return {
        available: true,
        isRepo: false,
        staged: params.staged,
        pathspecs: params.pathspecs,
        stat: '',
        diff: '',
        truncated: false,
        message: '当前工作区不是 Git 仓库。',
      };
    }

    return {
      available: true,
      isRepo: false,
      staged: params.staged,
      pathspecs: params.pathspecs,
      stat: '',
      diff: '',
      truncated: false,
      message: raw || 'Git diff 读取失败。',
    };
  }

  const stat = params.statResult.stdout.trim();
  let diff = params.diffResult.stdout.trim();
  const threshold = params.truncationThreshold ?? 190_000;
  const truncated = stat.length + diff.length >= threshold;

  if (truncated) {
    const maxDiffLen = Math.max(1, threshold - stat.length - 200);
    diff = diff.slice(0, maxDiffLen) + '\n\n... [diff 已截断，仅显示前 ' + maxDiffLen + ' 字符]';
  }

  return {
    available: true,
    isRepo: true,
    staged: params.staged,
    pathspecs: params.pathspecs,
    stat,
    diff,
    truncated,
    ...(stat || diff ? {} : { message: 'Git 工作区当前没有可显示的 diff。' }),
  };
}
