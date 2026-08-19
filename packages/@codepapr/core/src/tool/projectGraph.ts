import { estimateTokens } from '@codepapr/common';
import {
  countFunctionLinesIndentBased,
  isIndentationBasedLanguage,
} from './workspace/graph/codeMetrics';

export type ProjectGraphNodeKind = 'file' | 'symbol';
export type ProjectGraphFileType = 'source' | 'test' | 'config' | 'doc' | 'docker' | 'cicd' | 'sql';
export type ProjectGraphEdgeKind = 'contains' | 'imports' | 'reexports' | 'extends' | 'implements' | 'calls' | 'tested_by' | 'configures';
export type ProjectGraphSymbolSource = 'lsp' | 'ast' | 'pattern';
export type LspMode = 'overrides-only' | 'full-integration';

// LSP 增强器接口
export interface LspProjectGraphEnhancer {
  // `filePath` 是定义文件；返回项的 `filePath` 是使用点（references 结果）。
  enhanceReferences(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; line: number; kind: string }>
  ): Promise<Array<{ filePath: string; line: number; character: number; fromSymbol?: string; toSymbol?: string }>>;
  enhanceInheritance(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; line: number; kind: string }>
  ): Promise<Array<{ fromSymbol: string; toSymbol: string; kind: 'extends' | 'implements'; toFilePath?: string }>>;
}

export interface ProjectGraphSymbolInput {
  name: string;
  kind: string;
  signature: string;
  line: number;
  containerName?: string;
  exported: boolean;
  async?: boolean;
}

export interface ProjectGraphFileInput {
  path: string;
  language: string;
  bytes: number;
  symbols: ProjectGraphSymbolInput[];
  stubs?: string[];
  symbolSource?: ProjectGraphSymbolSource;
  entryPoint?: boolean;
  entryPointScore?: number;
}

export interface ProjectGraphFileEntry {
  path: string;
  isDir?: boolean;
}

export interface ProjectGraphFileContent {
  content: string;
  bytes?: number;
}

export interface ProjectGraphNode {
  id: string;
  kind: ProjectGraphNodeKind;
  label: string;
  path: string;
  language?: string;
  bytes?: number;
  fileType?: ProjectGraphFileType;
  symbol?: ProjectGraphSymbolInput;
  symbolSource?: ProjectGraphSymbolSource;
  qualifiedName?: string;
  disambiguated?: boolean;
  entryPoint?: boolean;
  entryPointScore?: number;
}

export interface ProjectGraphEdge {
  id: string;
  kind: ProjectGraphEdgeKind;
  from: string;
  to: string;
  label?: string;
}

export interface ProjectGraphQualityMetrics {
  lspCoverage: number;
  astCoverage: number;
  callGraphPrecision: number;
  importResolutionRate: number;
}

export interface WorkspaceProjectGraphResult {
  root: string;
  tree: string;
  files: ProjectGraphFileInput[];
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  summary: {
    files: number;
    testFiles: number;
    configFiles: number;
    docFiles: number;
    symbols: number;
    imports: number;
    reexports: number;
    extends: number;
    implements: number;
    calls: number;
    testedBy: number;
    configures: number;
    lspSymbols: number;
    entryPoints: number;
    orphanNodes: number;
    edges: number;
    truncated: boolean;
    lspEnhanced?: boolean;
    validated?: boolean;
  };
  quality?: ProjectGraphQualityMetrics;
  truncated: boolean;
  /** 仅包含目录树骨架的降级结果（语义分析失败时回退用） */
  degraded?: boolean;
  /** 降级原因（degraded=true 时给出原因，便于 UI 排查） */
  degradedReason?: string;
}

const DEFAULT_STRIP_MAX_TOKENS = 200_000;

function graphJsonTokens(graph: WorkspaceProjectGraphResult): number {
  return estimateTokens(JSON.stringify(graph));
}

function dropAllSignatures(graph: WorkspaceProjectGraphResult): void {
  for (const file of graph.files) {
    for (const sym of file.symbols) {
      if (sym.signature) {
        const nl = sym.signature.indexOf('\n');
        sym.signature = nl > 0 ? sym.signature.slice(0, nl) : sym.signature;
      }
    }
  }
  for (const node of graph.nodes) {
    if (node.symbol?.signature) {
      const nl = node.symbol.signature.indexOf('\n');
      node.symbol.signature = nl > 0 ? node.symbol.signature.slice(0, nl) : node.symbol.signature;
    }
  }
}

/** Type-safe field deletion: `Partial<T>` makes every property optional so the
 *  `delete` operator type-checks even on required fields. Runtime behaviour is
 *  identical to a bare `delete obj[key]`. */
function deleteField<T>(obj: T, key: keyof T): void {
  delete (obj as Partial<T>)[key];
}

function stripCoreNoise(graph: WorkspaceProjectGraphResult): void {
  for (const edge of graph.edges) {
    deleteField(edge, 'id');
  }
  graph.edges = graph.edges.filter((e) => e.kind !== 'contains');

  delete graph.quality;

  for (const file of graph.files) {
    deleteField(file, 'bytes');
    deleteField(file, 'symbolSource');
    deleteField(file, 'entryPointScore');
    deleteField(file, 'stubs');
  }

  for (const node of graph.nodes) {
    deleteField(node, 'bytes');
    deleteField(node, 'symbolSource');
  }

  if (!graph.truncated) deleteField(graph, 'truncated');
  if (!graph.degraded) {
    deleteField(graph, 'degraded');
    deleteField(graph, 'degradedReason');
  }
}

export function stripGraphNoise(
  graph: WorkspaceProjectGraphResult,
  maxTokens: number = DEFAULT_STRIP_MAX_TOKENS
): WorkspaceProjectGraphResult {
  stripCoreNoise(graph);
  dropAllSignatures(graph);

  if (graphJsonTokens(graph) <= maxTokens) return graph;

  for (const file of graph.files) {
    for (const sym of file.symbols) {
      deleteField(sym, 'signature');
    }
  }
  for (const node of graph.nodes) {
    if (node.symbol) {
      deleteField(node.symbol, 'signature');
    }
  }
  if (graphJsonTokens(graph) <= maxTokens) return graph;

  const half = Math.max(1, Math.ceil(graph.files.length / 2));
  const keepSet = new Set(graph.files.slice(0, half).map((f) => f.path));
  graph.files.length = half;
  graph.nodes = graph.nodes.filter((n) => keepSet.has(n.path));
  // 边的 from/to 是节点 ID（file:<path> / symbol:<path>:...），不是裸路径：
  // 必须按保留后的节点 ID 集合过滤。旧实现用裸路径集合比较节点 ID，
  // has() 恒为 false，图超 token 上限进入减半分支时所有语义边被静默清空。
  const keepNodeIds = new Set(graph.nodes.map((n) => n.id));
  graph.edges = graph.edges.filter((e) => keepNodeIds.has(e.from) && keepNodeIds.has(e.to));
  if (graphJsonTokens(graph) <= maxTokens) return graph;

  graph.files.length = 0;
  graph.nodes.length = 0;
  graph.edges.length = 0;

  return graph;
}

export interface BuildWorkspaceProjectGraphParams {
  root: string;
  tree: string;
  files: ProjectGraphFileInput[];
  allFiles?: readonly ProjectGraphFileEntry[];
  fileContents?: Record<string, ProjectGraphFileContent>;
  maxEdges?: number;
  truncated?: boolean;
  // LSP 增强选项
  lspMode?: LspMode;
  lspEnhancer?: LspProjectGraphEnhancer;
  lspConcurrency?: number;
}

interface ModuleReference {
  kind: 'imports' | 'reexports';
  specifier: string;
}

interface ModuleBinding {
  targetPath: string;
  importedName?: string;
  namespace?: boolean;
}

interface ModuleReexport {
  targetPath: string;
  star?: boolean;
  importedName?: string;
  localName?: string;
}

interface FileModuleContext {
  references: ModuleReference[];
  importedSymbols: Map<string, ModuleBinding[]>;
  importedNamespaces: Map<string, ModuleBinding>;
  /** barrel `export *` / `export { a as b }` 再导出，供导入方穿透解析到源符号。 */
  reexports?: ModuleReexport[];
  /** 看起来是项目内导入（相对路径 / crate:: / mod 声明）但未能解析的数量。
   *  references 只记录解析成功的导入，质量指标需要它当分母的一部分，
   *  否则 importResolutionRate 结构性恒等于 1。外部包导入不计入。 */
  unresolvedLocalImports?: number;
}

interface RelationTargetDescriptor {
  raw: string;
  simpleName: string;
  qualifiedName?: string;
}

interface SymbolRelationDescriptor {
  kind: 'extends' | 'implements';
  target: RelationTargetDescriptor;
}

interface ProjectGraphSymbolCandidate {
  id: string;
  path: string;
  symbol: ProjectGraphSymbolInput;
  qualifiedName: string;
}

type NormalizedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'dart'
  | 'unknown';

function normalizeLanguage(language?: string): NormalizedLanguage {
  if (!language) return 'unknown';
  const lower = language.toLowerCase();
  if (lower.includes('typescript') || lower.includes('tsx')) return 'typescript';
  if (lower.includes('javascript') || lower.includes('jsx')) return 'javascript';
  if (lower.includes('python')) return 'python';
  if (lower.includes('rust')) return 'rust';
  if (lower.includes('go')) return 'go';
  if (lower.includes('java')) return 'java';
  if (lower.includes('c#') || lower.includes('csharp')) return 'csharp';
  if (lower.includes('c / c++') || lower.includes('c++') || lower.includes('cpp')) return 'cpp';
  if (lower.includes('swift')) return 'swift';
  if (lower.includes('ruby')) return 'ruby';
  if (lower.includes('php')) return 'php';
  if (lower.includes('kotlin')) return 'kotlin';
  if (lower.includes('dart')) return 'dart';
  return 'unknown';
}

function languageFromPath(path: string): NormalizedLanguage {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'c': case 'cc': case 'cpp': case 'cxx': case 'h': case 'hh': case 'hpp': case 'hxx': return 'cpp';
    case 'swift': return 'swift';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'kt': case 'kts': return 'kotlin';
    case 'dart': return 'dart';
    default: return 'unknown';
  }
}

function detectLanguage(path: string, language?: string): NormalizedLanguage {
  const fromLabel = normalizeLanguage(language);
  if (fromLabel !== 'unknown') return fromLabel;
  return languageFromPath(path);
}

const EXTENSION_CANDIDATES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

const INDEX_EXTENSION_CANDIDATES = [
  'index.ts',
  'index.tsx',
  'index.mts',
  'index.cts',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'index.json',
];

const PYTHON_EXTENSION_CANDIDATES = ['', '.py'];
const PYTHON_INDEX_CANDIDATES = ['__init__.py'];

const RUST_EXTENSION_CANDIDATES = ['', '.rs'];
const RUST_INDEX_CANDIDATES = ['mod.rs'];

const GO_EXTENSION_CANDIDATES = ['', '.go'];

const JAVA_EXTENSION_CANDIDATES = ['', '.java'];

const CSHARP_EXTENSION_CANDIDATES = ['', '.cs'];

const CSHARP_CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'catch',
  'using', 'lock', 'fixed', 'unchecked', 'checked', 'return', 'throw',
  'yield', 'try', 'finally', 'using',
]);

const CSHARP_CALL_PREFIXES = new Set([
  'return', 'throw', 'yield', 'new', 'await', 'var', 'if', 'for', 'foreach',
  'while', 'switch', 'using', 'lock', 'do', 'else', 'try', 'catch', 'finally',
  'this', 'base', 'true', 'false', 'null', 'value',
]);

const SWIFT_EXTENSION_CANDIDATES = ['', '.swift'];

const CPP_EXTENSION_CANDIDATES = ['', '.h', '.hpp', '.hh', '.hxx', '.c', '.cc', '.cpp', '.cxx'];

const ENTRYPOINT_FILE_NAMES = new Set([
  'main',
  'index',
  'app',
  'program',
  'server',
  'client',
  'entry',
  'bootstrap',
  'cli',
  'controls',
]);

const ENTRYPOINT_SYMBOL_NAMES = new Set([
  'main',
  'boot',
  'bootstrap',
  'start',
  'run',
  'render',
  'createapp',
  'createclient',
  'createserver',
  'program',
  'app',
  'cli',
  '_ready',
  '_entertree',
  '_process',
  '_physicsprocess',
  '_input',
  '_unhandledinput',
]);

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

function classifyFileType(path: string): ProjectGraphFileType {
  const normalized = normalizePath(path).toLowerCase();
  const segments = normalized.split('/');
  const filename = segments[segments.length - 1];
  const dirnameStr = segments.length > 1 ? segments[segments.length - 2] : '';

  if (
    normalized.includes('/.github/workflows/') ||
    normalized.includes('/.gitlab-ci') ||
    filename === 'jenkinsfile' ||
    filename.startsWith('jenkinsfile') ||
    normalized.startsWith('.github/workflows/')
  ) {
    return 'cicd';
  }

  if (
    filename.startsWith('dockerfile') ||
    filename === 'docker-compose.yml' ||
    filename === 'docker-compose.yaml' ||
    filename === '.dockerignore'
  ) {
    return 'docker';
  }

  if (
    filename.endsWith('.sql') ||
    normalized.includes('/migrations/') ||
    normalized.includes('/migration/')
  ) {
    return 'sql';
  }

  if (
    filename.endsWith('.md') ||
    filename.endsWith('.mdx') ||
    filename === 'readme' ||
    filename.startsWith('readme.') ||
    filename === 'changelog' ||
    filename.startsWith('changelog.') ||
    filename === 'contributing' ||
    filename.startsWith('contributing.')
  ) {
    return 'doc';
  }

  if (
    filename.endsWith('.test.ts') ||
    filename.endsWith('.test.tsx') ||
    filename.endsWith('.spec.ts') ||
    filename.endsWith('.spec.tsx') ||
    filename.endsWith('.test.js') ||
    filename.endsWith('.test.jsx') ||
    filename.endsWith('.spec.js') ||
    filename.endsWith('.spec.jsx') ||
    filename.endsWith('.test.mts') ||
    filename.endsWith('.spec.mts') ||
    filename.endsWith('.test.mjs') ||
    filename.endsWith('.spec.mjs') ||
    filename.endsWith('_test.py') ||
    filename.endsWith('_test.rs') ||
    filename.endsWith('_test.go') ||
    filename.startsWith('test_') ||
    filename.endsWith('_test.rb') ||
    filename.endsWith('_test.dart') ||
    filename.endsWith('_test.kt') ||
    filename.endsWith('_test.php') ||
    filename.endsWith('_test.swift') ||
    filename.endsWith('_test.cs') ||
    dirnameStr === '__tests__' ||
    dirnameStr === '__test__' ||
    dirnameStr === 'test' ||
    dirnameStr === 'tests' ||
    dirnameStr === 'spec' ||
    dirnameStr === 'specs' ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/__test__/') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/spec/') ||
    normalized.includes('/specs/')
  ) {
    return 'test';
  }

  if (
    filename.endsWith('.json') ||
    filename.endsWith('.yaml') ||
    filename.endsWith('.yml') ||
    filename.endsWith('.toml') ||
    filename.startsWith('.env') ||
    filename === '.env' ||
    filename === '.eslintrc' ||
    filename.startsWith('.eslintrc') ||
    filename === '.prettierrc' ||
    filename.startsWith('.prettierrc') ||
    filename.startsWith('tsconfig') ||
    filename.startsWith('jsconfig') ||
    filename.startsWith('.babelrc') ||
    filename.startsWith('.npmrc') ||
    filename.startsWith('.nvmrc') ||
    filename.startsWith('package') ||
    filename.startsWith('vite.config') ||
    filename.startsWith('webpack.config') ||
    filename.startsWith('rollup.config') ||
    filename.startsWith('tailwind.config') ||
    filename.startsWith('postcss.config') ||
    filename.startsWith('.gitignore') ||
    filename.startsWith('.dockerignore') ||
    filename.startsWith('.editorconfig') ||
    filename.endsWith('.config.ts') ||
    filename.endsWith('.config.js') ||
    filename.endsWith('.config.mjs') ||
    filename.endsWith('.config.mts')
  ) {
    return 'config';
  }

  return 'source';
}

function joinRelativePath(baseDir: string, specifier: string): string | null {
  const parts = [...baseDir.split('/'), ...specifier.split('/')].filter(Boolean);
  const normalized: string[] = [];

  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  return normalized.join('/');
}

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveImportTarget(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>, language?: NormalizedLanguage): string | null {
  if (isRelativeImport(specifier)) {
    return resolveRelativeImport(sourcePath, specifier, allFiles, EXTENSION_CANDIDATES, INDEX_EXTENSION_CANDIDATES);
  }

  switch (language) {
    case 'python':
      return resolvePythonImport(sourcePath, specifier, allFiles);
    case 'rust':
      return resolveRustImport(sourcePath, specifier, allFiles);
    case 'java':
      return resolveJavaImport(specifier, allFiles);
    case 'go':
      return resolveGoImport(sourcePath, specifier, allFiles);
    case 'csharp':
      return resolveCsharpImport(sourcePath, specifier, allFiles);
    case 'swift':
      return resolveSwiftImport(sourcePath, specifier, allFiles);
    case 'cpp':
      return resolveCppInclude(sourcePath, specifier, allFiles);
    case 'ruby':
      return resolveRubyRequire(specifier, allFiles);
    case 'php':
      return resolvePhpUse(specifier, allFiles);
    case 'kotlin':
      return resolveKotlinImport(specifier, allFiles);
    case 'dart':
      return resolveDartImport(sourcePath, specifier, allFiles);
    default:
      return null;
  }
}

function resolveRelativeImport(
  sourcePath: string,
  specifier: string,
  allFiles: ReadonlySet<string>,
  extensions: string[],
  indexFiles: string[],
): string | null {
  const base = joinRelativePath(dirname(sourcePath), specifier);
  if (!base) {
    return null;
  }

  for (const extension of extensions) {
    const candidate = normalizePath(`${base}${extension}`);
    if (allFiles.has(candidate)) {
      return candidate;
    }
  }

  for (const indexFile of indexFiles) {
    const candidate = normalizePath(`${base}/${indexFile}`);
    if (allFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function tryPythonModule(base: string, allFiles: ReadonlySet<string>): string | null {
  const normalizedBase = normalizePath(base);
  if (!normalizedBase) {
    return null;
  }
  for (const ext of PYTHON_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`${normalizedBase}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const indexFile of PYTHON_INDEX_CANDIDATES) {
    const candidate = normalizePath(`${normalizedBase}/${indexFile}`);
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function resolvePythonImport(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  let dots = 0;
  while (specifier[dots] === '.') dots++;
  const remainder = specifier.slice(dots).replace(/^\.+/, '');

  if (dots > 0) {
    let dir = dirname(sourcePath);
    for (let i = 1; i < dots; i++) {
      if (!dir) break;
      dir = dirname(dir);
    }
    if (remainder) {
      const relative = remainder.replace(/\./g, '/');
      return tryPythonModule(dir ? `${dir}/${relative}` : relative, allFiles);
    }
    return tryPythonModule(dir, allFiles);
  }

  const parts = specifier.split('.');
  const basePath = parts.join('/');
  const sourceDir = dirname(sourcePath);

  for (const dir of [sourceDir, '']) {
    const base = dir ? `${dir}/${basePath}` : basePath;
    const resolved = tryPythonModule(base, allFiles);
    if (resolved) return resolved;
  }

  for (const candidate of allFiles) {
    if (candidate === `${basePath}.py` || candidate.endsWith(`/${basePath}.py`)) return candidate;
    if (candidate === `${basePath}/__init__.py` || candidate.endsWith(`/${basePath}/__init__.py`)) return candidate;
  }

  return null;
}

function resolveRustImport(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  let modulePath: string;
  if (specifier.startsWith('crate::')) {
    modulePath = specifier.slice('crate::'.length).replace(/::/g, '/');
  } else if (specifier.startsWith('super::')) {
    const parentDir = dirname(dirname(sourcePath));
    const relative = specifier.slice('super::'.length).replace(/::/g, '/');
    modulePath = normalizePath(`${parentDir}/${relative}`);
  } else if (specifier.startsWith('self::')) {
    const relative = specifier.slice('self::'.length).replace(/::/g, '/');
    modulePath = normalizePath(`${dirname(sourcePath)}/${relative}`);
  } else {
    return null;
  }

  for (const ext of RUST_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`src/${modulePath}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const indexFile of RUST_INDEX_CANDIDATES) {
    const candidate = normalizePath(`src/${modulePath}/${indexFile}`);
    if (allFiles.has(candidate)) return candidate;
  }

  for (const ext of RUST_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`${modulePath}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const indexFile of RUST_INDEX_CANDIDATES) {
    const candidate = normalizePath(`${modulePath}/${indexFile}`);
    if (allFiles.has(candidate)) return candidate;
  }

  return null;
}

function resolveJavaImport(specifier: string, allFiles: ReadonlySet<string>): string | null {
  const pathFromPackage = specifier.replace(/\./g, '/');
  for (const ext of JAVA_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`src/main/java/${pathFromPackage}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const ext of JAVA_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`src/test/java/${pathFromPackage}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const ext of JAVA_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`${pathFromPackage}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function resolveGoImport(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  if (isRelativeImport(specifier)) {
    return resolveRelativeImport(sourcePath, specifier, allFiles, GO_EXTENSION_CANDIDATES, []);
  }
  const sourceDir = dirname(sourcePath);
  const goModDir = findGoModuleRoot(sourceDir, allFiles);
  if (goModDir !== null) {
    for (const ext of GO_EXTENSION_CANDIDATES) {
      const candidate = normalizePath(`${goModDir}/${specifier}${ext}`);
      if (allFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function findGoModuleRoot(sourceDir: string, allFiles: ReadonlySet<string>): string | null {
  let dir = sourceDir;
  for (let i = 0; i < 10; i++) {
    if (allFiles.has(normalizePath(`${dir}/go.mod`))) return dir;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveCsharpImport(_sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  const parts = specifier.split('.');
  for (let depth = parts.length; depth >= 1; depth--) {
    const basePath = parts.slice(0, depth).join('/');
    for (const ext of CSHARP_EXTENSION_CANDIDATES) {
      const candidate = normalizePath(`${basePath}${ext}`);
      if (allFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolveSwiftImport(_sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  const lower = specifier.toLowerCase();
  for (const ext of SWIFT_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`Sources/${specifier}/${specifier}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const ext of SWIFT_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`${lower}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const candidate of allFiles) {
    const normalized = normalizePath(candidate);
    if (normalized.endsWith(`/${specifier}.swift`) || normalized.endsWith(`/Sources/${specifier}/${specifier}.swift`)) {
      return candidate;
    }
  }
  return null;
}

function resolveCppInclude(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  const clean = specifier.replace(/^["<]/, '').replace(/[">]$/, '');
  if (allFiles.has(normalizePath(clean))) return normalizePath(clean);

  const sourceDir = dirname(sourcePath);
  for (const ext of CPP_EXTENSION_CANDIDATES) {
    const candidate = normalizePath(`${sourceDir}/${clean}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }

  for (const candidate of allFiles) {
    if (candidate.endsWith(`/${clean}`)) return candidate;
  }
  return null;
}

function resolveRubyRequire(specifier: string, allFiles: ReadonlySet<string>): string | null {
  const clean = specifier.replace(/^['"]/, '').replace(/['"]$/, '');
  const candidate = normalizePath(`${clean}.rb`);
  if (allFiles.has(candidate)) return candidate;
  for (const c of allFiles) {
    if (c.endsWith(`/${clean}.rb`) || c === `${clean}.rb`) return c;
  }
  return null;
}

function resolvePhpUse(specifier: string, allFiles: ReadonlySet<string>): string | null {
  const pathParts = specifier.replace(/\\/g, '/').split('/');
  for (let depth = pathParts.length; depth >= 1; depth--) {
    const basePath = pathParts.slice(0, depth).join('/');
    for (const ext of ['', '.php']) {
      const candidate = normalizePath(`${basePath}${ext}`);
      if (allFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolveKotlinImport(specifier: string, allFiles: ReadonlySet<string>): string | null {
  const pathFromPackage = specifier.replace(/\./g, '/');
  for (const ext of ['', '.kt', '.kts']) {
    const candidate = normalizePath(`${pathFromPackage}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  for (const ext of ['', '.kt', '.kts']) {
    const candidate = normalizePath(`src/main/kotlin/${pathFromPackage}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function resolveDartImport(sourcePath: string, specifier: string, allFiles: ReadonlySet<string>): string | null {
  if (specifier.startsWith('package:')) return null;
  const sourceDir = dirname(sourcePath);
  const base = joinRelativePath(sourceDir, specifier);
  if (base) {
    for (const ext of ['', '.dart']) {
      const candidate = normalizePath(`${base}${ext}`);
      if (allFiles.has(candidate)) return candidate;
    }
  }
  for (const ext of ['', '.dart']) {
    const candidate = normalizePath(`lib/${specifier}${ext}`);
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeIdentifierKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

function symbolNodeId(path: string, symbol: ProjectGraphSymbolInput, index: number): string {
  return `symbol:${path}:${symbol.line}:${symbol.kind}:${symbol.containerName ?? ''}:${symbol.name}:${index}`;
}

function qualifiedSymbolName(symbol: ProjectGraphSymbolInput): string {
  return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

function splitTopLevelList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (const char of value) {
    if (char === '<') {
      angleDepth += 1;
    } else if (char === '>' && angleDepth > 0) {
      angleDepth -= 1;
    } else if (char === '(') {
      parenDepth += 1;
    } else if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
    }

    if (
      char === ',' &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      const part = current.trim();
      if (part) {
        parts.push(part);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }

  return parts;
}

function stripGenericSections(value: string): string {
  let result = '';
  let depth = 0;

  for (const char of value) {
    if (char === '<') {
      depth += 1;
      continue;
    }
    if (char === '>' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      result += char;
    }
  }

  return result;
}

function parseNamedBindings(raw: string): Array<{ localName: string; importedName: string }> {
  const normalized = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  if (!normalized) {
    return [];
  }

  return splitTopLevelList(normalized)
    .map((part) => part.replace(/^type\s+/i, '').trim())
    .filter(Boolean)
    .map((part) => {
      const [importedName, localName] = part.split(/\s+as\s+/i).map((item) => item.trim());
      return {
        importedName,
        localName: localName || importedName,
      };
    })
    .filter((binding) => Boolean(binding.localName) && Boolean(binding.importedName));
}

function addImportedBinding(
  bindings: Map<string, ModuleBinding[]>,
  localName: string,
  binding: ModuleBinding
): void {
  const key = localName.trim();
  if (!key) {
    return;
  }

  const existing = bindings.get(key) ?? [];
  existing.push(binding);
  bindings.set(key, existing);
}

function buildModuleContext(
  sourcePath: string,
  content: string,
  allFiles: ReadonlySet<string>,
  language?: string,
): FileModuleContext {
  const normLang = detectLanguage(sourcePath, language);

  switch (normLang) {
    case 'python':
      return buildPythonModuleContext(sourcePath, content, allFiles);
    case 'rust':
      return buildRustModuleContext(sourcePath, content, allFiles);
    case 'go':
      return buildGoModuleContext(sourcePath, content, allFiles);
    case 'java':
      return buildJavaModuleContext(sourcePath, content, allFiles);
    case 'csharp':
      return buildCsharpModuleContext(sourcePath, content, allFiles);
    case 'swift':
      return buildSwiftModuleContext(sourcePath, content, allFiles);
    case 'cpp':
      return buildCppModuleContext(sourcePath, content, allFiles);
    case 'ruby':
      return buildRubyModuleContext(sourcePath, content, allFiles);
    case 'php':
      return buildPhpModuleContext(sourcePath, content, allFiles);
    case 'kotlin':
      return buildKotlinModuleContext(sourcePath, content, allFiles);
    case 'dart':
      return buildDartModuleContext(sourcePath, content, allFiles);
    case 'typescript':
    case 'javascript':
      return buildJsTsModuleContext(sourcePath, content, allFiles);
    default:
      return emptyModuleContext();
  }
}

function buildCodeMask(content: string, style: 'c-like' | 'python'): boolean[] {
  const mask = new Array<boolean>(content.length).fill(true);
  const mark = (from: number, to: number): void => {
    for (let i = from; i < to && i < mask.length; i++) {
      if (content[i] !== '\n' && content[i] !== '\r') mask[i] = false;
    }
  };
  let i = 0;
  const n = content.length;

  const consumeLineComment = (): void => {
    const start = i;
    while (i < n && content[i] !== '\n') i++;
    mark(start, i);
  };

  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : '';

    if (style === 'python' && (content.startsWith('"""', i) || content.startsWith("'''", i))) {
      const quote = content.slice(i, i + 3);
      const start = i;
      i += 3;
      while (i < n && !content.startsWith(quote, i)) i++;
      if (i < n) i += 3;
      mark(start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || (style === 'c-like' && ch === '`')) {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        if (content[i] === '\n' && quote !== '`') {
          break;
        }
        i++;
      }
      mark(start, i);
      continue;
    }

    if (style === 'c-like' && ch === '/' && next === '/') {
      consumeLineComment();
      continue;
    }
    if (style === 'c-like' && ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n) {
        if (content[i] === '*' && i + 1 < n && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      mark(start, i);
      continue;
    }
    if (style === 'python' && ch === '#') {
      consumeLineComment();
      continue;
    }

    i++;
  }

  return mask;
}

function isCodeIndex(mask: boolean[], index: number | undefined): boolean {
  return index !== undefined && index >= 0 && index < mask.length && mask[index];
}

function buildJsTsModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();
  const reexports: ModuleReexport[] = [];
  let unresolvedLocalImports = 0;
  const code = buildCodeMask(content, 'c-like');
  // 相对/绝对路径导入必须解析到项目文件；解析失败说明图有缺口。
  // 裸包名（react、lodash 等）属于外部依赖，不计入。
  const isLocalSpecifier = (specifier: string): boolean =>
    specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
  const staticModulePattern = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  const sideEffectImportPattern = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  const dynamicModulePatterns: Array<{ pattern: RegExp; kind: ModuleReference['kind'] }> = [
    { pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'imports' },
    { pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'imports' },
  ];

  let staticMatch = staticModulePattern.exec(content);
  while (staticMatch) {
    const keyword = staticMatch[1]?.trim();
    const keywordOffset = keyword ? staticMatch[0].search(new RegExp(`\\b${keyword}\\b`)) : -1;
    if (!isCodeIndex(code, staticMatch.index + Math.max(0, keywordOffset))) {
      staticMatch = staticModulePattern.exec(content);
      continue;
    }
    const clause = collapseWhitespace(staticMatch[2] ?? '');
    const specifier = staticMatch[3]?.trim() ?? '';
    const targetPath = resolveImportTarget(sourcePath, specifier, allFiles, 'typescript');

    if (!targetPath && isLocalSpecifier(specifier)) {
      unresolvedLocalImports += 1;
    }

    if (targetPath) {
      const kind: ModuleReference['kind'] = keyword === 'export' ? 'reexports' : 'imports';
      references.push({ kind, specifier });

      if (keyword === 'import') {
        const clauseParts = splitTopLevelList(clause.replace(/^type\s+/i, '').trim());
        for (const part of clauseParts) {
          if (!part) {
            continue;
          }

          if (/^\*\s+as\s+/i.test(part)) {
            const alias = part.replace(/^\*\s+as\s+/i, '').trim();
            if (alias) {
              importedNamespaces.set(alias, {
                targetPath,
                namespace: true,
              });
            }
            continue;
          }

          if (part.startsWith('{') && part.endsWith('}')) {
            for (const binding of parseNamedBindings(part)) {
              addImportedBinding(importedSymbols, binding.localName, {
                targetPath,
                importedName: binding.importedName,
              });
            }
            continue;
          }

          addImportedBinding(importedSymbols, part.trim(), {
            targetPath,
            importedName: 'default',
          });
        }
      } else if (keyword === 'export') {
        const clauseParts = splitTopLevelList(clause.replace(/^type\s+/i, '').trim());
        for (const part of clauseParts) {
          if (!part) {
            continue;
          }
          if (part === '*' || /^\*\s*$/.test(part)) {
            reexports.push({ targetPath, star: true });
            continue;
          }
          if (/^\*\s+as\s+/i.test(part)) {
            continue;
          }
          if (part.startsWith('{') && part.endsWith('}')) {
            for (const binding of parseNamedBindings(part)) {
              reexports.push({
                targetPath,
                importedName: binding.importedName,
                localName: binding.localName,
              });
            }
          }
        }
      }
    }

    staticMatch = staticModulePattern.exec(content);
  }

  let sideEffectMatch = sideEffectImportPattern.exec(content);
  while (sideEffectMatch) {
    const importOffset = sideEffectMatch[0].search(/\bimport\b/);
    if (!isCodeIndex(code, sideEffectMatch.index + Math.max(0, importOffset))) {
      sideEffectMatch = sideEffectImportPattern.exec(content);
      continue;
    }
    const specifier = sideEffectMatch[1]?.trim() ?? '';
    const targetPath = resolveImportTarget(sourcePath, specifier, allFiles, 'typescript');
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
    } else if (isLocalSpecifier(specifier)) {
      unresolvedLocalImports += 1;
    }
    sideEffectMatch = sideEffectImportPattern.exec(content);
  }

  for (const { pattern, kind } of dynamicModulePatterns) {
    let match = pattern.exec(content);
    while (match) {
      if (!isCodeIndex(code, match.index)) {
        match = pattern.exec(content);
        continue;
      }
      const specifier = match[1]?.trim() ?? '';
      if (resolveImportTarget(sourcePath, specifier, allFiles, 'typescript')) {
        references.push({ kind, specifier });
      } else if (isLocalSpecifier(specifier)) {
        unresolvedLocalImports += 1;
      }
      match = pattern.exec(content);
    }
  }

  return {
    references,
    importedSymbols,
    importedNamespaces,
    reexports,
    unresolvedLocalImports,
  };
}

function buildPythonModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();
  let unresolvedLocalImports = 0;
  const code = buildCodeMask(content, 'python');

  const fromImportPattern = /^[\t ]*from[\t ]+(\.+[A-Za-z_][\w.]*|\.+|[A-Za-z_][\w.]*)[\t ]+import[\t ]+(.+)/gm;
  const bareImportPattern = /^[\t ]*import[\t ]+([A-Za-z_][\w.]*)(?:[\t ]+as[\t ]+(\w+))?/gm;

  let match: RegExpExecArray | null;
  match = fromImportPattern.exec(content);
  while (match) {
    if (!isCodeIndex(code, match.index)) {
      match = fromImportPattern.exec(content);
      continue;
    }
    const modulePath = match[1].trim();
    const importList = match[2].trim();
    const isRelative = modulePath.startsWith('.');
    const targetPath = resolveImportTarget(sourcePath, modulePath, allFiles, 'python');
    if (targetPath) {
      references.push({ kind: 'imports', specifier: modulePath });
      for (const item of importList.split(',')) {
        const parts = item.trim().split(/\s+as\s+/i);
        const importedName = parts[0]?.trim();
        const localName = parts[1]?.trim() ?? importedName;
        if (!importedName || !localName || importedName === '*') continue;
        let bindingPath: string = targetPath;
        if (isRelative && /^[.]+$/.test(modulePath)) {
          bindingPath =
            resolveImportTarget(sourcePath, `${modulePath}${importedName}`, allFiles, 'python') ?? targetPath;
          if (bindingPath !== targetPath) {
            references.push({ kind: 'imports', specifier: `${modulePath}${importedName}` });
          }
        }
        addImportedBinding(importedSymbols, localName, { targetPath: bindingPath, importedName });
      }
    } else if (isRelative) {
      unresolvedLocalImports += 1;
    }
    match = fromImportPattern.exec(content);
  }

  match = bareImportPattern.exec(content);
  while (match) {
    if (!isCodeIndex(code, match.index)) {
      match = bareImportPattern.exec(content);
      continue;
    }
    const modulePath = match[1].trim();
    const alias = match[2]?.trim();
    const targetPath = resolveImportTarget(sourcePath, modulePath, allFiles, 'python');
    if (targetPath) {
      references.push({ kind: 'imports', specifier: modulePath });
      if (alias) {
        importedNamespaces.set(alias, { targetPath, namespace: true });
      } else {
        const topName = modulePath.split('.')[0];
        if (topName) {
          importedNamespaces.set(topName, { targetPath, namespace: true });
        }
      }
    }
    match = bareImportPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces, unresolvedLocalImports };
}

function buildRustModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();
  let unresolvedLocalImports = 0;
  // crate::/self::/super:: 与 mod 声明必须解析到项目内文件；外部 crate 不计入。
  const isLocalUsePath = (path: string): boolean =>
    path === 'crate' || path === 'self' || path === 'super' ||
    path.startsWith('crate::') || path.startsWith('self::') || path.startsWith('super::');

  const usePattern = /^[\t ]*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/gm;
  const externCratePattern = /^[\t ]*extern\s+crate\s+(\w+)/gm;
  const modDeclPattern = /^[\t ]*(?:pub\s+)?mod\s+(\w+)/gm;

  let match: RegExpExecArray | null;
  match = usePattern.exec(content);
  while (match) {
    const usePath = match[1].trim();
    const basePath = usePath.replace(/\s+as\s+\w+.*$/, '').replace(/\{[^}]+\}/, '').replace(/::\*$|::\{.*\}$/, '').trim();
    if (!basePath) { match = usePattern.exec(content); continue; }

    const targetPath = resolveImportTarget(sourcePath, basePath, allFiles, 'rust');
    if (targetPath) {
      references.push({ kind: 'imports', specifier: basePath });
      const names = extractRustUseNames(usePath);
      for (const name of names) {
        addImportedBinding(importedSymbols, name, { targetPath, importedName: name });
      }
    } else {
      if (isLocalUsePath(basePath)) {
        unresolvedLocalImports += 1;
      }
      const crateName = basePath.split('::')[0];
      if (crateName && crateName !== 'crate' && crateName !== 'self' && crateName !== 'super') {
        importedNamespaces.set(crateName, { targetPath: crateName, namespace: true });
      }
    }
    match = usePattern.exec(content);
  }

  match = externCratePattern.exec(content);
  while (match) {
    const crateName = match[1].trim();
    references.push({ kind: 'imports', specifier: crateName });
    importedNamespaces.set(crateName, { targetPath: crateName, namespace: true });
    match = externCratePattern.exec(content);
  }

  match = modDeclPattern.exec(content);
  while (match) {
    const modName = match[1].trim();
    const modPath = `crate::${modName}`;
    const targetPath = resolveImportTarget(sourcePath, modPath, allFiles, 'rust');
    if (targetPath) {
      references.push({ kind: 'imports', specifier: modName });
    } else {
      unresolvedLocalImports += 1;
    }
    match = modDeclPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces, unresolvedLocalImports };
}

function extractRustUseNames(usePath: string): string[] {
  const braceMatch = usePath.match(/\{([^}]+)\}/);
  if (braceMatch) {
    return braceMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
  }
  const lastSegment = usePath.split('::').pop()?.split(/\s+as\s+/)[0].trim();
  return lastSegment && lastSegment !== '*' ? [lastSegment] : [];
}

function buildGoModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();

  const singleImportPattern = /^[\t ]*import\s+["`]([^"`]+)["`]/gm;
  const groupedImportPattern = /import\s*\(([\s\S]*?)\)/g;

  let match: RegExpExecArray | null;
  match = singleImportPattern.exec(content);
  while (match) {
    const specifier = match[1].trim();
    const targetPath = resolveImportTarget(sourcePath, specifier, allFiles, 'go');
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
      const pkgName = specifier.split('/').pop()?.trim() ?? specifier;
      importedNamespaces.set(pkgName, { targetPath, namespace: true });
    }
    match = singleImportPattern.exec(content);
  }

  match = groupedImportPattern.exec(content);
  while (match) {
    const block = match[1];
    const linePattern = /(?:(\w+)\s+)?["`]([^"`]+)["`]/g;
    let lineMatch = linePattern.exec(block);
    while (lineMatch) {
      const alias = lineMatch[1]?.trim();
      const specifier = lineMatch[2].trim();
      const targetPath = resolveImportTarget(sourcePath, specifier, allFiles, 'go');
      if (targetPath) {
        references.push({ kind: 'imports', specifier });
        const pkgName = alias ?? specifier.split('/').pop()?.trim() ?? specifier;
        importedNamespaces.set(pkgName, { targetPath, namespace: true });
      }
      lineMatch = linePattern.exec(block);
    }
    match = groupedImportPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces };
}

function buildJavaModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();

  const importPattern = /^[\t ]*import\s+(?:static\s+)?([^;]+);/gm;

  let match: RegExpExecArray | null;
  match = importPattern.exec(content);
  while (match) {
    const specifier = match[1].trim().replace(/\s+$/, '');
    const isStatic = /\bstatic\s+/.test(match[0]);
    const isWildcard = specifier.endsWith('.*');

    const targetPath = resolveJavaImport(specifier.replace(/\.\*$/, ''), allFiles);
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
      if (!isWildcard) {
        const simpleName = specifier.split('.').pop() ?? '';
        if (simpleName) {
          addImportedBinding(importedSymbols, simpleName, { targetPath, importedName: simpleName });
        }
      }
    } else if (isWildcard) {
      const pkgName = specifier.replace(/\.\*$/, '');
      const pkgPath = pkgName.replace(/\./g, '/');
      for (const candidate of allFiles) {
        if (candidate.startsWith(pkgPath + '/') && candidate.endsWith('.java')) {
          references.push({ kind: 'imports', specifier });
          break;
        }
      }
    }

    if (isStatic && !isWildcard) {
      const parts = specifier.split('.');
      parts.pop();
      const className = parts.pop() ?? '';
      if (className) {
        importedNamespaces.set(className, { targetPath: className, namespace: true });
      }
    }

    match = importPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces };
}

function buildCsharpModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();

  const usingPattern = /^[\t ]*(?:global\s+)?using\s+(?:static\s+|([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)(?:\s*;)/gm;

  let match: RegExpExecArray | null;
  match = usingPattern.exec(content);
  while (match) {
    const alias = match[1]?.trim();
    const specifier = match[2].trim();
    const targetPath = resolveCsharpImport(sourcePath, specifier, allFiles);
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
    }
    const nsName = alias ?? specifier.split('.').pop() ?? specifier;
    importedNamespaces.set(nsName, { targetPath: targetPath ?? specifier, namespace: true });
    match = usingPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces };
}

function buildSwiftModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();

  const importPattern = /^[\t ]*import\s+(?:(class|struct|enum|protocol|typealias|func|var|let)\s+)?(\w+(?:\.\w+)*)/gm;

  let match: RegExpExecArray | null;
  match = importPattern.exec(content);
  while (match) {
    const specifier = match[2].trim();
    const targetPath = resolveSwiftImport(sourcePath, specifier, allFiles);
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
    }
    const moduleName = specifier.split('.')[0];
    importedNamespaces.set(moduleName, { targetPath: targetPath ?? moduleName, namespace: true });
    match = importPattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces };
}

function buildCppModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importedSymbols = new Map<string, ModuleBinding[]>();
  const importedNamespaces = new Map<string, ModuleBinding>();

  const includePattern = /^[\t ]*#\s*include\s+([<"'][^>"']+[>"'])/gm;
  const usingNamespacePattern = /^[\t ]*using\s+namespace\s+([\w:]+)\s*;/gm;

  let match: RegExpExecArray | null;
  match = includePattern.exec(content);
  while (match) {
    const specifier = match[1].trim();
    const targetPath = resolveCppInclude(sourcePath, specifier, allFiles);
    if (targetPath) {
      references.push({ kind: 'imports', specifier });
    }
    match = includePattern.exec(content);
  }

  match = usingNamespacePattern.exec(content);
  while (match) {
    const nsName = match[1].trim();
    const lastPart = nsName.split('::').pop() ?? nsName;
    importedNamespaces.set(lastPart, { targetPath: lastPart, namespace: true });
    match = usingNamespacePattern.exec(content);
  }

  return { references, importedSymbols, importedNamespaces };
}

function buildRubyModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const requirePattern = /(?:^|\n)\s*require(?:_relative)?\s+['"]([^'"]+)['"]/g;
  let match = requirePattern.exec(content);
  while (match) {
    const specifier = match[1]?.trim() ?? '';
    if (specifier && resolveRubyRequire(specifier, allFiles)) {
      references.push({ kind: 'imports', specifier });
    }
    match = requirePattern.exec(content);
  }
  return { references, importedSymbols: new Map(), importedNamespaces: new Map() };
}

function buildPhpModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const usePattern = /(?:^|\n)\s*use\s+([^\s;{(]+)/g;
  let match = usePattern.exec(content);
  while (match) {
    const specifier = match[1]?.trim() ?? '';
    if (specifier && resolvePhpUse(specifier, allFiles)) {
      references.push({ kind: 'imports', specifier });
    }
    match = usePattern.exec(content);
  }
  return { references, importedSymbols: new Map(), importedNamespaces: new Map() };
}

function buildKotlinModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importPattern = /(?:^|\n)\s*import\s+([^\s;]+)/g;
  let match = importPattern.exec(content);
  while (match) {
    const specifier = match[1]?.trim() ?? '';
    if (specifier && resolveKotlinImport(specifier, allFiles)) {
      references.push({ kind: 'imports', specifier });
    }
    match = importPattern.exec(content);
  }
  return { references, importedSymbols: new Map(), importedNamespaces: new Map() };
}

function buildDartModuleContext(sourcePath: string, content: string, allFiles: ReadonlySet<string>): FileModuleContext {
  const references: ModuleReference[] = [];
  const importPattern = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let match = importPattern.exec(content);
  while (match) {
    const specifier = match[1]?.trim() ?? '';
    if (specifier && resolveDartImport(sourcePath, specifier, allFiles)) {
      references.push({ kind: 'imports', specifier });
    }
    match = importPattern.exec(content);
  }
  return { references, importedSymbols: new Map(), importedNamespaces: new Map() };
}

function emptyModuleContext(): FileModuleContext {
  return { references: [], importedSymbols: new Map(), importedNamespaces: new Map() };
}

export interface StructuralSymbol {
  name: string;
  kind: string;
  signature: string;
  line: number;
  containerName?: string;
  exported: boolean;
  async?: boolean;
}

function extractPythonStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  const classStack: Array<{ name: string; indent: number }> = [];

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const indent = rawLine.search(/\S/);
    if (indent === -1) continue;
    const trimmed = rawLine.trim();

    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
      classStack.pop();
    }

    const classMatch = trimmed.match(/^(?:async\s+)?class\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?/);
    if (classMatch) {
      const name = classMatch[1];
      const baseSig = classMatch[2] ? `class ${name}(${classMatch[2].trim()})` : `class ${name}`;
      symbols.push({
        name,
        kind: 'class',
        signature: baseSig,
        line: lineNum,
        containerName: classStack.length > 0 ? classStack[classStack.length - 1].name : undefined,
        exported: !name.startsWith('_') || name.startsWith('__'),
      });
      classStack.push({ name, indent });
      continue;
    }

    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const name = funcMatch[1];
      const isAsync = trimmed.startsWith('async');
      const sig = `${isAsync ? 'async ' : ''}def ${name}(${funcMatch[2].trim()})`;
      const container = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;
      symbols.push({
        name,
        kind: container ? 'method' : 'function',
        signature: sig,
        line: lineNum,
        containerName: container,
        exported: !name.startsWith('_') || name.startsWith('__'),
        async: isAsync || undefined,
      });
    }
  }

  return symbols;
}

function extractRustStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  const implStack: Array<{ name: string; braceDepth: number }> = [];
  let braceDepth = 0;

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();
    const depthBefore = braceDepth;

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    while (implStack.length > 0 && braceDepth <= implStack[implStack.length - 1].braceDepth) {
      implStack.pop();
    }

    const pubPrefix = /^(?:pub(?:\s*\([^)]*\))?\s+)?/;
    const structMatch = trimmed.match(pubPrefix.source + /struct\s+([A-Za-z_]\w*)/.source);
    if (structMatch) {
      const name = structMatch[1];
      symbols.push({
        name,
        kind: 'struct',
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*;.*$/, ''),
        line: lineNum,
        exported: trimmed.startsWith('pub'),
      });
      continue;
    }

    const enumMatch = trimmed.match(pubPrefix.source + /enum\s+([A-Za-z_]\w*)/.source);
    if (enumMatch) {
      symbols.push({
        name: enumMatch[1],
        kind: 'enum',
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*;.*$/, ''),
        line: lineNum,
        exported: trimmed.startsWith('pub'),
      });
      continue;
    }

    const traitMatch = trimmed.match(pubPrefix.source + /trait\s+([A-Za-z_]\w*)/.source);
    if (traitMatch) {
      symbols.push({
        name: traitMatch[1],
        kind: 'trait',
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*;.*$/, ''),
        line: lineNum,
        exported: trimmed.startsWith('pub'),
      });
      continue;
    }

    const implMatch = trimmed.match(/^impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_]\w*)\s+for\s+)?([A-Za-z_]\w*)/);
    if (implMatch) {
      implStack.push({ name: implMatch[2], braceDepth: depthBefore });
      continue;
    }

    const fnMatch = trimmed.match(pubPrefix.source + /(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.source);
    if (fnMatch) {
      const name = fnMatch[1];
      const isAsync = /(?:^|\s)async\s+fn\s/.test(trimmed);
      const container = implStack.length > 0 ? implStack[implStack.length - 1].name : undefined;
      const kind = container ? 'method' : 'function';
      symbols.push({
        name,
        kind,
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*;.*$/, ''),
        line: lineNum,
        containerName: container,
        exported: trimmed.startsWith('pub'),
        async: isAsync || undefined,
      });
      continue;
    }
  }

  return symbols;
}

function extractGoStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  const receiverStack: Array<{ name: string; braceDepth: number }> = [];
  let braceDepth = 0;

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    while (receiverStack.length > 0 && braceDepth <= receiverStack[receiverStack.length - 1].braceDepth) {
      receiverStack.pop();
    }

    const typeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/);
    if (typeMatch) {
      const name = typeMatch[1];
      const kind = typeMatch[2] === 'interface' ? 'interface' : 'struct';
      symbols.push({
        name,
        kind,
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        exported: /^[A-Z]/.test(name),
      });
      continue;
    }

    const funcMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const name = funcMatch[1];
      const receiverMatch = trimmed.match(/^func\s+\(([^)]+)\)\s+([A-Za-z_]\w*)/);
      const container = receiverMatch ? receiverMatch[1].trim().split(/\s+/).pop() : undefined;
      const kind = container ? 'method' : 'function';
      symbols.push({
        name,
        kind,
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        containerName: container,
        exported: /^[A-Z]/.test(name),
      });
      if (container) {
        receiverStack.push({ name: container, braceDepth });
      }
      continue;
    }
  }

  return symbols;
}

export function extractStructuralSymbols(path: string, content: string): StructuralSymbol[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':
      return extractPythonStructuralSymbols(content);
    case 'rs':
      return extractRustStructuralSymbols(content);
    case 'go':
      return extractGoStructuralSymbols(content);
    case 'java':
      return extractJavaStructuralSymbols(content);
    case 'cs':
      return extractCsharpStructuralSymbols(content);
    case 'c': case 'cc': case 'cpp': case 'cxx': case 'h': case 'hh': case 'hpp': case 'hxx':
      return extractCppStructuralSymbols(content);
    case 'swift':
      return extractSwiftStructuralSymbols(content);
    case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return extractJsTsStructuralSymbols(content);
    default:
      return [];
  }
}

function extractJavaStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  let braceDepth = 0;

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    const typeMatch = trimmed.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record)\s+(\w+)/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[2],
        kind: typeMatch[1],
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*implements.*$/, '').replace(/\s*extends.*$/, ''),
        line: lineNum,
        exported: trimmed.includes('public') || !trimmed.includes('private'),
      });
      continue;
    }

    const methodMatch = trimmed.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|native\s+)*(?:<[^>]+>\s*)?(?:\w+(?:[<>,?.]|\s*\[\s*\])?\s+)?(\w+)\s*\(([^)]*)\)/);
    if (methodMatch && /[;{]/.test(trimmed)) {
      symbols.push({
        name: methodMatch[1],
        kind: braceDepth > 0 ? 'method' : 'function',
        signature: trimmed.replace(/\s*[;{].*$/, ''),
        line: lineNum,
        exported: trimmed.includes('public') || !trimmed.includes('private'),
      });
      continue;
    }
  }

  return symbols;
}

function extractCsharpStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  let braceDepth = 0;
  const containerStack: Array<{ name: string; kind: string; depth: number }> = [];

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') {
        braceDepth--;
        while (containerStack.length > 0 && containerStack[containerStack.length - 1].depth >= braceDepth) {
          containerStack.pop();
        }
      }
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    const typeMatch = trimmed.match(/^\s*(?:\[[^\]]+\]\s*)*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|sealed\s+|abstract\s+|partial\s+|readonly\s+|unsafe\s+|new\s+)*(class|interface|struct|enum|record(?:\s+struct)?)\s+(\w+)/);
    if (typeMatch) {
      const kindRaw = typeMatch[1].replace(/\s+/g, ' ');
      const kind = kindRaw.startsWith('record') ? 'record' : kindRaw;
      const name = typeMatch[2];
      const containerName = containerStack.length > 0 ? containerStack[containerStack.length - 1].name : undefined;
      symbols.push({
        name,
        kind,
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        containerName,
        exported: trimmed.includes('public') || !trimmed.includes('private'),
      });
      if (/{\s*$/.test(rawLine) || trimmed.endsWith('{')) {
        containerStack.push({ name, kind, depth: braceDepth - 1 });
      }
      continue;
    }

    const propertyMatch = trimmed.match(/^\s*(?:\[[^\]]+\]\s*)*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|sealed\s+|abstract\s+|virtual\s+|override\s+|new\s+)*(?:\w+(?:[<>,?.]|\s*\[\s*\])?\s+)?(\w+)\s*\{[^}]*\bget\b/);
    if (propertyMatch) {
      symbols.push({
        name: propertyMatch[1],
        kind: 'property',
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        containerName: containerStack.length > 0 ? containerStack[containerStack.length - 1].name : undefined,
        exported: trimmed.includes('public') || !trimmed.includes('private'),
      });
      continue;
    }

    const methodMatch = trimmed.match(/^\s*(?:\[[^\]]+\]\s*)*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|sealed\s+|abstract\s+|virtual\s+|override\s+|async\s+|extern\s+|unsafe\s+|partial\s+|new\s+)*(?:<[^>]+>\s*)?(?:\w+(?:[<>,?.]|\s*\[\s*\])?\s+)?(\w+)\s*\(([^)]*)\)/);
    if (methodMatch && !CSHARP_CONTROL_KEYWORDS.has(methodMatch[1]) && (/[;{]/.test(trimmed) || /\)\s*$/.test(trimmed))) {
      const methodName = methodMatch[1];
      const containerName = containerStack.length > 0 ? containerStack[containerStack.length - 1].name : undefined;
      const isConstructor = containerName === methodName;

      if (!isConstructor) {
        const nameIdx = trimmed.indexOf(methodName + '(');
        if (nameIdx <= 0) continue;
        const beforeName = trimmed.slice(0, nameIdx).trim();
        if (!beforeName || beforeName.endsWith('.')) continue;
        const lastToken = beforeName.split(/\s+/).pop() ?? '';
        if (CSHARP_CALL_PREFIXES.has(lastToken) || lastToken === '=') continue;
      }

      symbols.push({
        name: methodName,
        kind: braceDepth > 0 ? 'method' : 'function',
        signature: trimmed.replace(/\s*[;{].*$/, ''),
        line: lineNum,
        containerName,
        exported: trimmed.includes('public') || !trimmed.includes('private'),
      });
      continue;
    }
  }

  return symbols;
}

function extractCppStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  let braceDepth = 0;

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('#') && !trimmed.startsWith('#include')) continue;

    const typeMatch = trimmed.match(/^\s*(?:template\s*<[^>]+>\s*)?(class|struct|enum)\s+(\w+)/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[2],
        kind: typeMatch[1],
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*:.*$/, ''),
        line: lineNum,
        exported: true,
      });
      continue;
    }

    const funcMatch = trimmed.match(/^\s*(?:template\s*<[^>]+>\s*)?(?:inline\s+|static\s+|constexpr\s+|virtual\s+|explicit\s+|friend\s+|extern\s+|consteval\s+|constinit\s+|mutable\s+)*(?:[\w:<>~*&\s]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override|final)?\s*[;{]/);
    if (funcMatch) {
      const isCtor = /^~?\w+$/.test(funcMatch[1]) && braceDepth === 0;
      const isMethod = braceDepth > 0 && !funcMatch[1].startsWith('_');
      symbols.push({
        name: funcMatch[1],
        kind: isCtor ? 'constructor' : isMethod ? 'method' : 'function',
        signature: trimmed.replace(/\s*[;{].*$/, ''),
        line: lineNum,
        exported: true,
      });
      continue;
    }
  }

  return symbols;
}

function extractSwiftStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  let braceDepth = 0;

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    const typeMatch = trimmed.match(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+|indirect\s+)*(class|struct|enum|protocol|actor)\s+(\w+)/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[2],
        kind: typeMatch[1],
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*:.*$/, ''),
        line: lineNum,
        exported: trimmed.includes('public') || trimmed.includes('open') || !trimmed.includes('private'),
      });
      continue;
    }

    const extMatch = trimmed.match(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+|static\s+|class\s+|mutating\s+|nonmutating\s+|override\s+|convenience\s+|required\s+|async\s+|throws\s+|rethrows\s+)*func\s+(\w+)\s*\(/);
    if (extMatch) {
      const hasReceiver = /(?:mutating|nonmutating|convenience|override)\s+func/.test(trimmed);
      symbols.push({
        name: extMatch[1],
        kind: hasReceiver || braceDepth > 0 ? 'method' : 'function',
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        exported: trimmed.includes('public') || trimmed.includes('open') || !trimmed.includes('private'),
      });
      continue;
    }
  }

  return symbols;
}

function extractJsTsStructuralSymbols(content: string): StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  let braceDepth = 0;
  const containerStack: Array<{ name: string; kind: string; depth: number }> = [];

  for (const [lineIdx, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNum = lineIdx + 1;
    const trimmed = rawLine.trim();

    for (const ch of rawLine) {
      if (ch === '{') braceDepth++;
      if (ch === '}') {
        braceDepth--;
        while (containerStack.length > 0 && containerStack[containerStack.length - 1].depth >= braceDepth) {
          containerStack.pop();
        }
      }
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    const containerName = containerStack.length > 0 ? containerStack[containerStack.length - 1].name : undefined;

    const classMatch = trimmed.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|trait)\s+(\w+)/
    );
    if (classMatch) {
      const name = classMatch[2];
      // kind 必须按实际关键字映射：旧实现硬编码 'class'，TS 的 interface/enum
      // 全部被记成 class——lookup 按 symbolKind=interface/enum 查询漏检，
      // extractSymbolRelations 里 kind==='interface' 的 extends/implements
      // 分支对这些符号永不生效。
      const kind = classMatch[1];
      symbols.push({
        name,
        kind,
        signature: trimmed.replace(/\s*\{.*$/, '').replace(/\s*extends.*$/, '').replace(/\s*implements.*$/, ''),
        line: lineNum,
        containerName,
        exported: /\bexport\b/.test(trimmed),
      });
      if (/{\s*$/.test(rawLine) || trimmed.endsWith('{')) {
        containerStack.push({ name, kind, depth: braceDepth - 1 });
      }
      continue;
    }

    const typeAliasMatch = trimmed.match(/^\s*(?:export\s+)?type\s+(\w+)\s*[=<{]/);
    if (typeAliasMatch) {
      symbols.push({
        name: typeAliasMatch[1],
        kind: 'type',
        signature: trimmed.replace(/\s*[={].*$/, ''),
        line: lineNum,
        containerName,
        exported: /\bexport\b/.test(trimmed),
      });
      continue;
    }

    const funcMatch = trimmed.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/
    );
    if (funcMatch) {
      symbols.push({
        name: funcMatch[1],
        kind: braceDepth > 0 ? 'method' : 'function',
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        containerName,
        exported: /\bexport\b/.test(trimmed),
        async: /\basync\b/.test(trimmed),
      });
      continue;
    }

    const arrowConstMatch = trimmed.match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/
    );
    if (arrowConstMatch) {
      symbols.push({
        name: arrowConstMatch[1],
        kind: 'function',
        signature: trimmed.replace(/\s*=>.*$/, ' =>'),
        line: lineNum,
        containerName,
        exported: /\bexport\b/.test(trimmed),
        async: /\basync\b/.test(trimmed),
      });
      continue;
    }

    const methodMatch = trimmed.match(
      /^\s*(?:static\s+|get\s+|set\s+|async\s+|public\s+|private\s+|protected\s+|readonly\s+|override\s+|abstract\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/
    );
    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'throw'].includes(methodMatch[1])) {
      symbols.push({
        name: methodMatch[1],
        kind: 'method',
        signature: trimmed.replace(/\s*\{.*$/, ''),
        line: lineNum,
        containerName,
        exported: false,
        async: /\basync\b/.test(trimmed),
      });
      continue;
    }
  }

  return symbols;
}

function stripRelationDecorators(value: string): string {
  return collapseWhitespace(value)
    .replace(/\b(?:public|private|protected|internal|final|abstract|static|virtual|override|sealed|partial|new|readonly|open|friend)\b/gi, ' ')
    .replace(/^global::/i, '')
    .replace(/[?*&]+$/g, '')
    .replace(/\[\]/g, '')
    .trim();
}

function normalizeRelationTarget(raw: string): RelationTargetDescriptor | null {
  const withoutGenerics = stripGenericSections(stripRelationDecorators(raw))
    .replace(/\s+where\s+.+$/i, '')
    .replace(/\s*\{.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutGenerics) {
    return null;
  }

  const qualifiedName = withoutGenerics.replace(/\([^)]*\)$/g, '').trim();
  if (!qualifiedName) {
    return null;
  }

  const simpleName = qualifiedName.split(/\.|::/).pop()?.trim() ?? qualifiedName;
  if (!simpleName) {
    return null;
  }

  return {
    raw: collapseWhitespace(raw),
    simpleName,
    ...(qualifiedName !== simpleName ? { qualifiedName } : {}),
  };
}

function relationTargets(text: string): RelationTargetDescriptor[] {
  return splitTopLevelList(text)
    .map((item) => normalizeRelationTarget(item))
    .filter((item): item is RelationTargetDescriptor => item !== null);
}

function extractSymbolRelations(symbol: ProjectGraphSymbolInput, language: string): SymbolRelationDescriptor[] {
  const signature = collapseWhitespace(symbol.signature);
  const relations: SymbolRelationDescriptor[] = [];
  const extendsMatch = signature.match(/\bextends\s+(.+?)(?=\bimplements\b|$)/i);
  const implementsMatch = signature.match(/\bimplements\s+(.+)$/i);
  const pythonMatch = symbol.kind === 'class' ? signature.match(/\bclass\s+\w+\((.+)\)/i) : null;
  const colonMatch = signature.match(/\b(?:class|interface|record|struct|protocol|actor|enum)\b[^:]*:\s*(.+)$/i);

  if (extendsMatch) {
    for (const target of relationTargets(extendsMatch[1])) {
      relations.push({ kind: 'extends', target });
    }
  }

  if (implementsMatch) {
    for (const target of relationTargets(implementsMatch[1])) {
      relations.push({ kind: 'implements', target });
    }
  }

  if (!extendsMatch && !implementsMatch && colonMatch) {
    const targets = relationTargets(colonMatch[1]);
    if (targets.length > 0) {
      if (symbol.kind === 'interface') {
        for (const target of targets) {
          relations.push({ kind: 'extends', target });
        }
      } else if (symbol.kind === 'struct') {
        for (const target of targets) {
          relations.push({ kind: 'implements', target });
        }
      } else {
        const isCsharp = /c#|csharp/i.test(language);
        const firstIsInterface = isCsharp && /^I[A-Z]/.test(targets[0].simpleName);
        if (firstIsInterface) {
          for (const target of targets) {
            relations.push({ kind: 'implements', target });
          }
        } else {
          relations.push({ kind: 'extends', target: targets[0] });
          for (const target of targets.slice(1)) {
            const isInterface = isCsharp ? /^I[A-Z]/.test(target.simpleName) : true;
            relations.push({ kind: isInterface ? 'implements' : 'extends', target });
          }
        }
      }
    }
  }

  if (!extendsMatch && !implementsMatch && !colonMatch && pythonMatch) {
    for (const target of relationTargets(pythonMatch[1])) {
      relations.push({ kind: 'extends', target });
    }
  }

  // 旧实现用 language === 'Java' 精确匹配原始标签：扫描器若给出 'java'/'JAVA'
  // 等其它大小写，该分支永不执行（死代码）。统一走 normalizeLanguage。
  if (normalizeLanguage(language) === 'java' && symbol.kind === 'interface') {
    return relations.map((relation) => (relation.kind === 'implements' ? { ...relation, kind: 'extends' } : relation));
  }

  return relations;
}

function symbolNameMatches(candidate: ProjectGraphSymbolCandidate, targetName: string): boolean {
  const normalizedTarget = normalizeIdentifierKey(targetName);
  if (!normalizedTarget) {
    return false;
  }

  return (
    normalizeIdentifierKey(candidate.symbol.name) === normalizedTarget ||
    normalizeIdentifierKey(candidate.qualifiedName) === normalizedTarget ||
    normalizeIdentifierKey(candidate.qualifiedName.split('.').pop()) === normalizedTarget
  );
}

function resolveDefaultImportCandidate(candidates: ProjectGraphSymbolCandidate[]): ProjectGraphSymbolCandidate | null {
  const explicitDefault = candidates.filter((candidate) => /(^|\s)default(\s|$)/i.test(candidate.symbol.signature));
  if (explicitDefault.length === 1) {
    return explicitDefault[0];
  }

  const exportedCandidates = candidates.filter((candidate) => candidate.symbol.exported);
  return exportedCandidates.length === 1 ? exportedCandidates[0] : null;
}

function pickUniqueExportedMatch(
  matches: ProjectGraphSymbolCandidate[],
): ProjectGraphSymbolCandidate | null {
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const callableMatch = matches.find((candidate) => isCallableSymbolKind(candidate.symbol.kind));
    return callableMatch ?? null;
  }
  return null;
}

/** 从模块导出面解析符号：先看本文件，再沿 `export *` / `export { a as b }` 再导出穿透。 */
function resolveExportedSymbolInModule(
  modulePath: string,
  importedName: string,
  candidatesByPath: Map<string, ProjectGraphSymbolCandidate[]>,
  moduleContexts: Map<string, FileModuleContext> | undefined,
  visited: Set<string> = new Set(),
): ProjectGraphSymbolCandidate | null {
  if (!modulePath || visited.has(modulePath)) {
    return null;
  }
  visited.add(modulePath);

  const localCandidates = candidatesByPath.get(modulePath) ?? [];
  if (importedName === 'default') {
    const localDefault = resolveDefaultImportCandidate(localCandidates);
    if (localDefault) {
      return localDefault;
    }
  } else {
    const localMatches = localCandidates.filter(
      (candidate) => candidate.symbol.exported && symbolNameMatches(candidate, importedName),
    );
    const picked = pickUniqueExportedMatch(localMatches);
    if (picked) {
      return picked;
    }
  }

  for (const reexport of moduleContexts?.get(modulePath)?.reexports ?? []) {
    if (reexport.star) {
      const found = resolveExportedSymbolInModule(
        reexport.targetPath,
        importedName,
        candidatesByPath,
        moduleContexts,
        visited,
      );
      if (found) {
        return found;
      }
      continue;
    }
    if (reexport.localName !== importedName) {
      continue;
    }
    const found = resolveExportedSymbolInModule(
      reexport.targetPath,
      reexport.importedName ?? importedName,
      candidatesByPath,
      moduleContexts,
      visited,
    );
    if (found) {
      return found;
    }
  }

  return null;
}

function resolveTargetFromBindings(
  bindingCandidates: ModuleBinding[] | undefined,
  relation: RelationTargetDescriptor,
  candidatesByPath: Map<string, ProjectGraphSymbolCandidate[]>,
  moduleContexts?: Map<string, FileModuleContext>,
): ProjectGraphSymbolCandidate | null {
  if (!bindingCandidates?.length) {
    return null;
  }

  for (const binding of bindingCandidates) {
    const importedName = binding.importedName ?? relation.simpleName;
    const resolved = resolveExportedSymbolInModule(
      binding.targetPath,
      importedName,
      candidatesByPath,
      moduleContexts,
    );
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveRelatedSymbol(params: {
  sourcePath: string;
  relation: RelationTargetDescriptor;
  moduleContext: FileModuleContext | undefined;
  moduleContexts?: Map<string, FileModuleContext>;
  candidatesByPath: Map<string, ProjectGraphSymbolCandidate[]>;
  candidatesBySimpleName: Map<string, ProjectGraphSymbolCandidate[]>;
  candidatesByQualifiedName: Map<string, ProjectGraphSymbolCandidate[]>;
  sourceSymbol?: ProjectGraphSymbolInput;
}): ProjectGraphSymbolCandidate | null {
  const {
    sourcePath,
    relation,
    moduleContext,
    moduleContexts,
    candidatesByPath,
    candidatesBySimpleName,
    candidatesByQualifiedName,
    sourceSymbol,
  } = params;
  const sourceCandidates = candidatesByPath.get(sourcePath) ?? [];
  const relationQualifiedKey = normalizeIdentifierKey(relation.qualifiedName);
  const relationSimpleKey = normalizeIdentifierKey(relation.simpleName);

  if (relationQualifiedKey) {
    const sameFileQualified = sourceCandidates.filter((candidate) => normalizeIdentifierKey(candidate.qualifiedName) === relationQualifiedKey);
    if (sameFileQualified.length === 1) {
      return sameFileQualified[0];
    }
    if (sameFileQualified.length > 1 && sourceSymbol) {
      const tripleMatch = sameFileQualified.find((c) =>
        c.symbol.kind === sourceSymbol.kind ||
        c.symbol.kind === 'interface' && sourceSymbol.kind === 'class' ||
        c.symbol.kind === 'class' && sourceSymbol.kind === 'interface'
      );
      if (tripleMatch) return tripleMatch;
    }
  }

  if (relationSimpleKey) {
    const sameFileSimple = sourceCandidates.filter((candidate) => normalizeIdentifierKey(candidate.symbol.name) === relationSimpleKey);
    if (sameFileSimple.length === 1) {
      return sameFileSimple[0];
    }
    if (sameFileSimple.length > 1 && sourceSymbol) {
      const kindMatch = sameFileSimple.find((c) =>
        c.symbol.kind === sourceSymbol.kind ||
        (c.symbol.kind === 'interface' && sourceSymbol.kind === 'class') ||
        (c.symbol.kind === 'class' && sourceSymbol.kind === 'interface')
      );
      if (kindMatch) return kindMatch;
    }
  }

  if (moduleContext) {
    const directBindingCandidate = resolveTargetFromBindings(
      moduleContext.importedSymbols.get(relation.simpleName) ?? moduleContext.importedSymbols.get(relation.qualifiedName ?? ''),
      relation,
      candidatesByPath,
      moduleContexts,
    );
    if (directBindingCandidate) {
      return directBindingCandidate;
    }

    if (relation.qualifiedName && relation.qualifiedName.includes('.')) {
      const [namespaceAlias, ...restSegments] = relation.qualifiedName.split('.');
      const namespaceBinding = moduleContext.importedNamespaces.get(namespaceAlias);
      if (namespaceBinding && restSegments.length > 0) {
        const namespaceTargetName = restSegments.join('.');
        const viaReexport = resolveExportedSymbolInModule(
          namespaceBinding.targetPath,
          namespaceTargetName,
          candidatesByPath,
          moduleContexts,
        );
        if (viaReexport) {
          return viaReexport;
        }
        const targetCandidates = candidatesByPath.get(namespaceBinding.targetPath) ?? [];
        const namespaceMatches = targetCandidates.filter(
          (candidate) =>
            symbolNameMatches(candidate, namespaceTargetName) &&
            candidate.symbol.exported
        );
        if (namespaceMatches.length === 1) {
          return namespaceMatches[0];
        }
        if (namespaceMatches.length > 1 && sourceSymbol) {
          const kindMatch = namespaceMatches.find((c) =>
            c.symbol.kind === sourceSymbol.kind ||
            (c.symbol.kind === 'interface' && sourceSymbol.kind === 'class') ||
            (c.symbol.kind === 'class' && sourceSymbol.kind === 'interface')
          );
          if (kindMatch) return kindMatch;
        }
      }
    }
  }

  if (relationQualifiedKey) {
    const qualifiedMatches = candidatesByQualifiedName.get(relationQualifiedKey) ?? [];
    if (qualifiedMatches.length === 1) {
      return qualifiedMatches[0];
    }
    if (qualifiedMatches.length > 1 && sourceSymbol) {
      const kindMatch = qualifiedMatches.find((c) =>
        c.symbol.kind === sourceSymbol.kind ||
        (c.symbol.kind === 'interface' && sourceSymbol.kind === 'class') ||
        (c.symbol.kind === 'class' && sourceSymbol.kind === 'interface')
      );
      if (kindMatch) return kindMatch;
    }
  }

  if (!relationSimpleKey) {
    return null;
  }

  const simpleMatches = candidatesBySimpleName.get(relationSimpleKey) ?? [];
  if (simpleMatches.length === 1) {
    return simpleMatches[0];
  }

  const exportedMatches = simpleMatches.filter((candidate) => candidate.symbol.exported);
  if (exportedMatches.length === 1) {
    return exportedMatches[0];
  }

  if (sourceSymbol) {
    const kindMatch = (exportedMatches.length > 0 ? exportedMatches : simpleMatches).find((c) =>
      c.symbol.kind === sourceSymbol.kind ||
      (c.symbol.kind === 'interface' && sourceSymbol.kind === 'class') ||
      (c.symbol.kind === 'class' && sourceSymbol.kind === 'interface')
    );
    if (kindMatch) return kindMatch;
  }

  return null;
}

function fileHasEntrypointBootstrapEvidence(file: ProjectGraphFileInput, content?: string): boolean {
  const normalizedPath = normalizePath(file.path).toLowerCase();
  const fileName = basenameWithoutExtension(normalizedPath);
  if (ENTRYPOINT_FILE_NAMES.has(fileName)) {
    return true;
  }
  const normalizedContent = content ?? '';
  return (
    /require\.main\s*===\s*module/.test(normalizedContent) ||
    /import\.meta\.main/.test(normalizedContent) ||
    /createRoot\(|ReactDOM\.render\(|\.listen\(/.test(normalizedContent) ||
    /:\s*(Node|Control|Node2D|Node3D|CanvasItem|SceneTree)\b/.test(normalizedContent) ||
    /\b(GD\.Print|GetTree|GetNode|_Ready\s*\()/.test(normalizedContent) ||
    /\b(Host\.CreateDefaultBuilder|Application\.Run|Build\(\)\.RunAsync)/.test(normalizedContent)
  );
}

function symbolLooksLikeNamedEntrypoint(symbol: ProjectGraphSymbolInput): boolean {
  const name = symbol.name.trim().toLowerCase();
  return ENTRYPOINT_SYMBOL_NAMES.has(name) || name === 'main';
}

function symbolEntryPointScore(symbol: ProjectGraphSymbolInput): number {
  const name = symbol.name.trim().toLowerCase();
  let score = 0;

  if (ENTRYPOINT_SYMBOL_NAMES.has(name)) {
    score += 40;
  }
  if (symbol.exported) {
    score += 15;
  }
  if (symbol.kind === 'function' || symbol.kind === 'method') {
    score += 10;
  }
  if (/export\s+default/i.test(symbol.signature)) {
    score += 12;
  }
  if (name === 'main') {
    score += 20;
  }

  return score;
}

function fileEntryPointScore(file: ProjectGraphFileInput, content?: string): number {
  const normalizedPath = normalizePath(file.path).toLowerCase();
  const fileName = basenameWithoutExtension(normalizedPath);
  const depth = normalizedPath.split('/').length;
  let score = 0;

  if (ENTRYPOINT_FILE_NAMES.has(fileName)) {
    score += 60;
  }
  if (/\/(src|app|server|client)\//.test(normalizedPath)) {
    score += 10;
  }
  if (depth <= 2) {
    score += 8;
  }
  let bestSymbolScore = 0;
  for (const symbol of file.symbols) {
    bestSymbolScore = Math.max(bestSymbolScore, Math.min(35, symbolEntryPointScore(symbol)));
  }
  score += bestSymbolScore;

  const normalizedContent = content ?? '';
  if (/require\.main\s*===\s*module/.test(normalizedContent) || /import\.meta\.main/.test(normalizedContent)) {
    score += 35;
  }
  if (/createRoot\(|ReactDOM\.render\(|\.listen\(/.test(normalizedContent)) {
    score += 18;
  }
  if (/:\s*(Node|Control|Node2D|Node3D|CanvasItem|SceneTree)\b/.test(normalizedContent)) {
    score += 25;
  }
  if (/\b(GD\.Print|GetTree|GetNode|_Ready\s*\()/.test(normalizedContent)) {
    score += 15;
  }
  if (/\b(Host\.CreateDefaultBuilder|Application\.Run|Build\(\)\.RunAsync)/.test(normalizedContent)) {
    score += 25;
  }

  return score;
}

export function buildWorkspaceProjectGraph(params: BuildWorkspaceProjectGraphParams): WorkspaceProjectGraphResult {
  try {
    return buildWorkspaceProjectGraphImpl(params);
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn('[ProjectGraph] build failed, returning degraded tree-only result:', reason);
    // 降级：仅保留目录树骨架，剥离语义/符号/边，避免 Explore 子代理整体崩
    return buildDegradedProjectGraph(params, reason);
  }
}

function buildDegradedProjectGraph(
  params: BuildWorkspaceProjectGraphParams,
  reason: string,
): WorkspaceProjectGraphResult {
  const truncated = Boolean(params.truncated);
  const fileNodes: ProjectGraphNode[] = (params.files ?? []).map((file) => ({
    id: fileNodeId(normalizePath(file.path)),
    kind: 'file' as const,
    label: basename(normalizePath(file.path)) || file.path,
    path: normalizePath(file.path),
    fileType: classifyFileType(normalizePath(file.path)),
    ...(file.language ? { language: file.language } : {}),
    ...(typeof file.bytes === 'number' ? { bytes: file.bytes } : {}),
    ...(file.entryPoint ? { entryPoint: true } : {}),
  }));

  return {
    root: params.root,
    tree: params.tree,
    files: params.files ?? [],
    nodes: fileNodes,
    edges: [],
    summary: {
      files: fileNodes.length,
      testFiles: 0,
      configFiles: 0,
      docFiles: 0,
      symbols: 0,
      imports: 0,
      reexports: 0,
      extends: 0,
      implements: 0,
      calls: 0,
      testedBy: 0,
      configures: 0,
      lspSymbols: 0,
      entryPoints: 0,
      orphanNodes: 0,
      edges: 0,
      truncated,
      lspEnhanced: false,
      validated: false,
    },
    quality: {
      lspCoverage: 0,
      astCoverage: 0,
      callGraphPrecision: 0,
      importResolutionRate: 0,
    },
    truncated,
    degraded: true,
    degradedReason: reason,
  };
}

function buildWorkspaceProjectGraphImpl(params: BuildWorkspaceProjectGraphParams): WorkspaceProjectGraphResult {
  const maxEdges = Math.max(1, params.maxEdges ?? Number.MAX_SAFE_INTEGER);
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const allFileSet = new Set<string>();
  const fileLookup = new Map<string, ProjectGraphFileInput>();
  const candidatesByPath = new Map<string, ProjectGraphSymbolCandidate[]>();
  const candidatesBySimpleName = new Map<string, ProjectGraphSymbolCandidate[]>();
  const candidatesByQualifiedName = new Map<string, ProjectGraphSymbolCandidate[]>();
  const moduleContexts = new Map<string, FileModuleContext>();
  let lspSymbols = 0;
  let semanticEdgeCount = 0;

  const addContainsEdge = (edge: ProjectGraphEdge): boolean => {
    if (seenEdges.has(edge.id)) return false;
    seenEdges.add(edge.id);
    edges.push(edge);
    return true;
  };

  const addSemanticEdge = (edge: ProjectGraphEdge): boolean => {
    if (semanticEdgeCount >= maxEdges || seenEdges.has(edge.id)) return false;
    seenEdges.add(edge.id);
    edges.push(edge);
    semanticEdgeCount++;
    return true;
  };

  for (const entry of params.allFiles ?? []) {
    if (!entry.isDir) {
      allFileSet.add(normalizePath(entry.path));
    }
  }
  for (const path of Object.keys(params.fileContents ?? {})) {
    allFileSet.add(normalizePath(path));
  }
  for (const file of params.files) {
    const normalizedPath = normalizePath(file.path);
    allFileSet.add(normalizedPath);
    fileLookup.set(normalizedPath, file);
  }

  const prioritizedFiles = [...params.files]
    .map((file) => {
      const normalizedPath = normalizePath(file.path);
      const contentForScore = params.fileContents?.[normalizedPath]?.content
        ?? params.fileContents?.[file.path]?.content
        ?? params.fileContents?.[normalizePath(file.path)]?.content;
      const score = fileEntryPointScore(file, contentForScore);
      return {
        ...file,
        path: normalizedPath,
        entryPoint: fileHasEntrypointBootstrapEvidence(file, contentForScore) && score >= 60,
        entryPointScore: score,
      } satisfies ProjectGraphFileInput;
    })
    .sort((left, right) => {
      const scoreDiff = (right.entryPointScore ?? 0) - (left.entryPointScore ?? 0);
      return scoreDiff !== 0 ? scoreDiff : left.path.localeCompare(right.path);
    });

  const ensureFileNode = (file: ProjectGraphFileInput): string => {
    const normalizedPath = normalizePath(file.path);
    const id = fileNodeId(normalizedPath);
    if (!seenNodes.has(id)) {
      seenNodes.add(id);
      nodes.push({
        id,
        kind: 'file',
        label: basename(normalizedPath) || normalizedPath,
        path: normalizedPath,
        fileType: classifyFileType(normalizedPath),
        ...(file.language ? { language: file.language } : {}),
        ...(typeof file.bytes === 'number' ? { bytes: file.bytes } : {}),
        ...(file.entryPoint ? { entryPoint: true } : {}),
        ...(typeof file.entryPointScore === 'number' ? { entryPointScore: file.entryPointScore } : {}),
      });
    }
    return id;
  };

  for (const file of prioritizedFiles) {
    const fileId = ensureFileNode(file);
    const pathCandidates: ProjectGraphSymbolCandidate[] = [];

    file.symbols.forEach((symbol, index) => {
      const id = symbolNodeId(file.path, symbol, index);
      const qualifiedName = qualifiedSymbolName(symbol);
      const localEntryPointScore = symbolEntryPointScore(symbol) + (file.entryPoint ? 10 : 0);
      if (!seenNodes.has(id)) {
        seenNodes.add(id);
        nodes.push({
          id,
          kind: 'symbol',
          label: qualifiedName,
          path: file.path,
          language: file.language,
          symbol,
          symbolSource: file.symbolSource,
          qualifiedName,
          ...(symbolLooksLikeNamedEntrypoint(symbol) && localEntryPointScore >= 35
            ? { entryPoint: true, entryPointScore: localEntryPointScore }
            : {}),
        });
        if (file.symbolSource === 'lsp') {
          lspSymbols += 1;
        }
      }

      const candidate = {
        id,
        path: file.path,
        symbol,
        qualifiedName,
      } satisfies ProjectGraphSymbolCandidate;
      pathCandidates.push(candidate);

      const simpleKey = normalizeIdentifierKey(symbol.name);
      if (simpleKey) {
        const existing = candidatesBySimpleName.get(simpleKey) ?? [];
        existing.push(candidate);
        candidatesBySimpleName.set(simpleKey, existing);
      }

      const qualifiedKey = normalizeIdentifierKey(qualifiedName);
      if (qualifiedKey) {
        const existing = candidatesByQualifiedName.get(qualifiedKey) ?? [];
        existing.push(candidate);
        candidatesByQualifiedName.set(qualifiedKey, existing);
      }

      addContainsEdge({
        id: `contains:${fileId}->${id}`,
        kind: 'contains',
        from: fileId,
        to: id,
        label: 'contains',
      });
    });

    candidatesByPath.set(file.path, pathCandidates);
  }

  for (const file of prioritizedFiles) {
    const fileContent = params.fileContents?.[file.path]?.content ?? params.fileContents?.[normalizePath(file.path)]?.content;
    if (!fileContent) {
      continue;
    }
    moduleContexts.set(file.path, buildModuleContext(file.path, fileContent, allFileSet, file.language));
  }

  for (const file of prioritizedFiles) {
    if (semanticEdgeCount >= maxEdges) {
      break;
    }

    const fileId = ensureFileNode(file);
    const moduleContext = moduleContexts.get(file.path);
    for (const reference of moduleContext?.references ?? []) {
      const targetPath = resolveImportTarget(file.path, reference.specifier, allFileSet, detectLanguage(file.path, file.language));
      if (!targetPath) {
        continue;
      }

      const targetFile =
        prioritizedFiles.find((item) => item.path === targetPath) ??
        fileLookup.get(targetPath) ?? {
          path: targetPath,
          language: '',
          bytes: params.fileContents?.[targetPath]?.bytes ?? 0,
          symbols: [],
        };

      const targetId = ensureFileNode(targetFile);
      addSemanticEdge({
        id: `${reference.kind}:${fileId}->${targetId}:${reference.specifier}`,
        kind: reference.kind,
        from: fileId,
        to: targetId,
        label: reference.specifier,
      });
    }

    // 具名导入若能解析到具体符号（而非只是文件），额外补一条文件->符号的 imports 边。
    // 否则 class/interface 等仅被 import + new/类型引用（没有 calls/extends/implements）
    // 的符号在图里永远拿不到任何入边，会被 dead_code 误判为死代码。
    for (const bindings of moduleContext?.importedSymbols?.values() ?? []) {
      if (semanticEdgeCount >= maxEdges) {
        break;
      }
      for (const binding of bindings) {
        const resolved = resolveExportedSymbolInModule(
          binding.targetPath,
          binding.importedName ?? '',
          candidatesByPath,
          moduleContexts,
        );
        if (!resolved) {
          continue;
        }

        addSemanticEdge({
          id: `imports:${fileId}->${resolved.id}:${binding.importedName ?? resolved.symbol.name}`,
          kind: 'imports',
          from: fileId,
          to: resolved.id,
          label: binding.importedName,
        });
      }
    }

    for (const candidate of candidatesByPath.get(file.path) ?? []) {
      if (semanticEdgeCount >= maxEdges) {
        break;
      }

      const relations = extractSymbolRelations(candidate.symbol, file.language);
      for (const relation of relations) {
        const targetCandidate = resolveRelatedSymbol({
          sourcePath: file.path,
          relation: relation.target,
          moduleContext,
          moduleContexts,
          candidatesByPath,
          candidatesBySimpleName,
          candidatesByQualifiedName,
          sourceSymbol: candidate.symbol,
        });
        if (!targetCandidate || targetCandidate.id === candidate.id) {
          continue;
        }

        addSemanticEdge({
          id: `${relation.kind}:${candidate.id}->${targetCandidate.id}:${relation.target.qualifiedName ?? relation.target.simpleName}`,
          kind: relation.kind,
          from: candidate.id,
          to: targetCandidate.id,
          label: relation.target.raw,
        });
      }
    }
  }

  // ============= Phase 2.4: C# Cross-File Type References =============
  // C# `using` imports namespaces (usually framework), not local files.
  // Detect cross-file type references by scanning for type names defined in other files.
  const CSHARP_TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'record']);
  for (const file of prioritizedFiles) {
    if (semanticEdgeCount >= maxEdges) break;
    const lang = detectLanguage(file.path, file.language);
    if (lang !== 'csharp') continue;

    const fileContent = params.fileContents?.[file.path]?.content ?? params.fileContents?.[normalizePath(file.path)]?.content;
    if (!fileContent) continue;

    const fileId = ensureFileNode(file);
    const seenTypeRefs = new Set<string>();

    const typeRefPattern = /\bnew\s+([A-Z]\w*)\s*\(|\b([A-Z]\w*)\s*\.\s*\w+/g;
    let typeMatch: RegExpExecArray | null;
    while ((typeMatch = typeRefPattern.exec(fileContent)) !== null) {
      const typeName = typeMatch[1] ?? typeMatch[2];
      if (!typeName || seenTypeRefs.has(typeName)) continue;
      seenTypeRefs.add(typeName);

      const typeKey = normalizeIdentifierKey(typeName);
      if (!typeKey) continue;
      const candidates = (candidatesBySimpleName.get(typeKey) ?? [])
        .filter((c) => CSHARP_TYPE_KINDS.has(c.symbol.kind));
      if (candidates.length === 0) continue;

      for (const candidate of candidates) {
        if (candidate.path === file.path) continue;
        const targetFile = prioritizedFiles.find((item) => item.path === candidate.path) ?? fileLookup.get(candidate.path);
        if (!targetFile) continue;

        const targetId = ensureFileNode(targetFile);
        const edgeId = `imports:${fileId}->${targetId}:${typeName}`;
        addSemanticEdge({
          id: edgeId,
          kind: 'imports',
          from: fileId,
          to: targetId,
          label: typeName,
        });
      }
    }
  }

  // ============= Phase 2.4b: tested_by / configures 边 =============
  const testNodeIds = new Set<string>();
  const configNodeIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    if (node.fileType === 'test') testNodeIds.add(node.id);
    if (node.fileType === 'config') configNodeIds.add(node.id);
  }

  if (testNodeIds.size > 0) {
    for (const edge of edges) {
      if (edge.kind !== 'imports' && edge.kind !== 'reexports') continue;
      const fromNode = nodes.find((n) => n.id === edge.from);
      const toNode = nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) continue;
      if (testNodeIds.has(edge.from) && fromNode.kind === 'file' && toNode.fileType === 'source') {
        const testedById = `tested_by:${edge.from}->${edge.to}`;
        if (seenEdges.has(testedById)) continue;
        seenEdges.add(testedById);
        edges.push({
          id: testedById,
          kind: 'tested_by',
          from: edge.from,
          to: edge.to,
          label: 'tested_by',
        });
      }
    }
  }

  if (configNodeIds.size > 0) {
    for (const edge of edges) {
      if (edge.kind !== 'imports' && edge.kind !== 'reexports') continue;
      const fromNode = nodes.find((n) => n.id === edge.from);
      const toNode = nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) continue;
      if (configNodeIds.has(edge.to) && toNode.fileType === 'config') {
        const configuresId = `configures:${edge.from}->${edge.to}`;
        if (seenEdges.has(configuresId)) continue;
        seenEdges.add(configuresId);
        edges.push({
          id: configuresId,
          kind: 'configures',
          from: edge.from,
          to: edge.to,
          label: 'configures',
        });
      }
    }
  }

  const duplicateCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== 'symbol') {
      continue;
    }

    const key = normalizeIdentifierKey(node.qualifiedName ?? node.label) ?? node.label;
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }

  for (const node of nodes) {
    if (node.kind !== 'symbol') {
      continue;
    }

    const key = normalizeIdentifierKey(node.qualifiedName ?? node.label) ?? node.label;
    if ((duplicateCounts.get(key) ?? 0) > 1) {
      node.label = `${node.qualifiedName ?? node.label} · ${node.path}:L${node.symbol?.line ?? 0}`;
      node.disambiguated = true;
    }
  }

  // ============= Phase 2.5: Call Graph =============
  const callEdgeCounter = { value: semanticEdgeCount };
  buildCallEdges(nodes, edges, seenEdges, candidatesByPath, candidatesBySimpleName, candidatesByQualifiedName, prioritizedFiles, params.fileContents, moduleContexts, maxEdges, callEdgeCounter);
  semanticEdgeCount = callEdgeCounter.value;

  const imports = edges.filter((edge) => edge.kind === 'imports').length;
  const reexports = edges.filter((edge) => edge.kind === 'reexports').length;
  const extendsCount = edges.filter((edge) => edge.kind === 'extends').length;
  const implementsCount = edges.filter((edge) => edge.kind === 'implements').length;
  const calls = edges.filter((edge) => edge.kind === 'calls').length;
  const testedBy = edges.filter((edge) => edge.kind === 'tested_by').length;
  const configuresEdges = edges.filter((edge) => edge.kind === 'configures').length;

  // ============= Phase 2.6: Quality Metrics =============
  const quality = computeQualityMetrics(prioritizedFiles, nodes, edges, lspSymbols, moduleContexts, allFileSet);

  // ============= Phase 2.7: Validation & Orphan Detection =============
  const validation = validateProjectGraph(nodes, edges);

  // ============= Phase 3: LSP 关系增强 =============
  // 注意：这里只是参数配置齐全，真正的 LSP 语义增强是异步的 enrichProjectGraphEdges，
  // 需要调用方拿到这个结果后单独调用并等待完成。这里不能提前把 lspEnhanced
  // 置为 true，否则会出现“参数传对了就显示已增强”但实际从未执行增强的误导性状态。
  // 只有真正跑完 enrichProjectGraphEdges 后，那里才会把 summary.lspEnhanced 置为 true。
  const lspEnhanced = false;

  const truncated = Boolean(params.truncated);

  return {
    root: params.root,
    tree: params.tree,
    files: prioritizedFiles,
    nodes,
    edges,
    summary: {
      files: prioritizedFiles.length,
      testFiles: nodes.filter((n) => n.kind === 'file' && n.fileType === 'test').length,
      configFiles: nodes.filter((n) => n.kind === 'file' && n.fileType === 'config').length,
      docFiles: nodes.filter((n) => n.kind === 'file' && n.fileType === 'doc').length,
      symbols: nodes.filter((node) => node.kind === 'symbol').length,
      imports,
      reexports,
      extends: extendsCount,
      implements: implementsCount,
      calls,
      testedBy,
      configures: configuresEdges,
      lspSymbols,
      entryPoints: prioritizedFiles.filter((file) => file.entryPoint).length,
      orphanNodes: validation.orphanCount,
      edges: edges.length,
      truncated,
      lspEnhanced,
      validated: validation.valid,
    },
    quality,
    truncated,
  };
}

interface ProjectGraphValidationResult {
  valid: boolean;
  orphanCount: number;
  danglingEdgeCount: number;
  duplicateEdgeCount: number;
  issues: string[];
}

function validateProjectGraph(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
): ProjectGraphValidationResult {
  const issues: string[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  let danglingEdgeCount = 0;
  let duplicateEdgeCount = 0;

  const edgeKeySet = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.kind}:${edge.from}->${edge.to}`;
    if (edgeKeySet.has(key)) {
      duplicateEdgeCount++;
      issues.push(`Duplicate edge: ${key}`);
      continue;
    }
    edgeKeySet.add(key);

    if (!nodeIds.has(edge.from)) {
      danglingEdgeCount++;
      issues.push(`Dangling edge source: ${edge.kind} ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.to)) {
      danglingEdgeCount++;
      issues.push(`Dangling edge target: ${edge.kind} ${edge.from} -> ${edge.to}`);
    }
  }

  const connectedNodes = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    connectedNodes.add(edge.from);
    connectedNodes.add(edge.to);
  }

  let orphanCount = 0;
  for (const node of nodes) {
    if (node.kind === 'file' && !connectedNodes.has(node.id)) {
      orphanCount++;
    }
  }

  const valid = danglingEdgeCount === 0;

  return { valid, orphanCount, danglingEdgeCount, duplicateEdgeCount, issues };
}

function computeQualityMetrics(
  files: ProjectGraphFileInput[],
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
  lspSymbols: number,
  moduleContexts: Map<string, FileModuleContext>,
  _allFiles: ReadonlySet<string>,
): ProjectGraphQualityMetrics {
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const symbolNodes = nodes.filter((n) => n.kind === 'symbol');
  const totalSymbols = symbolNodes.length;
  const lspCoverage = totalSymbols > 0 ? lspSymbols / totalSymbols : 0;

  const astSymbols = symbolNodes.filter((n) => n.symbolSource === 'ast').length;
  const astCoverage = totalSymbols > 0 ? (lspSymbols + astSymbols) / totalSymbols : 0;

  const callEdges = edges.filter((e) => e.kind === 'calls');
  const totalCallEdges = callEdges.length;
  const callsWithReceiver = callEdges.filter((e) => e.label?.includes('.') || e.label?.includes('::')).length;
  const callsToExportedTargets = callEdges.filter((e) => {
    const targetNode = nodeById.get(e.to);
    return targetNode?.symbol?.exported ?? false;
  }).length;
  const callGraphPrecision = totalCallEdges > 0
    ? (callsWithReceiver + callsToExportedTargets) / (2 * Math.max(1, totalCallEdges))
    : 0;

  let resolvedImports = 0;
  let totalImports = 0;
  for (const ctx of moduleContexts.values()) {
    // references 只含解析成功的导入；加上未解析的项目内导入才是真实分母，
    // 否则该指标结构性恒等于 1，无法反映图质量。
    totalImports += ctx.references.length + (ctx.unresolvedLocalImports ?? 0);
  }
  for (const edge of edges) {
    if (edge.kind !== 'imports') continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from?.kind === 'file' && to?.kind === 'file') {
      resolvedImports++;
    }
  }
  const importResolutionRate = totalImports > 0 ? resolvedImports / totalImports : 0;

  return {
    lspCoverage: Math.round(lspCoverage * 1000) / 1000,
    astCoverage: Math.round(astCoverage * 1000) / 1000,
    callGraphPrecision: Math.round(callGraphPrecision * 1000) / 1000,
    importResolutionRate: Math.round(importResolutionRate * 1000) / 1000,
  };
}

function buildCallEdges(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
  seenEdges: Set<string>,
  candidatesByPath: Map<string, ProjectGraphSymbolCandidate[]>,
  candidatesBySimpleName: Map<string, ProjectGraphSymbolCandidate[]>,
  candidatesByQualifiedName: Map<string, ProjectGraphSymbolCandidate[]>,
  files: ProjectGraphFileInput[],
  fileContents: Record<string, ProjectGraphFileContent> | undefined,
  moduleContexts: Map<string, FileModuleContext>,
  maxEdges: number,
  semanticEdgeCount: { value: number },
) {
  if (!fileContents) return;

  const symbolNodes = nodes.filter((n) => n.kind === 'symbol' && n.symbol);
  const callableSymbols = symbolNodes.filter(
    (n) => n.symbol && isCallableSymbolKind(n.symbol.kind)
  );
  const callableNames = new Set(callableSymbols.map((n) => n.symbol!.name));

  const fileContentCache = new Map<string, string>();
  for (const file of files) {
    const content = fileContents[file.path]?.content;
    if (!content) continue;
    fileContentCache.set(file.path, content);
  }

  for (const file of files) {
    if (semanticEdgeCount.value >= maxEdges) break;
    const content = fileContentCache.get(file.path);
    if (!content) continue;

    const fileCandidates = candidatesByPath.get(file.path) ?? [];
    const funcSymbols = fileCandidates.filter(
      (c) => c.symbol && isCallableSymbolKind(c.symbol.kind)
    );
    if (funcSymbols.length === 0) continue;

    const callTargets = extractCallTargets(file.path, content, file.language);
    const moduleContext = moduleContexts.get(file.path);

    for (const func of funcSymbols) {
      if (semanticEdgeCount.value >= maxEdges) break;
      const funcLine = func.symbol!.line;
      const funcEndLine = findFunctionEndLine(content, funcLine, file.path, file.language);
      // candidate.id 与建图时 symbolNodeId(path, symbol, index) 生成的节点 ID
      // 完全一致，直接复用：旧实现用 fileCandidates.indexOf(func) 重建索引是
      // O(符号数²)，且一旦候选数组中途被过滤/重排就会指向错误节点。
      const sourceId = func.id;

      for (const call of callTargets) {
        if (!callableNames.has(call.name)) continue;
        if (call.line < funcLine) continue;
        if (funcEndLine > 0 && call.line > funcEndLine) continue;
        // 函数/方法自身的声明行会把 `function foo(` 里的 foo 误判成一次"调用"，
        // 必须排除，否则任何函数都会靠这条假边把自己标记成"已被使用"。
        if (call.line === funcLine && call.name === func.symbol!.name) continue;

        const target = resolveCallTarget(
          call.name,
          call.receiver,
          file.path,
          candidatesByPath,
          candidatesBySimpleName,
          candidatesByQualifiedName,
          moduleContext,
          moduleContexts,
        );
        if (!target || target.id === sourceId) continue;

        const edgeId = `calls:${sourceId}->${target.id}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);

        edges.push({
          id: edgeId,
          kind: 'calls',
          from: sourceId,
          to: target.id,
        });
        semanticEdgeCount.value++;
      }
    }
  }
}

interface CallTarget {
  name: string;
  receiver?: string;
  line: number;
  character: number;
}

function isCallableSymbolKind(kind: string): boolean {
  return /^(function|method|constructor|arrow|local_function|fn|def|func|sub)$/i.test(kind);
}

const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return',
  'typeof', 'instanceof', 'new', 'delete', 'throw',
  'import', 'export', 'from', 'async', 'await',
  'class', 'function', 'var', 'let', 'const', 'static',
  'public', 'private', 'protected', 'abstract',
  'super', 'this', 'true', 'false', 'null', 'undefined',
  'void', 'int', 'float', 'double', 'bool', 'string',
  'enum', 'interface', 'type', 'extends', 'implements',
  'break', 'continue', 'default', 'else', 'finally',
  'try', 'do', 'goto', 'as', 'is', 'in', 'of',
  'print', 'printf', 'echo', 'exit', 'die',
  'def', 'fn', 'func', 'sub', 'proc',
  'match', 'loop', 'range', 'len', 'str', 'int',
  'impl', 'mod', 'use', 'pub', 'mut', 'let', 'move',
  'package', 'defer', 'go', 'chan', 'select', 'map', 'cap', 'copy', 'append',
  'self', 'cls', 'raise', 'pass', 'with', 'yield', 'lambda', 'global', 'nonlocal',
  'struct', 'trait', 'enum', 'where', 'type', 'dyn', 'ref',
]);

function extractCallTargets(
  _path: string,
  content: string,
  language?: string,
): CallTarget[] {
  const normLang = detectLanguage(_path, language);
  const code = buildCodeMask(content, normLang === 'python' ? 'python' : 'c-like');
  const results: CallTarget[] = [];
  const seen = new Set<string>();
  let lineNum = 1;
  let lineStart = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const inCode = (index: number): boolean => isCodeIndex(code, lineStart + index);
    if (line && !line.startsWith('//') && !line.startsWith('#') && !line.startsWith('/*')) {
    switch (normLang) {
      case 'python': {
        const pyPattern = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
        let pyMatch: RegExpExecArray | null;
        while ((pyMatch = pyPattern.exec(rawLine)) !== null) {
          if (!inCode(pyMatch.index)) continue;
          const receiver = pyMatch[1] || undefined;
          const name = pyMatch[2];
          if (!name || CALL_KEYWORDS.has(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver)) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: pyMatch.index + 1 });
        }
        break;
      }
      case 'rust': {
        const rustPattern = /(?:(\w+(?:::\w+)*)\s*::\s*)?(\w+)\s*[(<]/g;
        let rsMatch: RegExpExecArray | null;
        while ((rsMatch = rustPattern.exec(rawLine)) !== null) {
          if (!inCode(rsMatch.index)) continue;
          const receiver = rsMatch[1] || undefined;
          const name = rsMatch[2];
          if (!name || CALL_KEYWORDS.has(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver.split('::').pop() ?? '')) continue;
          const key = `${receiver ?? ''}::${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: rsMatch.index + 1 });
        }
        break;
      }
      case 'go': {
        const goPattern = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
        let goMatch: RegExpExecArray | null;
        while ((goMatch = goPattern.exec(rawLine)) !== null) {
          if (!inCode(goMatch.index)) continue;
          const receiver = goMatch[1] || undefined;
          const name = goMatch[2];
          if (!name || CALL_KEYWORDS.has(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver)) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: goMatch.index + 1 });
        }
        break;
      }
      case 'java': {
        const javaPattern = /(?:(\w+(?:\.\w+)*)\s*\.\s*)?(\w+)\s*\(/g;
        let jMatch: RegExpExecArray | null;
        while ((jMatch = javaPattern.exec(rawLine)) !== null) {
          if (!inCode(jMatch.index)) continue;
          const receiver = jMatch[1] || undefined;
          const name = jMatch[2];
          if (!name || CALL_KEYWORDS.has(name) || /^[A-Z]/.test(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver.split('.').pop() ?? '')) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: jMatch.index + 1 });
        }
        break;
      }
      case 'csharp': {
        const csPattern = /(?:(\w+(?:\.\w+)*)\s*\.\s*)?(\w+)\s*\(/g;
        let csMatch: RegExpExecArray | null;
        while ((csMatch = csPattern.exec(rawLine)) !== null) {
          if (!inCode(csMatch.index)) continue;
          const receiver = csMatch[1] || undefined;
          const name = csMatch[2];
          if (!name || CALL_KEYWORDS.has(name)) continue;
          if (/^[A-Z]/.test(name) && !receiver) continue;
          if (receiver && CALL_KEYWORDS.has(receiver.split('.').pop() ?? '')) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: csMatch.index + 1 });
        }
        break;
      }
      case 'cpp': {
        const cppPattern = /(?:(\w+(?:::[\w<>:]+)*)\s*(?:\.|->|::)\s*)?(\w+)\s*[(<]/g;
        let cppMatch: RegExpExecArray | null;
        while ((cppMatch = cppPattern.exec(rawLine)) !== null) {
          if (!inCode(cppMatch.index)) continue;
          const receiver = cppMatch[1] || undefined;
          const name = cppMatch[2];
          if (!name || CALL_KEYWORDS.has(name) || name.startsWith('_')) continue;
          if (receiver && CALL_KEYWORDS.has(receiver.split('::').pop() ?? '')) continue;
          const key = `${receiver ?? ''}::${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: cppMatch.index + 1 });
        }
        break;
      }
      case 'swift': {
        const swiftPattern = /(?:(\w+(?:\.\w+)*)\s*\.\s*)?(\w+)\s*\(/g;
        let swMatch: RegExpExecArray | null;
        while ((swMatch = swiftPattern.exec(rawLine)) !== null) {
          if (!inCode(swMatch.index)) continue;
          const receiver = swMatch[1] || undefined;
          const name = swMatch[2];
          if (!name || CALL_KEYWORDS.has(name) || /^[A-Z]/.test(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver.split('.').pop() ?? '')) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: swMatch.index + 1 });
        }
        break;
      }
      default: {
        const pattern = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(rawLine)) !== null) {
          if (!inCode(match.index)) continue;
          const receiver = match[1] || undefined;
          const name = match[2];
          if (!name || CALL_KEYWORDS.has(name)) continue;
          if (receiver && CALL_KEYWORDS.has(receiver)) continue;
          const key = `${receiver ?? ''}.${name}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name, receiver, line: lineNum, character: match.index + 1 });
        }
        break;
      }
    }
    }

    const nextNl = content.indexOf('\n', lineStart);
    lineStart = nextNl === -1 ? content.length : nextNl + 1;
    lineNum++;
  }

  return results;
}

function findFunctionEndLine(
  content: string,
  startLine: number,
  filePath: string,
  language?: string,
): number {
  // Python 等缩进语言没有花括号：旧实现一律按括号配对找函数结尾，对它们
  // 返回 -1，导致 buildCallEdges 跳过结束行边界，把声明行之后的所有调用
  // 都记到每个函数头上。缩进语言改用缩进判定（与 codeMetrics 一致）。
  if (isIndentationBasedLanguage(filePath, language)) {
    const lineCount = countFunctionLinesIndentBased(content, startLine);
    return lineCount > 0 ? startLine + lineCount - 1 : -1;
  }

  const lines = content.split(/\r?\n/);
  let depth = 0;
  let started = false;

  // 支持 Allman 风格（C# 默认）：声明行 `public void Foo()` 后 `{` 在下一行。
  // 旧实现只在首行找 `{`，首行无括号即返回 -1，导致 buildCallEdges 跳过
  // 结束行边界，把声明行之后到 EOF 的全部调用都挂到该函数名下。
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') {
        depth--;
        if (started && depth <= 0) return i + 1;
      }
    }
  }
  // 扫到 EOF 仍未配对闭合：函数体残缺（无括号函数/解析边界），返回 -1，
  // 由调用方按"无结束边界"处理。
  return -1;
}

function resolveCallTarget(
  name: string,
  receiver: string | undefined,
  callerPath: string,
  candidatesByPath: Map<string, ProjectGraphSymbolCandidate[]>,
  candidatesBySimpleName: Map<string, ProjectGraphSymbolCandidate[]>,
  candidatesByQualifiedName: Map<string, ProjectGraphSymbolCandidate[]>,
  moduleContext?: FileModuleContext,
  moduleContexts?: Map<string, FileModuleContext>,
): ProjectGraphSymbolCandidate | null {
  if (receiver) {
    if (moduleContext) {
      const namespaceBinding = moduleContext.importedNamespaces.get(receiver);
      if (namespaceBinding?.targetPath) {
        const viaReexport = resolveExportedSymbolInModule(
          namespaceBinding.targetPath,
          name,
          candidatesByPath,
          moduleContexts,
        );
        if (viaReexport) return viaReexport;
      }

      const bindingCandidates = moduleContext.importedSymbols.get(receiver);
      if (bindingCandidates?.length) {
        for (const binding of bindingCandidates) {
          const viaReexport = resolveExportedSymbolInModule(
            binding.targetPath,
            name,
            candidatesByPath,
            moduleContexts,
          );
          if (viaReexport) return viaReexport;
        }
      }
    }

    const qualifiedKey = normalizeIdentifierKey(`${receiver}.${name}`);
    if (qualifiedKey) {
      const candidates = candidatesByQualifiedName.get(qualifiedKey);
      if (candidates && candidates.length > 0) {
        const callableMatch = candidates.find((c) => isCallableSymbolKind(c.symbol.kind));
        return callableMatch ?? candidates[0];
      }
    }

    // receiver 存在但全部解析路径（import 命名空间/导入绑定/限定名）都未命中：
    // 绝不能跌落到下方的裸名解析——那会把 ctx.json()、utils.format() 等
    // 方法调用解析到项目里任意同名的函数上，产生系统性假 calls 边，
    // 污染 dead_code（假"被使用"证据）与 impact 分析。receiver 信息无法
    // 利用时宁可返回 null（丢失一条边）也不制造错误边。
    return null;
  }

  if (moduleContext) {
    const directBindings = moduleContext.importedSymbols.get(name);
    if (directBindings?.length) {
      for (const binding of directBindings) {
        const importedName = binding.importedName ?? name;
        const viaReexport = resolveExportedSymbolInModule(
          binding.targetPath,
          importedName,
          candidatesByPath,
          moduleContexts,
        );
        if (viaReexport) return viaReexport;
      }
    }
  }

  const fileCandidates = candidatesByPath.get(callerPath);
  if (fileCandidates) {
    // 与其它分支同口径：多个同名候选时优先可调用符号。旧实现直接返回
    // 第一个同名候选，同文件存在同名变量/类时 calls 边会指向非可调用符号
    // （例如让 deadCode 误判该变量"被使用"）。
    const matches = fileCandidates.filter((c) => c.symbol?.name === name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const callableMatch = matches.find((c) => isCallableSymbolKind(c.symbol.kind));
      if (callableMatch) return callableMatch;
    }
  }

  const qualifiedKey = normalizeIdentifierKey(name);
  if (qualifiedKey) {
    const candidates = candidatesByQualifiedName.get(qualifiedKey);
    if (candidates && candidates.length > 0) return candidates[0];
  }

  return null;
}

export async function enrichProjectGraphEdges(
  result: WorkspaceProjectGraphResult,
  enhancer: LspProjectGraphEnhancer,
  fileContents: Record<string, ProjectGraphFileContent>,
  concurrency: number = 3,
  maxSymbols: number = Number.MAX_SAFE_INTEGER,
): Promise<WorkspaceProjectGraphResult> {
  const edges = [...result.edges];
  const seenEdges = new Set(edges.map((e) => e.id));

  const addEdge = (edge: ProjectGraphEdge): boolean => {
    if (seenEdges.has(edge.id)) {
      return false;
    }
    seenEdges.add(edge.id);
    edges.push(edge);
    return true;
  };

  const symbolNodes = result.nodes.filter((n) => n.kind === 'symbol' && n.symbol);
  const symbolsByName = new Map<string, ProjectGraphNode[]>();
  for (const n of symbolNodes) {
    const name = n.symbol!.name;
    const list = symbolsByName.get(name) ?? [];
    list.push(n);
    symbolsByName.set(name, list);
  }
  const prioritized = symbolNodes.sort(
    (a, b) => (b.entryPointScore ?? 0) - (a.entryPointScore ?? 0)
  );
  const toEnhance = prioritized.slice(0, Math.max(0, maxSymbols));

  // 按文件分组后一次性交给 enhancer：同一文件的所有符号共享一次文档
  // open/close 窗口（批量 LSP 命令的调用方），避免逐符号重复开闭文档。
  const groups = new Map<string, Array<{ node: ProjectGraphNode; symbol: NonNullable<ProjectGraphNode['symbol']> }>>();
  for (const node of toEnhance) {
    if (!node.symbol || !node.path) continue;
    const list = groups.get(node.path) ?? [];
    list.push({ node, symbol: node.symbol });
    groups.set(node.path, list);
  }
  const paths = [...groups.keys()];

  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (path) => {
        const content = fileContents[path]?.content;
        if (!content) return;
        const entries = groups.get(path) ?? [];

        try {
          const refs = await enhancer.enhanceReferences(
            path,
            content,
            entries.map((e) => ({ name: e.symbol.name, line: e.symbol.line, kind: e.symbol.kind })),
          );

          // textDocument/references 是在定义文件 `path` 上查使用点。
          // imports 边必须是使用方 → 定义方，与 AST 导入边同向，否则会和
          // 已有边对打、凭空造出循环依赖。
          for (const ref of refs) {
            const usageFileId = `file:${ref.filePath}`;
            const definitionFileId = `file:${path}`;
            if (usageFileId === definitionFileId) continue;

            addEdge({
              id: `imports:${usageFileId}->${definitionFileId}:lsp`,
              kind: 'imports',
              from: usageFileId,
              to: definitionFileId,
            });
          }

          const inheritances = await enhancer.enhanceInheritance(
            path,
            content,
            entries.map((e) => ({ name: e.symbol.name, line: e.symbol.line, kind: e.symbol.kind })),
          );

          for (const inh of inheritances) {
            const fromNode = entries.find((e) => e.symbol.name === inh.fromSymbol)?.node;
            if (!fromNode) continue;
            const candidates = symbolsByName.get(inh.toSymbol);
            if (!candidates || candidates.length === 0) continue;
            const toNode =
              (inh.toFilePath
                ? candidates.find((n) => n.path === inh.toFilePath)
                : undefined) ??
              candidates.find((n) => n.path === fromNode.path) ??
              candidates.find((n) => n.symbol?.exported) ??
              candidates[0];
            if (!toNode || fromNode.id === toNode.id) continue;

            addEdge({
              id: `${inh.kind}:${fromNode.id}->${toNode.id}:lsp`,
              kind: inh.kind as ProjectGraphEdgeKind,
              from: fromNode.id,
              to: toNode.id,
            });
          }
        } catch (e) {
          console.warn('ProjectGraph enhancement failed for', path, ':', e);
        }
      })
    );
  }

  return {
    ...result,
    edges,
    summary: {
      ...result.summary,
      imports: edges.filter((e) => e.kind === 'imports').length,
      reexports: edges.filter((e) => e.kind === 'reexports').length,
      extends: edges.filter((e) => e.kind === 'extends').length,
      implements: edges.filter((e) => e.kind === 'implements').length,
      calls: edges.filter((e) => e.kind === 'calls').length,
      edges: edges.length,
      lspEnhanced: true,
    },
    quality: result.quality,
  };
}
