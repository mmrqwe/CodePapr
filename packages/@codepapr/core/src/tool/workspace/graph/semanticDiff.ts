import type { WorkspaceProjectGraphResult } from '../../projectGraph';

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
  const beforeExported = new Set(
    before.nodes.filter((n) => n.kind === 'symbol' && n.symbol?.exported).map((n) => n.id),
  );

  for (const [id, beforeSym] of beforeSymbols) {
    const afterSym = afterSymbols.get(id);
    if (!afterSym) {
      const change: SemanticSymbolChange = {
        kind: 'removed',
        symbol: beforeSym,
      };
      changes.push(change);
      if (beforeExported.has(id)) {
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
      if (beforeExported.has(id)) {
        breakingChanges.push(change);
      }
    }
  }

  for (const [id, afterSym] of afterSymbols) {
    if (!beforeSymbols.has(id)) {
      changes.push({ kind: 'added', symbol: afterSym });
    }
  }

  const beforeEdgeIds = new Set(before.edges.map((e) => e.id));
  const afterEdgeIds = new Set(after.edges.map((e) => e.id));
  let edgeAdded = 0;
  let edgeRemoved = 0;
  for (const id of afterEdgeIds) {
    if (!beforeEdgeIds.has(id)) edgeAdded++;
  }
  for (const id of beforeEdgeIds) {
    if (!afterEdgeIds.has(id)) edgeRemoved++;
  }
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
