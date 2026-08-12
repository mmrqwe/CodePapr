// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command?: string) => undefined),
  openMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}));

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { useToastStore } from '../store/toastStore';
import { ProjectSwitcherModal } from './ProjectSwitcherModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ProjectSwitcherModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        recentWorkspaces: [
          { path: '/proj/a', name: 'a', lastOpenedAt: 200, pinned: false },
          { path: '/proj/b', name: 'b', lastOpenedAt: 100, pinned: false },
        ],
      }),
      workspacePath: '/proj/a',
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

  function renderModal(): void {
    act(() => {
      root.render(<ProjectSwitcherModal onClose={() => undefined} />);
    });
  }

  function clickButtonByTitle(title: string): void {
    const button = Array.from(container.querySelectorAll('button')).find(
      (el) => el.title === title,
    );
    if (!button) throw new Error(`Button with title "${title}" not found`);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('persists the pinned list to the backend before updating the store', async () => {
    renderModal();
    clickButtonByTitle('置顶');

    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith('set_recent_workspaces', {
      workspacesJson: JSON.stringify([
        { path: '/proj/a', name: 'a', lastOpenedAt: 200, pinned: true },
        { path: '/proj/b', name: 'b', lastOpenedAt: 100, pinned: false },
      ]),
    });
    expect(
      useAgentStore.getState().settings.recentWorkspaces.find((e) => e.path === '/proj/a')?.pinned,
    ).toBe(true);
  });

  it('persists the list without the removed project before updating the store', async () => {
    renderModal();
    clickButtonByTitle('从列表中移除');

    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith('set_recent_workspaces', {
      workspacesJson: JSON.stringify([
        { path: '/proj/b', name: 'b', lastOpenedAt: 100, pinned: false },
      ]),
    });
    expect(
      useAgentStore.getState().settings.recentWorkspaces.map((e) => e.path),
    ).toEqual(['/proj/b']);
  });

  it('N12：失效路径打开失败时提示错误且当前工作区保持原样', async () => {
    renderModal();
    useToastStore.getState().clearToasts();
    invokeMock.mockImplementation(async (command?: string) => {
      if (command === 'load_sessions' || command === 'load_project_state') {
        throw new Error('workspace path not found');
      }
      return undefined;
    });

    const entryButton = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent?.includes('/proj/b'),
    );
    act(() => {
      entryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 当前工作区必须保持原样（不被一起关掉落到空状态）
    expect(useAgentStore.getState().workspacePath).toBe('/proj/a');
    // 明确提示用户打开失败
    expect(
      useToastStore.getState().toasts.some((t) => t.message.includes('打开项目失败')),
    ).toBe(true);
  });
});
