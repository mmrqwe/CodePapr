// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { PluginOverlayHost } from './PluginOverlayHost';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function pluginApp() {
  return {
    appId: 'stock-ticker',
    title: '股票看板',
    icon: '📈',
    html: '',
    filePath: '.CodePapr/apps/stock-ticker/index.html',
    createdAt: 1,
    updatedAt: 1,
    manifestJson: JSON.stringify({
      spec: 'papr/0.1',
      name: '股票看板',
      kind: 'plugin',
      surface: { type: 'overlay', width: 320, height: 200, position: 'top-right' },
      local: 'none',
      network: true,
    }),
  };
}

describe('PluginOverlayHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
      mountSignal: 0,
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
    usePaprPermissionStore.getState().clearAll();
  });

  it('renders a pinned plugin overlay iframe', async () => {
    useAppRuntimeStore.setState({
      apps: [pluginApp()],
      pinnedPluginIds: ['stock-ticker'],
      openedAppId: null,
    });

    await act(async () => {
      root.render(<PluginOverlayHost lang="zh-CN" />);
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('codepapr-app://stock-ticker/index.html');
    expect(container.textContent).toContain('股票看板');
  });

  it('hides overlays while a fullscreen app is open without unmounting the iframe', async () => {
    useAppRuntimeStore.setState({
      apps: [pluginApp()],
      pinnedPluginIds: ['stock-ticker'],
      openedAppId: 'other-app',
    });

    await act(async () => {
      root.render(<PluginOverlayHost lang="zh-CN" />);
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('codepapr-app://stock-ticker/index.html');
    const card = container.querySelector('[data-plugin-overlay="stock-ticker"]');
    expect(card?.className).toContain('invisible');
    expect(card?.className).toContain('pointer-events-none');
    expect(card?.getAttribute('aria-hidden')).toBe('true');
  });

  it('unpins from the overlay close button', async () => {
    useAppRuntimeStore.setState({
      apps: [pluginApp()],
      pinnedPluginIds: ['stock-ticker'],
      openedAppId: null,
    });

    await act(async () => {
      root.render(<PluginOverlayHost lang="zh-CN" />);
    });

    const close = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === '收起',
    );
    expect(close).toBeTruthy();
    await act(async () => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
  });
});
