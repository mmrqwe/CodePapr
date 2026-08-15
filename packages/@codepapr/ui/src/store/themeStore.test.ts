// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const setSettingsMock = vi.hoisted(() => vi.fn());

vi.mock('./agentStore', () => ({
  useAgentStore: {
    getState: () => ({ setSettings: setSettingsMock }),
  },
}));

import { useThemeStore } from './themeStore';
import { THEME_STYLE_ID } from '../theme/themeEngine';
import type { CustomThemeRecord } from '../theme/types';

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

function resetDom() {
  document.getElementById(THEME_STYLE_ID)?.remove();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
}

function resetStore() {
  useThemeStore.setState({
    themeId: null,
    accent: null,
    customThemes: {},
    resolvedThemeId: 'paper-dark',
    mode: 'dark',
  });
}

afterEach(() => {
  resetDom();
  resetStore();
  setSettingsMock.mockClear();
});

describe('themeStore.applyFromSettings', () => {
  it('follows system when theme is null and applies resolved theme to DOM', () => {
    // matchMedia 桩固定返回 matches: false → 系统浅色
    useThemeStore.getState().applyFromSettings({ theme: null, accent: null, customThemes: {} });
    const state = useThemeStore.getState();
    expect(state.resolvedThemeId).toBe('paper-light');
    expect(state.mode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('paper-light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(setSettingsMock).not.toHaveBeenCalled();
  });

  it('applies explicit themes and custom themes with aux fallback', () => {
    const custom: CustomThemeRecord = {
      name: 'Custom',
      mode: 'light',
      tokens: {
        'bg-base': '#abcabc',
        'foreground': '#123456',
        'accent': '#654321',
      },
    };
    useThemeStore
      .getState()
      .applyFromSettings({ theme: 'custom-1', accent: null, customThemes: { 'custom-1': custom } });
    const state = useThemeStore.getState();
    expect(state.resolvedThemeId).toBe('custom-1');
    expect(state.mode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('custom-1');
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).toContain('--bg-base: #abcabc');
    expect(style.textContent).toContain('--accent: #654321');
  });

  it('falls back to system theme for unknown theme ids', () => {
    useThemeStore
      .getState()
      .applyFromSettings({ theme: 'bogus', accent: null, customThemes: {} });
    const state = useThemeStore.getState();
    expect(state.resolvedThemeId).not.toBe('bogus');
  });
});

describe('themeStore.setTheme / setAccent', () => {
  it('setTheme applies DOM and persists through agentStore.setSettings', () => {
    useThemeStore.getState().setTheme('nord');
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(useThemeStore.getState().themeId).toBe('nord');
    expect(setSettingsMock).toHaveBeenCalledWith({ theme: 'nord' }, { preserveAgent: true });
  });

  it('setTheme(null) returns to system follow', () => {
    useThemeStore.getState().setTheme('nord');
    useThemeStore.getState().setTheme(null);
    expect(useThemeStore.getState().themeId).toBeNull();
    expect(document.documentElement.dataset.theme).not.toBe('nord');
    expect(setSettingsMock).toHaveBeenLastCalledWith({ theme: null }, { preserveAgent: true });
  });

  it('setAccent injects an accent override block after theme tokens', () => {
    useThemeStore.getState().setTheme('paper-dark');
    useThemeStore.getState().setAccent('#ff0000');
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).toContain('--accent: #ff0000;');
    const themeAccentIndex = style.textContent.indexOf('--accent: #6366F1;');
    const overrideIndex = style.textContent.indexOf('--accent: #ff0000;');
    expect(overrideIndex).toBeGreaterThan(themeAccentIndex);
    expect(setSettingsMock).toHaveBeenLastCalledWith({ accent: '#ff0000' }, { preserveAgent: true });
  });

  it('setAccent(null) restores the theme accent', () => {
    useThemeStore.getState().setTheme('paper-dark');
    useThemeStore.getState().setAccent('#ff0000');
    useThemeStore.getState().setAccent(null);
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).not.toContain('--accent: #ff0000;');
    expect(style.textContent).toContain('--accent: #6366F1;');
  });
});

describe('themeStore.syncFromSystem', () => {
  it('ignores system changes when an explicit theme is set', () => {
    useThemeStore.getState().setTheme('midnight');
    const before = useThemeStore.getState().resolvedThemeId;
    useThemeStore.getState().syncFromSystem(true);
    expect(useThemeStore.getState().resolvedThemeId).toBe(before);
  });

  it('re-resolves when following system', () => {
    useThemeStore.getState().applyFromSettings({ theme: null, accent: null, customThemes: {} });
    useThemeStore.getState().syncFromSystem(true);
    expect(useThemeStore.getState().resolvedThemeId).toBe('paper-dark');
    useThemeStore.getState().syncFromSystem(false);
    expect(useThemeStore.getState().resolvedThemeId).toBe('paper-light');
  });
});
