// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command?: string): Promise<unknown> => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => null),
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
    useAppRuntimeStore.setState({
      apps: [makeApp()],
      activeAppId: 'app-1',
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
    });
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

  it('N18：后端未启动时双击会先启动再打开；启动失败则留在 dock', async () => {
    invokeMock.mockImplementation(async (command?: string) => {
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') throw new Error('没有可用的本地端口');
      return undefined;
    });
    useAppRuntimeStore.setState({
      apps: [makeApp({
        command: 'npm',
        args: ['run', 'dev'],
        port: 3000,
        manifestJson: JSON.stringify({ local: 'read', network: false }),
      })],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();

    const row = Array.from(container.querySelectorAll('div')).find(
      (el) => el.className.includes('cursor-pointer') && el.textContent?.includes('我的应用'),
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useAppRuntimeStore.getState().openedAppId).toBeNull();
    expect(container.textContent).toMatch(/端口|分配/);
  });

  it('N18：后端未启动时双击启动成功后打开 app', async () => {
    invokeMock.mockImplementation(async (command?: string, args?: Record<string, unknown>) => {
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') return args?.preferred ?? 3000;
      if (command === 'start_workspace_background_command') return { pid: 42 };
      if (command === 'check_port_available_structured') return { v4: true, v6: false };
      if (command === 'check_port_owned_by') return true;
      if (command === 'check_port_bind_address') return ['127.0.0.1'];
      if (command === 'check_port_available_detail') return 'listening';
      return undefined;
    });
    useAppRuntimeStore.setState({
      apps: [makeApp({
        command: 'npm',
        args: ['run', 'dev'],
        port: 3000,
        manifestJson: JSON.stringify({ local: 'read', network: false }),
      })],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();

    const row = Array.from(container.querySelectorAll('div')).find(
      (el) => el.className.includes('cursor-pointer') && el.textContent?.includes('我的应用'),
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_workspace_background_command',
      expect.objectContaining({ command: 'npm' }),
    );
    expect(useAppRuntimeStore.getState().openedAppId).toBe('app-1');
    expect(useAppRuntimeStore.getState().apps[0]?.pid).toBe(42);
  });

  it('N18：后端已运行时双击正常打开 app', async () => {
    useAppRuntimeStore.setState({
      apps: [makeApp({ command: 'npm', args: ['run', 'dev'], port: 3000, pid: 42, url: 'http://127.0.0.1:3000' })],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();

    const row = Array.from(container.querySelectorAll('div')).find(
      (el) => el.className.includes('cursor-pointer') && el.textContent?.includes('我的应用'),
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useAppRuntimeStore.getState().openedAppId).toBe('app-1');
  });

  it('N18：无后端 app（纯静态）双击直接打开', async () => {
    useAppRuntimeStore.setState({
      apps: [makeApp()],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();

    const row = Array.from(container.querySelectorAll('div')).find(
      (el) => el.className.includes('cursor-pointer') && el.textContent?.includes('我的应用'),
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useAppRuntimeStore.getState().openedAppId).toBe('app-1');
  });

  it('纯前端 app 用就绪态灰点，不用红点', () => {
    useAppRuntimeStore.setState({
      apps: [makeApp()],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();
    const dot = container.querySelector('span[title="就绪"]');
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain('bg-fg-muted');
    expect(dot?.className).not.toContain('bg-danger');
  });

  it('有后端且未运行时用红点「已停止」', () => {
    useAppRuntimeStore.setState({
      apps: [makeApp({ command: 'node', port: 3000 })],
      activeAppId: 'app-1',
      openedAppId: null,
    });
    renderPanel();
    const dot = container.querySelector('span[title="已停止"]');
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain('bg-danger');
  });

  it('插件行显示徽章；钉住打开 overlay 而不是全屏 App', async () => {
    useAppRuntimeStore.setState({
      apps: [
        makeApp({
          appId: 'stock-ticker',
          title: '股票看板',
          manifestJson: JSON.stringify({ spec: 'papr/0.1', name: '股票看板', kind: 'plugin' }),
        }),
      ],
      activeAppId: 'stock-ticker',
      openedAppId: null,
      pinnedPluginIds: [],
    });
    renderPanel();
    expect(container.textContent).toContain('插件');

    const row = Array.from(container.querySelectorAll('div')).find(
      (el) => el.className.includes('cursor-pointer') && el.textContent?.includes('股票看板'),
    );
    if (!row) throw new Error('Plugin row not found');
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const pin = Array.from(container.querySelectorAll('button')).find((el) => el.textContent?.includes('钉住'));
    if (!pin) throw new Error('Pin button not found');
    act(() => {
      pin.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['stock-ticker']);
    expect(useAppRuntimeStore.getState().openedAppId).toBeNull();
  });
});
