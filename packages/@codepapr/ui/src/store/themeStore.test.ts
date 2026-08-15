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
    lightTheme: 'paper-light',
    darkTheme: 'paper-dark',
    followSystem: true,
    mode: 'light',
    accent: null,
    customThemes: {},
    resolvedThemeId: 'paper-light',
  });
}

const BASE = {
  lightTheme: 'paper-light',
  darkTheme: 'paper-dark',
  followSystem: true,
  themeMode: 'light' as const,
  accent: null,
  customThemes: {},
};

afterEach(() => {
  resetDom();
  resetStore();
  setSettingsMock.mockClear();
});

describe('themeStore.applyFromSettings', () => {
  it('follows system when enabled (matchMedia 桩 → 浅色) and applies resolved theme', () => {
    useThemeStore.getState().applyFromSettings({ ...BASE, darkTheme: 'nord' });
    const state = useThemeStore.getState();
    expect(state.mode).toBe('light');
    expect(state.resolvedThemeId).toBe('paper-light');
    expect(document.documentElement.dataset.theme).toBe('paper-light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(setSettingsMock).not.toHaveBeenCalled();
  });

  it('uses themeMode when not following system', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
      darkTheme: 'midnight',
    });
    const state = useThemeStore.getState();
    expect(state.mode).toBe('dark');
    expect(state.resolvedThemeId).toBe('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies custom themes with aux fallback', () => {
    const custom: CustomThemeRecord = {
      name: 'Custom',
      mode: 'light',
      tokens: {
        'bg-base': '#abcabc',
        'foreground': '#123456',
        'accent': '#654321',
      },
    };
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'light',
      lightTheme: 'custom-1',
      customThemes: { 'custom-1': custom },
    });
    expect(document.documentElement.dataset.theme).toBe('custom-1');
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).toContain('--bg-base: #abcabc');
    expect(style.textContent).toContain('--accent: #654321');
  });

  it('falls back to the default theme for unknown theme ids', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
      darkTheme: 'bogus',
    });
    expect(useThemeStore.getState().resolvedThemeId).toBe('paper-dark');
    expect(document.documentElement.dataset.theme).toBe('paper-dark');
  });
});

describe('themeStore.setLightTheme / setDarkTheme', () => {
  it('setLightTheme applies live when in light mode and persists', () => {
    useThemeStore.getState().applyFromSettings({ ...BASE, lightTheme: 'paper-light' });
    useThemeStore.getState().setLightTheme('solarized-light');
    expect(document.documentElement.dataset.theme).toBe('solarized-light');
    expect(useThemeStore.getState().lightTheme).toBe('solarized-light');
    expect(setSettingsMock).toHaveBeenCalledWith({ lightTheme: 'solarized-light' }, { preserveAgent: true });
  });

  it('setLightTheme only persists when in dark mode (no live switch)', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().setLightTheme('solarized-light');
    expect(document.documentElement.dataset.theme).toBe('paper-dark');
    expect(useThemeStore.getState().lightTheme).toBe('solarized-light');
  });

  it('setDarkTheme applies live when in dark mode', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().setDarkTheme('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
  });

  it('rejects unknown theme ids', () => {
    useThemeStore.getState().setLightTheme('bogus');
    expect(useThemeStore.getState().lightTheme).toBe('paper-light');
    expect(setSettingsMock).not.toHaveBeenCalled();
  });
});

describe('themeStore.setFollowSystem / toggleMode', () => {
  it('setFollowSystem(true) follows the system scheme', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().setFollowSystem(true);
    expect(useThemeStore.getState().followSystem).toBe(true);
    expect(useThemeStore.getState().mode).toBe('light');
    expect(setSettingsMock).toHaveBeenLastCalledWith(
      { followSystem: true, themeMode: 'light' },
      { preserveAgent: true },
    );
  });

  it('toggleMode switches light/dark and turns off system follow', () => {
    useThemeStore.getState().applyFromSettings({ ...BASE, darkTheme: 'nord' });
    useThemeStore.getState().toggleMode();
    const state = useThemeStore.getState();
    expect(state.followSystem).toBe(false);
    expect(state.mode).toBe('dark');
    expect(state.resolvedThemeId).toBe('nord');
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(setSettingsMock).toHaveBeenCalledWith(
      { followSystem: false, themeMode: 'dark' },
      { preserveAgent: true },
    );

    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe('light');
    expect(useThemeStore.getState().resolvedThemeId).toBe('paper-light');
  });
});

describe('themeStore.setAccent', () => {
  it('injects an accent override block after theme tokens', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().setAccent('#ff0000');
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).toContain('--accent: #ff0000;');
    const themeAccentIndex = style.textContent.indexOf('--accent: #6366F1;');
    const overrideIndex = style.textContent.indexOf('--accent: #ff0000;');
    expect(overrideIndex).toBeGreaterThan(themeAccentIndex);
    expect(setSettingsMock).toHaveBeenLastCalledWith({ accent: '#ff0000' }, { preserveAgent: true });
  });

  it('setAccent(null) restores the theme accent', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().setAccent('#ff0000');
    useThemeStore.getState().setAccent(null);
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).not.toContain('--accent: #ff0000;');
    expect(style.textContent).toContain('--accent: #6366F1;');
  });
});

describe('themeStore.syncFromSystem', () => {
  it('ignores system changes when not following system', () => {
    useThemeStore.getState().applyFromSettings({
      ...BASE,
      followSystem: false,
      themeMode: 'dark',
    });
    useThemeStore.getState().syncFromSystem(true);
    expect(useThemeStore.getState().mode).toBe('dark');
  });

  it('re-resolves when following system', () => {
    useThemeStore.getState().applyFromSettings({ ...BASE, darkTheme: 'nord' });
    useThemeStore.getState().syncFromSystem(true);
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(useThemeStore.getState().resolvedThemeId).toBe('nord');
    useThemeStore.getState().syncFromSystem(false);
    expect(useThemeStore.getState().mode).toBe('light');
    expect(useThemeStore.getState().resolvedThemeId).toBe('paper-light');
  });
});
