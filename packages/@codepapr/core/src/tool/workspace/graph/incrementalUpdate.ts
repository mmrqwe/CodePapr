import type { ProjectGraphEdge, ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';

export interface IncrementalGraphUpdate {
  addedNodes: ProjectGraphNode[];
  removedNodeIds: string[];
  addedEdges: ProjectGraphEdge[];
  removedEdgeIds: string[];
  changedNodes: ProjectGraphNode[];
  summaryDelta: {
    filesDelta: number;
    symbolsDelta: number;
    importsDelta: number;
    callsDelta: number;
    edgesDelta: number;
  };
  /** 应用后应采用的完整 files 清单；缺省时保留原图 files。 */
  files?: WorkspaceProjectGraphResult['files'];
  /** 应用后应采用的完整 summary；缺省时按 summaryDelta 做字段级加减。 */
  summary?: WorkspaceProjectGraphResult['summary'];
  quality?: WorkspaceProjectGraphResult['quality'];
  truncated?: boolean;
}

function nodeChanged(prev: ProjectGraphNode, next: ProjectGraphNode): boolean {
  return (
    prev.kind !== next.kind ||
    prev.label !== next.label ||
    prev.path !== next.path ||
    prev.language !== next.language ||
    prev.bytes !== next.bytes ||
    prev.fileType !== next.fileType ||
    prev.entryPoint !== next.entryPoint ||
    prev.entryPointScore !== next.entryPointScore ||
    prev.symbolSource !== next.symbolSource ||
    prev.qualifiedName !== next.qualifiedName ||
    prev.disambiguated !== next.disambiguated ||
    JSON.stringify(prev.symbol) !== JSON.stringify(next.symbol)
  );
}

export function computeIncrementalUpdate(
  before: WorkspaceProjectGraphResult,
  after: WorkspaceProjectGraphResult,
): IncrementalGraphUpdate {
  const beforeNodeMap = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodeMap = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdgeMap = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdgeMap = new Map(after.edges.map((e) => [e.id, e]));

  const addedNodes: ProjectGraphNode[] = [];
  const removedNodeIds: string[] = [];
  const changedNodes: ProjectGraphNode[] = [];

  for (const [id, node] of afterNodeMap) {
    if (!beforeNodeMap.has(id)) {
      addedNodes.push(node);
    } else {
      const prev = beforeNodeMap.get(id)!;
      if (nodeChanged(prev, node)) {
        changedNodes.push(node);
      }
    }
  }
  for (const [id] of beforeNodeMap) {
    if (!afterNodeMap.has(id)) {
      removedNodeIds.push(id);
    }
  }

  const addedEdges: ProjectGraphEdge[] = [];
  const removedEdgeIds: string[] = [];

  for (const [id, edge] of afterEdgeMap) {
    if (!beforeEdgeMap.has(id)) {
      addedEdges.push(edge);
    }
  }
  for (const [id] of beforeEdgeMap) {
    if (!afterEdgeMap.has(id)) {
      removedEdgeIds.push(id);
    }
  }

  return {
    addedNodes,
    removedNodeIds,
    addedEdges,
    removedEdgeIds,
    changedNodes,
    summaryDelta: {
      filesDelta: after.summary.files - before.summary.files,
      symbolsDelta: after.summary.symbols - before.summary.symbols,
      importsDelta: after.summary.imports - before.summary.imports,
      callsDelta: after.summary.calls - before.summary.calls,
      edgesDelta: after.summary.edges - before.summary.edges,
    },
    files: after.files,
    summary: after.summary,
    quality: after.quality,
    truncated: after.truncated,
  };
}

export function applyIncrementalUpdate(
  graph: WorkspaceProjectGraphResult,
  update: IncrementalGraphUpdate,
): WorkspaceProjectGraphResult {
  const removedNodeSet = new Set(update.removedNodeIds);
  const removedEdgeSet = new Set(update.removedEdgeIds);

  const nodeMap = new Map<string, ProjectGraphNode>();
  for (const node of graph.nodes) {
    if (!removedNodeSet.has(node.id)) nodeMap.set(node.id, node);
  }
  for (const node of update.addedNodes) {
    nodeMap.set(node.id, node);
  }

  const changedNodeMap = new Map(update.changedNodes.map((n) => [n.id, n]));
  for (const [id, updated] of changedNodeMap) {
    if (nodeMap.has(id)) nodeMap.set(id, updated);
  }
  const nodes = [...nodeMap.values()];

  const edgeMap = new Map<string, ProjectGraphEdge>();
  for (const edge of graph.edges) {
    if (!removedEdgeSet.has(edge.id)) edgeMap.set(edge.id, edge);
  }
  for (const edge of update.addedEdges) {
    edgeMap.set(edge.id, edge);
  }
  const uniqueEdges = [...edgeMap.values()];

  return {
    ...graph,
    nodes,
    edges: uniqueEdges,
    files: update.files ?? graph.files,
    truncated: update.truncated ?? graph.truncated,
    quality: update.quality ?? graph.quality,
    summary: update.summary ?? {
      ...graph.summary,
      files: graph.summary.files + update.summaryDelta.filesDelta,
      symbols: graph.summary.symbols + update.summaryDelta.symbolsDelta,
      imports: graph.summary.imports + update.summaryDelta.importsDelta,
      calls: graph.summary.calls + update.summaryDelta.callsDelta,
      edges: graph.summary.edges + update.summaryDelta.edgesDelta,
    },
  };
}
