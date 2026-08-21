import { describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { warmupLspForWorkspace, stopWorkspaceLsp } from './lspWarmup';

describe('warmupLspForWorkspace', () => {
  it('sends a Windows drive documentSymbol URI with three slashes', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return { entries: [{ path: 'src/a.ts', isDir: false }] };
      }
      if (command === 'lsp_start_server' || command === 'lsp_open_document' || command === 'lsp_close_document') {
        return {};
      }
      if (command === 'read_text_file') {
        return { content: 'export const a = 1;\n' };
      }
      if (command === 'lsp_request') {
        return { message: { result: [] } };
      }
      throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
    });

    await warmupLspForWorkspace('C:/proj');

    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_request',
      expect.objectContaining({
        method: 'textDocument/documentSymbol',
        params: {
          textDocument: { uri: 'file:///C:/proj/src/a.ts' },
        },
      }),
    );
  });

  it('skips disabled families during warmup', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          entries: [
            { path: 'src/a.ts', isDir: false },
            { path: 'src/lib.rs', isDir: false },
          ],
        };
      }
      if (command === 'lsp_start_server' || command === 'lsp_open_document' || command === 'lsp_close_document') {
        return {};
      }
      if (command === 'read_text_file') {
        return { content: 'ok\n' };
      }
      if (command === 'lsp_request') {
        return { message: { result: [] } };
      }
      throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
    });

    await warmupLspForWorkspace('C:/proj', ['typescript']);

    const started = invokeMock.mock.calls
      .filter((call) => call[0] === 'lsp_start_server')
      .map((call) => (call[1] as { languageId?: string }).languageId);
    expect(started).toEqual(['rust']);
  });

  it('closes pooled connections and backend servers for the previous workspace', async () => {
    invokeMock.mockResolvedValue({});
    const { globalLspPool } = await import('../tools/workspaceProjectMapLsp');
    const handle = await globalLspPool.acquire('typescript', 'C:/proj');
    globalLspPool.release(handle);
    invokeMock.mockClear();

    await stopWorkspaceLsp('C:/proj');

    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_stop_server',
      expect.objectContaining({ workspacePath: 'C:/proj', languageId: 'typescript' }),
    );
  });
});
