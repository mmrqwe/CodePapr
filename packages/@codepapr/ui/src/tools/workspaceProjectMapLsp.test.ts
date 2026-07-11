import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { resolveProjectMapSymbolOverrides, globalLspPool } from './workspaceProjectMapLsp';

describe('resolveProjectMapSymbolOverrides', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses real LSP document symbols for C#/Java/C++ with fallback support', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'lsp_open_document') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'src/Program.cs') {
          return { message: { server: { toolSource: 'managed-cache' } } };
        }
        if (relativePath === 'src/Main.java') {
          return { message: { server: { toolSource: 'builtin-fallback' } } };
        }
        if (relativePath === 'src/native/main.cpp') {
          return { message: { server: { toolSource: 'path' } } };
        }
      }

      if (command === 'lsp_request') {
        const languageId = String(args?.languageId ?? '');
        if (languageId === 'csharp') {
          return {
            message: {
              result: [
                {
                  name: 'Program',
                  kind: 5,
                  selectionRange: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 7 },
                  },
                  children: [
                    {
                      name: 'Main',
                      kind: 6,
                      detail: '(string[] args)',
                      selectionRange: {
                        start: { line: 3, character: 4 },
                        end: { line: 3, character: 8 },
                      },
                    },
                  ],
                },
              ],
            },
          };
        }

        if (languageId === 'cpp') {
          return {
            message: {
              result: [
                {
                  name: 'Runner',
                  kind: 5,
                  selectionRange: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 6 },
                  },
                  children: [
                    {
                      name: 'run',
                      kind: 6,
                      detail: '() -> int',
                      selectionRange: {
                        start: { line: 4, character: 2 },
                        end: { line: 4, character: 5 },
                      },
                    },
                  ],
                },
              ],
            },
          };
        }

        if (languageId === 'java') {
          return {
            message: {
              result: [
                {
                  name: 'Main',
                  kind: 5,
                  selectionRange: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 4 },
                  },
                  children: [
                    {
                      name: 'main',
                      kind: 6,
                      detail: '(String[] args)',
                      selectionRange: {
                        start: { line: 1, character: 4 },
                        end: { line: 1, character: 8 },
                      },
                    },
                  ],
                },
              ],
            },
          };
        }
      }

      if (command === 'lsp_close_document') {
        return true;
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const overrides = await resolveProjectMapSymbolOverrides(
      '/tmp/codepapr-workspace',
      {
        'src/Program.cs': {
          content: 'public class Program { public static void Main(string[] args) {} }',
          bytes: 64,
        },
        'src/Main.java': {
          content: 'public final class Main { public static void main(String[] args) {} }',
          bytes: 72,
        },
        'src/native/main.cpp': {
          content: 'class Runner { public: int run(); };',
          bytes: 38,
        },
      },
      4
    );

    expect(overrides['src/Program.cs']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'Program', line: 1 }),
        expect.objectContaining({
          kind: 'method',
          name: 'Main',
          containerName: 'Program',
          signature: 'Program.Main(string[] args)',
          line: 4,
        }),
      ])
    );
    expect(overrides['src/Main.java']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'Main', line: 1 }),
        expect.objectContaining({
          kind: 'method',
          name: 'main',
          containerName: 'Main',
          signature: 'Main.main(String[] args)',
          line: 2,
        }),
      ])
    );
    expect(overrides['src/native/main.cpp']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'Runner', line: 1 }),
        expect.objectContaining({
          kind: 'method',
          name: 'run',
          containerName: 'Runner',
          signature: 'Runner.run() -> int',
          line: 5,
        }),
      ])
    );
  });
});

describe('globalLspPool eviction', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('stops the backend LSP server when the oldest connection is evicted', async () => {
    // 连接池上限是 10，第 11 次 acquire 一个新的 (language, workspace) 组合会淘汰最早的一个。
    for (let i = 0; i < 11; i++) {
      await globalLspPool.acquire('typescript', `/workspace-${i}`);
    }

    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_stop_server',
      expect.objectContaining({ workspacePath: '/workspace-0', languageId: 'typescript' })
    );
  });
});