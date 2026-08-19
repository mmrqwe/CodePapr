import { describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  checkLspAvailability,
  describeLspSupport,
  ensureLspServer,
  isLikelyMissingLspServer,
} from './lspSupport';

describe('describeLspSupport', () => {
  it('describes managed C# and C/C++ servers', () => {
    expect(describeLspSupport('csharp')).toMatchObject({
      languageLabel: 'C#',
      installMode: 'managed',
      recommendedServers: ['csharp-ls', 'OmniSharp'],
    });
    expect(describeLspSupport('cpp')).toMatchObject({
      languageLabel: 'C / C++',
      installMode: 'managed',
      recommendedServers: ['clangd'],
    });
  });

  it('describes npm-managed TypeScript family servers', () => {
    expect(describeLspSupport('typescriptreact')).toMatchObject({
      languageLabel: 'TypeScript / JavaScript',
      installMode: 'npm',
      recommendedServers: ['typescript-language-server'],
    });
  });

  it('returns null for unsupported languages', () => {
    expect(describeLspSupport('fortran')).toBeNull();
    expect(describeLspSupport(null)).toBeNull();
  });
});

describe('isLikelyMissingLspServer', () => {
  it.each([
    '无法启动 LSP server `jdtls`: No such file or directory (os error 2)',
    'spawn clangd ENOENT command not found',
    'The system cannot find the file specified',
  ])('recognizes missing LSP server errors: %s', (message) => {
    expect(isLikelyMissingLspServer(message)).toBe(true);
  });

  it('does not classify generic runtime failures as missing binaries', () => {
    expect(isLikelyMissingLspServer('LSP request timed out after initialization')).toBe(false);
  });
});

function legacyAvailableFromResolveSymbolProvider(providerInfo: unknown): boolean {
  const info = providerInfo as { tool_source?: string; available?: boolean } | null;
  return info?.available ?? false;
}

describe('checkLspAvailability / ensureLspServer contract', () => {
  const rustProviderShape = {
    languageId: 'typescript',
    providerName: 'typescript-ast',
    source: 'Ast',
    capability: { bits: 1 },
    fallbackChain: ['typescript-ast', 'typescript-regex'],
  };

  it('treats the current resolve_symbol_provider Rust shape as unavailable under the old contract', () => {
    expect(legacyAvailableFromResolveSymbolProvider(rustProviderShape)).toBe(false);
  });

  it('reads available/running from lsp_query_availability instead of resolve_symbol_provider', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lsp_query_availability') {
        return {
          languageId: 'typescript',
          available: true,
          running: true,
          toolOrigin: 'external',
          toolSource: 'path',
          serverStatus: {
            running: true,
            toolLabel: 'typescript-language-server',
            toolSource: 'path',
            toolOrigin: 'external',
            command: 'typescript-language-server --stdio',
          },
        };
      }
      if (command === 'resolve_symbol_provider') {
        return rustProviderShape;
      }
      throw new Error(`unexpected ${command}`);
    });

    const results = await checkLspAvailability('/proj', ['typescript']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      available: true,
      running: true,
      serverName: 'typescript-language-server',
      toolSource: 'path',
    });
    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_query_availability',
      expect.objectContaining({ workspacePath: '/proj', languageId: 'typescript' }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith('resolve_symbol_provider', expect.anything());
  });

  it('does not start an LSP server with an empty workspace path', async () => {
    invokeMock.mockReset();
    const status = await ensureLspServer('', 'typescript');
    expect(status.available).toBe(false);
    expect(status.message).toContain('工作区路径');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('starts the server with a real workspace then queries runtime status', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lsp_start_server') {
        return { running: true, languageId: 'typescript' };
      }
      if (command === 'lsp_query_availability') {
        return {
          languageId: 'typescript',
          available: true,
          running: true,
          toolOrigin: 'external',
          toolSource: 'path',
          serverStatus: {
            running: true,
            toolLabel: 'typescript-language-server',
            toolSource: 'path',
          },
        };
      }
      throw new Error(`unexpected ${command}`);
    });

    const status = await ensureLspServer('/proj', 'typescript');
    expect(status.available).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_start_server',
      expect.objectContaining({ workspacePath: '/proj', languageId: 'typescript' }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_query_availability',
      expect.objectContaining({ workspacePath: '/proj', languageId: 'typescript' }),
    );
  });
});