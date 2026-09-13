import { describe, expect, it } from 'vitest';
import {
  applyOverlayResize,
  clampOverlaySize,
  defaultOverlayOrigin,
  isPluginApp,
  overlayFromSetSize,
  OVERLAY_CHROME_HEIGHT,
  parsePluginSurfaceArg,
  parsePaprKind,
  pluginIsEnabled,
  pluginShouldAutostartOverlay,
  defaultPluginPlacement,
  resolveShowPlacement,
  selectDockedPluginId,
  resolvePluginShowPolicy,
  shouldRevealOnPublish,
  resolveOverlaySurface,
  resolvePaprEntryFile,
} from './pluginSurface';

describe('pluginSurface', () => {
  it('treats missing kind as app', () => {
    expect(parsePaprKind({ spec: 'papr/0.1', name: 'X' })).toBe('app');
    expect(isPluginApp({ manifestJson: '{"spec":"papr/0.1","name":"X"}' })).toBe(false);
  });

  it('detects plugin apps from manifestJson', () => {
    expect(
      isPluginApp({
        manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Ticker', kind: 'plugin' }),
      }),
    ).toBe(true);
  });

  it('resolves overlay defaults and keeps min size without a 720 cap', () => {
    expect(resolveOverlaySurface(null)).toEqual({
      type: 'overlay',
      width: 320,
      height: 200,
      position: 'top-right',
    });
    expect(
      resolveOverlaySurface({
        spec: 'papr/0.1',
        name: 'X',
        surface: { type: 'overlay', width: 9999, height: 10, position: 'bottom-left' },
      }),
    ).toMatchObject({ type: 'overlay', width: 9999, height: 100, position: 'bottom-left' });
    const clamped = clampOverlaySize({ width: 9999, height: 10 }, { width: 1200, height: 800 });
    expect(clamped.width).toBe(1200 - 16);
    expect(clamped.height).toBe(100);
  });

  it('accepts panel surfaces and rejects unknown types', () => {
    expect(parsePluginSurfaceArg({ type: 'panel' }).type).toBe('panel');
    expect(() => parsePluginSurfaceArg({ type: 'hud' })).toThrow(/overlay.*panel|panel.*overlay/);
    expect(parsePluginSurfaceArg(undefined).type).toBe('overlay');
    expect(parsePluginSurfaceArg({ type: '' }).type).toBe('overlay');
  });

  it('defaults inbox plugins to right dock unless chrome has geometry or an explicit placement', () => {
    const board = {
      spec: 'papr/0.1' as const,
      name: '看板',
      kind: 'plugin' as const,
      inbox: { cards: { description: '卡片' } },
    };
    const ticker = { spec: 'papr/0.1' as const, name: '行情', kind: 'plugin' as const };
    expect(defaultPluginPlacement(board)).toBe('right');
    expect(defaultPluginPlacement(ticker)).toBe('float');
    expect(
      defaultPluginPlacement({
        ...board,
        surface: { type: 'overlay', width: 420, height: 280, position: 'top-right' },
      }),
    ).toBe('right');
    expect(defaultPluginPlacement({ ...ticker, surface: { type: 'panel', width: 320, height: 200 } })).toBe('right');
    expect(defaultPluginPlacement({ ...ticker, surface: { type: 'overlay', width: 320, height: 200 } })).toBe('float');
    expect(resolveShowPlacement(board, undefined)).toBe('right');
    expect(resolveShowPlacement(board, { x: 10, y: 20 })).toBe('float');
    expect(resolveShowPlacement(board, { placement: 'right', x: 10, y: 20 })).toBe('right');
    expect(resolveShowPlacement(board, { placement: 'float' })).toBe('float');
    expect(selectDockedPluginId({
      apps: [{ appId: 'board', manifestJson: JSON.stringify(board) }],
      pinnedPluginIds: ['board'],
      pluginChrome: { board: { placement: 'right' } },
    })).toBe('board');
  });

  it('places default origin in the requested corner', () => {
    const size = { width: 320, height: 200 };
    const viewport = { width: 1000, height: 800 };
    const topRight = defaultOverlayOrigin('top-right', size, viewport, 0);
    expect(topRight.x).toBeGreaterThan(600);
    expect(topRight.y).toBeLessThan(80);
    const bottomLeft = defaultOverlayOrigin('bottom-left', size, viewport, 0);
    expect(bottomLeft.x).toBeLessThan(40);
    expect(bottomLeft.y).toBeGreaterThan(500);
  });

  it('keeps entry files without path traversal', () => {
    expect(resolvePaprEntryFile({ spec: 'papr/0.1', name: 'X', entry: 'app.html' })).toBe('app.html');
    expect(resolvePaprEntryFile({ spec: 'papr/0.1', name: 'X', entry: '../secret.html' })).toBe('index.html');
  });

  it('enables from user chrome, else autostart default true', () => {
    const plugin = { spec: 'papr/0.1' as const, name: 'X', kind: 'plugin' as const };
    expect(pluginIsEnabled(plugin, undefined)).toBe(true);
    expect(pluginIsEnabled({ ...plugin, lifecycle: { autostart: false } }, undefined)).toBe(false);
    expect(pluginIsEnabled({ ...plugin, lifecycle: { autostart: false } }, { enabled: true })).toBe(true);
    expect(pluginIsEnabled(plugin, { enabled: false })).toBe(false);
  });

  it('autostarts overlay for widgets, not inbox plugins, unless chrome.visible says so', () => {
    const widget = { spec: 'papr/0.1' as const, name: 'X', kind: 'plugin' as const };
    const board = {
      ...widget,
      inbox: { cards: { description: '看板' } },
    };
    expect(resolvePluginShowPolicy(widget)).toBe('always');
    expect(resolvePluginShowPolicy(board)).toBe('onDemand');
    expect(resolvePluginShowPolicy({ ...board, lifecycle: { show: 'never' } })).toBe('never');
    expect(pluginShouldAutostartOverlay(widget, undefined)).toBe(true);
    expect(pluginShouldAutostartOverlay(board, undefined)).toBe(false);
    expect(pluginShouldAutostartOverlay(board, { enabled: true, visible: true })).toBe(true);
    expect(pluginShouldAutostartOverlay(widget, { enabled: true, visible: false })).toBe(false);
    expect(pluginShouldAutostartOverlay(widget, { enabled: false })).toBe(false);
  });

  it('reveals onDemand plugins on publish only when enabled and hidden', () => {
    const board = {
      spec: 'papr/0.1' as const,
      name: 'X',
      kind: 'plugin' as const,
      inbox: { cards: { description: '看板' } },
    };
    expect(shouldRevealOnPublish(board, { enabled: true }, false)).toBe(true);
    expect(shouldRevealOnPublish(board, { enabled: true }, true)).toBe(false);
    expect(shouldRevealOnPublish(board, { enabled: false }, false)).toBe(false);
    expect(shouldRevealOnPublish({ spec: 'papr/0.1', name: 'X', kind: 'plugin' }, { enabled: true }, false)).toBe(false);
  });

  it('resizes from the south-east handle and maps content setSize onto overlay height', () => {
    const start = { x: 100, y: 80, width: 320, height: 200, sizeSource: 'manifest' as const };
    expect(applyOverlayResize(start, 'se', 40, 20)).toMatchObject({
      x: 100,
      y: 80,
      width: 360,
      height: 220,
      sizeSource: 'user',
    });
    const west = applyOverlayResize(start, 'w', 30, 0);
    expect(west.x).toBe(130);
    expect(west.width).toBe(290);
    expect(overlayFromSetSize(start, { width: 300, height: 120 }).height).toBe(120 + OVERLAY_CHROME_HEIGHT);
    expect(overlayFromSetSize(start, { width: 300, height: 180, box: 'overlay' }).height).toBe(180);
  });
});
