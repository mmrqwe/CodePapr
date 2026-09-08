import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, loadPluginUiMock, savePluginUiMock, workspaceRef } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadPluginUiMock: vi.fn(),
  savePluginUiMock: vi.fn(),
  workspaceRef: { path: '/ws' },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('./store/agentStore', () => ({
  useAgentStore: { getState: () => ({ workspacePath: workspaceRef.path }) },
}));

vi.mock('./papr/pluginUiStorage', async (importOriginal) => {
  const original = await importOriginal<typeof import('./papr/pluginUiStorage')>();
  return {
    ...original,
    loadPluginUi: loadPluginUiMock,
    queueSavePluginUi: savePluginUiMock,
  };
});

const { useAppRuntimeStore } = await import('./store/appRuntimeStore');
const { restoreWorkspaceApps } = await import('./restoreWorkspaceApps');

type Discovered = {
  app_id: string;
  title: string;
  html: string;
  manifest_json: string | null;
  command: string | null;
  args: string[] | null;
  port: number | null;
  icon: string | null;
  scope?: 'workspace' | 'global';
};

function discoveredApp(
  appId: string,
  manifest: Record<string, unknown>,
  scope: 'global' | 'workspace' = 'global',
): Discovered {
  return {
    app_id: appId,
    title: appId,
    html: '',
    manifest_json: JSON.stringify(manifest),
    command: null,
    args: null,
    port: null,
    icon: null,
    scope,
  };
}

function mountRecorder() {
  const mounted: string[] = [];
  const mountApp = (app: {
    appId: string;
    title: string;
    icon?: string;
    html: string;
    filePath: string;
    manifestJson?: string;
    command?: string;
    args?: string[];
    port?: number;
    scope?: 'workspace' | 'global';
  }) => {
    mounted.push(app.appId);
    useAppRuntimeStore.getState().mountApp(app);
  };
  return { mounted, mountApp };
}

function stubInvoke(discovered: Discovered[]): void {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'scan_workspace_apps') return discovered;
    if (cmd === 'list_background_processes') return [];
    return null;
  });
}

const weatherHud = discoveredApp('weather-hud', { spec: 'papr/0.1', name: '天气小组件', kind: 'plugin' });
const explicitTicker = discoveredApp('ticker', {
  spec: 'papr/0.1',
  name: 'Ticker',
  kind: 'plugin',
  lifecycle: { autostart: true, show: 'always' },
});
const plainApp = discoveredApp('dash', { spec: 'papr/0.1', name: 'Dash', kind: 'app' });

describe('restoreWorkspaceApps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRef.path = '/ws';
    loadPluginUiMock.mockResolvedValue({ chrome: {} });
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
      pluginChrome: {},
    });
  });

  it('does not auto-open any plugin in a fresh project, even with explicit autostart/show:always', async () => {
    stubInvoke([weatherHud, explicitTicker, plainApp]);
    const { mounted, mountApp } = mountRecorder();

    await restoreWorkspaceApps('/ws', mountApp);

    expect(mounted).toEqual(['weather-hud', 'ticker', 'dash']);
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    // 未记录的插件仍被挂载并注册为启用态（后台可见性不变，只是不弹 overlay）
    expect(useAppRuntimeStore.getState().pluginChrome['weather-hud']).toMatchObject({
      enabled: true,
      visible: false,
    });
  });

  it('re-pins plugins whose persisted chrome has visible=true', async () => {
    stubInvoke([weatherHud, explicitTicker]);
    loadPluginUiMock.mockResolvedValue({
      chrome: {
        'weather-hud': { enabled: true, visible: true, x: 10, y: 10 },
        ticker: { enabled: true, visible: false },
      },
    });
    const { mountApp } = mountRecorder();

    await restoreWorkspaceApps('/ws', mountApp);

    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['weather-hud']);
  });

  it('keeps disabled plugins disabled and unpinned', async () => {
    stubInvoke([weatherHud]);
    loadPluginUiMock.mockResolvedValue({
      chrome: { 'weather-hud': { enabled: false, visible: false } },
    });
    const { mountApp } = mountRecorder();

    await restoreWorkspaceApps('/ws', mountApp);

    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().pluginChrome['weather-hud']).toMatchObject({
      enabled: false,
      visible: false,
    });
  });

  it('never pins regular (non-plugin) apps', async () => {
    stubInvoke([plainApp]);
    const { mountApp } = mountRecorder();

    await restoreWorkspaceApps('/ws', mountApp);

    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().pluginChrome).toEqual({});
  });

  it('aborts when the workspace changed while scanning', async () => {
    stubInvoke([weatherHud]);
    loadPluginUiMock.mockImplementation(async () => {
      workspaceRef.path = '/other';
      return { chrome: {} };
    });
    const { mounted, mountApp } = mountRecorder();

    await restoreWorkspaceApps('/ws', mountApp);

    expect(mounted).toEqual([]);
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
  });
});
