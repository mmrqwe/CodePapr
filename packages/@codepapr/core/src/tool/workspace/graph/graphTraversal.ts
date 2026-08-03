import type { ProjectGraphEdge, ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';

export function buildEdgeMaps(graph: WorkspaceProjectGraphResult): {
  outgoing: Map<string, ProjectGraphEdge[]>;
  incoming: Map<string, ProjectGraphEdge[]>;
} {
  const outgoing = new Map<string, ProjectGraphEdge[]>();
  const incoming = new Map<string, ProjectGraphEdge[]>();

  for (const edge of graph.edges) {
    const outgoingEdges = outgoing.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.from, outgoingEdges);

    const incomingEdges = incoming.get(edge.to) ?? [];
    incomingEdges.push(edge);
    incoming.set(edge.to, incomingEdges);
  }

  return { outgoing, incoming };
}

export function buildNodeMap(graph: WorkspaceProjectGraphResult): Map<string, ProjectGraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}
