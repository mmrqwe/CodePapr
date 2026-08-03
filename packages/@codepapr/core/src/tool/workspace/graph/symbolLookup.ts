import type { ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';
import { clamp } from './graphUtils';
import { graphSymbolNodes, normalizeText, toGraphSymbolMatch, type WorkspaceGraphSymbolMatch } from './graphSymbols';

export type { WorkspaceGraphSymbolMatch };

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
      if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
      }
      return (left.symbol?.line ?? 0) - (right.symbol?.line ?? 0);
    });

  return {
    matches: matches.slice(0, limit).map(toGraphSymbolMatch),
    total: matches.length,
    truncated: matches.length > limit,
  };
}
