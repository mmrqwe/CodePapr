import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { isTypeSymbolKind } from './graphSymbols';

export interface TypeNode {
  symbolId: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  parents: string[];
  children: string[];
  depth: number;
}

export interface TypeHierarchyResult {
  roots: TypeNode[];
  nodes: Map<string, TypeNode>;
  chains: TypeNode[][];
  summary: string;
}

export function buildTypeHierarchy(
  graph: WorkspaceProjectGraphResult,
): TypeHierarchyResult {
  const typeSymbols = graph.nodes.filter(
    (n) => n.kind === 'symbol' && n.symbol && isTypeSymbolKind(n.symbol.kind),
  );

  const nodes = new Map<string, TypeNode>();
  for (const s of typeSymbols) {
    nodes.set(s.id, {
      symbolId: s.id,
      name: s.symbol!.name,
      kind: s.symbol!.kind,
      path: s.path,
      line: s.symbol!.line,
      parents: [],
      children: [],
      depth: -1,
    });
  }

  for (const edge of graph.edges) {
    if (edge.kind === 'extends' || edge.kind === 'implements') {
      const child = nodes.get(edge.from);
      const parent = nodes.get(edge.to);
      if (child && parent) {
        child.parents.push(parent.symbolId);
        parent.children.push(child.symbolId);
      }
    }
  }

  for (const [, node] of nodes) {
    if (node.parents.length === 0) {
      assignDepth(node, nodes, 0, new Set());
    }
  }
  for (const [, node] of nodes) {
    if (node.depth < 0) node.depth = 0;
  }

  const roots: TypeNode[] = [];
  const chains: TypeNode[][] = [];

  for (const [, node] of nodes) {
    if (node.parents.length === 0) {
      roots.push(node);
    }
    if (node.children.length === 0 && node.parents.length > 0) {
      // 多父节点按每条父路径各生成一条链（旧实现只跟 parents[0]，
      // 多继承链不完整），数量封顶防指数爆炸。
      for (const chain of buildAncestorChains(node, nodes)) {
        if (chain.length >= 2) chains.push(chain);
      }
    }
  }

  return {
    roots,
    nodes,
    chains,
    summary: `${nodes.size} 个类型，${roots.length} 个根类型，${chains.length} 条继承链。`,
  };
}

function assignDepth(
  node: TypeNode,
  nodes: Map<string, TypeNode>,
  depth: number,
  visiting: Set<string>,
) {
  if (visiting.has(node.symbolId)) return;
  // 记忆化剪枝：深度只增不减。等深重访（菱形/多继承 DAG 的常见情况）不会
  // 给后代带来任何新信息，直接返回——旧实现用 `depth < node.depth`，等深
  // 重访照样整棵子树重探，稠密图的遍历次数 = 根到节点的路径数（指数级）。
  if (depth <= node.depth) return;
  node.depth = depth;
  visiting.add(node.symbolId);
  for (const childId of node.children) {
    const child = nodes.get(childId);
    if (child) assignDepth(child, nodes, depth + 1, visiting);
  }
  visiting.delete(node.symbolId);
}

/** 每条根→叶路径最多产出的继承链数（多父节点的链数按路径指数增长，必须封顶）。 */
const MAX_CHAINS_PER_LEAF = 8;

function buildAncestorChains(
  leaf: TypeNode,
  nodes: Map<string, TypeNode>,
): TypeNode[][] {
  const results: TypeNode[][] = [];
  const current: TypeNode[] = [leaf];
  const seen = new Set<string>([leaf.symbolId]);

  const dfs = (node: TypeNode): void => {
    if (results.length >= MAX_CHAINS_PER_LEAF) return;
    if (node.parents.length === 0) {
      results.push([...current]);
      return;
    }
    for (const parentId of node.parents) {
      if (results.length >= MAX_CHAINS_PER_LEAF) return;
      if (seen.has(parentId)) continue;
      const parent = nodes.get(parentId);
      if (!parent) continue;
      seen.add(parentId);
      current.unshift(parent);
      dfs(parent);
      current.shift();
      seen.delete(parentId);
    }
  };

  dfs(leaf);
  return results;
}
