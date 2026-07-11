import * as ts from 'typescript';
import {
  buildWorkspaceProjectGraph as buildCoreWorkspaceProjectGraph,
  type ProjectGraphSymbolSource,
  type WorkspaceProjectGraphResult,
  type LspProjectGraphEnhancer,
} from '@codepapr/core';

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
  maxTreeEntries?: number;
  maxStubsPerFile?: number;
  truncated?: boolean;
}

interface BuildWorkspaceProjectGraphParams {
  projectMap: WorkspaceProjectMapResult;
  entries: WorkspaceListEntry[];
  fileContents: Record<string, { content: string; bytes: number }>;
  maxEdges?: number;
  lspMode?: 'overrides-only' | 'full-integration';
  lspEnhancer?: LspProjectGraphEnhancer;
  lspConcurrency?: number;
}

const PROJECT_MAP_FILE_BYTE_LIMIT = 120_000;

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
};

type ProjectMapStubFamily = keyof typeof STUB_PATTERNS;

const TYPESCRIPT_AST_FAMILIES = new Set<ProjectMapStubFamily>(['ts', 'js']);

export type { ProjectGraphSymbolSource, WorkspaceProjectGraphResult, LspProjectGraphEnhancer };

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
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
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
  if (extension === 'rs' || extension === 'py' || extension === 'cs' || extension === 'go' || extension === 'java') {
    return extension;
  }
  return undefined;
}

function isProjectMapCandidate(entry: WorkspaceListEntry): boolean {
  if (entry.isDir || entry.bytes > PROJECT_MAP_FILE_BYTE_LIMIT) {
    return false;
  }
  return stubPatternFamily(entry.path) !== undefined;
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
  maxFiles: number = 24
): WorkspaceListEntry[] {
  return [...entries]
    .filter(isProjectMapCandidate)
    .sort((left, right) => {
      const scoreDiff = projectMapPriority(left.path) - projectMapPriority(right.path);
      return scoreDiff !== 0 ? scoreDiff : left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, maxFiles));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function scriptKindForProjectMap(path: string): ts.ScriptKind {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'ts':
    case 'mts':
    case 'cts':
    default:
      return ts.ScriptKind.TS;
  }
}

function typeParametersText(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile
): string {
  if (!typeParameters?.length) {
    return '';
  }

  return `<${typeParameters.map((parameter) => collapseWhitespace(parameter.getText(sourceFile))).join(', ')}>`;
}

function parametersText(parameters: readonly ts.ParameterDeclaration[], sourceFile: ts.SourceFile): string {
  return parameters.map((parameter) => collapseWhitespace(parameter.getText(sourceFile))).join(', ');
}

function returnTypeText(node: { type?: ts.TypeNode }, sourceFile: ts.SourceFile): string {
  return node.type ? `: ${collapseWhitespace(node.type.getText(sourceFile))}` : '';
}

function heritageText(
  heritageClauses: ts.NodeArray<ts.HeritageClause> | undefined,
  sourceFile: ts.SourceFile
): string {
  return heritageClauses?.map((clause) => collapseWhitespace(clause.getText(sourceFile))).join(' ') ?? '';
}

function symbolLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function bindingNameText(name: ts.BindingName): string | undefined {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function propertyNameText(name: ts.PropertyName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return collapseWhitespace(name.expression.getText(sourceFile));
  }

  return undefined;
}

function initializerPreview(initializer: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isArrowFunction(initializer)) {
    return `${hasModifier(initializer, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}${typeParametersText(initializer.typeParameters, sourceFile)}(${parametersText(initializer.parameters, sourceFile)})${returnTypeText(initializer, sourceFile)} =>`;
  }

  if (ts.isFunctionExpression(initializer)) {
    return `${hasModifier(initializer, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function${typeParametersText(initializer.typeParameters, sourceFile)}(${parametersText(initializer.parameters, sourceFile)})${returnTypeText(initializer, sourceFile)}`;
  }

  if (ts.isClassExpression(initializer)) {
    return `class${initializer.name ? ` ${initializer.name.text}` : ''}`;
  }

  if (ts.isCallExpression(initializer)) {
    return `${collapseWhitespace(initializer.expression.getText(sourceFile))}(...)`;
  }

  if (ts.isNewExpression(initializer)) {
    return `new ${collapseWhitespace(initializer.expression.getText(sourceFile))}(...)`;
  }

  if (ts.isObjectLiteralExpression(initializer)) {
    return '{ ... }';
  }

  if (ts.isArrayLiteralExpression(initializer)) {
    return '[...]';
  }

  return collapseWhitespace(initializer.getText(sourceFile));
}

function variableKeyword(node: ts.VariableDeclarationList): 'const' | 'let' | 'var' {
  if ((node.flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }
  if ((node.flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }
  return 'var';
}

function fallbackSymbolName(stub: string): string {
  const matchers = [
    /\b(?:class|record|interface|enum|struct|trait|type)\s+([A-Za-z_][\w$]*)/,
    /\b(?:fn|function|def)\s+([A-Za-z_][\w$]*)/,
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
  if (/\binterface\b/i.test(stub)) return 'interface';
  if (/\btype\b/i.test(stub)) return 'type';
  if (/\benum\b/i.test(stub)) return 'enum';
  if (/\b(?:class|record|struct)\b/i.test(stub)) return 'class';
  if (/\btrait\b/i.test(stub)) return 'trait';
  if (/\b(?:fn|function|def)\b/i.test(stub)) return 'function';
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

function extractTypeScriptSymbols(path: string, content: string, maxSymbols: number): WorkspaceMapSymbolSummary[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForProjectMap(path));
  const symbols: WorkspaceMapSymbolSummary[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, maxSymbols);

  const pushSymbol = (symbol: WorkspaceMapSymbolSummary | null | undefined): boolean => {
    if (!symbol) {
      return false;
    }

    const normalizedSignature = normalizeStubLine(symbol.signature);
    if (!normalizedSignature) {
      return false;
    }

    const next = {
      ...symbol,
      signature: normalizedSignature,
    } satisfies WorkspaceMapSymbolSummary;
    const key = `${next.line}:${next.kind}:${next.containerName ?? ''}:${next.name}:${next.signature}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    symbols.push(next);
    return symbols.length >= limit;
  };

  const visitClassMembers = (declaration: ts.ClassDeclaration, exported: boolean): void => {
    const className = declaration.name?.text ?? 'default';
    for (const member of declaration.members) {
      if (symbols.length >= limit) {
        return;
      }

      if (
        !ts.isMethodDeclaration(member) &&
        !ts.isGetAccessorDeclaration(member) &&
        !ts.isSetAccessorDeclaration(member)
      ) {
        continue;
      }

      if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) {
        continue;
      }

      const memberName = propertyNameText(member.name, sourceFile);
      if (!memberName) {
        continue;
      }

      const prefixParts: string[] = [];
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
        prefixParts.push('static');
      }

      if (ts.isMethodDeclaration(member) && hasModifier(member, ts.SyntaxKind.AsyncKeyword)) {
        prefixParts.push('async');
      }

      const kind = ts.isMethodDeclaration(member) ? 'method' : 'accessor';
      const signature = ts.isGetAccessorDeclaration(member)
        ? `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}get ${className}.${memberName}()${returnTypeText(member, sourceFile)}`
        : ts.isSetAccessorDeclaration(member)
          ? `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}set ${className}.${memberName}(${parametersText(member.parameters, sourceFile)})`
          : `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}${className}.${memberName}${typeParametersText(member.typeParameters, sourceFile)}(${parametersText(member.parameters, sourceFile)})${returnTypeText(member, sourceFile)}`;

      if (
        pushSymbol({
          name: memberName,
          kind,
          signature,
          line: symbolLine(member, sourceFile),
          containerName: className,
          exported,
          async: ts.isMethodDeclaration(member) ? hasModifier(member, ts.SyntaxKind.AsyncKeyword) : false,
        })
      ) {
        return;
      }
    }
  };

  const visitStatement = (statement: ts.Statement): void => {
    if (symbols.length >= limit) {
      return;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) {
        return;
      }

      pushSymbol({
        name,
        kind: 'function',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}${hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default ' : ''}${hasModifier(statement, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function ${name}${typeParametersText(statement.typeParameters, sourceFile)}(${parametersText(statement.parameters, sourceFile)})${returnTypeText(statement, sourceFile)}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        async: hasModifier(statement, ts.SyntaxKind.AsyncKeyword),
      });
      return;
    }

    if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) {
        return;
      }

      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const heritage = heritageText(statement.heritageClauses, sourceFile);
      pushSymbol({
        name,
        kind: 'class',
        signature: `${exported ? 'export ' : ''}${hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default ' : ''}${hasModifier(statement, ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : ''}class ${name}${typeParametersText(statement.typeParameters, sourceFile)}${heritage ? ` ${heritage}` : ''}`,
        line: symbolLine(statement, sourceFile),
        exported,
      });
      visitClassMembers(statement, exported);
      return;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const heritage = heritageText(statement.heritageClauses, sourceFile);
      pushSymbol({
        name: statement.name.text,
        kind: 'interface',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}interface ${statement.name.text}${typeParametersText(statement.typeParameters, sourceFile)}${heritage ? ` ${heritage}` : ''}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushSymbol({
        name: statement.name.text,
        kind: 'type',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}type ${statement.name.text}${typeParametersText(statement.typeParameters, sourceFile)} = ${collapseWhitespace(statement.type.getText(sourceFile))}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isEnumDeclaration(statement)) {
      pushSymbol({
        name: statement.name.text,
        kind: 'enum',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}enum ${statement.name.text}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const keyword = variableKeyword(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        if (symbols.length >= limit) {
          return;
        }

        const name = bindingNameText(declaration.name);
        if (!name) {
          continue;
        }

        const initializer = declaration.initializer;
        const kind = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? 'function'
          : initializer && ts.isClassExpression(initializer)
            ? 'class'
            : 'variable';
        const async = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)
          : false;

        if (
          pushSymbol({
            name,
            kind,
            signature: `${exported ? 'export ' : ''}${keyword} ${name}${declaration.type ? `: ${collapseWhitespace(declaration.type.getText(sourceFile))}` : ''}${initializer ? ` = ${initializerPreview(initializer, sourceFile)}` : ''}`,
            line: symbolLine(declaration, sourceFile),
            exported,
            async,
          })
        ) {
          return;
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    visitStatement(statement);
    if (symbols.length >= limit) {
      break;
    }
  }

  return symbols;
}

export function extractProjectMapSymbols(path: string, content: string, maxSymbols: number = 8): WorkspaceMapSymbolSummary[] {
  const family = stubPatternFamily(path);
  if (!family) {
    return [];
  }

  if (TYPESCRIPT_AST_FAMILIES.has(family)) {
    return extractTypeScriptSymbols(path, content, maxSymbols);
  }

  return extractPatternSymbols(path, content, maxSymbols);
}

export function extractCodeStubs(path: string, content: string, maxStubs: number = 8): string[] {
  return extractProjectMapSymbols(path, content, maxStubs).map((symbol) => symbol.signature);
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

export function buildWorkspaceProjectMap(
  params: BuildWorkspaceProjectMapParams
): WorkspaceProjectMapResult {
  const treeResult = buildWorkspaceTree(
    [...params.entries].sort((left, right) => left.path.localeCompare(right.path)),
    params.rootRelativePath,
    Math.max(20, params.maxTreeEntries ?? 120)
  );

  const files = Object.entries(params.fileContents)
    .map(([path, file]) => {
      const language = detectProjectMapLanguage(path);
      const symbols = extractProjectMapSymbols(path, file.content, params.maxStubsPerFile ?? 8);
      const stubs = symbols.map((symbol) => symbol.signature);
      if (!language || stubs.length === 0) {
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
  return (
    /(^|\/)(main|index|app|program|server|client|entry|bootstrap|cli)\./.test(lowerPath) ||
    /\b(?:import|export)\s+[\s\S]*?\bfrom\s+['"]/.test(content) ||
    /\bimport\s*\(/.test(content) ||
    /\brequire\s*\(/.test(content)
  );
}

export function buildWorkspaceProjectGraph(params: BuildWorkspaceProjectGraphParams): WorkspaceProjectGraphResult {
  const projectGraphFiles = new Map(
    params.projectMap.files.map((file) => {
      const family = stubPatternFamily(file.path);
      const symbolSource: ProjectGraphSymbolSource = family && TYPESCRIPT_AST_FAMILIES.has(family)
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
    const symbolSource: ProjectGraphSymbolSource = family && TYPESCRIPT_AST_FAMILIES.has(family)
      ? 'ast'
      : 'pattern';

    projectGraphFiles.set(path, {
      path,
      language,
      bytes: file.bytes,
      symbols: [],
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
    lspMode: params.lspMode,
    lspEnhancer: params.lspEnhancer,
    lspConcurrency: params.lspConcurrency,
  });
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
    message: message.trim() || 'Git 不可用。',
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
    message: message.trim() || 'Git 不可用。',
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
