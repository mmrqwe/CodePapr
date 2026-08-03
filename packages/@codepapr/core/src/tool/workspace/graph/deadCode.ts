import type { WorkspaceProjectGraphResult } from '../../projectGraph';

export interface DeadCodeSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  exported?: boolean;
}

export interface DeadCodeResult {
  unusedSymbols: DeadCodeSymbol[];
  total: number;
  summary: string;
}

export function detectDeadCode(
  graph: WorkspaceProjectGraphResult,
): DeadCodeResult {
  const inbound = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === 'symbol') {
      inbound.set(node.id, 0);
    }
  }

  for (const edge of graph.edges) {
    // 注意：'contains' 是文件/容器到符号的结构性归属边，每个符号必然有且仅有一条，
    // 不代表真实引用/调用，绝不能计入"被使用"的证据，否则死代码检测永远不会命中。
    if (edge.kind === 'imports' || edge.kind === 'calls' ||
        edge.kind === 'extends' || edge.kind === 'implements' ||
        edge.kind === 'reexports' || edge.kind === 'tested_by') {
      const current = inbound.get(edge.to) ?? 0;
      inbound.set(edge.to, current + 1);
    }
  }

  const deadSymbols: DeadCodeSymbol[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'symbol' || !node.symbol) continue;
    if (node.entryPoint) continue;
    if (node.symbol.name === 'main' || node.symbol.name === 'init') continue;

    const count = inbound.get(node.id) ?? 0;
    if (count <= 0) {
      deadSymbols.push({
        id: node.id,
        name: node.symbol.name,
        kind: node.symbol.kind,
        path: node.path,
        line: node.symbol.line,
        exported: node.symbol.exported,
      });
    }
  }

  const publicDead = deadSymbols.filter((s) => s.exported).length;

  return {
    unusedSymbols: deadSymbols,
    total: deadSymbols.length,
    summary: deadSymbols.length === 0
      ? '未检测到死代码。'
      : `检测到 ${deadSymbols.length} 个无引用的符号（其中 ${publicDead} 个为导出符号，可能是公共 API）。`,
  };
}
