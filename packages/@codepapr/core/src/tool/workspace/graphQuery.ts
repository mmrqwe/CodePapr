import type {
  ProjectGraphEdge,
  ProjectGraphNode,
  WorkspaceProjectGraphResult,
} from '../projectGraph';

export interface WorkspaceGraphSymbolMatch {
  symbolId: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  path: string;
  language?: string;
  line?: number;
  containerName?: string;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  symbolSource?: string;
  entryPoint?: boolean;
  entryPointScore?: number;
}

export interface WorkspaceSymbolLookupOptions {
  query?: string;
  relativePath?: string;
  symbolKind?: string;
  language?: string;
  exported?: boolean;
  limit?: number;
}

export interface WorkspaceSymbolLookupResult {
  matches: WorkspaceGraphSymbolMatch[];
  total: number;
  truncated: boolean;
}

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

export interface WorkspaceEntrypointCandidate {
  nodeId: string;
  kind: ProjectGraphNode['kind'];
  path: string;
  label: string;
  score: number;
  language?: string;
  qualifiedName?: string;
}

export interface WorkspaceEntrypointsResult {
  entries: WorkspaceEntrypointCandidate[];
  total: number;
  truncated: boolean;
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

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}

function graphSymbolNodes(graph: WorkspaceProjectGraphResult): ProjectGraphNode[] {
  return graph.nodes.filter((node) => node.kind === 'symbol' && node.symbol);
}

function toGraphSymbolMatch(node: ProjectGraphNode): WorkspaceGraphSymbolMatch {
  return {
    symbolId: node.id,
    name: node.label,
    qualifiedName: node.qualifiedName,
    kind: node.symbol?.kind ?? 'symbol',
    path: node.path,
    language: node.language,
    line: node.symbol?.line,
    containerName: node.symbol?.containerName,
    signature: node.symbol?.signature,
    exported: node.symbol?.exported,
    async: node.symbol?.async,
    symbolSource: node.symbolSource,
    entryPoint: node.entryPoint,
    entryPointScore: node.entryPointScore,
  };
}

function matchesSymbolQuery(node: ProjectGraphNode, options: WorkspaceSymbolLookupOptions): boolean {
  const query = normalizeText(options.query);
  const queryTerms = query ? query.split(/\s+/).filter(Boolean) : [];
  const kind = normalizeText(options.symbolKind);
  const language = normalizeText(options.language);
  const path = normalizeText(options.relativePath);

  if (kind && normalizeText(node.symbol?.kind) !== kind) {
    return false;
  }
  if (language && normalizeText(node.language) !== language) {
    return false;
  }
  if (path && !normalizeText(node.path).includes(path)) {
    return false;
  }
  if (typeof options.exported === 'boolean' && Boolean(node.symbol?.exported) !== options.exported) {
    return false;
  }
  if (queryTerms.length === 0) {
    return true;
  }

  const haystack = [
    node.label,
    node.qualifiedName,
    node.path,
    node.symbol?.signature,
    node.symbol?.containerName,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeText(value))
    .join(' ');

  return queryTerms.every((term) => haystack.includes(term));
}

export function lookupWorkspaceSymbols(
  graph: WorkspaceProjectGraphResult,
  options: WorkspaceSymbolLookupOptions = {}
): WorkspaceSymbolLookupResult {
  const limit = clamp(options.limit, 20, 1, 100);
  const matches = graphSymbolNodes(graph)
    .filter((node) => matchesSymbolQuery(node, options))
    .sort((left, right) => {
      const leftScore = left.entryPointScore ?? 0;
      const rightScore = right.entryPointScore ?? 0;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return `${left.path}:${left.symbol?.line ?? 0}`.localeCompare(`${right.path}:${right.symbol?.line ?? 0}`);
    });

  return {
    matches: matches.slice(0, limit).map(toGraphSymbolMatch),
    total: matches.length,
    truncated: matches.length > limit,
  };
}

function buildEdgeMaps(graph: WorkspaceProjectGraphResult): {
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

function buildNodeMap(graph: WorkspaceProjectGraphResult): Map<string, ProjectGraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
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
    if (matches.length > 0) {
      return matches.map((node) => node.id);
    }
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

export function findWorkspaceEntrypoints(
  graph: WorkspaceProjectGraphResult,
  limit?: number
): WorkspaceEntrypointsResult {
  const maxEntries = clamp(limit, 20, 1, 100);
  const ranked = graph.nodes
    .filter((node) => node.entryPoint)
    .map((node) => ({
      nodeId: node.id,
      kind: node.kind,
      path: node.path,
      label: node.label,
      score: node.entryPointScore ?? 0,
      language: node.language,
      qualifiedName: node.qualifiedName,
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  return {
    entries: ranked.slice(0, maxEntries),
    total: ranked.length,
    truncated: ranked.length > maxEntries,
  };
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
    .sort((left, right) => `${left.path}:${left.line ?? 0}`.localeCompare(`${right.path}:${right.line ?? 0}`));
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
  const targetNodeId = seedIds.find((id) => nodeMap.get(id)?.kind === 'symbol');

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

  const implementationIdSet = new Set(
    graph.edges
      .filter((edge) => (edge.kind === 'extends' || edge.kind === 'implements') && edge.to === targetNodeId)
      .map((edge) => edge.from)
  );
  const implementations = graph.nodes
    .filter((node) => implementationIdSet.has(node.id) && node.kind === 'symbol' && node.symbol)
    .map(toGraphSymbolMatch)
    .sort((left, right) => `${left.path}:${left.line ?? 0}`.localeCompare(`${right.path}:${right.line ?? 0}`));

  return {
    available: true,
    target: toGraphSymbolMatch(targetNode),
    implementations: implementations.slice(0, limit),
    total: implementations.length,
    truncated: implementations.length > limit,
  };
}

export interface WorkspaceSmartContextOptions {
  query: string;
  relativePath?: string;
  depth?: number;
}

export interface WorkspaceSmartContextResult {
  available: boolean;
  summary: string;
  relevantSymbols: WorkspaceGraphSymbolMatch[];
  relevantFiles: string[];
  entryPoints: WorkspaceEntrypointCandidate[];
  dependencySubgraph?: WorkspaceDependencySubgraphResult;
  message?: string;
}

export function getWorkspaceSmartContext(
  graph: WorkspaceProjectGraphResult,
  options: WorkspaceSmartContextOptions
): WorkspaceSmartContextResult {
  // Step 1: Lookup relevant symbols based on the query
  const symbolLookup = lookupWorkspaceSymbols(graph, {
    query: options.query,
    relativePath: options.relativePath,
    limit: 10,
  });

  // Step 2: Find entry points
  const entryPoints = findWorkspaceEntrypoints(graph, 5);

  // Step 3: Build dependency subgraph from the top matches
  let dependencySubgraph: WorkspaceDependencySubgraphResult | undefined;
  if (symbolLookup.matches.length > 0) {
    dependencySubgraph = buildWorkspaceDependencySubgraph(graph, {
      symbolId: symbolLookup.matches[0].symbolId,
      depth: options.depth ?? 2,
      direction: 'both',
      maxNodes: 40,
      maxEdges: 100,
    });
  }

  // Step 4: Collect relevant files
  const relevantFilesSet = new Set<string>();
  for (const match of symbolLookup.matches) {
    relevantFilesSet.add(match.path);
  }
  if (dependencySubgraph?.available) {
    for (const node of dependencySubgraph.nodes) {
      relevantFilesSet.add(node.path);
    }
  }
  const relevantFiles = [...relevantFilesSet].sort();

  // Step 5: Build summary
  const summaryParts: string[] = [];
  summaryParts.push(`找到 ${symbolLookup.matches.length} 个相关符号`);
  if (entryPoints.entries.length > 0) {
    summaryParts.push(`${entryPoints.entries.length} 个入口点`);
  }
  if (relevantFiles.length > 0) {
    summaryParts.push(`${relevantFiles.length} 个相关文件`);
  }

  return {
    available: true,
    summary: summaryParts.join('，'),
    relevantSymbols: symbolLookup.matches,
    relevantFiles,
    entryPoints: entryPoints.entries,
  };
}

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

export function planProjectGraphRename(
  params: ProjectGraphRenameParams,
): { edits: Map<string, Array<{ line: number; startColumn: number; endColumn: number; replacement: string }>>; symbol: ProjectGraphNode | null } {
  const symbol = findSymbolAtPosition(params.graph, params.relativePath, params.line, params.character);
  if (!symbol || !symbol.symbol) {
    return { edits: new Map(), symbol: null };
  }

  const oldName = symbol.symbol.name;
  const refs = findAllReferences(params.graph, symbol.id, oldName);
  const edits = new Map<string, Array<{ line: number; startColumn: number; endColumn: number; replacement: string }>>();

  for (const ref of refs) {
    const fileEdits = edits.get(ref.path) ?? [];
    fileEdits.push({
      line: ref.line,
      startColumn: ref.column,
      endColumn: ref.column + oldName.length,
      replacement: params.newName,
    });
    edits.set(ref.path, fileEdits);
  }

  return { edits, symbol };
}

function findSymbolAtPosition(
  graph: WorkspaceProjectGraphResult,
  relativePath: string,
  line: number,
  character: number,
): ProjectGraphNode | null {
  const nodeMap = buildNodeMap(graph);
  const candidates: ProjectGraphNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.kind === 'symbol' && node.path === relativePath && node.symbol && node.symbol.line <= line) {
      candidates.push(node);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.symbol?.line ?? 0) - (a.symbol?.line ?? 0));
  const nearest = candidates[0] ?? null;
  if (nearest?.symbol?.line === line && character > 0) {
    const sameLine = candidates.filter((n) => n.symbol?.line === line);
    if (sameLine.length > 1) {
      return sameLine.reduce((best, n) => {
        const bestDist = Math.abs((best.symbol?.line ?? 0) - line);
        const nDist = Math.abs((n.symbol?.line ?? 0) - line);
        return nDist < bestDist ? n : best;
      });
    }
  }
  return nearest;
}

interface RawReference {
  path: string;
  line: number;
  column: number;
}

function findAllReferences(
  graph: WorkspaceProjectGraphResult,
  symbolId: string,
  symbolName: string,
): RawReference[] {
  const refs: RawReference[] = [];
  const seen = new Set<string>();
  const nodeMap = buildNodeMap(graph);

  for (const node of nodeMap.values()) {
    if (node.kind === 'symbol' && node.symbol) {
      if (node.id === symbolId) {
        addRef(refs, seen, node.path, node.symbol.line, 0, symbolName);
        continue;
      }
      if (node.symbol.name === symbolName) {
        addRef(refs, seen, node.path, node.symbol.line, 0, symbolName);
      }
    }
  }

  const incoming = graph.edges.filter((e) => e.to === symbolId && e.from.startsWith('symbol:'));
  for (const edge of incoming) {
    const fromNode = nodeMap.get(edge.from);
    if (fromNode?.symbol) {
      addRef(refs, seen, fromNode.path, fromNode.symbol.line, 0, symbolName);
    }
  }

  return refs;
}

function addRef(
  refs: RawReference[],
  seen: Set<string>,
  path: string,
  line: number,
  column: number,
  name: string,
) {
  const key = `${path}:${line}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  refs.push({ path, line, column });
}

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
        const p = parent.get(top.node);
        if (p !== undefined) onStack.delete(p);
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
        const files = cycleIds.map((id) => nodeIdToPath.get(id) ?? id);
        cycles.push({ cycle: cycleIds, files, length: cycleIds.length });
        continue;
      }

      if (!color.has(neighbor) || color.get(neighbor) === NodeColor.WHITE) {
        color.set(neighbor, NodeColor.GRAY);
        onStack.add(neighbor);
        parent.set(neighbor, top.node);
        stack.push({ node: neighbor, iter: adjacency.get(neighbor)![Symbol.iterator]() });
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
    : `检测到 ${cycles.length} 个循环依赖，涉及 ${cycles.reduce((s, c) => s + c.length, 0)} 个文件。`;

  return { cycles, total: cycles.length, summary };
}

function extractFileId(nodeId: string): string | null {
  const colon = nodeId.lastIndexOf(':');
  if (colon < 0) return null;
  const prefix = nodeId.substring(0, colon);
  if (prefix.startsWith('file:') || prefix.startsWith('symbol:')) return null;
  if (nodeId.startsWith('file:')) return nodeId;
  if (nodeId.startsWith('symbol:')) return `file:${nodeId.substring('symbol:'.length, colon)}`;
  return null;
}

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
        edge.kind === 'extends' || edge.kind === 'implements') {
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
      depth: 0,
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
      assignDepth(node, nodes, new Set(), 0);
    }
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

function isTypeSymbolKind(kind: string): boolean {
  return /^(class|interface|struct|enum|trait|type|protocol|object|actor|record|module)$/i.test(kind);
}

function isCallableSymbolKind(kind: string): boolean {
  return /^(function|method|constructor|arrow|local_function|fn|def|func|sub)$/i.test(kind);
}

function assignDepth(
  node: TypeNode,
  nodes: Map<string, TypeNode>,
  visited: Set<string>,
  depth: number,
) {
  if (visited.has(node.symbolId)) return;
  visited.add(node.symbolId);
  node.depth = Math.max(node.depth, depth);
  for (const childId of node.children) {
    const child = nodes.get(childId);
    if (child) assignDepth(child, nodes, visited, depth + 1);
  }
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

export interface TestDiscoveryResult {
  testFiles: string[];
  testFunctions: Array<{ path: string; name: string; line: number }>;
  mappedSources: Map<string, string[]>;
  summary: string;
}

export function discoverAndMapTests(
  graph: WorkspaceProjectGraphResult,
): TestDiscoveryResult {
  const nodeMap = buildNodeMap(graph);
  const edgeMap = buildEdgeMaps(graph);
  const testFiles: string[] = [];
  const testFunctions: Array<{ path: string; name: string; line: number }> = [];

  const TEST_FILE_PATTERNS = /[._](test|spec|_test)\.\w+$|^test[._]|\.test\./i;
  const TEST_FUNC_PATTERNS = /^test[A-Z_]|^it\(|^describe\(|^Spec_|^Test[A-Z]/;

  for (const node of nodeMap.values()) {
    if (node.kind !== 'symbol' || !node.symbol) continue;

    if (TEST_FILE_PATTERNS.test(node.path)) {
      if (!testFiles.includes(node.path)) {
        testFiles.push(node.path);
      }
      if (TEST_FUNC_PATTERNS.test(node.symbol.name)) {
        testFunctions.push({
          path: node.path,
          name: node.symbol.name,
          line: node.symbol.line,
        });
      }
    }
  }

  const mappedSources = new Map<string, string[]>();
  for (const testFile of testFiles) {
    const sources: string[] = [];
    const outEdges = edgeMap.outgoing.get(testFile) ?? [];
    for (const edge of outEdges) {
      if (edge.kind !== 'imports' && edge.kind !== 'calls') continue;
      const toNode = nodeMap.get(edge.to);
      if (!toNode || isTestFile(toNode.path)) continue;
      if (!sources.includes(toNode.path)) {
        sources.push(toNode.path);
      }
    }

    if (sources.length === 0) {
      for (const edge of outEdges) {
        if (edge.kind !== 'imports') continue;
        const toNode = nodeMap.get(edge.to);
        if (toNode && !isTestFile(toNode.path) && !sources.includes(toNode.path)) {
          sources.push(toNode.path);
        }
      }
    }

    if (sources.length > 0) {
      mappedSources.set(testFile, sources);
    }
  }

  return {
    testFiles,
    testFunctions,
    mappedSources,
    summary: `${testFiles.length} 个测试文件，${testFunctions.length} 个测试函数，${mappedSources.size} 个被测源文件映射。`,
  };
}

function isTestFile(path: string): boolean {
  return /[._](test|spec|_test)\.\w+$|^test[._]/i.test(path);
}

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

function countFunctionLines(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  let depth = 0;
  let started = false;
  let endLine = startLine;

  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') {
        depth--;
        if (started && depth <= 0) {
          endLine = i + 1;
          return endLine - startLine + 1;
        }
      }
    }
    if (i === startLine - 1 && !started && depth === 0) {
      return 0;
    }
  }
  return endLine - startLine + 1;
}

// Python 等语言用缩进而非花括号定界代码块，countFunctionLines/estimateNestingDepth
// 的花括号计数对这些语言永远返回 0/1，长函数建议永远不会触发，这里按缩进单独处理。
function isIndentationBasedLanguage(path: string, language?: string): boolean {
  if (language && language.toLowerCase().includes('python')) return true;
  return path.toLowerCase().endsWith('.py');
}

function countFunctionLinesIndentBased(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length) return 0;
  const baseIndent = lines[startLine - 1].search(/\S/);
  if (baseIndent < 0) return 0;

  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    endLine = i + 1;
  }
  return endLine - startLine + 1;
}

function estimateNestingDepthIndentBased(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length) return 1;
  const baseIndent = lines[startLine - 1].search(/\S/);
  if (baseIndent < 0) return 1;

  let maxIndent = baseIndent;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    if (indent > maxIndent) maxIndent = indent;
  }
  // 常见每级缩进 4 个空格，粗略换算成层级数。
  return Math.max(1, Math.round((maxIndent - baseIndent) / 4));
}

function estimateNestingDepth(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  let depth = 0;
  let started = false;
  let maxDepth = 0;

  for (let i = startLine - 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const indent = lines[i].length - trimmed.length;
    if (indent > maxDepth) maxDepth = indent;

    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') {
        depth--;
        if (started && depth <= 0) return Math.max(1, Math.round(maxDepth / 2));
      }
    }
    if (i === startLine - 1 && !started && depth === 0) {
      return 1;
    }
  }
  return Math.max(1, Math.round(maxDepth / 2));
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

function getExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : 'ts';
}

export interface ImpactBasedTestSelectionResult {
  changedFiles: string[];
  affectedTests: string[];
  selectedTests: Array<{ path: string; name: string; line: number }>;
  reasoning: string[];
  summary: string;
}

export function selectTestsByChangeImpact(
  graph: WorkspaceProjectGraphResult,
  changedFiles: string[],
): ImpactBasedTestSelectionResult {
  const testDiscovery = discoverAndMapTests(graph);
  const reasoning: string[] = [];

  const impactedFiles = new Set<string>(changedFiles);
  for (const changedFile of changedFiles) {
    const impact = analyzeChangeImpactInternal(graph, changedFile);
    for (const node of impact) {
      impactedFiles.add(node.path);
    }
    reasoning.push(`${changedFile} 变更影响 ${impact.length} 个下游文件`);
  }

  const selectedTests: Array<{ path: string; name: string; line: number }> = [];
  const affectedTests = new Set<string>();

  for (const impactedFile of impactedFiles) {
    for (const [testFile, sources] of testDiscovery.mappedSources) {
      if (sources.includes(impactedFile)) {
        affectedTests.add(testFile);
        break;
      }
    }
  }

  for (const tf of testDiscovery.testFunctions) {
    if (affectedTests.has(tf.path)) {
      selectedTests.push(tf);
    } else {
      for (const impactedFile of impactedFiles) {
        if (tf.path.includes(impactedFile.replace(/\.[^.]+$/, '')) ||
            impactedFile.includes(tf.name.replace(/^(test|spec|Test|it\s*\(['"])\s*/, ''))) {
          selectedTests.push(tf);
          affectedTests.add(tf.path);
          break;
        }
      }
    }
  }

  return {
    changedFiles,
    affectedTests: [...affectedTests],
    selectedTests,
    reasoning,
    summary: `${changedFiles.length} 个变更文件 → ${impactedFiles.size} 个影响范围 → ${affectedTests.size} 个需运行的测试文件。`,
  };
}

function analyzeChangeImpactInternal(
  graph: WorkspaceProjectGraphResult,
  filePath: string,
): ProjectGraphNode[] {
  const edgeMap = buildEdgeMaps(graph);
  const fileNode = graph.nodes.find(
    (n) => n.kind === 'file' && n.path === filePath,
  );
  if (!fileNode) return [];

  const impacted = new Set<string>();
  const queue = [fileNode.id];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const outEdges = edgeMap.outgoing.get(current) ?? [];
    for (const edge of outEdges) {
      if (!impacted.has(edge.to)) {
        impacted.add(edge.to);
        queue.push(edge.to);
      }
    }
    const inEdges = edgeMap.incoming.get(current) ?? [];
    for (const edge of inEdges) {
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        queue.push(edge.from);
      }
    }
  }

  return graph.nodes.filter(
    (n) => impacted.has(n.id) && n.kind !== 'file',
  );
}

export interface ArchitectureLayer {
  patterns: string[];
  allowedImports: string[];
}

export interface LayerViolation {
  fromPath: string;
  toPath: string;
  fromLayer: string;
  toLayer: string;
  edgeId: string;
}

export interface ArchitectureCheckResult {
  violations: LayerViolation[];
  total: number;
  summary: string;
}

export function checkArchitectureLayers(
  graph: WorkspaceProjectGraphResult,
  layers: ArchitectureLayer[],
): ArchitectureCheckResult {
  const violations: LayerViolation[] = [];
  const nodeMap = buildNodeMap(graph);

  const compiledLayers = layers.map((layer) => ({
    ...layer,
    compiledPatterns: layer.patterns.map((p) => new RegExp(p)),
  }));

  const classifyFile = (path: string): string => {
    for (const layer of compiledLayers) {
      for (const re of layer.compiledPatterns) {
        if (re.test(path)) {
          return layer.patterns[0];
        }
      }
    }
    return '';
  };

  const allowedByLayer = new Map<string, Set<string>>();
  for (const layer of compiledLayers) {
    const allowed = new Set(layer.allowedImports);
    allowedByLayer.set(layer.patterns[0], allowed);
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' && edge.kind !== 'reexports') continue;

    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fromLayer = classifyFile(fromNode.path);
    const toLayer = classifyFile(toNode.path);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const allowed = allowedByLayer.get(fromLayer);
    if (allowed && !allowed.has(toLayer)) {
      violations.push({
        fromPath: fromNode.path,
        toPath: toNode.path,
        fromLayer,
        toLayer,
        edgeId: edge.id,
      });
    }
  }

  return {
    violations,
    total: violations.length,
    summary: violations.length === 0
      ? '未检测到架构分层违规。'
      : `检测到 ${violations.length} 个分层违规。`,
  };
}

export type SemanticChangeKind = 'added' | 'removed' | 'modified' | 'renamed';

export interface SemanticSymbolChange {
  kind: SemanticChangeKind;
  symbol: { name: string; kind: string; signature: string; path: string; line: number };
  previous?: { name: string; kind: string; signature: string };
}

export interface SemanticEdgeChange {
  added: number;
  removed: number;
  details: string[];
}

export interface SemanticDiffResult {
  symbolChanges: SemanticSymbolChange[];
  edgeChanges: SemanticEdgeChange;
  breakingChanges: SemanticSymbolChange[];
  summary: string;
}

export function computeSemanticDiff(
  before: WorkspaceProjectGraphResult,
  after: WorkspaceProjectGraphResult,
): SemanticDiffResult {
  const beforeSymbols = new Map<string, { name: string; kind: string; signature: string; path: string; line: number }>();
  const afterSymbols = new Map<string, { name: string; kind: string; signature: string; path: string; line: number }>();

  for (const n of before.nodes) {
    if (n.kind === 'symbol' && n.symbol) {
      beforeSymbols.set(n.id, {
        name: n.symbol.name,
        kind: n.symbol.kind,
        signature: n.symbol.signature,
        path: n.path,
        line: n.symbol.line,
      });
    }
  }
  for (const n of after.nodes) {
    if (n.kind === 'symbol' && n.symbol) {
      afterSymbols.set(n.id, {
        name: n.symbol.name,
        kind: n.symbol.kind,
        signature: n.symbol.signature,
        path: n.path,
        line: n.symbol.line,
      });
    }
  }

  const changes: SemanticSymbolChange[] = [];
  const breakingChanges: SemanticSymbolChange[] = [];

  for (const [id, beforeSym] of beforeSymbols) {
    const afterSym = afterSymbols.get(id);
    if (!afterSym) {
      const change: SemanticSymbolChange = {
        kind: 'removed',
        symbol: beforeSym,
      };
      changes.push(change);
      if (isExportedSymbol(before, id)) {
        breakingChanges.push(change);
      }
    } else if (beforeSym.signature !== afterSym.signature) {
      const change: SemanticSymbolChange = {
        kind: 'modified',
        symbol: afterSym,
        previous: { name: beforeSym.name, kind: beforeSym.kind, signature: beforeSym.signature },
      };
      changes.push(change);
      if (beforeSym.name !== afterSym.name) {
        change.kind = 'renamed';
      }
      if (isExportedSymbol(before, id)) {
        breakingChanges.push(change);
      }
    }
  }

  for (const [id, afterSym] of afterSymbols) {
    if (!beforeSymbols.has(id)) {
      changes.push({ kind: 'added', symbol: afterSym });
    }
  }

  const edgeAdded = after.edges.length - before.edges.length;
  const edgeRemoved = Math.max(0, before.edges.length - after.edges.length);
  const newImports = after.edges.filter((e) => e.kind === 'imports').length -
    before.edges.filter((e) => e.kind === 'imports').length;
  const newCalls = after.edges.filter((e) => e.kind === 'calls').length -
    before.edges.filter((e) => e.kind === 'calls').length;

  const edgeDetails: string[] = [];
  if (Math.abs(newImports) > 0) edgeDetails.push(`import 关系 ${newImports > 0 ? '+' : ''}${newImports}`);
  if (Math.abs(newCalls) > 0) edgeDetails.push(`调用关系 ${newCalls > 0 ? '+' : ''}${newCalls}`);

  const added = changes.filter((c) => c.kind === 'added').length;
  const removed = changes.filter((c) => c.kind === 'removed').length;
  const modified = changes.filter((c) => c.kind === 'modified' || c.kind === 'renamed').length;

  return {
    symbolChanges: changes,
    edgeChanges: { added: edgeAdded, removed: edgeRemoved, details: edgeDetails },
    breakingChanges,
    summary: `+${added} −${removed} ~${modified} 个符号变更` +
      (breakingChanges.length > 0 ? `，${breakingChanges.length} 个破坏性变更` : '') +
      (edgeDetails.length > 0 ? `，${edgeDetails.join('，')}` : ''),
  };
}

function isExportedSymbol(graph: WorkspaceProjectGraphResult, symbolId: string): boolean {
  const node = graph.nodes.find((n) => n.id === symbolId);
  return node?.symbol?.exported ?? false;
}

export interface GeneratedTest {
  fileName: string;
  testName: string;
  content: string;
  language: string;
}

export interface TestGenerationResult {
  tests: GeneratedTest[];
  summary: string;
}

export function generateTestSkeletons(
  graph: WorkspaceProjectGraphResult,
): TestGenerationResult {
  const tests: GeneratedTest[] = [];
  const testTargets = graph.nodes.filter(
    (n) => n.kind === 'symbol' && n.symbol && isCallableSymbolKind(n.symbol.kind) && n.symbol.exported,
  );

  for (const node of testTargets) {
    if (!node.symbol) continue;
    const lang = detectTestLanguage(node.language ?? node.path);
    const test = generateSingleTest(node.symbol.name, node.symbol.signature, node.path, lang);
    if (test) tests.push(test);
  }

  return {
    tests,
    summary: `为 ${tests.length} 个导出函数生成了测试骨架。`,
  };
}

function detectTestLanguage(langOrPath: string): string {
  const ext = langOrPath.split('.').pop()?.toLowerCase() ?? '';
  const LANG_MAP: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift',
  };
  return LANG_MAP[ext] ?? 'typescript';
}

function generateSingleTest(
  name: string,
  signature: string,
  sourcePath: string,
  language: string,
): GeneratedTest | null {
  const params = extractParams(signature);
  switch (language) {
    case 'typescript':
    case 'javascript':
      return {
        fileName: sourcePath.replace(/\.\w+$/, '.test.ts'),
        testName: `test ${name}`,
        content: generateTsTest(name, params, sourcePath),
        language,
      };
    case 'python':
      return {
        fileName: `test_${sourcePath.split('/').pop() ?? ''}`,
        testName: `test_${name}`,
        content: generatePythonTest(name, params, sourcePath),
        language,
      };
    case 'go':
      return {
        fileName: sourcePath.replace(/\.go$/, '_test.go'),
        testName: `Test${capitalize(name)}`,
        content: generateGoTest(name, params),
        language,
      };
    case 'rust':
      return {
        fileName: sourcePath,
        testName: `test_${name}`,
        content: generateRustTest(name, params),
        language,
      };
    default:
      return null;
  }
}

function extractParams(signature: string): string[] {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const parts = p.split(/[\s:=]+/);
      return parts[parts.length - 1].replace(/[,?]$/, '');
    });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateTsTest(name: string, params: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const args = params.map((p) => `/* ${p} */ undefined`).join(', ');

  return [
    `import { describe, expect, it } from 'vitest';`,
    `import { ${name} } from './${moduleName}';`,
    ``,
    `describe('${name}', () => {`,
    `  it('should return expected result', () => {`,
    `    const result = ${name}(${args});`,
    `    expect(result).toBeDefined();`,
    `  });`,
    ``,
    `  it('should handle edge cases', () => {`,
    `    // TODO: add edge case tests`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function generatePythonTest(name: string, params: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.py$/, '');
  const args = params.join(', ');

  return [
    `import pytest`,
    `from ${moduleName} import ${name}`,
    ``,
    ``,
    `def test_${name}_returns_expected():`,
    `    result = ${name}(${args})`,
    `    assert result is not None`,
    ``,
    ``,
    `def test_${name}_edge_cases():`,
    `    # TODO: add edge case tests`,
    `    pass`,
    ``,
  ].join('\n');
}

function generateGoTest(name: string, params: string[]): string {
  return [
    `package main`,
    ``,
    `import "testing"`,
    ``,
    `func Test${capitalize(name)}(t *testing.T) {`,
    `    // TODO: setup test fixtures`,
    ...params.map((p) => `    ${p} := "" /* TODO: initialize */`),
    `    _ = ${name}(${params.join(', ')})`,
    `    // TODO: add assertions`,
    `}`,
    ``,
  ].join('\n');
}

function generateRustTest(name: string, params: string[]): string {
  return [
    `#[cfg(test)]`,
    `mod tests {`,
    `    use super::*;`,
    ``,
    `    #[test]`,
    `    fn test_${name}() {`,
    ...params.map((p) => `        let ${p} = todo!();`),
    `        let result = ${name}(${params.join(', ')});`,
    `        // TODO: add assertions`,
    `    }`,
    `}`,
    ``,
  ].join('\n');
}

// ============= P2-1: Extract Method, Move Symbol, Inline Variable =============

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

  const importers: string[] = [];
  const dependencies: string[] = [];

  for (const edge of graph.edges) {
    if (edge.to === symbolId) {
      const fromNode = graph.nodes.find((n) => n.id === edge.from);
      if (fromNode && fromNode.path !== node.path && !importers.includes(fromNode.path)) {
        importers.push(fromNode.path);
      }
    }
    if (edge.from === symbolId && (edge.kind === 'imports' || edge.kind === 'calls')) {
      const toNode = graph.nodes.find((n) => n.id === edge.to);
      if (toNode && toNode.path !== node.path && !dependencies.includes(toNode.path)) {
        dependencies.push(toNode.path);
      }
    }
  }

  if (importers.length < 2) return null;

  const ext = getExtension(node.path);
  const safeName = node.symbol.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const targetPath = node.path.replace(/\/[^/]+$/, `/${safeName}.${ext}`);

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

  for (const otherNode of graph.nodes) {
    if (otherNode.kind !== 'symbol' || !otherNode.symbol) continue;
    if (otherNode.id === symbolId) continue;

    const otherContent = fileContents[otherNode.path]?.content;
    if (!otherContent) continue;

    const otherLines = otherContent.split(/\r?\n/);
    for (let i = 0; i < otherLines.length; i++) {
      const pattern = new RegExp(`\\b${escapeRegex(varName)}\\b`, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(otherLines[i])) !== null) {
        const beforeChar = otherLines[i][match.index - 1];
        if (beforeChar && /[a-zA-Z0-9_$.]/.test(beforeChar)) continue;
        usageSites.push({ path: otherNode.path, line: i + 1, column: match.index + 1 });
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

    const outgoing = edgeMap.outgoing.get(node.id) ?? [];
    const incoming = edgeMap.incoming.get(node.id) ?? [];
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const prefix = fromDir.filter((p, i) => p === toParts[i]).length;
  const upCount = fromDir.length - prefix;
  const up = '../'.repeat(Math.max(0, upCount));
  const down = toParts.slice(prefix).join('/');
  return `./${up}${down}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
}

// ============= P2-2: Smarter Test Intelligence =============

export interface SmartTestSkeleton {
  fileName: string;
  testName: string;
  content: string;
  language: string;
  testedSymbol: string;
  calleeSymbols: string[];
  assertionHints: string[];
}

export interface SmartTestGenerationResult {
  tests: SmartTestSkeleton[];
  testCoverage: { covered: number; total: number; percentage: number };
  summary: string;
}

export function generateSmartTestSkeletons(
  graph: WorkspaceProjectGraphResult,
): SmartTestGenerationResult {
  const tests: SmartTestSkeleton[] = [];
  const nodeMap = buildNodeMap(graph);
  const callableNodes = graph.nodes.filter(
    (n) => n.kind === 'symbol' && n.symbol && isCallableSymbolKind(n.symbol.kind) && n.symbol.exported,
  );
  const testFileSet = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' && isTestFile(n.path)) testFileSet.add(n.path);
  }

  const edgeMap = buildEdgeMaps(graph);
  const coveredSymbols = new Set<string>();

  for (const node of callableNodes) {
    if (!node.symbol) continue;
    if (testFileSet.has(node.path)) continue;
    if (node.path.includes('__test__') || node.path.includes('.test.') || node.path.includes('.spec.')) continue;

    const callTargets = (edgeMap.outgoing.get(node.id) ?? [])
      .filter((e) => e.kind === 'calls')
      .map((e) => {
        const target = nodeMap.get(e.to);
        return target?.symbol?.name ?? '';
      })
      .filter(Boolean);

    const depTargets = (edgeMap.outgoing.get(node.id) ?? [])
      .filter((e) => e.kind === 'imports' || e.kind === 'calls')
      .map((e) => {
        const target = nodeMap.get(e.to);
        return target?.symbol?.name ?? '';
      })
      .filter(Boolean);

    const lang = detectTestLanguage(node.language ?? node.path);
    const assertionHints = generateAssertionHints(node.symbol, callTargets, depTargets, lang);
    const params = extractParams(node.symbol.signature);

    const content = generateSmartTestContent(
      node.symbol.name, params, callTargets, assertionHints, node.path, lang,
    );

    tests.push({
      fileName: generateTestFileName(node.path, lang),
      testName: generateTestName(node.symbol.name, lang),
      content,
      language: lang,
      testedSymbol: node.symbol.name,
      calleeSymbols: callTargets,
      assertionHints,
    });

    coveredSymbols.add(node.id);
  }

  const totalSymbols = callableNodes.length;
  const covered = coveredSymbols.size;

  return {
    tests,
    testCoverage: {
      covered,
      total: totalSymbols,
      percentage: totalSymbols > 0 ? Math.round((covered / totalSymbols) * 100) : 0,
    },
    summary: `为 ${covered}/${totalSymbols} 个导出函数生成了智能测试骨架（覆盖率 ${totalSymbols > 0 ? Math.round((covered / totalSymbols) * 100) : 0}%）。`,
  };
}

function generateAssertionHints(
  symbol: { name: string; kind: string; signature: string },
  callTargets: string[],
  _depTargets: string[],
  lang: string,
): string[] {
  const hints: string[] = [];

  if (/=>|return|:\s*\w/.test(symbol.signature)) {
    if (lang === 'python') {
      hints.push(`assert result is not None  # ${symbol.name} 应返回有效值`);
    } else if (lang === 'go') {
      hints.push(`// assert: result should not be nil`);
    } else if (lang === 'rust') {
      hints.push(`assert!(result.is_ok() || result.is_some());`);
    } else {
      hints.push(`expect(result).toBeDefined();`);
    }
  }

  for (const target of callTargets.slice(0, 3)) {
    if (lang === 'python') {
      hints.push(`# Verify ${target} was called`);
    } else if (lang === 'go') {
      hints.push(`// Verify ${target} was called`);
    } else {
      hints.push(`// Verify ${target} interaction`);
    }
  }

  return hints;
}

function generateSmartTestContent(
  name: string,
  params: string[],
  callTargets: string[],
  assertionHints: string[],
  sourcePath: string,
  lang: string,
): string {
  switch (lang) {
    case 'python': return generateSmartPythonTest(name, params, callTargets, assertionHints, sourcePath);
    case 'go': return generateSmartGoTest(name, params, callTargets, assertionHints);
    case 'rust': return generateSmartRustTest(name, params, callTargets, assertionHints);
    default: return generateSmartTsTest(name, params, callTargets, assertionHints, sourcePath);
  }
}

function generateSmartTsTest(name: string, params: string[], callTargets: string[], hints: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const args = params.map((p) => `/* ${p} */ undefined`).join(', ');
  const hintLines = hints.map((h) => `    // ${h}`).join('\n');
  const mockSetup = callTargets.slice(0, 3).map((t) => `    // const ${t}Mock = vi.fn();`).join('\n');

  return [
    `import { describe, expect, it, vi } from 'vitest';`,
    `import { ${name} } from './${moduleName}';`,
    ``,
    `describe('${name}', () => {`,
    `  it('should return expected result', () => {`,
    mockSetup ? `${mockSetup}\n` : '',
    `    const result = ${name}(${args});`,
    hintLines,
    `    expect(result).toBeDefined();`,
    `  });`,
    ``,
    `  it('should handle edge cases', () => {`,
    `    // TODO: add edge case tests for ${name}`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function generateSmartPythonTest(name: string, params: string[], callTargets: string[], hints: string[], sourcePath: string): string {
  const moduleName = sourcePath.replace(/^.*\//, '').replace(/\.py$/, '');
  const args = params.join(', ');
  const hintLines = hints.map((h) => `    ${h}`).join('\n');

  return [
    `import pytest`,
    `from ${moduleName} import ${name}`,
    ``,
    ``,
    `def test_${name}_returns_expected():`,
    `    result = ${name}(${args})`,
    hintLines,
    ``,
    ``,
    `def test_${name}_edge_cases():`,
    `    # TODO: add edge case tests`,
    `    pass`,
    ``,
  ].join('\n');
}

function generateSmartGoTest(name: string, params: string[], callTargets: string[], hints: string[]): string {
  const hintLines = hints.map((h) => `    ${h}`).join('\n');

  return [
    `package main`,
    ``,
    `import "testing"`,
    ``,
    `func Test${capitalize(name)}(t *testing.T) {`,
    ...params.map((p) => `    ${p} := "" /* TODO: initialize */`),
    `    result := ${name}(${params.join(', ')})`,
    hintLines,
    `}`,
    ``,
  ].join('\n');
}

function generateSmartRustTest(name: string, params: string[], callTargets: string[], hints: string[]): string {
  const hintLines = hints.map((h) => `        ${h}`).join('\n');

  return [
    `#[cfg(test)]`,
    `mod tests {`,
    `    use super::*;`,
    ``,
    `    #[test]`,
    `    fn test_${name}() {`,
    ...params.map((p) => `        let ${p} = todo!();`),
    `        let result = ${name}(${params.join(', ')});`,
    hintLines,
    `    }`,
    `}`,
    ``,
  ].join('\n');
}

function generateTestFileName(sourcePath: string, lang: string): string {
  switch (lang) {
    case 'python': return `test_${sourcePath.split('/').pop()?.replace(/\.py$/, '') ?? 'module'}.py`;
    case 'go': return sourcePath.replace(/\.go$/, '_test.go');
    case 'rust': return sourcePath;
    default: return sourcePath.replace(/\.\w+$/, '.test.ts');
  }
}

function generateTestName(name: string, lang: string): string {
  switch (lang) {
    case 'python': return `test_${name}`;
    case 'go': return `Test${capitalize(name)}`;
    case 'rust': return `test_${name}`;
    default: return `test ${name}`;
  }
}

// ============= P2-3: Incremental Graph Update =============

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
      if (node.symbol?.signature !== prev.symbol?.signature || node.symbol?.name !== prev.symbol?.name) {
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
  };
}

export function applyIncrementalUpdate(
  graph: WorkspaceProjectGraphResult,
  update: IncrementalGraphUpdate,
): WorkspaceProjectGraphResult {
  const removedNodeSet = new Set(update.removedNodeIds);
  const removedEdgeSet = new Set(update.removedEdgeIds);

  const nodes = [
    ...graph.nodes.filter((n) => !removedNodeSet.has(n.id)),
    ...update.addedNodes,
  ];

  const changedNodeMap = new Map(update.changedNodes.map((n) => [n.id, n]));
  for (let i = 0; i < nodes.length; i++) {
    const updated = changedNodeMap.get(nodes[i].id);
    if (updated) {
      nodes[i] = updated;
    }
  }

  const edges = [
    ...graph.edges.filter((e) => !removedEdgeSet.has(e.id)),
    ...update.addedEdges,
  ];

  const uniqueEdges = edges.filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);

  return {
    ...graph,
    nodes,
    edges: uniqueEdges,
    summary: {
      ...graph.summary,
      files: graph.summary.files + update.summaryDelta.filesDelta,
      symbols: graph.summary.symbols + update.summaryDelta.symbolsDelta,
      imports: graph.summary.imports + update.summaryDelta.importsDelta,
      calls: graph.summary.calls + update.summaryDelta.callsDelta,
      edges: graph.summary.edges + update.summaryDelta.edgesDelta,
    },
  };
}
