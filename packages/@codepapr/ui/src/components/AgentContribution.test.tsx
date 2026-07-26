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

import { AgentContribution } from './AgentContribution';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('AgentContribution', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'load_checkpoint_records') {
        return [
          { id: 1, sessionId: 'sess-aaaaaaaa', messageId: 'm1', sha: 'sha1', label: 'c1', fileCount: 10, createdAt: 1000 },
          { id: 2, sessionId: 'sess-aaaaaaaa', messageId: 'm2', sha: 'sha2', label: 'c2', fileCount: 12, createdAt: 2000 },
          { id: 3, sessionId: 'sess-bbbbbbbb', messageId: 'm3', sha: 'sha3', label: 'c3', fileCount: 15, createdAt: 3000 },
        ];
      }
      if (command === 'snapshot_head_sha') {
        return 'head-sha';
      }
      if (command === 'diff_snapshots') {
        return [
          { path: 'src/a.ts', oldPath: null, status: 'M', additions: 100, deletions: 20, patch: null },
          { path: 'src/b.ts', oldPath: null, status: 'A', additions: 50, deletions: 0, patch: null },
          { path: 'src/c.ts', oldPath: null, status: 'M', additions: 5, deletions: 30, patch: null },
        ];
      }
      return null;
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('aggregates cumulative contribution from checkpoint diffs', async () => {
    await act(async () => {
      root.render(<AgentContribution workspacePath="/tmp/project" lang="en" />);
    });
    await flushEffects();

    const text = container.textContent ?? '';
    // 3 files changed, +155 additions, −50 deletions, net +105
    expect(text).toContain('3');
    expect(text).toContain('+155');
    expect(text).toContain('105');
    // top changed files (sorted by churn: a.ts 120, b.ts 50, c.ts 35)
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
    // session activity (short ids)
    expect(text).toContain('sess-aaa');
    expect(text).toContain('sess-bbb');
    // diff called from earliest checkpoint to HEAD
    expect(invokeMock).toHaveBeenCalledWith('diff_snapshots', {
      workspacePath: '/tmp/project',
      fromSha: 'sha1',
      toSha: 'head-sha',
    });
  });

  it('shows unavailable state when there are no checkpoints', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'load_checkpoint_records') return [];
      return null;
    });

    await act(async () => {
      root.render(<AgentContribution workspacePath="/tmp/project" lang="en" />);
    });
    await flushEffects();

    expect(container.textContent ?? '').toContain('No checkpoint data');
    expect(invokeMock).not.toHaveBeenCalledWith('diff_snapshots', expect.anything());
  });
});
