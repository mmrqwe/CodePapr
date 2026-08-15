// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES, getBuiltinTheme, systemThemeId } from './themes';
import {
  AUX_TOKEN_KEYS,
  CORE_TOKEN_KEYS,
  applyThemeToDom,
  buildThemeCss,
  deriveAccentTokens,
  resolveEffectiveThemeId,
  resolveTheme,
  systemPrefersDark,
  tokensToCss,
  validateCustomTheme,
  THEME_CHANGED_EVENT,
  THEME_STYLE_ID,
} from './themeEngine';
import type { CustomThemeRecord } from './types';

afterEach(() => {
  document.getElementById(THEME_STYLE_ID)?.remove();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
});

describe('builtin themes', () => {
  it('all builtin themes define the full token set', () => {
    const allKeys = [...CORE_TOKEN_KEYS, ...AUX_TOKEN_KEYS];
    for (const theme of BUILTIN_THEMES) {
      for (const key of allKeys) {
        expect(theme.tokens[key], `${theme.id} missing --${key}`).toBeTruthy();
      }
    }
  });

  it('has unique ids matching the id pattern', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    }
  });

  it('paper-light/paper-dark exist for system follow', () => {
    expect(getBuiltinTheme('paper-light')?.mode).toBe('light');
    expect(getBuiltinTheme('paper-dark')?.mode).toBe('dark');
    expect(systemThemeId(true)).toBe('paper-dark');
    expect(systemThemeId(false)).toBe('paper-light');
  });

  it('monacoTheme matches mode', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.monacoTheme).toBe(theme.mode === 'dark' ? 'vs-dark' : 'vs');
    }
  });
});

describe('tokensToCss / buildThemeCss', () => {
  it('serializes tokens to custom property declarations', () => {
    const css = tokensToCss({ 'bg-base': '#0f1117', 'shadow-md': '0 8px 24px rgba(0,0,0,0.5)' });
    expect(css).toContain('--bg-base: #0f1117;');
    expect(css).toContain('--shadow-md: 0 8px 24px rgba(0,0,0,0.5);');
  });

  it('strips characters that could escape the declaration block', () => {
    const css = tokensToCss({ 'bg-base': 'red; color: blue } evil { }' });
    expect(css).toBe('--bg-base: red color: blue  evil  ;');
    expect(css).not.toContain('}');
    expect(css).not.toContain('{');
  });

  it('skips keys that are not valid variable names', () => {
    expect(tokensToCss({ 'bg base!': 'red', 'ok-key': 'blue' })).toBe('--ok-key: blue;');
  });

  it('builds scoped theme css with accent block after theme tokens', () => {
    const theme = getBuiltinTheme('paper-dark')!;
    const css = buildThemeCss(theme, '#ff0000');
    expect(css).toContain(':root[data-theme="paper-dark"]');
    expect(css).toContain('--accent: #ff0000;');
    const themeBlockIndex = css.indexOf('--bg-deep');
    const accentBlockIndex = css.indexOf('--accent: #ff0000;');
    expect(accentBlockIndex).toBeGreaterThan(themeBlockIndex);
  });

  it('omits the accent block when accent is null', () => {
    const theme = getBuiltinTheme('nord')!;
    const css = buildThemeCss(theme, null);
    expect(css).toContain('--accent: #88c0d0;');
    expect(css.match(/--accent:/g)).toHaveLength(1);
  });
});

describe('applyThemeToDom', () => {
  it('applies attributes, class, color-scheme, injects css and dispatches event', () => {
    const theme = getBuiltinTheme('midnight')!;
    const onChanged = vi.fn();
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    const state = applyThemeToDom('midnight', theme, null);
    const root = document.documentElement;
    expect(state).toEqual({ themeId: 'midnight', mode: 'dark', accent: null });
    expect(root.dataset.theme).toBe('midnight');
    expect(root.dataset.mode).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style).toBeTruthy();
    expect(style.textContent).toContain(':root[data-theme="midnight"]');
    expect(onChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  });

  it('removes dark class for light themes and reuses the style element', () => {
    const dark = getBuiltinTheme('paper-dark')!;
    applyThemeToDom('paper-dark', dark, null);
    const styleBefore = document.getElementById(THEME_STYLE_ID);
    const light = getBuiltinTheme('paper-light')!;
    applyThemeToDom('paper-light', light, null);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.getElementById(THEME_STYLE_ID)).toBe(styleBefore);
  });
});

describe('resolveTheme', () => {
  const customRecord: CustomThemeRecord = {
    name: 'My Theme',
    mode: 'dark',
    tokens: { 'bg-base': '#111111', 'foreground': '#eeeeee' },
  };

  it('resolves builtin themes', () => {
    expect(resolveTheme('nord')?.builtin).toBe(true);
  });

  it('resolves custom themes and falls back missing tokens from base', () => {
    const resolved = resolveTheme('my-theme', { 'my-theme': customRecord });
    expect(resolved).toBeTruthy();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.tokens['bg-base']).toBe('#111111');
    expect(resolved!.tokens['accent']).toBeTruthy();
  });

  it('returns null for unknown ids', () => {
    expect(resolveTheme('missing')).toBeNull();
    expect(resolveTheme(null)).toBeNull();
  });
});

describe('resolveEffectiveThemeId', () => {
  it('maps null to system theme', () => {
    expect(resolveEffectiveThemeId(null, {}, true)).toBe('paper-dark');
    expect(resolveEffectiveThemeId(null, {}, false)).toBe('paper-light');
  });

  it('keeps valid ids and falls back to system for invalid ones', () => {
    expect(resolveEffectiveThemeId('nord', {}, false)).toBe('nord');
    expect(resolveEffectiveThemeId('bogus', {}, false)).toBe('paper-light');
  });
});

describe('deriveAccentTokens', () => {
  it('derives full accent family for dark mode', () => {
    const tokens = deriveAccentTokens('#ff0000', 'dark');
    expect(tokens['accent']).toBe('#ff0000');
    expect(tokens['accent-soft']).toContain('255, 0, 0');
    expect(tokens['accent-bg']).toBeTruthy();
    expect(tokens['accent-text']).toBeTruthy();
    expect(tokens['accent-glow']).toBeTruthy();
  });

  it('produces lighter accent-text in dark mode and darker in light mode', () => {
    const darkText = deriveAccentTokens('#808080', 'dark')['accent-text'];
    const lightText = deriveAccentTokens('#808080', 'light')['accent-text'];
    expect(parseInt(darkText.slice(1), 16)).toBeGreaterThan(parseInt(lightText.slice(1), 16));
  });

  it('keeps invalid hex as-is for accent', () => {
    expect(deriveAccentTokens('nonsense', 'dark')['accent']).toBe('nonsense');
  });
});

describe('validateCustomTheme', () => {
  const validTokens: CustomThemeRecord['tokens'] = Object.fromEntries(
    CORE_TOKEN_KEYS.map((k) => [k, '#000']),
  );

  it('accepts a complete record', () => {
    expect(
      validateCustomTheme('my-theme', { name: 'My', mode: 'dark', tokens: validTokens }).ok,
    ).toBe(true);
  });

  it('rejects invalid ids, modes, names and missing tokens', () => {
    expect(
      validateCustomTheme('BAD ID', { name: 'x', mode: 'dark', tokens: validTokens }).ok,
    ).toBe(false);
    expect(
      validateCustomTheme('ok', {
        name: 'x',
        mode: 'blue' as unknown as 'light',
        tokens: validTokens,
      }).ok,
    ).toBe(false);
    expect(
      validateCustomTheme('ok', { name: '', mode: 'dark', tokens: validTokens }).ok,
    ).toBe(false);
    const missing = validateCustomTheme('ok', { name: 'x', mode: 'dark', tokens: {} });
    expect(missing.ok).toBe(false);
    expect(missing.missingTokens).toContain('bg-base');
  });
});

describe('systemPrefersDark', () => {
  it('falls back to false when matchMedia is unavailable', () => {
    expect(typeof systemPrefersDark()).toBe('boolean');
  });
});
