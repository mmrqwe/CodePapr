// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./MonacoDiffEditor', async () => {
  const React = await import('react');
  return {
    MonacoDiffEditor: (props: { originalValue?: string; modifiedValue?: string }) =>
      React.createElement(
        'div',
        { 'data-testid': 'monaco-diff-editor' },
        `${props.originalValue ?? ''}|${props.modifiedValue ?? ''}`
      ),
  };
});

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { CodeReviewPanel } from './CodeReviewPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('CodeReviewPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'diff_snapshots') {
        return [
          { path: 'src/app.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, patch: null },
        ];
      }
      if (command === 'snapshot_file_content') {
        return `snapshot:${String(args?.sha ?? '')}:${String(args?.path ?? '')}`;
      }
      if (command === 'read_text_file') {
        return { content: `worktree:${String(args?.relativePath ?? '')}` };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    useAgentStore.setState((state) => ({
      ...state,
      workspacePath: '/workspace',
      settings: normalizeSettings({ lang: 'zh-CN' }),
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('loads compare-with-current from the shadow repo instead of workspace git CLI', async () => {
    const baseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await act(async () => {
      root.render(
        <CodeReviewPanel
          scope={{ baseRef: baseSha, headRef: 'WORKTREE' }}
          onClose={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    expect(invokeMock).toHaveBeenCalledWith('diff_snapshots', {
      workspacePath: '/workspace',
      fromSha: baseSha,
      toSha: 'WORKTREE',
    });
    expect(invokeMock).toHaveBeenCalledWith('snapshot_file_content', {
      workspacePath: '/workspace',
      sha: baseSha,
      path: 'src/app.ts',
    });
    expect(invokeMock).toHaveBeenCalledWith('read_text_file', {
      workspacePath: '/workspace',
      relativePath: 'src/app.ts',
      maxBytes: 5_000_000,
    });
    expect(invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command')).toBe(
      false
    );

    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('当前工作区');
    expect(container.querySelector('[data-testid="monaco-diff-editor"]')?.textContent).toBe(
      `snapshot:${baseSha}:src/app.ts|worktree:src/app.ts`
    );
  });

  it('loads compare-with-previous as two shadow-repo refs, including parent revparse', async () => {
    const headSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const parentRef = `${headSha}~1`;
    await act(async () => {
      root.render(
        <CodeReviewPanel
          scope={{ baseRef: parentRef, headRef: headSha }}
          onClose={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    expect(invokeMock).toHaveBeenCalledWith('diff_snapshots', {
      workspacePath: '/workspace',
      fromSha: parentRef,
      toSha: headSha,
    });
    expect(invokeMock).toHaveBeenCalledWith('snapshot_file_content', {
      workspacePath: '/workspace',
      sha: parentRef,
      path: 'src/app.ts',
    });
    expect(invokeMock).toHaveBeenCalledWith('snapshot_file_content', {
      workspacePath: '/workspace',
      sha: headSha,
      path: 'src/app.ts',
    });
    expect(invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command')).toBe(
      false
    );
  });
});
