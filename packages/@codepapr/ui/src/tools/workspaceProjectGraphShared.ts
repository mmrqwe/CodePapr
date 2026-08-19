import {
  buildWorkspaceProjectGraph as buildCoreWorkspaceProjectGraph,
  extractStructuralSymbols,
  type ProjectGraphSymbolSource,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';
import type {
  WorkspaceListEntry,
  WorkspaceMapFileSummary,
  WorkspaceMapSymbolSummary,
  WorkspaceProjectMapResult,
} from './workspaceToolUtils';

export interface BuildWorkspaceProjectMapParams {
  rootRelativePath?: string;
  entries: WorkspaceListEntry[];
  fileContents: Record<string, { content: string; bytes: number }>;
  symbolOverrides?: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
  maxTreeEntries?: number;
  maxStubsPerFile?: number;
  truncated?: boolean;
}

export interface BuildWorkspaceProjectGraphParams {
  projectMap: WorkspaceProjectMapResult;
  entries: WorkspaceListEntry[];
  fileContents: Record<string, { content: string; bytes: number }>;
  symbolOverrides?: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>;
  maxEdges?: number;
}

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

export type ProjectMapStubFamily = keyof typeof STUB_PATTERNS;

export const TYPESCRIPT_AST_FAMILIES = new Set<ProjectMapStubFamily>(['ts', 'js']);
export const STRUCTURAL_AST_FAMILIES = new Set<ProjectMapStubFamily>(['py', 'rs', 'go', 'java', 'cs', 'cpp', 'swift', 'ts', 'js']);

function normalizeRootLabel(rootRelativePath: string | undefined): string {
  const trimmed = rootRelativePath?.trim();
  return trimmed ? trimmed.replace(/^\.\//, '') : '.';
}

export { normalizeRootLabel };

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

export function isInsightIgnoredPath(path: string): boolean {
  return pathSegments(path).some((segment) => INSIGHT_IGNORED_PATH_SEGMENTS.has(segment));
}

export function detectProjectMapLanguage(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension ? LANGUAGE_ALIASES[extension] : undefined;
}

export function stubPatternFamily(path: string): ProjectMapStubFamily | undefined {
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

function fallbackSymbolName(stub: string): string {
  const matchers = [
    /\b(?:class|record|interface|enum|struct|trait|type|protocol|actor)\s+([A-Za-z_][\w$]*)/,
    /\b(?:fn|function|def|func)\s+([A-Za-z_][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_][\w$]*)/,
    /([A-Za-z_][\w$]*)\s*\([^)]*\)/,
  ];
  for (const matcher of matchers) {
    const match = stub.match(matcher);
    if (match?.[1]) return match[1];
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

export function extractPatternSymbols(path: string, content: string, maxSymbols: number): WorkspaceMapSymbolSummary[] {
  const family = stubPatternFamily(path);
  if (!family) return [];
  const patterns = STUB_PATTERNS[family];
  const stubs: WorkspaceMapSymbolSummary[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    lineNumber += 1;
    const trimmed = rawLine.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;
    if (!patterns.some((pattern) => pattern.test(trimmed))) continue;
    const normalized = normalizeStubLine(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    stubs.push({
      name: fallbackSymbolName(normalized),
      kind: fallbackSymbolKind(normalized),
      signature: normalized,
      line: lineNumber,
      exported: /^export\b/.test(normalized),
    });
    if (stubs.length >= Math.max(1, maxSymbols)) break;
  }
  return stubs;
}

export function extractSyncProjectMapSymbols(
  path: string,
  content: string,
  maxSymbols: number,
  symbolOverride: WorkspaceMapSymbolSummary[] | null | undefined,
  hasOverride: boolean,
): WorkspaceMapSymbolSummary[] {
  if (hasOverride) {
    return symbolOverride ?? [];
  }
  const family = stubPatternFamily(path);
  if (!family) return [];
  if (STRUCTURAL_AST_FAMILIES.has(family)) {
    try {
      const symbols = extractStructuralSymbols(path, content);
      if (symbols.length > 0) {
        return symbols.slice(0, maxSymbols).map((s) => ({
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          line: s.line,
          containerName: s.containerName,
          exported: s.exported,
          async: s.async,
        }));
      }
    } catch {
      /* fallback below */
    }
  }
  try {
    return extractPatternSymbols(path, content, maxSymbols);
  } catch {
    return [];
  }
}

export function isProjectGraphContextCandidate(path: string, content: string): boolean {
  const lowerPath = path.toLowerCase();
  if (isInsightIgnoredPath(path)) return false;
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

export function buildWorkspaceTree(
  entries: readonly WorkspaceListEntry[],
  rootRelativePath: string | undefined,
  maxTreeEntries: number,
): { tree: string; truncated: boolean } {
  const root = normalizeRootLabel(rootRelativePath);
  const lines = [root];
  let truncated = false;
  for (const entry of entries) {
    const localPath = stripRootPrefix(entry.path, rootRelativePath);
    if (!localPath) continue;
    if (lines.length >= maxTreeEntries + 1) {
      truncated = true;
      break;
    }
    const depth = Math.max(0, localPath.split('/').length - 1);
    lines.push(`${'  '.repeat(depth)}- ${entry.name}${entry.isDir ? '/' : ''}`);
  }
  return { tree: lines.join('\n'), truncated };
}

export function buildWorkspaceProjectMapSync(
  params: BuildWorkspaceProjectMapParams,
): WorkspaceProjectMapResult {
  const treeResult = buildWorkspaceTree(
    [...params.entries].sort((left, right) => left.path.localeCompare(right.path)),
    params.rootRelativePath,
    Math.max(20, params.maxTreeEntries ?? 120),
  );
  const files: WorkspaceMapFileSummary[] = [];
  for (const [path, file] of Object.entries(params.fileContents)) {
    const language = detectProjectMapLanguage(path);
    const hasOverride = Object.prototype.hasOwnProperty.call(params.symbolOverrides ?? {}, path);
    const symbols = extractSyncProjectMapSymbols(
      path,
      file.content,
      params.maxStubsPerFile ?? Number.MAX_SAFE_INTEGER,
      hasOverride ? (params.symbolOverrides?.[path] ?? null) : undefined,
      hasOverride,
    );
    const stubs = symbols.map((s) => s.signature);
    if (!language || (!hasOverride && stubs.length === 0)) continue;
    files.push({ path, language, bytes: file.bytes, symbols, stubs });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root: normalizeRootLabel(params.rootRelativePath),
    tree: treeResult.tree,
    files,
    truncated: Boolean(params.truncated) || treeResult.truncated,
  };
}

function resolveSymbolSource(
  path: string,
  overrides: Record<string, WorkspaceMapSymbolSummary[] | null | undefined>,
): ProjectGraphSymbolSource {
  if (Object.prototype.hasOwnProperty.call(overrides, path)) {
    return 'lsp';
  }
  const family = stubPatternFamily(path);
  return family && STRUCTURAL_AST_FAMILIES.has(family) ? 'ast' : 'pattern';
}

export function buildWorkspaceProjectGraph(
  params: BuildWorkspaceProjectGraphParams,
): WorkspaceProjectGraphResult {
  const overrides = params.symbolOverrides ?? {};
  const projectGraphFiles = new Map(
    params.projectMap.files.map((file) => [
      file.path,
      { ...file, symbolSource: resolveSymbolSource(file.path, overrides) },
    ] as const),
  );

  for (const [path, file] of Object.entries(params.fileContents)) {
    if (projectGraphFiles.has(path) || !isProjectGraphContextCandidate(path, file.content)) {
      continue;
    }
    const language = detectProjectMapLanguage(path);
    if (!language) continue;
    projectGraphFiles.set(path, {
      path,
      language,
      bytes: file.bytes,
      symbols: overrides[path] ?? [],
      stubs: [],
      symbolSource: resolveSymbolSource(path, overrides),
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
