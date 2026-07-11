import { describe, expect, it } from 'vitest';
import { describeLspSupport, isLikelyMissingLspServer } from './lspSupport';

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