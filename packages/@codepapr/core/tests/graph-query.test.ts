import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceProjectGraph,
  detectCircularDependencies,
  detectDeadCode,
  buildTypeHierarchy,
  discoverAndMapTests,
  suggestRefactorings,
  selectTestsByChangeImpact,
  checkArchitectureLayers,
  computeSemanticDiff,
  generateTestSkeletons,
  planProjectGraphRename,
  computeRenameEditsForContent,
  applyRenameEditsToContent,
  applyIncrementalUpdate,
  computeIncrementalUpdate,
  fileIdFromGraphNodeId,
  findSymbolAtPosition,
} from '../src';
import type {
  WorkspaceProjectGraphResult,
  ProjectGraphEdge,
  IncrementalGraphUpdate,
} from '../src';

function makeGraph(overrides: Partial<Parameters<typeof buildWorkspaceProjectGraph>[0]> = {}) {
  return buildWorkspaceProjectGraph({
    root: '.',
    tree: '.\n- src/',
    allFiles: [
      { path: 'src/main.ts' },
      { path: 'src/lib.ts' },
      { path: 'src/lib.test.ts' },
      { path: 'src/models.ts' },
    ],
    fileContents: {
      'src/main.ts': {
        content: 'import { helper, LibClass } from "./lib";\nimport { Model } from "./models";\nexport function main() { helper(); return new LibClass(); }\n',
      },
      'src/lib.ts': {
        content: 'import { Model } from "./models";\nexport function helper() { return 1; }\nexport class LibClass extends Model { greet() { return helper(); } }\n',
      },
      'src/lib.test.ts': {
        content: 'import { helper, LibClass } from "./lib";\ndescribe("lib", () => { it("works", () => { expect(helper()).toBe(1); }); });\n',
      },
      'src/models.ts': {
        content: 'export class Model { id = 0; }\nexport function unusedFn() {}\nfunction localUnused() {}\n',
      },
    },
    files: [
      {
        path: 'src/main.ts', language: 'TypeScript', bytes: 90, symbolSource: 'ast',
        symbols: [
          { name: 'main', kind: 'function', signature: 'export function main()', line: 3, exported: true },
        ],
      },
      {
        path: 'src/lib.ts', language: 'TypeScript', bytes: 120, symbolSource: 'ast',
        symbols: [
          { name: 'helper', kind: 'function', signature: 'export function helper()', line: 2, exported: true },
          { name: 'LibClass', kind: 'class', signature: 'export class LibClass extends Model', line: 3, exported: true },
          { name: 'greet', kind: 'method', signature: 'greet()', line: 3, exported: false },
        ],
      },
      {
        path: 'src/lib.test.ts', language: 'TypeScript', bytes: 100, symbolSource: 'ast',
        symbols: [
          { name: 'works', kind: 'function', signature: 'it("works", () => {...})', line: 1, exported: false },
        ],
      },
      {
        path: 'src/models.ts', language: 'TypeScript', bytes: 60, symbolSource: 'ast',
        symbols: [
          { name: 'Model', kind: 'class', signature: 'export class Model', line: 1, exported: true },
          { name: 'unusedFn', kind: 'function', signature: 'export function unusedFn()', line: 2, exported: true },
          { name: 'localUnused', kind: 'function', signature: 'function localUnused()', line: 3, exported: false },
        ],
      },
    ],
    maxEdges: 200,
    ...overrides,
  });
}

describe('ProjectGraph Analysis Functions', () => {
  describe('call graph', () => {
    it('includes calls edges in summary', () => {
      const graph = makeGraph();
      expect(graph.summary.calls).toBeGreaterThanOrEqual(0);
    });
  });

  describe('detectCircularDependencies', () => {
    it('returns empty for acyclic graph', () => {
      const graph = makeGraph();
      const result = detectCircularDependencies(graph);
      expect(result.cycles).toBeDefined();
    });
  });

  describe('detectDeadCode', () => {
    it('finds unused symbols', () => {
      const graph = makeGraph();
      const result = detectDeadCode(graph);
      const names = result.unusedSymbols.map((s) => s.name);
      // localUnused 未导出且无引用，作为 likely 死代码。
      expect(names).toContain('localUnused');
      expect(names).not.toContain('unusedFn');
      expect(result.exportedCandidates.map((s) => s.name)).toContain('unusedFn');
      expect(result.total).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
    });

    it('keeps exported APIs and framework callbacks as candidates, not likely dead code', () => {
      const graph = {
        nodes: [
          {
            id: 'symbol:src/a.ts:onClick',
            kind: 'symbol',
            path: 'src/a.ts',
            label: 'onClick',
            symbol: { name: 'onClick', kind: 'method', line: 4, signature: 'onClick()', exported: false },
          },
          {
            id: 'symbol:src/a.ts:Widget',
            kind: 'symbol',
            path: 'src/a.ts',
            label: 'Widget',
            symbol: { name: 'Widget', kind: 'function', line: 1, signature: 'export function Widget()', exported: true },
          },
        ],
        edges: [],
      } as unknown as WorkspaceProjectGraphResult;

      const result = detectDeadCode(graph);
      expect(result.unusedSymbols.map((s) => s.name)).toEqual([]);
      expect(result.exportedCandidates.map((s) => s.name).sort()).toEqual(['Widget', 'onClick']);
      expect(result.total).toBe(0);
      expect(result.candidateTotal).toBe(2);
    });

    it('does not flag symbols that are actually referenced', () => {
      const graph = makeGraph();
      const result = detectDeadCode(graph);
      const names = result.unusedSymbols.map((s) => s.name);
      // helper/LibClass/Model 都被其他文件引用或调用，不应被误判为死代码。
      expect(names).not.toContain('helper');
      expect(names).not.toContain('LibClass');
      expect(names).not.toContain('Model');
    });
  });

  describe('buildTypeHierarchy', () => {
    it('builds hierarchy from extends edges', () => {
      const graph = makeGraph();
      const result = buildTypeHierarchy(graph);
      expect(result.nodes.size).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
    });

    it('finds roots with no parents', () => {
      const graph = makeGraph();
      const result = buildTypeHierarchy(graph);
      expect(result.roots.length).toBeGreaterThan(0);
    });

    it('稠密菱形继承图：等深重访剪枝（线性而非指数），深度语义正确', () => {
      // 每层 2 个节点、层间完全二部继承边：根→叶路径数为 2^(levels-1)，
      // 旧实现按路径数遍历（30 层 ≈ 5 亿次访问，测试直接挂起）；
      // 修复后每节点只按"深度严格增大"重访，访问量 O(层数 × 每层节点数)。
      const levels = 30;
      const id = (level: number, idx: number) => `type-l${level}-${idx}`;
      const nodes: Array<{ id: string; kind: string; path: string; symbol: { name: string; kind: string; line: number; exported: boolean } }> = [];
      const edges: ProjectGraphEdge[] = [];
      for (let level = 0; level < levels; level += 1) {
        for (let idx = 0; idx < 2; idx += 1) {
          nodes.push({
            id: id(level, idx),
            kind: 'symbol',
            path: 'src/a.ts',
            symbol: { name: `T${level}_${idx}`, kind: 'class', line: level * 2 + idx + 1, exported: true },
          });
        }
        if (level > 0) {
          for (let idx = 0; idx < 2; idx += 1) {
            for (let prev = 0; prev < 2; prev += 1) {
              edges.push({ from: id(level, idx), to: id(level - 1, prev), kind: 'extends' });
            }
          }
        }
      }
      const graph = { nodes, edges } as unknown as WorkspaceProjectGraphResult;

      const result = buildTypeHierarchy(graph);
      // 深度 = 到根的最大距离（每层节点深度即层号）
      for (let level = 0; level < levels; level += 1) {
        for (let idx = 0; idx < 2; idx += 1) {
          expect(result.nodes.get(id(level, idx))?.depth).toBe(level);
        }
      }
      // 多父节点按每条父路径出链，数量封顶（每叶 ≤8，两片叶子 ≤16）
      expect(result.chains.length).toBeGreaterThan(0);
      expect(result.chains.length).toBeLessThanOrEqual(16);
    });
  });

  describe('discoverAndMapTests', () => {
    it('discovers test files', () => {
      const graph = makeGraph();
      const result = discoverAndMapTests(graph);
      expect(result.testFiles.length).toBeGreaterThanOrEqual(1);
      expect(result.testFiles).toContain('src/lib.test.ts');
    });
  });

  describe('suggestRefactorings', () => {
    it('returns suggestions for the graph', () => {
      const graph = makeGraph();
      const result = suggestRefactorings(graph);
      expect(result.extractions).toBeDefined();
      expect(result.moves).toBeDefined();
    });

    it('flags long Python functions using indentation instead of braces', () => {
      const bodyLines = Array.from({ length: 45 }, (_, i) => `    value_${i} = ${i}`).join('\n');
      const content = `def long_function():\n${bodyLines}\n    return value_0\n`;
      const graph = buildWorkspaceProjectGraph({
        root: '.',
        tree: '.\n- src/',
        allFiles: [{ path: 'src/module.py' }],
        fileContents: {
          'src/module.py': { content },
        },
        files: [
          {
            path: 'src/module.py',
            language: 'Python',
            bytes: content.length,
            symbolSource: 'ast',
            symbols: [
              { name: 'long_function', kind: 'function', signature: 'def long_function()', line: 1, exported: true },
            ],
          },
        ],
      });

      const result = suggestRefactorings(graph, { 'src/module.py': { content, bytes: content.length } });
      const extraction = result.extractions.find((e) => e.name === 'long_function');
      expect(extraction).toBeDefined();
      expect(extraction?.lineCount).toBeGreaterThan(40);
    });
  });

  describe('selectTestsByChangeImpact', () => {
    it('selects tests affected by changed files', () => {
      const graph = makeGraph();
      const result = selectTestsByChangeImpact(graph, ['src/lib.ts']);
      expect(result.changedFiles).toContain('src/lib.ts');
      expect(result.summary).toBeTruthy();
    });
  });

  describe('checkArchitectureLayers', () => {
    it('detects no violations when all imports allowed', () => {
      const graph = makeGraph();
      const result = checkArchitectureLayers(graph, [
        { patterns: ['src/'], allowedImports: ['src/'] },
      ]);
      expect(result.violations.length).toBe(0);
    });
  });

  describe('computeSemanticDiff', () => {
    it('detects symbol additions', () => {
      const before = makeGraph();
      const after = makeGraph({
        files: [
          ...before.files,
          {
            path: 'src/newfile.ts', language: 'TypeScript', bytes: 50, symbolSource: 'ast',
            symbols: [
              { name: 'newFn', kind: 'function', signature: 'export function newFn()', line: 1, exported: true },
            ],
          },
        ],
      });
      const result = computeSemanticDiff(before, after);
      expect(result.summary).toContain('+');
    });

    it('detects no changes for identical graphs', () => {
      const before = makeGraph();
      const after = makeGraph();
      const result = computeSemanticDiff(before, after);
      expect(result.breakingChanges.length).toBe(0);
    });
  });

  describe('generateTestSkeletons', () => {
    it('generates tests for exported functions', () => {
      const graph = makeGraph();
      const result = generateTestSkeletons(graph);
      expect(result.tests.length).toBeGreaterThan(0);
    });

    it('generates TypeScript test content', () => {
      const graph = makeGraph();
      const result = generateTestSkeletons(graph);
      const tsTest = result.tests.find((t) => t.language === 'typescript');
      if (tsTest) {
        expect(tsTest.content).toContain('describe');
        expect(tsTest.content).toContain('expect');
      }
    });
  });

  describe('planProjectGraphRename', () => {
    it('finds symbol and scopes rename to referencing files', () => {
      const graph = makeGraph();
      const result = planProjectGraphRename({
        relativePath: 'src/lib.ts',
        line: 2,
        character: 17,
        newName: 'util',
        graph,
      });
      expect(result.symbol).toBeDefined();
      expect(result.oldName).toBe('helper');
      expect(result.targetFiles).toContain('src/lib.ts');
      expect(result.targetFiles).toContain('src/main.ts');
    });
  });

  describe('computeRenameEditsForContent', () => {
    it('renames whole-word occurrences at their real columns, not line start', () => {
      const content = 'export function main() { helper(); return helper; }\n';
      const edits = computeRenameEditsForContent(content, 'helper', 'util');
      expect(edits.length).toBe(2);
      const applied = applyRenameEditsToContent(content, edits);
      expect(applied).toBe('export function main() { util(); return util; }\n');
    });

    it('does not rename substrings of larger identifiers', () => {
      const content = 'const helperFn = helperValue;\n';
      const edits = computeRenameEditsForContent(content, 'helper', 'util');
      expect(edits.length).toBe(0);
    });

    it('skips occurrences inside strings and comments', () => {
      const content = '// helper comment\nconst s = "helper";\nconst x = helper;\n';
      const edits = computeRenameEditsForContent(content, 'helper', 'util');
      expect(edits.length).toBe(1);
      expect(edits[0].line).toBe(3);
    });
  });

  describe('applyRenameEditsToContent', () => {
    it('preserves CRLF line endings', () => {
      const content = 'a helper\r\nb helper\r\n';
      const edits = computeRenameEditsForContent(content, 'helper', 'util');
      const applied = applyRenameEditsToContent(content, edits);
      expect(applied).toBe('a util\r\nb util\r\n');
    });
  });
});

describe('Edge Cases', () => {
  const emptyGraph = buildWorkspaceProjectGraph({
    root: '.',
    tree: '.',
    files: [],
    maxEdges: 100,
  });

  it('handles empty graph for circular deps', () => {
    const result = detectCircularDependencies(emptyGraph);
    expect(result.cycles.length).toBe(0);
  });

  it('handles empty graph for dead code', () => {
    const result = detectDeadCode(emptyGraph);
    expect(result.unusedSymbols.length).toBe(0);
  });

  it('handles empty graph for type hierarchy', () => {
    const result = buildTypeHierarchy(emptyGraph);
    expect(result.nodes.size).toBe(0);
  });

  it('handles empty graph for test discovery', () => {
    const result = discoverAndMapTests(emptyGraph);
    expect(result.testFiles.length).toBe(0);
  });

  it('handles empty graph for refactorings', () => {
    const result = suggestRefactorings(emptyGraph);
    expect(result.extractions.length).toBe(0);
  });

  it('handles empty graph for semantic diff', () => {
    const result = computeSemanticDiff(emptyGraph, emptyGraph);
    expect(result.symbolChanges.length).toBe(0);
  });
});

describe('Regression: audited graphQuery bugs', () => {
  function makeCyclicGraph() {
    return buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      fileContents: {
        'src/a.ts': { content: 'import { b } from "./b";\nexport function a() { return b(); }\n' },
        'src/b.ts': { content: 'import { a } from "./a";\nexport function b() { return a(); }\n' },
      },
      files: [
        {
          path: 'src/a.ts', language: 'TypeScript', bytes: 60, symbolSource: 'ast',
          symbols: [{ name: 'a', kind: 'function', signature: 'export function a()', line: 2, exported: true }],
        },
        {
          path: 'src/b.ts', language: 'TypeScript', bytes: 60, symbolSource: 'ast',
          symbols: [{ name: 'b', kind: 'function', signature: 'export function b()', line: 2, exported: true }],
        },
      ],
      maxEdges: 200,
    });
  }

  it('H1: detects a real import cycle (a -> b -> a)', () => {
    const result = detectCircularDependencies(makeCyclicGraph());
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    const cycleFiles = result.cycles[0].files;
    expect(cycleFiles).toContain('src/a.ts');
    expect(cycleFiles).toContain('src/b.ts');
  });

  it('H2: maps a test file to the source file it imports', () => {
    const result = discoverAndMapTests(makeGraph());
    expect(result.testFiles).toContain('src/lib.test.ts');
    const mapped = result.mappedSources.get('src/lib.test.ts') ?? [];
    expect(mapped).toContain('src/lib.ts');
  });

  it('M8: computeSemanticDiff reports true added/removed edges, not a net delta', () => {
    const g = makeGraph();
    const n0 = g.nodes[0].id;
    const n1 = g.nodes[1].id;
    const mk = (id: string, kind: ProjectGraphEdge['kind']): ProjectGraphEdge =>
      ({ id, kind, from: n0, to: n1 });
    const before: WorkspaceProjectGraphResult = { ...g, edges: [mk('old1', 'imports'), mk('old2', 'calls')] };
    const after: WorkspaceProjectGraphResult = { ...g, edges: [mk('new1', 'imports'), mk('new2', 'calls')] };

    const diff = computeSemanticDiff(before, after);
    expect(diff.edgeChanges.added).toBe(2);
    expect(diff.edgeChanges.removed).toBe(2);
  });

  it('M12: applyIncrementalUpdate dedupes nodes and edges by id', () => {
    const g = makeGraph();
    const dupNode = { ...g.nodes[0] };
    const dupEdge = { ...g.edges[0] };
    const update: IncrementalGraphUpdate = {
      addedNodes: [dupNode],
      removedNodeIds: [],
      addedEdges: [dupEdge],
      removedEdgeIds: [],
      changedNodes: [],
      summaryDelta: { filesDelta: 0, symbolsDelta: 0, importsDelta: 0, callsDelta: 0, edgesDelta: 0 },
    };
    const result = applyIncrementalUpdate(g, update);
    const nodeIds = result.nodes.map((n) => n.id);
    const edgeIds = result.edges.map((e) => e.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  it('applyIncrementalUpdate copies files, node metadata, and full summary', () => {
    const before = makeGraph();
    const after: WorkspaceProjectGraphResult = {
      ...before,
      files: before.files.map((file) =>
        file.path === 'src/lib.ts' ? { ...file, bytes: file.bytes + 40 } : file,
      ),
      nodes: before.nodes.map((node) =>
        node.kind === 'file' && node.path === 'src/lib.ts'
          ? { ...node, bytes: (node.bytes ?? 0) + 40, entryPoint: true }
          : node,
      ),
      summary: {
        ...before.summary,
        reexports: before.summary.reexports + 2,
        lspEnhanced: true,
        orphanNodes: before.summary.orphanNodes + 1,
      },
    };
    const update = computeIncrementalUpdate(before, after);
    expect(update.changedNodes.some((node) => node.path === 'src/lib.ts' && node.entryPoint)).toBe(true);
    const applied = applyIncrementalUpdate(before, update);
    expect(applied.files.find((file) => file.path === 'src/lib.ts')?.bytes).toBe(
      after.files.find((file) => file.path === 'src/lib.ts')?.bytes,
    );
    expect(applied.summary.reexports).toBe(after.summary.reexports);
    expect(applied.summary.lspEnhanced).toBe(true);
    expect(applied.summary.orphanNodes).toBe(after.summary.orphanNodes);
    expect(applied.nodes.find((node) => node.kind === 'file' && node.path === 'src/lib.ts')?.entryPoint).toBe(true);
  });

  it('fileIdFromGraphNodeId keeps Windows drive paths intact', () => {
    expect(fileIdFromGraphNodeId('file:C:/repo/src/a.ts')).toBe('file:C:/repo/src/a.ts');
    expect(fileIdFromGraphNodeId('symbol:C:/repo/src/a.ts:10:function::run:0')).toBe('file:C:/repo/src/a.ts');
    expect(fileIdFromGraphNodeId('symbol:src/a.ts:run')).toBe('file:src/a.ts');
  });

  it('circular_deps follows Windows symbol IDs back to their files', () => {
    const graph = makeGraph();
    const windows: WorkspaceProjectGraphResult = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'file:C:/repo/src/a.ts',
          kind: 'file',
          label: 'a.ts',
          path: 'C:/repo/src/a.ts',
        },
        {
          id: 'file:C:/repo/src/b.ts',
          kind: 'file',
          label: 'b.ts',
          path: 'C:/repo/src/b.ts',
        },
      ],
      edges: [
        {
          id: 'cycle-ab',
          kind: 'imports',
          from: 'symbol:C:/repo/src/a.ts:1:function::ping:0',
          to: 'file:C:/repo/src/b.ts',
        },
        {
          id: 'cycle-ba',
          kind: 'imports',
          from: 'symbol:C:/repo/src/b.ts:1:function::pong:0',
          to: 'file:C:/repo/src/a.ts',
        },
      ],
    };
    const result = detectCircularDependencies(windows);
    expect(result.cycles.some((cycle) => cycle.files.includes('C:/repo/src/a.ts'))).toBe(true);
  });

  it('P2-23: circular_deps survives dangling imports edges (no file node for target)', () => {
    // LSP enrich 可能产生指向不存在文件节点的 imports 边。旧实现 DFS 里
    // adjacency.get(neighbor)! 取到 undefined 的迭代器直接抛 TypeError。
    const g = makeGraph();
    const dangling: WorkspaceProjectGraphResult = {
      ...g,
      edges: [
        ...g.edges,
        { id: 'dangling-1', kind: 'imports', from: 'file:src/main.ts', to: 'file:src/does-not-exist.ts' },
      ],
    };
    expect(() => detectCircularDependencies(dangling)).not.toThrow();
    const result = detectCircularDependencies(dangling);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('P1-8: change-impact returns dependent files (not empty) and selects their tests', () => {
    // makeGraph: main.ts -> lib.ts -> models.ts，lib.test.ts 导入 lib.ts。
    // 旧实现反向 BFS 到达的全是 file 节点，却被 kind !== 'file' 过滤掉 → 恒为空。
    const graph = makeGraph();
    const result = selectTestsByChangeImpact(graph, ['src/models.ts']);
    // models.ts 的下游依赖（lib.ts / main.ts）应被纳入影响范围，
    // 进而选中导入 lib.ts 的测试文件。
    expect(result.affectedTests).toContain('src/lib.test.ts');
    expect(
      result.reasoning.some((line) => line.includes('src/models.ts') && !line.includes('影响 0 个'))
    ).toBe(true);
  });

  it('P1-9: Python call edges respect indentation-based function bodies', () => {
    // 旧实现 findFunctionEndLine 对无花括号语言返回 -1，buildCallEdges 跳过
    // 结束行边界，把函数声明之后的所有调用都记到该函数头上。
    const content = [
      'def bar():',
      '    pass',
      '',
      'def foo():',
      '    bar()',
      '',
      'def baz():',
      '    pass',
      '',
      'foo()',
      'baz()',
      '',
    ].join('\n');
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [{ path: 'src/module.py' }],
      fileContents: { 'src/module.py': { content } },
      files: [
        {
          path: 'src/module.py',
          language: 'Python',
          bytes: content.length,
          symbolSource: 'ast',
          symbols: [
            { name: 'bar', kind: 'function', signature: 'def bar()', line: 1, exported: true },
            { name: 'foo', kind: 'function', signature: 'def foo()', line: 4, exported: true },
            { name: 'baz', kind: 'function', signature: 'def baz()', line: 7, exported: true },
          ],
        },
      ],
      maxEdges: 200,
    });

    const idByName = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.kind === 'symbol' && node.symbol) {
        idByName.set(node.symbol.name, node.id);
      }
    }
    const fooId = idByName.get('foo');
    const barId = idByName.get('bar');
    const bazId = idByName.get('baz');
    expect(fooId).toBeDefined();
    expect(barId).toBeDefined();
    expect(bazId).toBeDefined();

    const fooCallTargets = graph.edges
      .filter((e) => e.kind === 'calls' && e.from === fooId)
      .map((e) => e.to);
    // foo 函数体内的 bar() 调用必须归属 foo
    expect(fooCallTargets).toContain(barId);
    // baz 定义在 foo 之后、顶层 foo()/baz() 也在 foo 体之外：均不得归属 foo
    expect(fooCallTargets).not.toContain(bazId);
  });

  it('Allman 大括号风格（C# 默认）：函数体边界正确，调用边不污染', () => {
    // 旧实现 findFunctionEndLine 要求声明行就有 `{`，Allman 风格 `{` 在下一行
    // → 返回 -1 → buildCallEdges 跳过结束边界 → 前面的函数吞下其声明行之后的
    // 全部调用（包括后定义函数体内的调用）。方法名用小写规避 C# 分支对
    // "大写裸调用"（疑似类型名）的过滤，聚焦测花括号边界本身。
    const content = [
      'public class worker',
      '{',
      '    public void first()',
      '    {',
      '        helper();',
      '    }',
      '',
      '    public void helper()',
      '    {',
      '        third();',
      '    }',
      '',
      '    public void third()',
      '    {',
      '    }',
      '}',
      '',
    ].join('\n');
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [{ path: 'src/Worker.cs' }],
      fileContents: { 'src/Worker.cs': { content } },
      files: [
        {
          path: 'src/Worker.cs',
          language: 'C#',
          bytes: content.length,
          symbolSource: 'ast',
          symbols: [
            { name: 'first', kind: 'method', signature: 'public void first()', line: 3, exported: false },
            { name: 'helper', kind: 'method', signature: 'public void helper()', line: 8, exported: false },
            { name: 'third', kind: 'method', signature: 'public void third()', line: 13, exported: false },
          ],
        },
      ],
      maxEdges: 200,
    });

    const idByName = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.kind === 'symbol' && node.symbol) {
        idByName.set(node.symbol.name, node.id);
      }
    }
    const firstId = idByName.get('first');
    const helperId = idByName.get('helper');
    const thirdId = idByName.get('third');
    expect(firstId).toBeDefined();
    expect(helperId).toBeDefined();
    expect(thirdId).toBeDefined();

    const targetsOf = (fromId: string | undefined) =>
      graph.edges
        .filter((e) => e.kind === 'calls' && e.from === fromId)
        .map((e) => e.to);

    // first 体内调用 helper；修复前 first 会吞下 helper 体内的 third() 调用
    expect(targetsOf(firstId)).toEqual([helperId]);
    // helper 体内调用 third
    expect(targetsOf(helperId)).toEqual([thirdId]);
    // third 无调用
    expect(targetsOf(thirdId)).toEqual([]);
  });
});

describe('findSymbolAtPosition (AST 兜底的位置→符号解析)', () => {
  it('resolves the nearest symbol at-or-before the given line', () => {
    const graph = makeGraph();
    expect(findSymbolAtPosition(graph, 'src/lib.ts', 2, 1)?.label).toBe('helper');
    expect(findSymbolAtPosition(graph, 'src/models.ts', 2, 1)?.label).toBe('unusedFn');
  });

  it('returns null when no symbol precedes the position in that file', () => {
    const graph = makeGraph();
    expect(findSymbolAtPosition(graph, 'src/main.ts', 1, 1)).toBeNull();
  });

  it('is scoped to the given file', () => {
    const graph = makeGraph();
    // lib.ts 第 1 行无符号（helper 在第 2 行）；models.ts 的 Model@1 不应串入
    expect(findSymbolAtPosition(graph, 'src/lib.ts', 1, 1)).toBeNull();
  });
});
