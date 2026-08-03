import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { capitalize, escapeRegExp, extractParams, getExtension } from './graphUtils';
import { isCallableSymbolKind, isTypeSymbolKind } from './graphSymbols';
import { buildEdgeMaps, buildNodeMap } from './graphTraversal';
import { countFunctionLines } from './codeMetrics';

export interface ExtractMethodPlan {
  symbolId: string;
  name: string;
  path: string;
  startLine: number;
  endLine: number;
  extractedName: string;
  parameters: string[];
  returnType: string;
  reason: string;
}

export interface MoveSymbolEdits {
  symbolId: string;
  symbolName: string;
  sourcePath: string;
  targetPath: string;
  newFileContent: string;
  importAdditions: Array<{ filePath: string; importStatement: string }>;
  sourceDeletion: { startLine: number; endLine: number };
  reason: string;
}

export interface InlineVariablePlan {
  symbolId: string;
  variableName: string;
  path: string;
  definitionLine: number;
  definitionValue: string;
  usageSites: Array<{ path: string; line: number; column: number }>;
  reason: string;
}

export interface InlineVariableSuggestion {
  symbolId: string;
  variableName: string;
  path: string;
  line: number;
  usageCount: number;
  reason: string;
}

export function planExtractMethod(
  symbolId: string,
  graph: WorkspaceProjectGraphResult,
  fileContents: Record<string, { content: string; bytes: number }>,
  newName?: string,
): ExtractMethodPlan | null {
  const node = graph.nodes.find((n) => n.id === symbolId);
  if (!node || !node.symbol || !isCallableSymbolKind(node.symbol.kind)) return null;

  const content = fileContents[node.path]?.content;
  if (!content) return null;

  const funcLines = countFunctionLines(content, node.symbol.line);
  if (funcLines < 15) return null;

  const calledBy = graph.edges.filter((e) => e.to === symbolId && e.kind === 'calls');
  const params = extractParams(node.symbol.signature);
  const returnType = inferReturnType(node.symbol.signature);
  const extractedName = newName ?? `extracted${capitalize(node.symbol.name)}`;

  return {
    symbolId,
    name: node.symbol.name,
    path: node.path,
    startLine: node.symbol.line,
    endLine: node.symbol.line + funcLines - 1,
    extractedName,
    parameters: params,
    returnType,
    reason: `函数 ${node.symbol.name} 有 ${funcLines} 行，被 ${calledBy.length} 处调用，可提取为独立方法以提升可读性。`,
  };
}

export function planMoveSymbol(
  symbolId: string,
  graph: WorkspaceProjectGraphResult,
  fileContents: Record<string, { content: string; bytes: number }>,
): MoveSymbolEdits | null {
  const node = graph.nodes.find((n) => n.id === symbolId);
  if (!node || !node.symbol) return null;
  if (!isTypeSymbolKind(node.symbol.kind)) return null;

  const nodeMap = buildNodeMap(graph);
  const importers: string[] = [];
  const dependencies: string[] = [];

  for (const edge of graph.edges) {
    if (edge.to === symbolId) {
      const fromNode = nodeMap.get(edge.from);
      if (fromNode && fromNode.path !== node.path && !importers.includes(fromNode.path)) {
        importers.push(fromNode.path);
      }
    }
    if (edge.from === symbolId && (edge.kind === 'imports' || edge.kind === 'calls')) {
      const toNode = nodeMap.get(edge.to);
      if (toNode && toNode.path !== node.path && !dependencies.includes(toNode.path)) {
        dependencies.push(toNode.path);
      }
    }
  }

  if (importers.length < 2) return null;

  const ext = getExtension(node.path);
  const safeName = node.symbol.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const targetPath = node.path.includes('/')
    ? node.path.replace(/\/[^/]+$/, `/${safeName}.${ext}`)
    : `${safeName}.${ext}`;
  if (targetPath === node.path) return null;

  const sourceContent = fileContents[node.path]?.content ?? '';
  const sourceLines = sourceContent.split(/\r?\n/);
  const symbolLine = node.symbol.line;

  let startLine = symbolLine;
  while (startLine > 1 && /^\s*(?:\/\/|\/\*|\*|#)/.test(sourceLines[startLine - 2]?.trim() ?? '')) {
    startLine--;
  }

  let endLine = symbolLine;
  let braceDepth = 0;
  let foundOpen = false;
  for (let i = symbolLine - 1; i < sourceLines.length; i++) {
    for (const ch of sourceLines[i]) {
      if (ch === '{') { braceDepth++; foundOpen = true; }
      if (ch === '}') {
        braceDepth--;
        if (foundOpen && braceDepth === 0) {
          endLine = i + 1;
          i = sourceLines.length;
          break;
        }
      }
    }
  }

  const symbolDefinition = sourceLines.slice(startLine - 1, endLine).join('\n');
  const depImports = buildDependencyImports(dependencies, node.path, ext);
  const newFileContent = `${depImports}\n\n${symbolDefinition}\n`;

  const importStatement = buildImportStatement(node.symbol.name, `./${safeName}`, ext);
  const importAdditions = importers.map((filePath) => ({
    filePath,
    importStatement,
  }));

  return {
    symbolId,
    symbolName: node.symbol.name,
    sourcePath: node.path,
    targetPath,
    newFileContent,
    importAdditions,
    sourceDeletion: { startLine, endLine },
    reason: `${node.symbol.name} 被 ${importers.length} 个文件引用，可独立为 ${targetPath} 以提高模块化。`,
  };
}

export function planInlineVariable(
  symbolId: string,
  graph: WorkspaceProjectGraphResult,
  fileContents: Record<string, { content: string; bytes: number }>,
): InlineVariablePlan | null {
  const node = graph.nodes.find((n) => n.id === symbolId);
  if (!node || !node.symbol) return null;

  const kind = node.symbol.kind.toLowerCase();
  if (kind !== 'variable' && kind !== 'constant' && kind !== 'const' && kind !== 'let') return null;

  const content = fileContents[node.path]?.content;
  if (!content) return null;

  const lines = content.split(/\r?\n/);
  const defLine = lines[node.symbol.line - 1];
  if (!defLine) return null;

  const valueMatch = defLine.match(/(?:const|let|var|val)\s+\w+\s*=\s*(.+?)(?:;?\s*$)/);
  if (!valueMatch) return null;

  const definitionValue = valueMatch[1].trim();

  const usageSites: Array<{ path: string; line: number; column: number }> = [];
  const varName = node.symbol.name;

  const candidatePaths = new Set<string>();
  for (const otherNode of graph.nodes) {
    if (otherNode.kind !== 'symbol' || !otherNode.symbol) continue;
    if (otherNode.id === symbolId) continue;
    candidatePaths.add(otherNode.path);
  }

  const seenSites = new Set<string>();
  for (const otherPath of candidatePaths) {
    const otherContent = fileContents[otherPath]?.content;
    if (!otherContent) continue;

    const otherLines = otherContent.split(/\r?\n/);
    for (let i = 0; i < otherLines.length; i++) {
      if (otherPath === node.path && i + 1 === node.symbol.line) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(varName)}\\b`, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(otherLines[i])) !== null) {
        const beforeChar = otherLines[i][match.index - 1];
        if (beforeChar && /[a-zA-Z0-9_$.]/.test(beforeChar)) continue;
        const siteKey = `${otherPath}:${i + 1}:${match.index + 1}`;
        if (seenSites.has(siteKey)) continue;
        seenSites.add(siteKey);
        usageSites.push({ path: otherPath, line: i + 1, column: match.index + 1 });
      }
    }
  }

  if (usageSites.length === 0) return null;

  return {
    symbolId,
    variableName: varName,
    path: node.path,
    definitionLine: node.symbol.line,
    definitionValue,
    usageSites,
    reason: `${varName} 仅使用 ${usageSites.length} 次，可以内联以减少间接引用。`,
  };
}

export function suggestInlineVariables(
  graph: WorkspaceProjectGraphResult,
): InlineVariableSuggestion[] {
  const suggestions: InlineVariableSuggestion[] = [];
  const edgeMap = buildEdgeMaps(graph);

  for (const node of graph.nodes) {
    if (node.kind !== 'symbol' || !node.symbol) continue;

    const kind = node.symbol.kind.toLowerCase();
    if (kind !== 'variable' && kind !== 'constant' && kind !== 'const' && kind !== 'let') continue;

    const outgoing = (edgeMap.outgoing.get(node.id) ?? []).filter((e) => e.kind !== 'contains');
    const incoming = (edgeMap.incoming.get(node.id) ?? []).filter((e) => e.kind !== 'contains');
    const usageCount = outgoing.length + incoming.length;

    if (usageCount <= 3 && usageCount > 0) {
      suggestions.push({
        symbolId: node.id,
        variableName: node.symbol.name,
        path: node.path,
        line: node.symbol.line,
        usageCount,
        reason: `${node.symbol.name} 仅使用 ${usageCount} 次，可考虑内联。`,
      });
    }
  }

  return suggestions;
}

function inferReturnType(signature: string): string {
  const arrowMatch = signature.match(/=>\s*([A-Za-z_<>[\]]+)/);
  if (arrowMatch) return arrowMatch[1];
  const colonMatch = signature.match(/:\s*([A-Za-z_<>[\]]+)\s*$/);
  if (colonMatch) return colonMatch[1];
  return 'void';
}

function buildImportStatement(symbolName: string, modulePath: string, ext: string): string {
  if (ext === 'py') return `from ${modulePath.replace(/^\.\//, '').replace(/\.py$/, '')} import ${symbolName}`;
  if (ext === 'go') return `import "${modulePath.replace(/^\.\//, '')}"`;
  if (ext === 'rs') return `use crate::${modulePath.replace(/^\.\//, '').replace(/\//g, '::')}::${symbolName};`;
  if (ext === 'java') return `import ${modulePath.replace(/^\.\//, '').replace(/\//g, '.')}.${symbolName};`;
  return `import { ${symbolName} } from '${modulePath}';`;
}

function buildDependencyImports(dependencies: string[], sourcePath: string, ext: string): string {
  const imports: string[] = [];
  for (const dep of dependencies) {
    const relPath = computeRelativePath(sourcePath, dep);
    const _depName = dep.split('/').pop()?.replace(/\.\w+$/, '') ?? 'module';
    if (ext === 'py') {
      imports.push(`from ${relPath.replace(/\//g, '.').replace(/^\./, '')} import *`);
    } else if (ext === 'go') {
      imports.push(`\t"${relPath}"`);
    } else if (ext === 'rs') {
      imports.push(`use crate::${relPath.replace(/\//g, '::')}::*;`);
    } else if (ext === 'java') {
      imports.push(`import ${relPath.replace(/\//g, '.')}.*;`);
    } else {
      imports.push(`import * from '${relPath}';`);
    }
  }
  if (ext === 'go' && imports.length > 0) {
    return `import (\n${imports.join('\n')}\n)`;
  }
  return imports.join('\n');
}

function computeRelativePath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.split('/').slice(0, -1);
  const toParts = toPath.split('/');
  let prefix = 0;
  while (prefix < fromDir.length && prefix < toParts.length && fromDir[prefix] === toParts[prefix]) {
    prefix++;
  }
  const upCount = fromDir.length - prefix;
  const up = '../'.repeat(Math.max(0, upCount));
  const down = toParts.slice(prefix).join('/');
  return `./${up}${down}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
}
