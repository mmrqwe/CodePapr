import type { ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';
import { clamp } from './graphUtils';
import type { WorkspaceGraphSymbolMatch } from './graphSymbols';
import {
  buildWorkspaceDependencySubgraph,
  type WorkspaceDependencySubgraphResult,
} from './dependency';
import { lookupWorkspaceSymbols } from './symbolLookup';

export interface WorkspaceEntrypointCandidate {
  nodeId: string;
  kind: ProjectGraphNode['kind'];
  path: string;
  label: string;
  score: number;
  language?: string;
  qualifiedName?: string;
  heuristic: true;
}

export interface WorkspaceEntrypointsResult {
  entries: WorkspaceEntrypointCandidate[];
  total: number;
  truncated: boolean;
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
      heuristic: true as const,
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  return {
    entries: ranked.slice(0, maxEntries),
    total: ranked.length,
    truncated: ranked.length > maxEntries,
  };
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
    ...(dependencySubgraph ? { dependencySubgraph } : {}),
  };
}
