import { describe, expect, it } from 'vitest';
import {
  applySearchReplaceDiff,
  applySearchReplacePatch,
  buildGitDiffSummary,
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMap,
  extractProjectMapSymbols,
  filterWorkspaceInsightEntries,
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

describe('filterWorkspaceInsightEntries', () => {
  it('filters .DS_Store and other OS noise files case-insensitively', () => {
    const filtered = filterWorkspaceInsightEntries([
      { path: 'src/main.ts', name: 'main.ts', isDir: false, bytes: 10 },
      { path: '.DS_Store', name: '.DS_Store', isDir: false, bytes: 6 },
      { path: 'src/.ds_store', name: '.ds_store', isDir: false, bytes: 6 },
      { path: 'assets/Thumbs.db', name: 'Thumbs.db', isDir: false, bytes: 6 },
      { path: 'node_modules/pkg/index.js', name: 'index.js', isDir: false, bytes: 10 },
    ]);

    expect(filtered.map((entry) => entry.path)).toEqual(['src/main.ts']);
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

  it('includes C and C++ sources in project map candidates', () => {
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

  it('ignores release artifacts while keeping Swift source files', () => {
    const selected = selectProjectMapFiles(
      [
        {
          path: 'release/Agent.app/Contents/Resources/agent-server/server.py',
          name: 'server.py',
          isDir: false,
          bytes: 4200,
        },
        {
          path: 'AgentApp/Sources/AgentApp/Views/ChatView.swift',
          name: 'ChatView.swift',
          isDir: false,
          bytes: 820,
        },
      ],
      4
    );

    expect(selected.map((entry) => entry.path)).toEqual([
      'AgentApp/Sources/AgentApp/Views/ChatView.swift',
    ]);
  });
});

describe('buildWorkspaceProjectMap', () => {
  it('builds a compact tree plus AST-derived code stubs and symbols', async () => {
    const result = await buildWorkspaceProjectMap({
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

  it('uses explicit symbol overrides without falling back to regex stubs', async () => {
    const result = await buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'src', name: 'src', isDir: true, bytes: 0 },
        { path: 'src/Program.cs', name: 'Program.cs', isDir: false, bytes: 160 },
      ],
      fileContents: {
        'src/Program.cs': {
          content: 'public class Program { public static void Main(string[] args) {} }',
          bytes: 64,
        },
      },
      symbolOverrides: {
        'src/Program.cs': [
          {
            name: 'Main',
            kind: 'method',
            signature: 'Program.Main(string[] args)',
            line: 1,
            containerName: 'Program',
            exported: false,
          },
        ],
      },
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        path: 'src/Program.cs',
        language: 'C#',
        symbols: [
          expect.objectContaining({
            kind: 'method',
            name: 'Main',
            containerName: 'Program',
          }),
        ],
        stubs: ['Program.Main(string[] args)'],
      }),
    ]);
  });

  it('extracts Swift symbols with the correct language label', async () => {
    const result = await buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'AgentApp', name: 'AgentApp', isDir: true, bytes: 0 },
        { path: 'AgentApp/Sources', name: 'Sources', isDir: true, bytes: 0 },
        { path: 'AgentApp/Sources/AgentApp', name: 'AgentApp', isDir: true, bytes: 0 },
        {
          path: 'AgentApp/Sources/AgentApp/Views/ChatView.swift',
          name: 'ChatView.swift',
          isDir: false,
          bytes: 196,
        },
      ],
      fileContents: {
        'AgentApp/Sources/AgentApp/Views/ChatView.swift': {
          content: [
            'import SwiftUI',
            'protocol ChatPresenting: ObservableObject {}',
            'struct ChatView: View {}',
            'func reloadMessages() async {}',
          ].join('\n'),
          bytes: 108,
        },
      },
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        path: 'AgentApp/Sources/AgentApp/Views/ChatView.swift',
        language: 'Swift',
        symbols: expect.arrayContaining([
          expect.objectContaining({ kind: 'interface', name: 'ChatPresenting' }),
          expect.objectContaining({ kind: 'class', name: 'ChatView' }),
          expect.objectContaining({ kind: 'function', name: 'reloadMessages' }),
        ]),
      }),
    ]);
  });
});

describe('buildWorkspaceProjectGraph', () => {
  it('includes relation-only files so re-export edges remain visible in ProjectGraph', async () => {
    const projectMap = await buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'src', name: 'src', isDir: true, bytes: 0 },
        { path: 'src/main.ts', name: 'main.ts', isDir: false, bytes: 120 },
        { path: 'src/reexports.ts', name: 'reexports.ts', isDir: false, bytes: 48 },
      ],
      fileContents: {
        'src/main.ts': {
          content: 'export function main() { return 1; }\n',
          bytes: 36,
        },
        'src/reexports.ts': {
          content: 'export { main } from "./main";\n',
          bytes: 31,
        },
      },
    });

    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: [
        { path: 'src/main.ts', name: 'main.ts', isDir: false, bytes: 120 },
        { path: 'src/reexports.ts', name: 'reexports.ts', isDir: false, bytes: 48 },
      ],
      fileContents: {
        'src/main.ts': {
          content: 'export function main() { return 1; }\n',
          bytes: 36,
        },
        'src/reexports.ts': {
          content: 'export { main } from "./main";\n',
          bytes: 31,
        },
      },
    });

    expect(graph.files.map((file) => file.path)).toEqual(['src/main.ts', 'src/reexports.ts']);
    expect(graph.summary).toMatchObject({
      files: 2,
      reexports: 1,
      entryPoints: 1,
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'reexports',
        from: 'file:src/reexports.ts',
        to: 'file:src/main.ts',
      })
    );
  });

  it('marks desktop LSP symbol overrides as semantic graph nodes', async () => {
    const fileContents = {
      'src/Program.cs': {
        content: 'public class Program { public static void Main(string[] args) {} }',
        bytes: 64,
      },
    };
    const symbolOverrides = {
      'src/Program.cs': [
        {
          name: 'Main',
          kind: 'method',
          signature: 'Program.Main(string[] args)',
          line: 1,
          containerName: 'Program',
          exported: false,
        },
      ],
    };
    const projectMap = await buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'src', name: 'src', isDir: true, bytes: 0 },
        { path: 'src/Program.cs', name: 'Program.cs', isDir: false, bytes: 160 },
      ],
      fileContents,
      symbolOverrides,
    });

    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: [
        { path: 'src/Program.cs', name: 'Program.cs', isDir: false, bytes: 160 },
      ],
      fileContents,
      symbolOverrides,
    });

    expect(graph.summary).toMatchObject({
      files: 1,
      symbols: 1,
      lspSymbols: 1,
    });
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'symbol',
        label: 'Program.Main',
        symbolSource: 'lsp',
      })
    );
  });

  it('maps Swift colon inheritance into extends and implements edges', async () => {
    const fileContents = {
      'AgentApp/Sources/AgentApp/App.swift': {
        content: [
          'protocol ConversationPresenting: ObservableObject {}',
          'class BaseViewModel {}',
          'class ChatViewModel: BaseViewModel, ConversationPresenting {}',
        ].join('\n'),
        bytes: 125,
      },
    };

    const projectMap = await buildWorkspaceProjectMap({
      rootRelativePath: '',
      entries: [
        { path: 'AgentApp', name: 'AgentApp', isDir: true, bytes: 0 },
        { path: 'AgentApp/Sources', name: 'Sources', isDir: true, bytes: 0 },
        { path: 'AgentApp/Sources/AgentApp', name: 'AgentApp', isDir: true, bytes: 0 },
        {
          path: 'AgentApp/Sources/AgentApp/App.swift',
          name: 'App.swift',
          isDir: false,
          bytes: 125,
        },
      ],
      fileContents,
    });

    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: [
        {
          path: 'AgentApp/Sources/AgentApp/App.swift',
          name: 'App.swift',
          isDir: false,
          bytes: 125,
        },
      ],
      fileContents,
    });

    expect(graph.summary).toMatchObject({
      extends: 1,
      implements: 1,
    });
  });
});

describe('extractProjectMapSymbols', () => {
  it('uses the TypeScript AST for top-level and nested symbols', async () => {
    const symbols = await extractProjectMapSymbols(
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
