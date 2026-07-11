import { describe, expect, it } from 'vitest';
import {
  applySearchReplaceDiff,
  applySearchReplacePatch,
  buildGitDiffSummary,
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMap,
  extractProjectMapSymbols,
  parseGitRepositoryRootCommandResult,
  parseGitStatusCommandResult,
  selectProjectMapFiles,
} from './workspaceToolUtils';

describe('applySearchReplacePatch', () => {
  it('replaces a single exact block', () => {
    expect(
      applySearchReplacePatch('const value = 1;\n', {
        search: 'const value = 1;',
        replace: 'const value = 2;',
      })
    ).toEqual({
      content: 'const value = 2;\n',
      replacements: 1,
    });
  });

  it('rejects ambiguous multi-match replacements without replaceAll', () => {
    expect(() =>
      applySearchReplacePatch('a\na\n', {
        search: 'a',
        replace: 'b',
      })
    ).toThrow('replaceAll=true');
  });
});

describe('applySearchReplaceDiff', () => {
  it('applies multiple ordered patches across files', () => {
    expect(
      applySearchReplaceDiff(
        {
          'src/a.ts': 'const value = 1;\nexport const label = "old";\n',
          'src/b.ts': 'export const enabled = false;\n',
        },
        [
          {
            relativePath: 'src/a.ts',
            search: 'const value = 1;',
            replace: 'const value = 2;',
          },
          {
            relativePath: 'src/a.ts',
            search: 'export const label = "old";',
            replace: 'export const label = "new";',
          },
          {
            relativePath: 'src/b.ts',
            search: 'false',
            replace: 'true',
            expectedOccurrences: 1,
          },
        ]
      )
    ).toEqual({
      files: [
        {
          path: 'src/a.ts',
          content: 'const value = 2;\nexport const label = "new";\n',
          patches: 2,
          replacements: 2,
        },
        {
          path: 'src/b.ts',
          content: 'export const enabled = true;\n',
          patches: 1,
          replacements: 1,
        },
      ],
      totalFiles: 2,
      totalPatches: 3,
      totalReplacements: 3,
    });
  });

  it('rejects the whole diff when any patch cannot be matched', () => {
    expect(() =>
      applySearchReplaceDiff(
        {
          'src/a.ts': 'const value = 1;\n',
        },
        [
          {
            relativePath: 'src/a.ts',
            search: 'const value = 1;',
            replace: 'const value = 2;',
          },
          {
            relativePath: 'src/a.ts',
            search: 'missing();',
            replace: 'present();',
          },
        ]
      )
    ).toThrow('补丁 2 (src/a.ts) 应用失败');
  });
});

describe('selectProjectMapFiles', () => {
  it('prioritizes core source files over tests', () => {
    const selected = selectProjectMapFiles(
      [
        { path: 'packages/@codepapr/ui/src/App.tsx', name: 'App.tsx', isDir: false, bytes: 1200 },
        { path: 'packages/@codepapr/ui/src/store/agentStore.ts', name: 'agentStore.ts', isDir: false, bytes: 2200 },
        { path: 'packages/@codepapr/ui/src/utils/agentPrompts.test.ts', name: 'agentPrompts.test.ts', isDir: false, bytes: 900 },
      ],
      2
    );

    expect(selected.map((entry) => entry.path)).toEqual([
      'packages/@codepapr/ui/src/App.tsx',
      'packages/@codepapr/ui/src/store/agentStore.ts',
    ]);
  });

  it('keeps C and C++ files eligible for the project map', () => {
    const selected = selectProjectMapFiles(
      [
        { path: 'src/native/main.cpp', name: 'main.cpp', isDir: false, bytes: 1800 },
        { path: 'src/native/main.hpp', name: 'main.hpp', isDir: false, bytes: 600 },
        { path: 'README.md', name: 'README.md', isDir: false, bytes: 200 },
      ],
      4
    );

    expect(selected.map((entry) => entry.path)).toEqual([
      'src/native/main.cpp',
      'src/native/main.hpp',
    ]);
  });
});

describe('buildWorkspaceProjectMap', () => {
  it('builds a compact tree plus AST-derived code stubs and symbols', () => {
    const result = buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'src', name: 'src', isDir: true, bytes: 0 },
        { path: 'src/App.tsx', name: 'App.tsx', isDir: false, bytes: 120 },
        { path: 'src/store', name: 'store', isDir: true, bytes: 0 },
        { path: 'src/store/agentStore.ts', name: 'agentStore.ts', isDir: false, bytes: 240 },
      ],
      fileContents: {
        'src/App.tsx': {
          content: 'export function App() {\n  return <main />;\n}\n',
          bytes: 41,
        },
        'src/store/agentStore.ts': {
          content: [
            'export class AgentStore {',
            '  async sendMessage(message: string): Promise<void> {}',
            '  private hydrate(): void {}',
            '}',
            'export const useAgentStore = create(() => ({}));',
          ].join('\n'),
          bytes: 148,
        },
      },
    });

    expect(result.root).toBe('.');
    expect(result.tree).toContain('src/');
    expect(result.tree).toContain('  - App.tsx');
    expect(result.files[0]?.stubs[0]).toContain('export function App()');
    expect(result.files[1]?.stubs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('export class AgentStore'),
        expect.stringContaining('async AgentStore.sendMessage(message: string): Promise<void>'),
        expect.stringContaining('export const useAgentStore = create(...)'),
      ])
    );
    expect(result.files[1]?.stubs.some((stub) => stub.includes('hydrate'))).toBe(false);
    expect(result.files[1]?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'AgentStore', exported: true }),
        expect.objectContaining({ kind: 'method', name: 'sendMessage', containerName: 'AgentStore', async: true }),
        expect.objectContaining({ kind: 'variable', name: 'useAgentStore', exported: true }),
      ])
    );
  });
});

describe('buildWorkspaceProjectGraph', () => {
  it('preserves AST and pattern symbol provenance while resolving import and re-export edges', () => {
    const graph = buildWorkspaceProjectGraph({
      projectMap: {
        root: '.',
        tree: '.\n- src/',
        truncated: false,
        files: [
          {
            path: 'src/entry.ts',
            language: 'TypeScript',
            bytes: 82,
            symbols: [
              {
                name: 'boot',
                kind: 'function',
                signature: 'export function boot()',
                line: 2,
                exported: true,
              },
            ],
            stubs: ['export function boot()'],
          },
          {
            path: 'src/worker.py',
            language: 'Python',
            bytes: 30,
            symbols: [
              {
                name: 'handler',
                kind: 'function',
                signature: 'def handler()',
                line: 1,
                exported: false,
              },
            ],
            stubs: ['def handler()'],
          },
        ],
      },
      entries: [
        { path: 'src/entry.ts', name: 'entry.ts', isDir: false, bytes: 82 },
        { path: 'src/feature.ts', name: 'feature.ts', isDir: false, bytes: 25 },
        { path: 'src/reexports.ts', name: 'reexports.ts', isDir: false, bytes: 31 },
        { path: 'src/worker.py', name: 'worker.py', isDir: false, bytes: 30 },
      ],
      fileContents: {
        'src/entry.ts': {
          content: 'import { feature } from "./feature";\nexport function boot() { return feature; }\n',
          bytes: 82,
        },
        'src/feature.ts': {
          content: 'export const feature = 1;\n',
          bytes: 25,
        },
        'src/reexports.ts': {
          content: 'export { boot } from "./entry";\n',
          bytes: 31,
        },
        'src/worker.py': {
          content: 'def handler():\n    return 1\n',
          bytes: 30,
        },
      },
    });

    // edges=4：2 条 contains + 1 条 imports + 1 条 reexports。boot()/handler() 各自的声明行
    // 曾被朴素的 calls 提取误判成"调用自身"，产生 2 条假自环边，修复后不再出现（原为 6）。
    expect(graph.summary).toMatchObject({
      files: 3,
      symbols: 2,
      imports: 1,
      reexports: 1,
      entryPoints: 1,
      edges: 4,
    });
    expect(graph.files[0]?.path).toBe('src/entry.ts');
    expect(graph.files.some((file) => file.path === 'src/reexports.ts')).toBe(true);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'symbol', label: 'boot', symbolSource: 'ast' }),
        expect.objectContaining({ kind: 'symbol', label: 'handler', symbolSource: 'pattern' }),
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'imports',
          from: 'file:src/entry.ts',
          to: 'file:src/feature.ts',
          label: './feature',
        }),
        expect.objectContaining({
          kind: 'reexports',
          from: 'file:src/reexports.ts',
          to: 'file:src/entry.ts',
          label: './entry',
        }),
      ])
    );
  });
});

describe('extractProjectMapSymbols', () => {
  it('uses the TypeScript AST for top-level and nested symbols', () => {
    const symbols = extractProjectMapSymbols(
      'src/projectMap.ts',
      [
        'export interface Message<T> {',
        '  payload: T;',
        '}',
        'export default async function boot(input: string): Promise<void> {}',
        'export const createRunner = async <T>(input: T): Promise<T> => input;',
      ].join('\n'),
      6
    );

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'interface', name: 'Message', exported: true, line: 1 }),
        expect.objectContaining({ kind: 'function', name: 'boot', exported: true, async: true, line: 4 }),
        expect.objectContaining({ kind: 'function', name: 'createRunner', exported: true, async: true, line: 5 }),
      ])
    );
    expect(symbols.map((symbol) => symbol.signature)).toEqual(
      expect.arrayContaining([
        'export interface Message<T>',
        'export default async function boot(input: string): Promise<void>',
        'export const createRunner = async <T>(input: T): Promise<T> =>',
      ])
    );
  });
});

describe('parseGitStatusCommandResult', () => {
  it('parses branch, rename, and untracked files', () => {
    const result = parseGitStatusCommandResult({
      status: 0,
      stdout: '## main...origin/main\nR  src/old.ts -> src/new.ts\n?? src/new-file.ts\n M README.md\n',
      stderr: '',
    });

    expect(result.available).toBe(true);
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBe('main...origin/main');
    expect(result.files).toEqual([
      {
        path: 'src/new.ts',
        indexStatus: 'R',
        worktreeStatus: '',
        originalPath: 'src/old.ts',
      },
      {
        path: 'src/new-file.ts',
        indexStatus: '?',
        worktreeStatus: '?',
      },
      {
        path: 'README.md',
        indexStatus: '',
        worktreeStatus: 'M',
      },
    ]);
  });
});

describe('parseGitRepositoryRootCommandResult', () => {
  it('returns the repository root when rev-parse succeeds', () => {
    const result = parseGitRepositoryRootCommandResult({
      status: 0,
      stdout: '/tmp/repo\n',
      stderr: '',
    });

    expect(result.available).toBe(true);
    expect(result.isRepo).toBe(true);
    expect(result.repoRoot).toBe('/tmp/repo');
  });

  it('marks non-repositories without treating git itself as unavailable', () => {
    const result = parseGitRepositoryRootCommandResult({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    expect(result.available).toBe(true);
    expect(result.isRepo).toBe(false);
    expect(result.message).toContain('不是 Git 仓库');
  });
});

describe('buildGitDiffSummary', () => {
  it('builds a clean staged diff summary', () => {
    const result = buildGitDiffSummary({
      staged: true,
      pathspecs: ['src/App.tsx'],
      statResult: {
        status: 0,
        stdout: ' src/App.tsx | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
        stderr: '',
      },
      diffResult: {
        status: 0,
        stdout: '@@ -1 +1 @@\n-old\n+new\n',
        stderr: '',
      },
    });

    expect(result.available).toBe(true);
    expect(result.isRepo).toBe(true);
    expect(result.staged).toBe(true);
    expect(result.pathspecs).toEqual(['src/App.tsx']);
    expect(result.stat).toContain('1 file changed');
    expect(result.diff).toContain('@@ -1 +1 @@');
  });
});
