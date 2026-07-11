/// <reference lib="webworker" />

import {
  buildWorkspaceProjectGraph as buildCoreWorkspaceProjectGraph,
  extractStructuralSymbols,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';
import type {
  ProjectGraphWorkerBuildRequest,
  ProjectGraphWorkerMessage,
} from './projectGraphWorkerProtocol';
import type {
  WorkspaceListEntry,
  WorkspaceMapSymbolSummary,
  WorkspaceMapFileSummary,
  WorkspaceProjectMapResult,
} from '../tools/workspaceToolUtils';

declare const self: DedicatedWorkerGlobalScope;

const INSIGHT_IGNORED_PATH_SEGMENTS = new Set([
  '.git', '.pytest_cache', '.swiftpm', '.venv', '__pycache__',
  '.build', 'build', 'coverage', 'deriveddata', 'dist',
  'node_modules', 'out', 'pods', 'release', 'target', 'vendor', 'venv',
  '.godot', '.mono', 'obj', 'bin',
  '.ds_store', 'thumbs.db',
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  rs: 'Rust', py: 'Python', cs: 'C#', c: 'C / C++', cc: 'C / C++',
  cpp: 'C / C++', cxx: 'C / C++', h: 'C / C++', hh: 'C / C++',
  hpp: 'C / C++', hxx: 'C / C++', go: 'Go', java: 'Java', swift: 'Swift',
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
};

type ProjectMapStubFamily = keyof typeof STUB_PATTERNS;
const TYPESCRIPT_AST_FAMILIES = new Set<ProjectMapStubFamily>(['ts', 'js']);
const STRUCTURAL_AST_FAMILIES = new Set<ProjectMapStubFamily>(['py', 'rs', 'go', 'java', 'cs', 'cpp', 'swift', 'ts', 'js']);

function detectProjectMapLanguage(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension ? LANGUAGE_ALIASES[extension] : undefined;
}

function stubPatternFamily(path: string): ProjectMapStubFamily | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  if (!extension) return undefined;
  if (extension === 'ts' || extension === 'tsx' || extension === 'mts' || extension === 'cts') return 'ts';
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return 'js';
  if (extension === 'c' || extension === 'cc' || extension === 'cpp' || extension === 'cxx' || extension === 'h' || extension === 'hh' || extension === 'hpp' || extension === 'hxx') return 'cpp';
  if (extension === 'rs' || extension === 'py' || extension === 'cs' || extension === 'go' || extension === 'java' || extension === 'swift') return extension;
  return undefined;
}

function isInsightIgnoredPath(path: string): boolean {
  return path.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean).some((segment) => INSIGHT_IGNORED_PATH_SEGMENTS.has(segment));
}

function isProjectGraphContextCandidate(path: string, content: string): boolean {
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
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('--');
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

function extractWorkerProjectMapSymbols(
  path: string,
  content: string,
  maxSymbols: number,
  symbolOverride: WorkspaceMapSymbolSummary[] | null | undefined,
): WorkspaceMapSymbolSummary[] {
  if (symbolOverride && symbolOverride.length > 0) {
    return symbolOverride;
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
    } catch { /* fallback below */ }
  }
  try {
    return extractPatternSymbols(path, content, maxSymbols);
  } catch {
    return [];
  }
}

function buildWorkspaceTree(
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
    if (lines.length >= maxTreeEntries + 1) { truncated = true; break; }
    const depth = Math.max(0, localPath.split('/').length - 1);
    lines.push(`${'  '.repeat(depth)}- ${entry.name}${entry.isDir ? '/' : ''}`);
  }
  return { tree: lines.join('\n'), truncated };
}

function buildProjectMapInWorker(params: ProjectGraphWorkerBuildRequest['projectMapParams']): WorkspaceProjectMapResult {
  const treeResult = buildWorkspaceTree(
    [...params.entries].sort((left, right) => left.path.localeCompare(right.path)),
    params.rootRelativePath,
    Math.max(20, params.maxTreeEntries ?? 120),
  );
  const files: WorkspaceMapFileSummary[] = [];
  for (const [path, file] of Object.entries(params.fileContents)) {
    const language = detectProjectMapLanguage(path);
    const hasOverride = Object.prototype.hasOwnProperty.call(params.symbolOverrides ?? {}, path);
    const symbols = extractWorkerProjectMapSymbols(path, file.content, params.maxStubsPerFile ?? Number.MAX_SAFE_INTEGER, hasOverride ? (params.symbolOverrides?.[path] ?? null) : undefined);
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

function buildProjectGraphInWorker(
  projectMap: WorkspaceProjectMapResult,
  params: ProjectGraphWorkerBuildRequest['projectGraphParams'],
): WorkspaceProjectGraphResult {
  const overrides = params.symbolOverrides ?? {};
  const projectGraphFiles = new Map(
    projectMap.files.map((file) => {
      const family = stubPatternFamily(file.path);
      const hasSymbolOverride = Object.prototype.hasOwnProperty.call(overrides, file.path);
      const symbolSource = hasSymbolOverride ? 'lsp' as const : family && TYPESCRIPT_AST_FAMILIES.has(family) ? 'ast' as const : 'pattern' as const;
      return [file.path, { ...file, symbolSource }] as const;
    }),
  );

  for (const [path, file] of Object.entries(params.fileContents)) {
    if (projectGraphFiles.has(path) || !isProjectGraphContextCandidate(path, file.content)) continue;
    const language = detectProjectMapLanguage(path);
    if (!language) continue;
    const family = stubPatternFamily(path);
    const hasSymbolOverride = Object.prototype.hasOwnProperty.call(overrides, path);
    const symbolSource = hasSymbolOverride ? 'lsp' as const : family && TYPESCRIPT_AST_FAMILIES.has(family) ? 'ast' as const : 'pattern' as const;
    projectGraphFiles.set(path, { path, language, bytes: file.bytes, symbols: overrides[path] ?? [], stubs: [], symbolSource });
  }

  return buildCoreWorkspaceProjectGraph({
    root: projectMap.root,
    tree: projectMap.tree,
    files: [...projectGraphFiles.values()],
    allFiles: params.entries,
    fileContents: params.fileContents,
    maxEdges: params.maxEdges ?? Number.MAX_SAFE_INTEGER,
    truncated: projectMap.truncated,
  });
}

self.onmessage = (event: MessageEvent<ProjectGraphWorkerBuildRequest>) => {
  const request = event.data;
  if (request.type !== 'build') return;

  try {
    self.postMessage({ type: 'progress', phase: 'building-map' } as ProjectGraphWorkerMessage);
    const projectMap = buildProjectMapInWorker(request.projectMapParams);

    self.postMessage({ type: 'progress', phase: 'building-graph' } as ProjectGraphWorkerMessage);
    const projectGraph = buildProjectGraphInWorker(projectMap, request.projectGraphParams);

    self.postMessage({ type: 'result', projectMap, projectGraph } as ProjectGraphWorkerMessage);
  } catch (error) {
    self.postMessage({ type: 'error', error: (error as Error).message || 'Unknown error' } as ProjectGraphWorkerMessage);
  }
};
