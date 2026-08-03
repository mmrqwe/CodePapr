import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { getExtension } from './graphUtils';
import { isCallableSymbolKind, isTypeSymbolKind } from './graphSymbols';
import { buildEdgeMaps, buildNodeMap } from './graphTraversal';
import {
  countFunctionLines,
  countFunctionLinesIndentBased,
  estimateNestingDepth,
  estimateNestingDepthIndentBased,
  isIndentationBasedLanguage,
} from './codeMetrics';

export interface MethodExtractionSuggestion {
  symbolId: string;
  name: string;
  path: string;
  lineCount: number;
  callCount: number;
  nestedDepth: number;
  reason: string;
}

export interface RefactorSuggestionResult {
  extractions: MethodExtractionSuggestion[];
  moves: SymbolMovePlan[];
  summary: string;
}

export interface SymbolMovePlan {
  symbolId: string;
  name: string;
  kind: string;
  path: string;
  sourceLine: number;
  newFileName: string;
  importers: string[];
  dependencies: string[];
  reason: string;
}

export function suggestRefactorings(
  graph: WorkspaceProjectGraphResult,
  fileContents?: Record<string, { content: string; bytes: number }>,
): RefactorSuggestionResult {
  const extractions = suggestMethodExtractions(graph, fileContents);
  const moves = planSymbolMoves(graph);

  return {
    extractions,
    moves,
    summary: `${extractions.length} 个方法可提取，${moves.length} 个符号可独立成文件。`,
  };
}

function suggestMethodExtractions(
  graph: WorkspaceProjectGraphResult,
  fileContents?: Record<string, { content: string; bytes: number }>,
): MethodExtractionSuggestion[] {
  const suggestions: MethodExtractionSuggestion[] = [];
  const edgeMap = buildEdgeMaps(graph);

  for (const node of graph.nodes) {
    if (node.kind !== 'symbol' || !node.symbol) continue;
    if (!isCallableSymbolKind(node.symbol.kind)) continue;

    const content = fileContents?.[node.path]?.content;
    if (!content) continue;

    const indentBased = isIndentationBasedLanguage(node.path, node.language);
    const funcLines = indentBased
      ? countFunctionLinesIndentBased(content, node.symbol.line)
      : countFunctionLines(content, node.symbol.line);
    const callCount = (edgeMap.outgoing.get(node.id) ?? []).filter((e) => e.kind === 'calls').length;
    const nestedDepth = indentBased
      ? estimateNestingDepthIndentBased(content, node.symbol.line)
      : estimateNestingDepth(content, node.symbol.line);

    let reason = '';
    if (funcLines > 40) {
      reason = `函数过长（${funcLines} 行），建议拆分为更小的函数。`;
    } else if (nestedDepth > 3) {
      reason = `嵌套深度 ${nestedDepth}，内层逻辑可提取为独立函数。`;
    } else if (callCount > 10) {
      reason = `内部调用了 ${callCount} 个子函数，职责可能过重。`;
    } else {
      continue;
    }

    suggestions.push({
      symbolId: node.id,
      name: node.symbol.name,
      path: node.path,
      lineCount: funcLines,
      callCount,
      nestedDepth,
      reason,
    });
  }

  return suggestions;
}

function planSymbolMoves(
  graph: WorkspaceProjectGraphResult,
): SymbolMovePlan[] {
  const plans: SymbolMovePlan[] = [];
  const nodeMap = buildNodeMap(graph);
  const edgeMap = buildEdgeMaps(graph);

  for (const node of graph.nodes) {
    if (node.kind !== 'symbol' || !node.symbol) continue;
    if (!isTypeSymbolKind(node.symbol.kind)) continue;

    const importers: string[] = [];
    const dependencies: string[] = [];

    const incomingEdges = edgeMap.incoming.get(node.id) ?? [];
    for (const edge of incomingEdges) {
      const fromNode = nodeMap.get(edge.from);
      if (fromNode && fromNode.path !== node.path && !importers.includes(fromNode.path)) {
        importers.push(fromNode.path);
      }
    }

    const outgoingEdges = edgeMap.outgoing.get(node.id) ?? [];
    for (const edge of outgoingEdges) {
      if (edge.kind === 'imports' || edge.kind === 'calls') {
        const toNode = nodeMap.get(edge.to);
        if (toNode && toNode.path !== node.path && !dependencies.includes(toNode.path)) {
          dependencies.push(toNode.path);
        }
      }
    }

    if (importers.length >= 2) {
      const safeName = node.symbol.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      plans.push({
        symbolId: node.id,
        name: node.symbol.name,
        kind: node.symbol.kind,
        path: node.path,
        sourceLine: node.symbol.line,
        newFileName: `${safeName}.${getExtension(node.path)}`,
        importers,
        dependencies,
        reason: `被 ${importers.length} 个文件引用，建议独立为单独文件以提高模块化。`,
      });
    }
  }

  return plans;
}
