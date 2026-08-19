import { invoke } from '@tauri-apps/api/core';
import {
  enrichProjectGraphEdges,
  extractStructuralSymbols,
  SymbolProviderRegistry,
  UnifiedSymbolDispatcher,
  relativePathFromFileUri,
  type LspProjectGraphEnhancer,
  type WorkspaceProjectGraphResult,
  type ProjectGraphSymbolSource,
  type SymbolProvider,
  type UnifiedSymbolDefinition,
  type SymbolSource,
  type ProviderCapability,
  type StructuralSymbol,
} from '@codepapr/core';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { WorkspaceSymbolProvider, isProviderSupportedLanguage } from '../utils/workspaceSymbolProvider';
import { extractTypeScriptProjectMapSymbols } from './workspaceProjectMapAst';
import { globalLspPool } from './workspaceProjectMapLsp';
import {
  TYPESCRIPT_AST_FAMILIES,
  STRUCTURAL_AST_FAMILIES,
  buildWorkspaceTree,
  detectProjectMapLanguage,
  extractPatternSymbols,
  isInsightIgnoredPath,
  normalizeRootLabel,
  stubPatternFamily,
  type BuildWorkspaceProjectMapParams,
} from './workspaceProjectGraphShared';

export {
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMapSync,
  detectProjectMapLanguage,
} from './workspaceProjectGraphShared';

export interface WorkspaceListEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
  mtimeMs?: number;
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
  locateSearchOccurrences,
} from '@codepapr/core';
export type {
  ApplySearchReplaceDiffFile,
  ApplySearchReplaceDiffPatch,
  ApplySearchReplaceDiffResult,
  ApplySearchReplacePatchPlan,
  SearchOccurrenceLocation,
} from '@codepapr/core';

export type { ProjectGraphSymbolSource, WorkspaceProjectGraphResult };

const PROJECT_MAP_FILE_BYTE_LIMIT = 120_000;

export function filterWorkspaceInsightEntries(
  entries: readonly WorkspaceListEntry[]
): WorkspaceListEntry[] {
  return entries.filter((entry) => !isInsightIgnoredPath(entry.path));
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

  if (STRUCTURAL_AST_FAMILIES.has(family) && !TYPESCRIPT_AST_FAMILIES.has(family)) {
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

export function resolveLspReferencePath(
  workspacePath: string | undefined,
  uri: string,
): string | null {
  if (!workspacePath || !uri) {
    return null;
  }
  return relativePathFromFileUri(workspacePath, uri);
}

export function createLspProjectGraphEnhancer(
  fileContents: Record<string, { content: string; bytes: number }>,
  workspacePath?: string,
): LspProjectGraphEnhancer {
  // 行拆分缓存：旧实现每个符号对全文 split 一遍（O(符号数×文件大小)）。
  // 一次构建内同一文件内容不变，按文件只拆一次。
  const lineCache = new Map<string, string[]>();
  const linesFor = (content: string): string[] => {
    let lines = lineCache.get(content);
    if (!lines) {
      lines = content.split(/\r?\n/);
      lineCache.set(content, lines);
    }
    return lines;
  };
  const findSymbolColumn = (content: string, zeroBasedLine: number, name: string): number => {
    const lineText = linesFor(content)[zeroBasedLine] ?? '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 不用后行断言 (?<!...)（需 Safari 16.4+ / macOS 13.3+，旧 WebView 会抛 SyntaxError）；
    // 改用 lookahead + 手动检查前导字符，返回第一个构成完整标识符的匹配位置。
    const pattern = new RegExp(`${escaped}(?![\\w$])`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const before = match.index > 0 ? lineText[match.index - 1] : '';
      if (before && /[\w$]/.test(before)) continue;
      return match.index;
    }
    return 0;
  };

  interface BatchEnrichFileResult {
    path: string;
    references: Array<{ uri: string; line: number; character: number; fromSymbol: string }>;
    inheritance: Array<{ fromSymbol: string; toSymbol: string; kind: 'extends' | 'implements' }>;
  }

  // 批量命令响应缓存：core 会先调 enhanceReferences 再调 enhanceInheritance
  // （同一文件的同一符号列表），两个阶段共享一次 lsp_batch_enrich 调用。
  const batchCache = new Map<string, Promise<BatchEnrichFileResult | null>>();
  const loadBatchForFile = (
    filePath: string,
    content: string,
    symbols: Array<{ name: string; line: number; kind: string }>,
  ): Promise<BatchEnrichFileResult | null> => {
    let pending = batchCache.get(filePath);
    if (!pending) {
      pending = (async () => {
        if (!workspacePath) return null;
        const lang = lspLanguageFromPath(filePath);
        if (!lang) return null;
        const entries: Array<{ name: string; line: number; character: number; kind: string }> = [];
        for (const sym of symbols) {
          try {
            const column = findSymbolColumn(content, sym.line - 1, sym.name);
            entries.push({ name: sym.name, line: sym.line - 1, character: column, kind: sym.kind });
          } catch {
            continue;
          }
        }
        if (entries.length === 0) return null;
        const handle = await globalLspPool.acquire(lang, workspacePath);
        try {
          const outputs = await invoke<
            Array<{ path: string; references: BatchEnrichFileResult['references']; inheritance: BatchEnrichFileResult['inheritance'] }>
          >('lsp_batch_enrich', {
            workspacePath,
            files: [{ path: filePath, languageId: lang, content, symbols: entries }],
          });
          return outputs?.[0] ?? null;
        } catch {
          return null;
        } finally {
          globalLspPool.release(handle);
        }
      })();
      batchCache.set(filePath, pending);
    }
    return pending;
  };

  return {
    enhanceReferences: async (
      filePath: string,
      _content: string,
      symbols: Array<{ name: string; line: number; kind: string }>,
    ) => {
      const results: Array<{ filePath: string; line: number; character: number; fromSymbol?: string; toSymbol?: string }> = [];
      const fileContent = fileContents[filePath]?.content;
      if (!fileContent) return results;

      if (workspacePath) {
        const batch = await loadBatchForFile(filePath, fileContent, symbols);
        if (batch) {
          for (const ref of batch.references) {
            const mappedPath = resolveLspReferencePath(workspacePath, ref.uri);
            if (!mappedPath) continue;
            results.push({
              filePath: mappedPath,
              line: ref.line,
              character: ref.character,
              fromSymbol: ref.fromSymbol,
              toSymbol: ref.fromSymbol,
            });
          }
        }
        return results;
      }

      for (const sym of symbols) {
        const lang = lspLanguageFromPath(filePath);
        if (!lang) continue;
        try {
          const column = findSymbolColumn(fileContent, sym.line - 1, sym.name);
          const refs = await WorkspaceSymbolProvider.references(lang, filePath, fileContent, sym.line - 1, column);
          for (const ref of refs) {
            const mappedPath = resolveLspReferencePath(workspacePath, ref.uri);
            if (!mappedPath) continue;
            results.push({
              filePath: mappedPath,
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
      const fileContent = fileContents[filePath]?.content;
      if (!fileContent) return results;

      if (workspacePath) {
        const batch = await loadBatchForFile(filePath, fileContent, symbols);
        if (batch) {
          return [...batch.inheritance];
        }
        return results;
      }

      for (const sym of symbols) {
        if (sym.kind !== 'class' && sym.kind !== 'interface') continue;
        const lang = lspLanguageFromPath(filePath);
        if (!lang) continue;
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

export const DEFAULT_LSP_ENRICH_SYMBOLS = 80;
export const LSP_BATCH_ENRICH_DEADLINE_MS = 15_000;

export async function enrichWorkspaceProjectGraph(
  graph: WorkspaceProjectGraphResult,
  fileContents: Record<string, { content: string; bytes: number }>,
  concurrency: number = 4,
  maxSymbols: number = DEFAULT_LSP_ENRICH_SYMBOLS,
  workspacePath?: string,
): Promise<WorkspaceProjectGraphResult> {
  try {
    const started = Date.now();
    const timedOut = () => Date.now() - started >= LSP_BATCH_ENRICH_DEADLINE_MS;
    const inner = createLspProjectGraphEnhancer(fileContents, workspacePath);
    const enhancer = {
      enhanceReferences: async (
        filePath: string,
        content: string,
        symbols: Array<{ name: string; line: number; kind: string }>,
      ) => timedOut() ? [] : inner.enhanceReferences(filePath, content, symbols),
      enhanceInheritance: async (
        filePath: string,
        content: string,
        symbols: Array<{ name: string; line: number; kind: string }>,
      ) => timedOut() ? [] : inner.enhanceInheritance(filePath, content, symbols),
    };
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
