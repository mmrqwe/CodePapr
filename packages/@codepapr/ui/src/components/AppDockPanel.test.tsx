// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command?: string) => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { AppDockPanel } from './AppDockPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    title: '我的应用',
    icon: '📊',
    html: '',
    filePath: '/ws/.CodePapr/apps/app-1/index.html',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('AppDockPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ lang: 'zh-CN' }),
      workspacePath: '/ws',
    }));
    useAppRuntimeStore.setState({ apps: [makeApp()], activeAppId: 'app-1', openedAppId: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useAppRuntimeStore.setState({ apps: [], activeAppId: null, openedAppId: null });
    vi.restoreAllMocks();
  });

  function renderPanel(): void {
    act(() => {
      root.render(<AppDockPanel lang="zh-CN" />);
    });
  }

  async function clickDelete(): Promise<void> {
    // 先点选 app 行（选中后才能启用底部操作按钮），等重渲染后再点删除
    const row = Array.from(container.querySelectorAll('div')).find(
      (el) =>
        el.className.includes('cursor-pointer') &&
        el.textContent?.includes('我的应用'),
    );
    if (!row) throw new Error('App row not found');
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent?.includes('删除'),
    );
    if (!button) throw new Error('Delete button not found');
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('N13：确认后删除成功才从 UI 移除', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel();
    await clickDelete();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invokeMock).toHaveBeenCalledWith('papr_delete_app', { appId: 'app-1' });
    expect(useAppRuntimeStore.getState().apps).toHaveLength(0);
  });

  it('N13：取消确认时不做任何事', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel();
    await clickDelete();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith('papr_delete_app', expect.anything());
    expect(useAppRuntimeStore.getState().apps).toHaveLength(1);
  });

  it('N13：删除失败时 app 保留在 UI 并显示错误（不假删除）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    invokeMock.mockImplementation(async (command?: string) => {
      if (command === 'papr_delete_app') {
        throw new Error('permission denied');
      }
      return undefined;
    });
    renderPanel();
    await clickDelete();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 目录仍在磁盘：app 必须保留在列表中，否则下次启动又被扫描回来
    expect(useAppRuntimeStore.getState().apps).toHaveLength(1);
    expect(container.textContent).toContain('删除应用失败');
  });
});
