import { beforeEach, describe, expect, it } from 'vitest';
import { useAppRuntimeStore } from './appRuntimeStore';

const pluginManifest = JSON.stringify({ spec: 'papr/0.1', name: 'Ticker', kind: 'plugin' });

function mountTicker(): void {
  useAppRuntimeStore.getState().mountApp({
    appId: 'ticker',
    title: 'Ticker',
    html: '',
    filePath: 'y',
    manifestJson: pluginManifest,
  });
}

describe('appRuntimeStore plugins', () => {
  beforeEach(() => {
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
      pluginChrome: {},
    });
  });

  it('pins plugins and refuses to pin regular apps', () => {
    useAppRuntimeStore.getState().mountApp({
      appId: 'dash',
      title: 'Dash',
      html: '',
      filePath: 'x',
      manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Dash', kind: 'app' }),
    });
    mountTicker();

    useAppRuntimeStore.getState().pinPlugin('dash');
    useAppRuntimeStore.getState().pinPlugin('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.enabled).toBe(true);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.visible).toBe(true);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.placement).toBe('float');

    useAppRuntimeStore.getState().openAppModal('ticker');
    expect(useAppRuntimeStore.getState().openedAppId).toBeNull();
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);

    useAppRuntimeStore.getState().openAppModal('dash');
    expect(useAppRuntimeStore.getState().openedAppId).toBe('dash');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);
  });

  it('bumps mountSignal on mount but silent restores do not', () => {
    useAppRuntimeStore.setState({ mountSignal: 0 });
    useAppRuntimeStore.getState().mountApp(
      { appId: 'dash', title: 'Dash', html: '', filePath: 'x' },
      { silent: true },
    );
    expect(useAppRuntimeStore.getState().mountSignal).toBe(0);
    expect(useAppRuntimeStore.getState().apps.map((app) => app.appId)).toEqual(['dash']);

    useAppRuntimeStore.getState().mountApp({ appId: 'ticker', title: 'Ticker', html: '', filePath: 'y' });
    expect(useAppRuntimeStore.getState().mountSignal).toBe(1);
  });

  it('does not bump mountSignal when mounting a plugin', () => {
    useAppRuntimeStore.setState({ mountSignal: 0 });
    useAppRuntimeStore.getState().mountApp({
      appId: 'ticker',
      title: 'Ticker',
      html: '',
      filePath: 'y',
      manifestJson: pluginManifest,
    });
    expect(useAppRuntimeStore.getState().mountSignal).toBe(0);
    expect(useAppRuntimeStore.getState().apps.map((app) => app.appId)).toEqual(['ticker']);

    useAppRuntimeStore.getState().mountApp({
      appId: 'dash',
      title: 'Dash',
      html: '',
      filePath: 'x',
      manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Dash', kind: 'app' }),
    });
    expect(useAppRuntimeStore.getState().mountSignal).toBe(1);
  });

  it('unpin keeps overlay geometry and stays enabled', () => {
    mountTicker();
    useAppRuntimeStore.getState().pinPlugin('ticker');
    useAppRuntimeStore.getState().setOverlayLayout('ticker', {
      x: 10,
      y: 20,
      width: 320,
      height: 200,
      sizeSource: 'user',
    });
    useAppRuntimeStore.getState().unpinPlugin('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().overlayLayouts.ticker).toEqual({
      x: 10,
      y: 20,
      width: 320,
      height: 200,
      sizeSource: 'user',
    });
    expect(useAppRuntimeStore.getState().pluginChrome.ticker).toMatchObject({
      enabled: true,
      visible: false,
      x: 10,
      y: 20,
      width: 320,
      height: 200,
    });
  });

  it('enable without pin keeps overlay hidden', () => {
    mountTicker();
    useAppRuntimeStore.getState().enablePlugin('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker).toMatchObject({
      enabled: true,
      visible: false,
    });
  });

  it('disable unpins and records enabled=false', () => {
    mountTicker();
    useAppRuntimeStore.getState().pinPlugin('ticker');
    useAppRuntimeStore.getState().disablePlugin('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker).toMatchObject({
      enabled: false,
      visible: false,
    });
  });

  it('closeApp drops pin state and chrome', () => {
    mountTicker();
    useAppRuntimeStore.getState().pinPlugin('ticker');
    useAppRuntimeStore.getState().setOverlayLayout('ticker', {
      x: 10,
      y: 10,
      width: 320,
      height: 200,
    });
    useAppRuntimeStore.getState().closeApp('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().overlayLayouts).toEqual({});
    expect(useAppRuntimeStore.getState().pluginChrome).toEqual({});
  });

  it('hydratePluginUi restores layouts without pinning', () => {
    useAppRuntimeStore.getState().hydratePluginUi({
      chrome: {
        ticker: { enabled: true, visible: true, x: 40, y: 80, width: 360, height: 220, sizeSource: 'user' },
        hidden: { enabled: false, visible: false, x: 1, y: 2, width: 200, height: 120 },
      },
    });
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().overlayLayouts.ticker).toMatchObject({ x: 40, y: 80, width: 360, height: 220 });
    expect(useAppRuntimeStore.getState().pluginChrome.hidden.enabled).toBe(false);
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.visible).toBe(true);
    expect(useAppRuntimeStore.getState().pluginChrome.hidden.visible).toBe(false);
  });

  it('docks inbox plugins on first pin even when the manifest declares an overlay surface', () => {
    useAppRuntimeStore.getState().mountApp({
      appId: 'board',
      title: 'Board',
      html: '',
      filePath: 'z',
      manifestJson: JSON.stringify({
        spec: 'papr/0.1',
        name: 'Board',
        kind: 'plugin',
        surface: { type: 'overlay', width: 420, height: 280, position: 'top-right' },
        inbox: { cards: { description: '卡片' } },
      }),
    });
    useAppRuntimeStore.getState().pinPlugin('board');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['board']);
    expect(useAppRuntimeStore.getState().pluginChrome.board.placement).toBe('right');
  });

  it('docks one plugin at a time and undocks back to float', () => {
    mountTicker();
    useAppRuntimeStore.getState().mountApp({
      appId: 'board',
      title: 'Board',
      html: '',
      filePath: 'z',
      manifestJson: JSON.stringify({
        spec: 'papr/0.1',
        name: 'Board',
        kind: 'plugin',
        inbox: { cards: { description: '卡片' } },
      }),
    });
    useAppRuntimeStore.getState().pinPlugin('board');
    expect(useAppRuntimeStore.getState().pluginChrome.board.placement).toBe('right');
    useAppRuntimeStore.getState().dockPlugin('ticker');
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.placement).toBe('right');
    expect(useAppRuntimeStore.getState().pluginChrome.board.placement).toBe('float');
    useAppRuntimeStore.getState().undockPlugin('ticker');
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.placement).toBe('float');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toContain('ticker');
  });
});
