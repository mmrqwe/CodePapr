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
      const chain = buildAncestorChain(node, nodes);
      if (chain.length >= 2) chains.push(chain);
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
  if (depth < node.depth) return;
  node.depth = depth;
  visiting.add(node.symbolId);
  for (const childId of node.children) {
    const child = nodes.get(childId);
    if (child) assignDepth(child, nodes, depth + 1, visiting);
  }
  visiting.delete(node.symbolId);
}

function buildAncestorChain(
  leaf: TypeNode,
  nodes: Map<string, TypeNode>,
): TypeNode[] {
  const chain: TypeNode[] = [leaf];
  let current = leaf;
  const seen = new Set<string>([current.symbolId]);

  while (current.parents.length > 0) {
    const parentId = current.parents[0];
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = nodes.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }

  return chain;
}
