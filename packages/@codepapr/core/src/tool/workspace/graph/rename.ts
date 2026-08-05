import type { ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';
import { escapeRegExp } from './graphUtils';
import { buildNodeMap } from './graphTraversal';

export interface ProjectGraphRenameParams {
  relativePath: string;
  line: number;
  character: number;
  newName: string;
  graph: WorkspaceProjectGraphResult;
}

export interface ProjectGraphRenameResult {
  ok: boolean;
  changedFiles: string[];
  appliedEdits: number;
  message: string;
}

export interface ProjectGraphRenameEdit {
  line: number;
  startColumn: number;
  endColumn: number;
  replacement: string;
}

export interface ProjectGraphRenamePlan {
  symbol: ProjectGraphNode | null;
  oldName: string;
  targetFiles: string[];
}

export function planProjectGraphRename(
  params: ProjectGraphRenameParams,
): ProjectGraphRenamePlan {
  const symbol = findSymbolAtPosition(params.graph, params.relativePath, params.line, params.character);
  if (!symbol || !symbol.symbol) {
    return { symbol: null, oldName: '', targetFiles: [] };
  }
  return {
    symbol,
    oldName: symbol.symbol.name,
    targetFiles: collectRenameTargetFiles(params.graph, symbol),
  };
}

function collectRenameTargetFiles(
  graph: WorkspaceProjectGraphResult,
  symbol: ProjectGraphNode,
): string[] {
  const nodeMap = buildNodeMap(graph);
  const files = new Set<string>();
  if (symbol.path) files.add(symbol.path);
  const targetFileId = symbol.path ? `file:${symbol.path}` : null;
  for (const edge of graph.edges) {
    if (edge.to === symbol.id && edge.from.startsWith('symbol:')) {
      const fromNode = nodeMap.get(edge.from);
      if (fromNode?.path) files.add(fromNode.path);
    }
    if (edge.kind === 'imports' && targetFileId && edge.to === targetFileId && edge.from.startsWith('file:')) {
      files.add(edge.from.slice('file:'.length));
    }
  }
  return [...files];
}

export function findSymbolAtPosition(
  graph: WorkspaceProjectGraphResult,
  relativePath: string,
  line: number,
  _character: number,
): ProjectGraphNode | null {
  const nodeMap = buildNodeMap(graph);
  let nearest: ProjectGraphNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.kind !== 'symbol' || node.path !== relativePath || !node.symbol) continue;
    if (node.symbol.line > line) continue;
    if (!nearest || (node.symbol.line > (nearest.symbol?.line ?? 0))) {
      nearest = node;
    }
  }
  return nearest;
}

/** 在指定文件中按名称查找符号节点（用于按位置实际标识符重新解析）。 */
export function findSymbolByNameInFile(
  graph: WorkspaceProjectGraphResult,
  relativePath: string,
  name: string,
): ProjectGraphNode | null {
  for (const node of graph.nodes) {
    if (node.kind === 'symbol' && node.path === relativePath && node.symbol?.name === name) {
      return node;
    }
  }
  return null;
}

/** 为已知符号节点重新生成重命名计划。 */
export function replanProjectGraphRenameForSymbol(
  graph: WorkspaceProjectGraphResult,
  symbol: ProjectGraphNode,
): ProjectGraphRenamePlan {
  return {
    symbol,
    oldName: symbol.symbol?.name ?? '',
    targetFiles: collectRenameTargetFiles(graph, symbol),
  };
}

/** 提取文件内容中覆盖 (line, character) 的标识符；character 为 1 基列号。
 *  位置不在任何标识符上时返回 null。 */
export function identifierAtPosition(
  content: string,
  line: number,
  character: number,
): string | null {
  const lines = content.split(/\r?\n/);
  const lineText = lines[line - 1];
  if (!lineText) return null;
  const isIdent = (ch: string | undefined): boolean =>
    typeof ch === 'string' && /[\w$]/.test(ch);

  let index = Math.floor(character) - 1;
  if (index < 0) index = 0;
  if (index >= lineText.length) index = lineText.length - 1;
  // 光标可能落在标识符末尾之后一个字符：回退到标识符上
  if (!isIdent(lineText[index]) && index > 0 && isIdent(lineText[index - 1])) {
    index -= 1;
  }
  if (!isIdent(lineText[index])) return null;

  let start = index;
  while (start > 0 && isIdent(lineText[start - 1])) start -= 1;
  let end = index;
  while (end + 1 < lineText.length && isIdent(lineText[end + 1])) end += 1;
  return lineText.slice(start, end + 1);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#')
  );
}

function isInsideStringLiteral(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    }
  }
  return quote !== null;
}

export function computeRenameEditsForContent(
  content: string,
  oldName: string,
  newName: string,
): ProjectGraphRenameEdit[] {
  const edits: ProjectGraphRenameEdit[] = [];
  if (!oldName || !newName || oldName === newName) return edits;
  // 注意：不使用后行断言 (?<!...)——它需要 Safari 16.4+（macOS 13.3+），而本应用目标 macOS 版本更低，
  // 旧 WebView 会在构造 RegExp 时抛 SyntaxError。这里改用 lookahead（全平台支持）+ 手动检查前导字符，
  // 等价地实现「完整标识符」匹配（含 $ 前缀的标识符边界）。
  const pattern = new RegExp(`${escapeRegExp(oldName)}(?![\\w$])`, 'g');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (isCommentLine(lineText)) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const start = match.index;
      const before = start > 0 ? lineText[start - 1] : '';
      if (before && /[\w$]/.test(before)) continue;
      if (isInsideStringLiteral(lineText, start)) continue;
      edits.push({
        line: i + 1,
        startColumn: start,
        endColumn: start + oldName.length,
        replacement: newName,
      });
    }
  }
  return edits;
}

export function applyRenameEditsToContent(
  content: string,
  edits: readonly ProjectGraphRenameEdit[],
): string {
  if (edits.length === 0) return content;
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetEdits = edits
    .filter((e) => e.line >= 1 && e.line <= lineStarts.length)
    .map((e) => ({
      start: lineStarts[e.line - 1] + e.startColumn,
      end: lineStarts[e.line - 1] + e.endColumn,
      replacement: e.replacement,
    }))
    .sort((a, b) => b.start - a.start);
  let next = content;
  for (const e of offsetEdits) {
    next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
  }
  return next;
}
