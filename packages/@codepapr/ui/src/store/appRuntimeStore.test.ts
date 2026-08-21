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

    useAppRuntimeStore.getState().openAppModal('ticker');
    expect(useAppRuntimeStore.getState().openedAppId).toBeNull();
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);

    useAppRuntimeStore.getState().openAppModal('dash');
    expect(useAppRuntimeStore.getState().openedAppId).toBe('dash');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);
  });

  it('unpin keeps overlay geometry and records enabled=false', () => {
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
      enabled: false,
      x: 10,
      y: 20,
      width: 320,
      height: 200,
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
        ticker: { enabled: true, x: 40, y: 80, width: 360, height: 220, sizeSource: 'user' },
        hidden: { enabled: false, x: 1, y: 2, width: 200, height: 120 },
      },
    });
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().overlayLayouts.ticker).toMatchObject({ x: 40, y: 80, width: 360, height: 220 });
    expect(useAppRuntimeStore.getState().pluginChrome.hidden.enabled).toBe(false);
  });
});
