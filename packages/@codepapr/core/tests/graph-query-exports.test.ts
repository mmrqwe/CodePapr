import { describe, expect, it } from 'vitest';
import * as barrel from '../src/tool/workspace/graphQuery';
import * as pkg from '../src';

// 拆分前 graphQuery.ts 对外暴露的 26 个查询函数。拆分后 barrel 必须原样保留，
// 既不能丢（消费方 import 会断），也不能多（避免把内部 helper 泄漏成公共 API）。
const PUBLIC_FUNCTIONS = [
  'analyzeWorkspaceChangeImpact',
  'applyIncrementalUpdate',
  'applyRenameEditsToContent',
  'buildTypeHierarchy',
  'buildWorkspaceDependencySubgraph',
  'checkArchitectureLayers',
  'computeIncrementalUpdate',
  'computeRenameEditsForContent',
  'computeSemanticDiff',
  'detectCircularDependencies',
  'detectDeadCode',
  'discoverAndMapTests',
  'findSymbolAtPosition',
  'findWorkspaceEntrypoints',
  'findWorkspaceSymbolImplementations',
  'generateSmartTestSkeletons',
  'generateTestSkeletons',
  'getWorkspaceSmartContext',
  'lookupWorkspaceSymbols',
  'planExtractMethod',
  'planInlineVariable',
  'planMoveSymbol',
  'planProjectGraphRename',
  'selectTestsByChangeImpact',
  'suggestInlineVariables',
  'suggestRefactorings',
] as const;

function exportedFunctions(module: unknown): string[] {
  const record = module as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => typeof record[key] === 'function')
    .sort();
}

describe('graphQuery barrel export surface', () => {
  it('exposes exactly the 26 public query functions (no loss, no leakage)', () => {
    expect(exportedFunctions(barrel)).toEqual([...PUBLIC_FUNCTIONS]);
  });

  it('re-exports every public function from the package index', () => {
    const record = pkg as Record<string, unknown>;
    for (const name of PUBLIC_FUNCTIONS) {
      expect(typeof record[name], `package index missing ${name}`).toBe('function');
    }
  });

  it('does not leak internal graph helpers through the barrel', () => {
    const record = barrel as Record<string, unknown>;
    const internals = [
      'buildEdgeMaps',
      'buildNodeMap',
      'clamp',
      'normalizeText',
      'toGraphSymbolMatch',
      'graphSymbolNodes',
      'isTypeSymbolKind',
      'isCallableSymbolKind',
      'isTestFile',
      'getExtension',
      'escapeRegExp',
      'extractParams',
      'countFunctionLines',
      'estimateNestingDepth',
    ];
    for (const name of internals) {
      expect(record[name], `barrel leaked internal ${name}`).toBeUndefined();
    }
  });
});
