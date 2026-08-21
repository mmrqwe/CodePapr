import { describe, expect, it } from 'vitest';
import {
  applyOverlayResize,
  defaultOverlayOrigin,
  isPluginApp,
  overlayFromSetSize,
  OVERLAY_CHROME_HEIGHT,
  parsePluginSurfaceArg,
  parsePaprKind,
  pluginShouldShow,
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

  it('resolves overlay defaults and clamps size', () => {
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
    ).toMatchObject({ width: 720, height: 100, position: 'bottom-left' });
  });

  it('rejects non-overlay surfaces at render time', () => {
    expect(() => parsePluginSurfaceArg({ type: 'hud' })).toThrow(/overlay/);
    expect(parsePluginSurfaceArg(undefined).type).toBe('overlay');
    expect(parsePluginSurfaceArg({ type: '' }).type).toBe('overlay');
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

  it('shows plugins from user chrome, else autostart default true', () => {
    const plugin = { spec: 'papr/0.1' as const, name: 'X', kind: 'plugin' as const };
    expect(pluginShouldShow(plugin, undefined)).toBe(true);
    expect(pluginShouldShow({ ...plugin, lifecycle: { autostart: false } }, undefined)).toBe(false);
    expect(pluginShouldShow({ ...plugin, lifecycle: { autostart: false } }, { enabled: true })).toBe(true);
    expect(pluginShouldShow(plugin, { enabled: false })).toBe(false);
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
