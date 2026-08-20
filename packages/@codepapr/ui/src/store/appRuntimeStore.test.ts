import { beforeEach, describe, expect, it } from 'vitest';
import { useAppRuntimeStore } from './appRuntimeStore';

describe('appRuntimeStore plugins', () => {
  beforeEach(() => {
    useAppRuntimeStore.setState({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
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
    useAppRuntimeStore.getState().mountApp({
      appId: 'ticker',
      title: 'Ticker',
      html: '',
      filePath: 'y',
      manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Ticker', kind: 'plugin' }),
    });

    useAppRuntimeStore.getState().pinPlugin('dash');
    useAppRuntimeStore.getState().pinPlugin('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);

    useAppRuntimeStore.getState().openAppModal('ticker');
    expect(useAppRuntimeStore.getState().openedAppId).toBeNull();
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);

    useAppRuntimeStore.getState().openAppModal('dash');
    expect(useAppRuntimeStore.getState().openedAppId).toBe('dash');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);
  });

  it('closeApp and clearApps drop pin state', () => {
    useAppRuntimeStore.getState().mountApp({
      appId: 'ticker',
      title: 'Ticker',
      html: '',
      filePath: 'y',
      manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Ticker', kind: 'plugin' }),
    });
    useAppRuntimeStore.getState().pinPlugin('ticker');
    useAppRuntimeStore.getState().setOverlayLayout('ticker', { x: 10, y: 10 });
    useAppRuntimeStore.getState().closeApp('ticker');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().overlayLayouts).toEqual({});
  });
});
