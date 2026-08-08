import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { resolveProjectMapSymbolOverrides, globalLspPool } from './workspaceProjectMapLsp';

afterEach(async () => {
  invokeMock.mockResolvedValue(undefined);
  await globalLspPool.closeAll();
});

describe('resolveProjectMapSymbolOverrides', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses real LSP document symbols for C#/Java/C++ with fallback support', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'lsp_batch_symbols') {
        const files = Array.isArray(args?.files) ? (args.files as Array<{ path: string; languageId: string }>) : [];
        return files.map((file) => {
          const languageId = String(file.languageId ?? '');
          let result: unknown = null;
          if (languageId === 'csharp') {
            result = [
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
            ];
          } else if (languageId === 'cpp') {
            result = [
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
            ];
          } else if (languageId === 'java') {
            result = [
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
            ];
          }

          return { path: file.path, result, error: null };
        });
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

  it('stops the backend LSP server when the least-recently-used idle connection is evicted', async () => {
    // 连接池上限是 10。模拟真实用法：每个连接 acquire 后立即 release（refCount 归零变为空闲）。
    // 第 11 个新的 (language, workspace) 组合会淘汰「最久未使用且空闲」的连接（workspace-0），
    // 而绝不会淘汰仍有 in-flight 请求（refCount>0）的连接。
    for (let i = 0; i < 10; i++) {
      const handle = await globalLspPool.acquire('typescript', `/workspace-${i}`);
      globalLspPool.release(handle);
    }
    await globalLspPool.acquire('typescript', '/workspace-10');

    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_stop_server',
      expect.objectContaining({ workspacePath: '/workspace-0', languageId: 'typescript' })
    );
  });

  it('never evicts a connection that still has in-flight work', async () => {
    // 全部 10 个连接都持有 in-flight 请求（acquire 后不 release，refCount>0），
    // 此时第 11 个连接进来也不应淘汰任何在用连接（池可临时超出上限，但绝不打断在用请求）。
    for (let i = 0; i < 10; i++) {
      await globalLspPool.acquire('typescript', `/busy-${i}`);
    }
    invokeMock.mockClear();
    await globalLspPool.acquire('typescript', '/busy-10');

    expect(invokeMock).not.toHaveBeenCalledWith(
      'lsp_stop_server',
      expect.anything()
    );
  });
});