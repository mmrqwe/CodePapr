// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { AppModal } from './AppModal';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dispatchReadyHandshake(iframe: HTMLIFrameElement | null): void {
  if (!iframe) throw new Error('Expected iframe to exist.');
  const event = new MessageEvent('message', { data: { __papr: true, type: 'papr://app-ready' } });
  Object.defineProperty(event, 'origin', { value: 'codepapr-app://app-1' });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

describe('AppModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      mountSignal: 0,
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
      mountSignal: 0,
      pinnedPluginIds: [],
      overlayLayouts: {},
    });
    usePaprPermissionStore.getState().clearAll();
  });

  it('#15 uses manifest.entry as the iframe entry file, falling back to index.html', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/app-1/custom.html',
          createdAt: 1,
          updatedAt: 2,
          manifestJson: JSON.stringify({ name: 'Test App', entry: 'custom.html' }),
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('codepapr-app://app-1/custom.html');
    expect(iframe?.getAttribute('sandbox')).toContain('allow-downloads');

    // 无 entry → 默认 index.html
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-2',
          title: 'Default Entry',
          html: '',
          filePath: '.CodePapr/apps/app-2/index.html',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      openedAppId: 'app-2',
    });
    await flush();

    const iframe2 = container.querySelector('iframe');
    expect(iframe2?.getAttribute('src')).toBe('codepapr-app://app-2/index.html');
  });

  it('#16 shows a load-failed error when onLoad fires but the SDK ready handshake never arrives', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/app-1/index.html',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    // 协议层错误页（404/403）同样触发 onLoad：模拟"有响应但无 SDK 握手"。
    await act(async () => {
      iframe?.dispatchEvent(new Event('load'));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    });

    expect(container.textContent).toContain('failed to initialize');
  });

  it('#16 clears the load detection when the SDK ready handshake arrives', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/app-1/index.html',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    await act(async () => {
      // 真实页面：SDK（head 内同步脚本）先于 onLoad 发握手。
      dispatchReadyHandshake(iframe);
      iframe?.dispatchEvent(new Event('load'));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    });

    expect(container.textContent).not.toContain('failed to initialize');
  });

  it('setAppStopped 不关闭已打开的窗口，并提示后端已停止', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/app-1/index.html',
          createdAt: 1,
          updatedAt: 2,
          command: 'node',
          args: ['server.js'],
          port: 3456,
          pid: 99,
          url: 'http://localhost:3456/',
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });
    expect(container.textContent).not.toContain('Backend stopped');

    act(() => {
      useAppRuntimeStore.getState().setAppStopped('app-1');
    });
    await flush();

    expect(useAppRuntimeStore.getState().openedAppId).toBe('app-1');
    expect(container.querySelector('iframe')).toBeTruthy();
    expect(container.textContent).toContain('Backend stopped');
    expect(container.textContent).toContain('Restart');
  });

  it('Info 展示两轴访问档，不再展示废弃的 permissions[]', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/app-1/index.html',
          createdAt: 1,
          updatedAt: 2,
          manifestJson: JSON.stringify({
            local: 'read',
            network: false,
            permissions: ['storage:read', 'http:get'],
            agents: [{ name: 'assistant' }],
          }),
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });

    const info = Array.from(container.querySelectorAll('button')).find((el) => el.textContent?.includes('Info'));
    expect(info).toBeTruthy();
    act(() => {
      info?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('Local: read');
    expect(container.textContent).toContain('Network: offline');
    expect(container.textContent).toContain('assistant');
    expect(container.textContent).not.toContain('storage:read');
    expect(container.textContent).not.toContain('http:get');
  });

  it('shows iframe console entries forwarded over papr://console', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'app-1',
          title: 'Test App',
          html: '',
          filePath: '.CodePapr/apps/app-1/index.html',
          createdAt: 1,
          updatedAt: 2,
          manifestJson: JSON.stringify({ local: 'none', network: false }),
        },
      ],
      openedAppId: 'app-1',
    });

    await act(async () => {
      root.render(<AppModal lang="en" />);
    });

    const iframe = container.querySelector('iframe');
    const toggle = Array.from(container.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Console'),
    );
    expect(toggle).toBeTruthy();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const event = new MessageEvent('message', {
      data: {
        __papr: true,
        type: 'papr://console',
        payload: { level: 'error', message: 'hello from app', ts: 1 },
      },
    });
    Object.defineProperty(event, 'origin', { value: 'codepapr-app://app-1' });
    Object.defineProperty(event, 'source', { value: iframe?.contentWindow });
    act(() => {
      window.dispatchEvent(event);
    });
    await flush();

    expect(container.textContent).toContain('hello from app');
  });
});
