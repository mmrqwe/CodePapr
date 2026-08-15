// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const defineThemeMock = vi.hoisted(() => vi.fn());
const setThemeMock = vi.hoisted(() => vi.fn());

vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({
  editor: {
    defineTheme: defineThemeMock,
    setTheme: setThemeMock,
  },
}));

const themeStoreState = vi.hoisted(() => ({
  resolvedThemeId: 'paper-dark',
  accent: null as string | null,
  customThemes: {} as Record<string, unknown>,
}));

vi.mock('../store/themeStore', () => ({
  useThemeStore: {
    getState: () => themeStoreState,
  },
}));

import {
  applyActiveMonacoTheme,
  detectMonacoThemeName,
  ensureMonacoThemeSync,
  monacoThemeNameFor,
  registerMonacoTheme,
} from './monacoThemes';
import { getBuiltinTheme } from './themes';

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  defineThemeMock.mockClear();
  setThemeMock.mockClear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  delete (window as unknown as { __monacoSync?: boolean }).__monacoSync;
});

describe('detectMonacoThemeName', () => {
  it('falls back to vs/vs-dark when no data-theme is set', () => {
    document.documentElement.classList.add('dark');
    expect(detectMonacoThemeName()).toBe('vs-dark');
    document.documentElement.classList.remove('dark');
    expect(detectMonacoThemeName()).toBe('vs');
  });

  it('returns a generated theme name for data-theme', () => {
    document.documentElement.dataset.theme = 'nord';
    expect(detectMonacoThemeName()).toBe(monacoThemeNameFor('nord'));
  });
});

describe('registerMonacoTheme', () => {
  it('defines a theme from tokens with base/colors/rules', () => {
    const nord = getBuiltinTheme('nord')!;
    const name = registerMonacoTheme(nord.id, nord.tokens, nord.mode, null);
    expect(name).toBe(monacoThemeNameFor('nord'));
    expect(defineThemeMock).toHaveBeenCalledTimes(1);
    const [themeName, definition] = defineThemeMock.mock.calls[0] as [
      string,
      { base: string; colors: Record<string, string>; rules: Array<{ token: string; foreground?: string }> },
    ];
    expect(themeName).toBe(name);
    expect(definition.base).toBe('vs-dark');
    expect(definition.colors['editor.background']).toBe(nord.tokens['code-bg']);
    expect(definition.rules.length).toBeGreaterThan(10);
    const keyword = definition.rules.find((rule) => rule.token === 'keyword');
    expect(keyword?.foreground).toBe(nord.tokens['accent']);
  });

  it('is idempotent per theme and accent', () => {
    const midnight = getBuiltinTheme('midnight')!;
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, null);
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, null);
    expect(defineThemeMock).toHaveBeenCalledTimes(1);
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, '#ff0000');
    expect(defineThemeMock).toHaveBeenCalledTimes(2);
  });

  it('derives accent tokens from the accent override', () => {
    const solarized = getBuiltinTheme('solarized-dark')!;
    registerMonacoTheme(solarized.id, solarized.tokens, solarized.mode, '#ff0000');
    const definition = defineThemeMock.mock.calls[0][1] as {
      rules: Array<{ token: string; foreground?: string }>;
    };
    const keyword = definition.rules.find((rule) => rule.token === 'keyword');
    expect(keyword?.foreground).toBe('#ff0000');
  });
});

describe('applyActiveMonacoTheme', () => {
  it('applies the fallback theme without data-theme', () => {
    document.documentElement.classList.add('dark');
    expect(applyActiveMonacoTheme()).toBe('vs-dark');
    expect(setThemeMock).toHaveBeenCalledWith('vs-dark');
  });

  it('registers and applies the active custom theme with accent', () => {
    const custom = {
      name: 'Custom',
      mode: 'light' as const,
      tokens: { 'bg-base': '#abcabc', 'accent': '#654321' },
    };
    themeStoreState.customThemes = { 'custom-1': custom };
    themeStoreState.accent = '#ff0000';
    document.documentElement.dataset.theme = 'custom-1';
    const name = applyActiveMonacoTheme();
    expect(name).toBe(monacoThemeNameFor('custom-1'));
    expect(setThemeMock).toHaveBeenCalledWith(name);
    const definition = defineThemeMock.mock.calls[0][1] as {
      rules: Array<{ token: string; foreground?: string }>;
    };
    const keyword = definition.rules.find((rule) => rule.token === 'keyword');
    expect(keyword?.foreground).toBe('#ff0000');
    themeStoreState.customThemes = {};
    themeStoreState.accent = null;
  });
});

describe('ensureMonacoThemeSync', () => {
  it('applies the active theme once and reacts to theme-change events', () => {
    document.documentElement.classList.add('dark');
    ensureMonacoThemeSync();
    expect(setThemeMock).toHaveBeenCalledWith('vs-dark');
    setThemeMock.mockClear();

    document.documentElement.dataset.theme = 'nord';
    window.dispatchEvent(new CustomEvent('codepapr-theme-changed'));
    expect(setThemeMock).toHaveBeenCalledWith(monacoThemeNameFor('nord'));
  });
});
