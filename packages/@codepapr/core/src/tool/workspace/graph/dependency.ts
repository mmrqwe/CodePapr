import type { ProjectGraphEdge, ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';
import { clamp } from './graphUtils';
import { graphSymbolNodes, normalizeText, toGraphSymbolMatch, type WorkspaceGraphSymbolMatch } from './graphSymbols';
import { buildEdgeMaps, buildNodeMap } from './graphTraversal';

export interface WorkspaceDependencySubgraphOptions {
  symbolId?: string;
  relativePath?: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface WorkspaceDependencySubgraphResult {
  available: boolean;
  seedNodeIds: string[];
  direction: 'incoming' | 'outgoing' | 'both';
  depth: number;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  summary: {
    nodes: number;
    edges: number;
    files: number;
    symbols: number;
  };
  message?: string;
  truncated?: boolean;
}

export interface WorkspaceChangeImpactOptions {
  symbolId?: string;
  relativePath?: string;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface WorkspaceChangeImpactResult {
  available: boolean;
  seedNodeIds: string[];
  impactedNodes: ProjectGraphNode[];
  impactedEdges: ProjectGraphEdge[];
  impactedFiles: string[];
  impactedSymbols: WorkspaceGraphSymbolMatch[];
  summary: {
    nodes: number;
    edges: number;
    files: number;
    symbols: number;
  };
  message?: string;
  truncated?: boolean;
}

export interface WorkspaceSymbolImplementationsOptions {
  symbolId?: string;
  relativePath?: string;
  symbolName?: string;
  limit?: number;
}

export interface WorkspaceSymbolImplementationsResult {
  available: boolean;
  target: WorkspaceGraphSymbolMatch | null;
  implementations: WorkspaceGraphSymbolMatch[];
  total: number;
  truncated: boolean;
  message?: string;
}

function resolveSeedNodeIds(
  graph: WorkspaceProjectGraphResult,
  options: { symbolId?: string; relativePath?: string; symbolName?: string }
): string[] {
  if (options.symbolId) {
    return graph.nodes.some((node) => node.id === options.symbolId) ? [options.symbolId] : [];
  }

  if (options.symbolName) {
    const matches = graphSymbolNodes(graph).filter((node) => {
      if (options.relativePath && node.path !== options.relativePath) {
        return false;
      }
      const exactName = normalizeText(node.label) === normalizeText(options.symbolName);
      const exactQualifiedName = normalizeText(node.qualifiedName) === normalizeText(options.symbolName);
      return exactName || exactQualifiedName;
    });
    return matches.map((node) => node.id);
  }

  if (options.relativePath) {
    return graph.nodes
      .filter((node) => node.path === options.relativePath)
      .map((node) => node.id);
  }

  return [];
}

function summarizeNodes(nodes: readonly ProjectGraphNode[]): {
  nodes: number;
  files: number;
  symbols: number;
} {
  let files = 0;
  let symbols = 0;
  for (const node of nodes) {
    if (node.kind === 'file') {
      files += 1;
    } else {
      symbols += 1;
    }
  }
  return {
    nodes: nodes.length,
    files,
    symbols,
  };
}

function collectSubgraph(params: {
  graph: WorkspaceProjectGraphResult;
  seedNodeIds: string[];
  direction: 'incoming' | 'outgoing' | 'both';
  depth: number;
  maxNodes: number;
  maxEdges: number;
}): WorkspaceDependencySubgraphResult {
  const nodeById = new Map(params.graph.nodes.map((node) => [node.id, node] as const));
  const edgeById = new Map(params.graph.edges.map((edge) => [edge.id, edge] as const));
  const adjacency = buildEdgeMaps(params.graph);
  const queue = params.seedNodeIds.map((nodeId) => ({ nodeId, depth: 0 }));
  const visited = new Set(params.seedNodeIds);
  const selectedEdgeIds = new Set<string>();
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (current.depth >= params.depth) {
      continue;
    }

    const outgoingEdges = params.direction === 'incoming' ? [] : adjacency.outgoing.get(current.nodeId) ?? [];
    const incomingEdges = params.direction === 'outgoing' ? [] : adjacency.incoming.get(current.nodeId) ?? [];
    const candidateEdges = [...outgoingEdges, ...incomingEdges];

    for (const edge of candidateEdges) {
      const nextNodeId = edge.from === current.nodeId ? edge.to : edge.from;
      if (selectedEdgeIds.size >= params.maxEdges) {
        truncated = true;
        break;
      }
      selectedEdgeIds.add(edge.id);

      if (!visited.has(nextNodeId)) {
        if (visited.size >= params.maxNodes) {
          truncated = true;
          break;
        }
        visited.add(nextNodeId);
        queue.push({ nodeId: nextNodeId, depth: current.depth + 1 });
      }
    }

    if (truncated) {
      break;
    }
  }

  const nodes = [...visited]
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is ProjectGraphNode => Boolean(node))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = [...selectedEdgeIds]
    .map((edgeId) => edgeById.get(edgeId))
    .filter((edge): edge is ProjectGraphEdge => Boolean(edge))
    .filter((edge) => visited.has(edge.from) && visited.has(edge.to))
    .sort((left, right) => left.id.localeCompare(right.id));
  const summary = summarizeNodes(nodes);

  return {
    available: true,
    seedNodeIds: params.seedNodeIds,
    direction: params.direction,
    depth: params.depth,
    nodes,
    edges,
    summary: {
      ...summary,
      edges: edges.length,
    },
    truncated,
  };
}

export function buildWorkspaceDependencySubgraph(
  graph: WorkspaceProjectGraphResult,
  options: WorkspaceDependencySubgraphOptions = {}
): WorkspaceDependencySubgraphResult {
  const seedNodeIds = resolveSeedNodeIds(graph, options);
  if (seedNodeIds.length === 0) {
    return {
      available: false,
      seedNodeIds: [],
      direction: options.direction ?? 'both',
      depth: clamp(options.depth, 2, 1, 6),
      nodes: [],
      edges: [],
      summary: { nodes: 0, edges: 0, files: 0, symbols: 0 },
      message: '没有找到可作为子图起点的文件或符号。',
    };
  }

  return collectSubgraph({
    graph,
    seedNodeIds,
    direction: options.direction ?? 'both',
    depth: clamp(options.depth, 2, 1, 6),
    maxNodes: clamp(options.maxNodes, 80, 1, 400),
    maxEdges: clamp(options.maxEdges, 240, 1, 800),
  });
}

export function analyzeWorkspaceChangeImpact(
  graph: WorkspaceProjectGraphResult,
  options: WorkspaceChangeImpactOptions = {}
): WorkspaceChangeImpactResult {
  const subgraph = buildWorkspaceDependencySubgraph(graph, {
    symbolId: options.symbolId,
    relativePath: options.relativePath,
    direction: 'incoming',
    depth: options.depth,
    maxNodes: options.maxNodes,
    maxEdges: options.maxEdges,
  });

  if (!subgraph.available) {
    return {
      available: false,
      seedNodeIds: [],
      impactedNodes: [],
      impactedEdges: [],
      impactedFiles: [],
      impactedSymbols: [],
      summary: { nodes: 0, edges: 0, files: 0, symbols: 0 },
      message: subgraph.message,
    };
  }

  const impactedNodes = subgraph.nodes.filter((node) => !subgraph.seedNodeIds.includes(node.id));
  const impactedFiles = [...new Set(impactedNodes.map((node) => node.path))].sort((left, right) => left.localeCompare(right));
  const impactedSymbols = impactedNodes
    .filter((node) => node.kind === 'symbol' && node.symbol)
    .map(toGraphSymbolMatch)
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      return (left.line ?? 0) - (right.line ?? 0);
    });
  const summary = summarizeNodes(impactedNodes);

  return {
    available: true,
    seedNodeIds: subgraph.seedNodeIds,
    impactedNodes,
    impactedEdges: subgraph.edges,
    impactedFiles,
    impactedSymbols,
    summary: {
      ...summary,
      edges: subgraph.edges.length,
    },
    truncated: subgraph.truncated,
  };
}

export function findWorkspaceSymbolImplementations(
  graph: WorkspaceProjectGraphResult,
  options: WorkspaceSymbolImplementationsOptions = {}
): WorkspaceSymbolImplementationsResult {
  const limit = clamp(options.limit, 20, 1, 100);
  const nodeMap = buildNodeMap(graph);
  const seedIds = resolveSeedNodeIds(graph, {
    symbolId: options.symbolId,
    relativePath: options.relativePath,
    symbolName: options.symbolName,
  });
  const targetNodeIds = seedIds.filter((id) => nodeMap.get(id)?.kind === 'symbol');
  const targetNodeId = targetNodeIds[0];

  if (!targetNodeId) {
    return {
      available: false,
      target: null,
      implementations: [],
      total: 0,
      truncated: false,
      message: '没有找到目标符号。',
    };
  }

  const targetNode = nodeMap.get(targetNodeId);
  if (!targetNode || targetNode.kind !== 'symbol' || !targetNode.symbol) {
    return {
      available: false,
      target: null,
      implementations: [],
      total: 0,
      truncated: false,
      message: '目标节点不是符号。',
    };
  }

  const targetIdSet = new Set(targetNodeIds);
  const implementationIdSet = new Set(
    graph.edges
      .filter((edge) => (edge.kind === 'extends' || edge.kind === 'implements') && targetIdSet.has(edge.to))
      .map((edge) => edge.from)
  );
  const implementations = graph.nodes
    .filter((node) => implementationIdSet.has(node.id) && node.kind === 'symbol' && node.symbol)
    .map(toGraphSymbolMatch)
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      return (left.line ?? 0) - (right.line ?? 0);
    });

  return {
    available: true,
    target: toGraphSymbolMatch(targetNode),
    implementations: implementations.slice(0, limit),
    total: implementations.length,
    truncated: implementations.length > limit,
  };
}
