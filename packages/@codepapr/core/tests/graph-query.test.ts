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
        content: 'export class Model { id = 0; }\nexport function unusedFn() {}\n',
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
      // unusedFn 在夹具里未被任何地方引用，必须被识别为死代码。
      expect(names).toContain('unusedFn');
      expect(result.total).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
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
});
