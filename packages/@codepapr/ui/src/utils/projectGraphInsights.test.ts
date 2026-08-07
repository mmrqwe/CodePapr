import { describe, expect, it } from 'vitest';
import type {
  ProjectGraphEdge,
  ProjectGraphNode,
  WorkspaceProjectGraphResult,
} from '@codepapr/core';
import { computeProjectGraphInsights } from './projectGraphInsights';

function fileNode(path: string, extra?: Partial<ProjectGraphNode>): ProjectGraphNode {
  return {
    id: `file:${path}`,
    kind: 'file',
    label: path,
    path,
    fileType: 'source',
    ...extra,
  };
}

function symbolNode(
  path: string,
  name: string,
  extra?: Partial<ProjectGraphNode>,
): ProjectGraphNode {
  return {
    id: `symbol:${path}:${name}`,
    kind: 'symbol',
    label: name,
    path,
    symbol: { name, kind: 'function', line: 1, signature: '', exported: false },
    ...extra,
  };
}

function edge(
  kind: ProjectGraphEdge['kind'],
  from: string,
  to: string,
): ProjectGraphEdge {
  return { id: `${kind}:${from}->${to}`, kind, from, to };
}

function buildGraph(): WorkspaceProjectGraphResult {
  const nodes: ProjectGraphNode[] = [
    fileNode('src/index.ts', { entryPoint: true, entryPointScore: 10 }),
    fileNode('src/a.ts'),
    fileNode('src/b.ts'),
    fileNode('src/hub.ts'),
    fileNode('src/orphan.ts'),
    fileNode('tests/a.test.ts', { fileType: 'test' }),
    symbolNode('src/index.ts', 'main'),
    symbolNode('src/b.ts', 'unusedFn'),
    symbolNode('src/b.ts', 'usedFn'),
  ];

  const edges: ProjectGraphEdge[] = [
    edge('contains', 'file:src/index.ts', 'symbol:src/index.ts:main'),
    edge('contains', 'file:src/b.ts', 'symbol:src/b.ts:unusedFn'),
    edge('contains', 'file:src/b.ts', 'symbol:src/b.ts:usedFn'),
    edge('imports', 'file:src/index.ts', 'file:src/a.ts'),
    edge('imports', 'file:src/index.ts', 'file:src/hub.ts'),
    edge('imports', 'file:src/a.ts', 'file:src/b.ts'),
    edge('imports', 'file:src/a.ts', 'file:src/hub.ts'),
    edge('imports', 'file:src/b.ts', 'file:src/a.ts'),
    edge('imports', 'file:tests/a.test.ts', 'file:src/a.ts'),
    edge('tested_by', 'file:tests/a.test.ts', 'file:src/a.ts'),
    // main → usedFn：usedFn 有入边不是死代码；该调用边归并为 index→b 的文件级入度。
    edge('calls', 'symbol:src/index.ts:main', 'symbol:src/b.ts:usedFn'),
  ];

  return {
    root: '.',
    tree: '',
    files: [],
    nodes,
    edges,
    summary: {
      files: 6,
      testFiles: 1,
      configFiles: 0,
      docFiles: 0,
      symbols: 3,
      imports: 6,
      reexports: 0,
      extends: 0,
      implements: 0,
      calls: 1,
      testedBy: 1,
      configures: 0,
      lspSymbols: 0,
      entryPoints: 1,
      orphanNodes: 1,
      edges: edges.length,
      truncated: false,
    },
    truncated: false,
  };
}

describe('computeProjectGraphInsights', () => {
  it('检测循环依赖（a ↔ b）', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    expect(insights.circularDeps.total).toBe(1);
    const files = insights.circularDeps.cycles[0].files;
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
  });

  it('检测死代码：contains 归属边不算引用，usedFn 有调用入边不算', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    const names = insights.deadCode.unusedSymbols.map((s) => s.name);
    expect(names).toEqual(['unusedFn']);
  });

  it('枢纽按文件入度降序：a(3) 最高，b/hub(2) 按路径排序', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    expect(insights.hubs.map((h) => h.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/hub.ts']);
    expect(insights.hubs[0].inDegree).toBe(3);
    expect(insights.hubs[1].inDegree).toBe(2);
    expect(insights.hubs[2].inDegree).toBe(2);
  });

  it('孤儿文件：仅无度数且非入口的源码文件', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    expect(insights.orphans.map((n) => n.path)).toEqual(['src/orphan.ts']);
  });

  it('测试覆盖缺口：被 tested_by 覆盖的 a.ts 不在缺口列表', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    const gaps = insights.testGaps.map((n) => n.path);
    expect(gaps).not.toContain('src/a.ts');
    expect(gaps).toContain('src/b.ts');
    expect(gaps).toContain('src/hub.ts');
  });

  it('无测试文件时不报覆盖缺口', () => {
    const graph = buildGraph();
    graph.nodes = graph.nodes.filter((n) => n.fileType !== 'test');
    graph.edges = graph.edges.filter((e) => e.kind !== 'tested_by');
    graph.summary.testFiles = 0;
    const insights = computeProjectGraphInsights(graph);
    expect(insights.testGaps).toEqual([]);
  });

  it('入口点来自 entryPoint 标记', () => {
    const insights = computeProjectGraphInsights(buildGraph());
    expect(insights.entryPoints.entries.map((e) => e.path)).toEqual(['src/index.ts']);
  });
});
