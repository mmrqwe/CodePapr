import type { WorkspaceProjectGraphResult } from '../../projectGraph';

export interface CircularDependency {
  cycle: string[];
  files: string[];
  length: number;
}

export interface CircularDependencyResult {
  cycles: CircularDependency[];
  total: number;
  summary: string;
}

const enum NodeColor { WHITE, GRAY, BLACK }

export function detectCircularDependencies(
  graph: WorkspaceProjectGraphResult,
): CircularDependencyResult {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.kind === 'file') {
      adjacency.set(node.id, new Set());
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'imports' || edge.kind === 'reexports') {
      const fromFile = extractFileId(edge.from);
      const toFile = extractFileId(edge.to);
      if (fromFile && toFile && fromFile !== toFile) {
        const neighbors = adjacency.get(fromFile);
        if (neighbors) neighbors.add(toFile);
      }
    }
  }

  const nodeIdToPath = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === 'file') nodeIdToPath.set(node.id, node.path);
  }

  const cycles: CircularDependency[] = [];
  const color = new Map<string, NodeColor>();
  const onStack = new Set<string>();
  const parent = new Map<string, string>();

  function dfs(start: string): void {
    const stack: Array<{ node: string; iter: Iterator<string, void, void> }> = [];
    stack.push({ node: start, iter: adjacency.get(start)![Symbol.iterator]() });
    color.set(start, NodeColor.GRAY);
    onStack.add(start);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const { value: neighbor, done } = top.iter.next();
      if (done) {
        color.set(top.node, NodeColor.BLACK);
        onStack.delete(top.node);
        stack.pop();
        continue;
      }

      if (color.get(neighbor) === NodeColor.GRAY && onStack.has(neighbor)) {
        const cycleIds: string[] = [neighbor];
        let cur = top.node;
        while (cur !== neighbor) {
          cycleIds.push(cur);
          cur = parent.get(cur) ?? '';
        }
        cycleIds.push(neighbor);
        const files = [...new Set(cycleIds.map((id) => nodeIdToPath.get(id) ?? id))];
        cycles.push({ cycle: cycleIds, files, length: cycleIds.length - 1 });
        continue;
      }

      if (!color.has(neighbor) || color.get(neighbor) === NodeColor.WHITE) {
        // 悬空边（LSP enrich 可能产生指向不存在文件节点的 imports 边）：
        // 目标不在 adjacency 中，跳过而不是取 undefined 的迭代器抛 TypeError。
        const neighborEdges = adjacency.get(neighbor);
        if (!neighborEdges) {
          continue;
        }
        color.set(neighbor, NodeColor.GRAY);
        onStack.add(neighbor);
        parent.set(neighbor, top.node);
        stack.push({ node: neighbor, iter: neighborEdges[Symbol.iterator]() });
      }
    }
  }

  for (const [nodeId] of adjacency) {
    const c = color.get(nodeId);
    if (c === undefined || c === NodeColor.WHITE) {
      dfs(nodeId);
    }
  }

  const summary = cycles.length === 0
    ? '未检测到循环依赖。'
    : `检测到 ${cycles.length} 个循环依赖，涉及 ${new Set(cycles.flatMap((c) => c.files)).size} 个文件。`;

  return { cycles, total: cycles.length, summary };
}

function extractFileId(nodeId: string): string | null {
  if (nodeId.startsWith('file:')) return nodeId;
  if (nodeId.startsWith('symbol:')) {
    const rest = nodeId.substring('symbol:'.length);
    const nextColon = rest.indexOf(':');
    const path = nextColon < 0 ? rest : rest.substring(0, nextColon);
    return path ? `file:${path}` : null;
  }
  return null;
}
