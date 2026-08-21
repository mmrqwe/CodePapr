import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { parsePluginUiState } from './pluginUiStorage';

describe('parsePluginUiState', () => {
  it('returns empty chrome for garbage input', () => {
    expect(parsePluginUiState(null)).toEqual({ chrome: {} });
    expect(parsePluginUiState('nope')).toEqual({ chrome: {} });
    expect(parsePluginUiState({ chrome: [] })).toEqual({ chrome: {} });
  });

  it('keeps finite geometry and drops path-shaped ids', () => {
    const parsed = parsePluginUiState({
      chrome: {
        ticker: { enabled: false, x: 12, y: 40, width: 320, height: 180, sizeSource: 'user' },
        'a/b': { enabled: true, x: 1, y: 1 },
        broken: { enabled: true, x: 'nope', width: 999 },
      },
    });
    expect(parsed.chrome.ticker).toEqual({
      enabled: false,
      x: 12,
      y: 40,
      width: 320,
      height: 180,
      sizeSource: 'user',
    });
    expect(parsed.chrome['a/b']).toBeUndefined();
    expect(parsed.chrome.broken).toEqual({
      enabled: true,
      x: undefined,
      y: undefined,
      width: 999,
      height: undefined,
      sizeSource: undefined,
    });
  });
});
