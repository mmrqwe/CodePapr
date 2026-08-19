import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceProjectGraph, enrichProjectGraphEdges, type LspProjectGraphEnhancer } from '../src';

describe('buildWorkspaceProjectGraph', () => {
  it('builds file, symbol, contains, and import edges', () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [
        { path: 'src/main.ts' },
        { path: 'src/feature.ts' },
      ],
      fileContents: {
        'src/main.ts': {
          content: 'import { feature } from "./feature";\nexport function main() { return feature; }\n',
        },
        'src/feature.ts': {
          content: 'export const feature = 1;\n',
        },
      },
      files: [
        {
          path: 'src/main.ts',
          language: 'TypeScript',
          bytes: 78,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'main',
              kind: 'function',
              signature: 'export function main()',
              line: 2,
              exported: true,
            },
          ],
        },
        {
          path: 'src/feature.ts',
          language: 'TypeScript',
          bytes: 26,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'feature',
              kind: 'variable',
              signature: 'export const feature = 1',
              line: 1,
              exported: true,
            },
          ],
        },
      ],
    });

    // imports=2：文件级 main.ts->feature.ts 一条，加上具名绑定 `feature` 解析到
    // 具体符号后额外补的一条文件->符号边（用于让 dead_code 等分析能感知到该符号被引用）。
    // edges 总数不变：新增 1 条符号级 imports 边，同时消除了 `main` 声明行把自己
    // 误判为"调用自身"的假 calls 自环边，两者相抵。
    expect(graph.summary).toMatchObject({
      files: 2,
      symbols: 2,
      imports: 2,
      edges: 4,
      truncated: false,
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'file:src/main.ts', kind: 'file' }),
        expect.objectContaining({ kind: 'symbol', label: 'main', symbolSource: 'ast' }),
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'contains',
          from: 'file:src/main.ts',
        }),
        expect.objectContaining({
          kind: 'imports',
          from: 'file:src/main.ts',
          to: 'file:src/feature.ts',
          label: './feature',
        }),
      ])
    );
  });

  it('adds re-export, inheritance, implementation, disambiguation, and entrypoint metadata', () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [
        { path: 'src/main.ts' },
        { path: 'src/base.ts' },
        { path: 'src/contracts.ts' },
        { path: 'src/reexports.ts' },
        { path: 'src/feature/task.ts' },
      ],
      fileContents: {
        'src/main.ts': {
          content: [
            'import { BaseTask } from "./base";',
            'import { Runner } from "./contracts";',
            'export class Task extends BaseTask implements Runner {}',
            'export function main() { return new Task(); }',
          ].join('\n'),
        },
        'src/base.ts': {
          content: 'export class BaseTask {}\nexport class Task {}\n',
        },
        'src/contracts.ts': {
          content: 'export interface Runner {}\n',
        },
        'src/reexports.ts': {
          content: 'export { Task } from "./main";\n',
        },
        'src/feature/task.ts': {
          content: 'export class Task {}\n',
        },
      },
      files: [
        {
          path: 'src/main.ts',
          language: 'TypeScript',
          bytes: 180,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'Task',
              kind: 'class',
              signature: 'export class Task extends BaseTask implements Runner',
              line: 3,
              exported: true,
            },
            {
              name: 'main',
              kind: 'function',
              signature: 'export function main()',
              line: 4,
              exported: true,
            },
          ],
        },
        {
          path: 'src/base.ts',
          language: 'TypeScript',
          bytes: 64,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'BaseTask',
              kind: 'class',
              signature: 'export class BaseTask',
              line: 1,
              exported: true,
            },
            {
              name: 'Task',
              kind: 'class',
              signature: 'export class Task',
              line: 2,
              exported: true,
            },
          ],
        },
        {
          path: 'src/contracts.ts',
          language: 'TypeScript',
          bytes: 32,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'Runner',
              kind: 'interface',
              signature: 'export interface Runner',
              line: 1,
              exported: true,
            },
          ],
        },
        {
          path: 'src/reexports.ts',
          language: 'TypeScript',
          bytes: 40,
          symbolSource: 'ast',
          symbols: [],
        },
        {
          path: 'src/feature/task.ts',
          language: 'TypeScript',
          bytes: 30,
          symbolSource: 'ast',
          symbols: [
            {
              name: 'Task',
              kind: 'class',
              signature: 'export class Task',
              line: 1,
              exported: true,
            },
          ],
        },
      ],
    });

    // imports=4：BaseTask/Runner 各有一条文件级边 + 一条解析到具体符号的边。
    expect(graph.summary).toMatchObject({
      files: 5,
      imports: 4,
      reexports: 1,
      extends: 1,
      implements: 1,
      entryPoints: 1,
    });
    expect(graph.files[0]).toMatchObject({
      path: 'src/main.ts',
      entryPoint: true,
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'reexports', from: 'file:src/reexports.ts', to: 'file:src/main.ts' }),
        expect.objectContaining({ kind: 'extends', label: 'BaseTask' }),
        expect.objectContaining({ kind: 'implements', label: 'Runner' }),
      ])
    );
    expect(
      graph.nodes.filter((node) => node.kind === 'symbol' && node.symbol?.name === 'Task').map((node) => node.label)
    ).toEqual(
      expect.arrayContaining([
        'Task · src/main.ts:L3',
        'Task · src/base.ts:L2',
        'Task · src/feature/task.ts:L1',
      ])
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'symbol',
        path: 'src/main.ts',
        label: 'main',
        entryPoint: true,
      })
    );
  });

  it('does not treat a library file with many exports as an entry point', () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      files: [
        {
          path: 'src/utils.ts',
          language: 'TypeScript',
          bytes: 200,
          symbolSource: 'ast',
          symbols: [
            { name: 'formatDate', kind: 'function', signature: 'export function formatDate()', line: 1, exported: true },
            { name: 'parseDate', kind: 'function', signature: 'export function parseDate()', line: 2, exported: true },
            { name: 'clamp', kind: 'function', signature: 'export function clamp()', line: 3, exported: true },
          ],
        },
      ],
      fileContents: {
        'src/utils.ts': {
          content: 'export function formatDate() {}\nexport function parseDate() {}\nexport function clamp() {}\n',
        },
      },
    });

    expect(graph.files[0]?.entryPoint).toBeFalsy();
    expect(graph.nodes.filter((node) => node.kind === 'file' && node.entryPoint)).toEqual([]);
  });

  it('preserves LSP symbol provenance for semantic graph consumers', () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.',
      files: [
        {
          path: 'src/Program.cs',
          language: 'C#',
          bytes: 100,
          symbolSource: 'lsp',
          symbols: [
            {
              name: 'Main',
              kind: 'method',
              signature: 'Program.Main(string[] args)',
              line: 4,
              containerName: 'Program',
              exported: false,
            },
          ],
        },
      ],
    });

    expect(graph.summary.lspSymbols).toBe(1);
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'symbol',
        label: 'Program.Main',
        symbolSource: 'lsp',
      })
    );
  });

  it('groups LSP enhancement by file and enhances all symbols by default', async () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      fileContents: {
        'src/a.ts': { content: 'export function alpha() {}\nexport function beta() {}\n' },
        'src/b.ts': { content: 'export function gamma() {}\n' },
      },
      files: [
        {
          path: 'src/a.ts',
          language: 'TypeScript',
          bytes: 60,
          symbolSource: 'lsp',
          symbols: [
            { name: 'alpha', kind: 'function', signature: 'alpha()', line: 1, exported: true },
            { name: 'beta', kind: 'function', signature: 'beta()', line: 2, exported: true },
          ],
        },
        {
          path: 'src/b.ts',
          language: 'TypeScript',
          bytes: 30,
          symbolSource: 'lsp',
          symbols: [
            { name: 'gamma', kind: 'function', signature: 'gamma()', line: 1, exported: true },
          ],
        },
      ],
    });

    const enhanceReferences = vi.fn(async () => []);
    const enhanceInheritance = vi.fn(async () => []);
    const enhancer: LspProjectGraphEnhancer = { enhanceReferences, enhanceInheritance };

    await enrichProjectGraphEdges(graph, enhancer, {
      'src/a.ts': { content: 'x', bytes: 1 },
      'src/b.ts': { content: 'y', bytes: 1 },
    });

    // 按文件分组：enhanceReferences 每个文件只调一次，且一次带上该文件全部符号。
    expect(enhanceReferences).toHaveBeenCalledTimes(2);
    expect(enhanceReferences).toHaveBeenCalledWith(
      'src/a.ts',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ name: 'alpha', line: 1 }),
        expect.objectContaining({ name: 'beta', line: 2 }),
      ])
    );
    expect(enhanceReferences).toHaveBeenCalledWith(
      'src/b.ts',
      expect.any(String),
      expect.arrayContaining([expect.objectContaining({ name: 'gamma', line: 1 })])
    );
    // 无 maxSymbols 上限时全部符号都被增强，无一遗漏。
    const symbolsSentToA = enhanceReferences.mock.calls.find(([path]) => path === 'src/a.ts')?.[2];
    expect(symbolsSentToA).toHaveLength(2);

    // references 是使用点：定义在 a.ts，引用在 b.ts → imports 边必须是 b → a。
    enhanceReferences.mockResolvedValue([
      { filePath: 'src/b.ts', line: 1, character: 0, fromSymbol: 'alpha', toSymbol: 'alpha' },
    ]);
    const enriched = await enrichProjectGraphEdges(graph, enhancer, {
      'src/a.ts': { content: 'x', bytes: 1 },
      'src/b.ts': { content: 'y', bytes: 1 },
    });
    expect(enriched.edges).toContainEqual(
      expect.objectContaining({ kind: 'imports', from: 'file:src/b.ts', to: 'file:src/a.ts' })
    );
    expect(enriched.edges).not.toContainEqual(
      expect.objectContaining({ kind: 'imports', from: 'file:src/a.ts', to: 'file:src/b.ts' })
    );
  });

  it('honors an explicit maxSymbols cap in enhancement order (entry point score first)', async () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.',
      fileContents: {
        'src/a.ts': { content: 'export function alpha() {}\nexport function beta() {}\n' },
      },
      files: [
        {
          path: 'src/a.ts',
          language: 'TypeScript',
          bytes: 60,
          symbolSource: 'lsp',
          symbols: [
            { name: 'alpha', kind: 'function', signature: 'alpha()', line: 1, exported: true },
            { name: 'beta', kind: 'function', signature: 'beta()', line: 2, exported: true },
          ],
        },
      ],
    });

    const enhanceReferences = vi.fn(async () => []);
    const enhancer: LspProjectGraphEnhancer = {
      enhanceReferences,
      enhanceInheritance: vi.fn(async () => []),
    };

    await enrichProjectGraphEdges(graph, enhancer, { 'src/a.ts': { content: 'x', bytes: 1 } }, 1, 1);

    expect(enhanceReferences).toHaveBeenCalledTimes(1);
    expect(enhanceReferences.mock.calls[0]?.[2]).toHaveLength(1);
  });

  it('does not manufacture a cycle against an existing AST import edge', async () => {
    const graph = buildWorkspaceProjectGraph({
      root: '.',
      tree: '.',
      allFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      fileContents: {
        'src/a.ts': { content: 'export function alpha() {}\n' },
        'src/b.ts': { content: "import { alpha } from './a';\nalpha();\n" },
      },
      files: [
        {
          path: 'src/a.ts',
          language: 'TypeScript',
          bytes: 30,
          symbolSource: 'lsp',
          symbols: [{ name: 'alpha', kind: 'function', signature: 'alpha()', line: 1, exported: true }],
        },
        {
          path: 'src/b.ts',
          language: 'TypeScript',
          bytes: 40,
          symbolSource: 'lsp',
          symbols: [],
        },
      ],
    });

    expect(graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'imports', from: 'file:src/b.ts', to: 'file:src/a.ts' }),
    );

    const enhancer: LspProjectGraphEnhancer = {
      enhanceReferences: async (path) =>
        path === 'src/a.ts'
          ? [{ filePath: 'src/b.ts', line: 2, character: 0, fromSymbol: 'alpha', toSymbol: 'alpha' }]
          : [],
      enhanceInheritance: async () => [],
    };

    const enriched = await enrichProjectGraphEdges(graph, enhancer, {
      'src/a.ts': { content: 'export function alpha() {}\n', bytes: 30 },
      'src/b.ts': { content: "import { alpha } from './a';\nalpha();\n", bytes: 40 },
    });

    expect(enriched.edges).not.toContainEqual(
      expect.objectContaining({ kind: 'imports', from: 'file:src/a.ts', to: 'file:src/b.ts' }),
    );
  });
});
