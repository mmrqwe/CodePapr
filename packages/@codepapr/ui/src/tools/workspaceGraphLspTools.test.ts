import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@codepapr/core';

const {
  requestWorkspaceSymbolReferencesMock,
  requestWorkspaceHoverMock,
} = vi.hoisted(() => ({
  requestWorkspaceSymbolReferencesMock: vi.fn(),
  requestWorkspaceHoverMock: vi.fn(),
}));

vi.mock('@codepapr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codepapr/core')>();
  return {
    ...actual,
    requestWorkspaceSymbolReferences: (...args: unknown[]) =>
      requestWorkspaceSymbolReferencesMock(...args),
    requestWorkspaceHover: (...args: unknown[]) => requestWorkspaceHoverMock(...args),
  };
});

import {
  adoptAuthoritativeLspResult,
  registerWorkspaceGraphLspTools,
} from './workspaceGraphLspTools';
import type { WorkspaceToolContext } from './workspaceToolContext';

describe('adoptAuthoritativeLspResult', () => {
  it('keeps empty LSP results when the server answered successfully', () => {
    expect(adoptAuthoritativeLspResult({ available: true, locations: [] })).toEqual({
      available: true,
      locations: [],
      source: 'lsp',
      confidence: 'high',
    });
  });

  it('returns null so callers can fall back when LSP is unavailable', () => {
    expect(adoptAuthoritativeLspResult({ available: false, locations: [], message: 'down' })).toBeNull();
  });
});

describe('registerWorkspaceGraphLspTools', () => {
  const buildIntelligenceProjectGraph = vi.fn();

  beforeEach(() => {
    requestWorkspaceSymbolReferencesMock.mockReset();
    requestWorkspaceHoverMock.mockReset();
    buildIntelligenceProjectGraph.mockReset();
    buildIntelligenceProjectGraph.mockRejectedValue(new Error('AST fallback must not run'));
  });

  function buildRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerWorkspaceGraphLspTools({
      registry,
      options: {},
      workspace: () => '/tmp/ws',
      getWorkspaceHost: () => ({ workspacePath: '/tmp/ws' }),
      resolveLanguageId: () => 'typescript',
      buildIntelligenceProjectGraph,
      ensureExternalPathAllowed: () => undefined,
    } as unknown as WorkspaceToolContext);
    return registry;
  }

  it('does not fall back to AST when LSP returns available with empty references', async () => {
    requestWorkspaceSymbolReferencesMock.mockResolvedValue({
      available: true,
      locations: [],
    });

    const result = await buildRegistry().execute('workspace_symbol_references', {
      relativePath: 'src/a.ts',
      line: 1,
    });

    expect(result).toMatchObject({
      available: true,
      locations: [],
      source: 'lsp',
      confidence: 'high',
    });
    expect(buildIntelligenceProjectGraph).not.toHaveBeenCalled();
  });

  it('does not fall back to AST when LSP hover is available without contents', async () => {
    requestWorkspaceHoverMock.mockResolvedValue({
      available: true,
      contents: '',
    });

    const result = await buildRegistry().execute('workspace_symbol_hover', {
      relativePath: 'src/a.ts',
      line: 1,
    });

    expect(result).toMatchObject({
      available: true,
      contents: '',
      source: 'lsp',
      confidence: 'high',
    });
    expect(buildIntelligenceProjectGraph).not.toHaveBeenCalled();
  });

  it('falls back to AST only when LSP is unavailable', async () => {
    requestWorkspaceSymbolReferencesMock.mockResolvedValue({
      available: false,
      locations: [],
      message: 'no language service',
    });
    buildIntelligenceProjectGraph.mockResolvedValue({
      nodes: [],
      edges: [],
    });

    const result = await buildRegistry().execute('workspace_symbol_references', {
      relativePath: 'src/a.ts',
      line: 1,
    });

    expect(buildIntelligenceProjectGraph).toHaveBeenCalled();
    expect(result).toMatchObject({
      available: false,
      source: 'ast',
      confidence: 'low',
    });
  });
});
