import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { createLspProjectGraphEnhancer } from './workspaceToolUtils';
import { globalLspPool } from './workspaceProjectMapLsp';

describe('createLspProjectGraphEnhancer', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(async () => {
    await globalLspPool.closeAll();
  });

  it('attaches enrich edges to the URI-mapped file, not a shorter same-suffix sibling', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lsp_batch_enrich') {
        return [
          {
            path: 'packages/a/src/index.ts',
            references: [
              {
                uri: 'file:///Users/proj/packages/a/src/index.ts',
                line: 0,
                character: 16,
                fromSymbol: 'foo',
              },
              {
                uri: 'file:///elsewhere/src/index.ts',
                line: 1,
                character: 0,
                fromSymbol: 'foo',
              },
            ],
            inheritance: [],
          },
        ];
      }
      throw new Error(`unexpected command ${command}`);
    });

    const enhancer = createLspProjectGraphEnhancer(
      {
        'src/index.ts': {
          content: 'export const root = 1;\n',
          bytes: 23,
        },
        'packages/a/src/index.ts': {
          content: 'export function foo() {}\n',
          bytes: 25,
        },
      },
      '/Users/proj',
    );

    const edges = await enhancer.enhanceReferences(
      'packages/a/src/index.ts',
      'export function foo() {}\n',
      [{ name: 'foo', line: 1, kind: 'function' }],
    );

    expect(edges).toEqual([
      {
        filePath: 'packages/a/src/index.ts',
        line: 0,
        character: 16,
        fromSymbol: 'foo',
        toSymbol: 'foo',
      },
    ]);
  });
});
