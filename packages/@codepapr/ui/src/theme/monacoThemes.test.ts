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
    expect(keyword?.foreground).toBe(nord.tokens['syntax-keyword']);
    const string = definition.rules.find((rule) => rule.token === 'string');
    expect(string?.foreground).toBe(nord.tokens['syntax-string']);
  });

  it('is idempotent per theme and accent', () => {
    const midnight = getBuiltinTheme('midnight')!;
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, null);
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, null);
    expect(defineThemeMock).toHaveBeenCalledTimes(1);
    registerMonacoTheme(midnight.id, midnight.tokens, midnight.mode, '#ff0000');
    expect(defineThemeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps syntax colors decoupled from the accent override', () => {
    const solarized = getBuiltinTheme('solarized-dark')!;
    registerMonacoTheme(solarized.id, solarized.tokens, solarized.mode, '#ff0000');
    const definition = defineThemeMock.mock.calls[0][1] as {
      rules: Array<{ token: string; foreground?: string }>;
    };
    const keyword = definition.rules.find((rule) => rule.token === 'keyword');
    // 强调色为红时，关键字仍使用主题自身的语法色，不随 accent 变红
    expect(keyword?.foreground).toBe(solarized.tokens['syntax-keyword']);
    expect(keyword?.foreground).not.toBe('#ff0000');
  });

  it('keeps selection colors neutral per mode, decoupled from accent', () => {
    const paperLight = getBuiltinTheme('paper-light')!;
    registerMonacoTheme(paperLight.id, paperLight.tokens, paperLight.mode, '#ff0000');
    const lightDefinition = defineThemeMock.mock.calls[0][1] as {
      colors: Record<string, string>;
    };
    expect(lightDefinition.colors['editor.selectionBackground']).toBe('#ADD6FF');
    expect(lightDefinition.colors['editor.inactiveSelectionBackground']).toBe('#E5EBF1');

    const nord = getBuiltinTheme('nord')!;
    registerMonacoTheme(nord.id, nord.tokens, nord.mode, '#ff0000');
    const darkDefinition = defineThemeMock.mock.calls[1][1] as {
      colors: Record<string, string>;
    };
    expect(darkDefinition.colors['editor.selectionBackground']).toBe('#264F78');
    expect(darkDefinition.colors['editor.inactiveSelectionBackground']).toBe('#3A3D41');
  });

  it('keeps editor chrome (cursor / scrollbar hover) decoupled from accent', () => {
    // 红色强调色下，光标与滚动条悬停/拖动态不得变红（编辑器中无整片红色）
    const paperLight = getBuiltinTheme('paper-light')!;
    registerMonacoTheme(paperLight.id, paperLight.tokens, paperLight.mode, '#ff2200');
    const lightDefinition = defineThemeMock.mock.calls[0][1] as {
      colors: Record<string, string>;
    };
    expect(lightDefinition.colors['editorCursor.foreground']).toBe(
      paperLight.tokens['code-fg'],
    );
    expect(lightDefinition.colors['editorCursor.foreground']).not.toBe('#ff2200');
    expect(lightDefinition.colors['scrollbarSlider.hoverBackground']).toBe(
      paperLight.tokens['foreground-soft'],
    );
    expect(lightDefinition.colors['scrollbarSlider.hoverBackground']).not.toBe('#ff2200');
    expect(lightDefinition.colors['scrollbarSlider.activeBackground']).toBe(
      paperLight.tokens['foreground-muted'],
    );
    expect(lightDefinition.colors['scrollbarSlider.activeBackground']).not.toBe('#ff2200');
  });

  it('covers diagnostic and inherited colors from theme tokens instead of base neon red', () => {
    // 基底继承的 #E51400 诊断红曾透过滚动条/波浪线整片刺眼：
    // 生成主题必须显式覆盖诊断色、diff 色与点击词高亮等全部继承项。
    const paperLight = getBuiltinTheme('paper-light')!;
    registerMonacoTheme(paperLight.id, paperLight.tokens, paperLight.mode, '#00ffaa');
    const definition = defineThemeMock.mock.calls[0][1] as {
      colors: Record<string, string>;
    };
    expect(definition.colors['editorError.foreground']).toBe(paperLight.tokens['editor-error']);
    expect(definition.colors['editorError.foreground']).not.toBe('#e51400');
    expect(definition.colors['editorOverviewRuler.errorForeground']).toBe(
      paperLight.tokens['editor-error'],
    );
    expect(definition.colors['editorWarning.foreground']).toBe(paperLight.tokens['editor-warning']);
    expect(definition.colors['editorInfo.foreground']).toBe(paperLight.tokens['editor-info']);
    expect(definition.colors['scrollbarSlider.background']).toBe(
      paperLight.tokens['foreground-dim'],
    );
    expect(definition.colors['editor.wordHighlightBackground']).toBeTruthy();
    expect(definition.colors['editor.selectionHighlightBackground']).toBeTruthy();
    expect(definition.colors['editor.lineHighlightBorder']).toBe('#00000000');
    expect(definition.colors['editor.findMatchBackground']).toBeTruthy();
  });

  it('converts rgba colors to 8-digit hex: Monaco fails on rgba and falls back to pure red', () => {
    // Color.fromHex = parseHex(hex) || Color.red：任何 rgba() 值都会被解析为
    // 纯红——历史上"点击行大红/滚动条静止大红"的总根源。生成主题必须全部为 hex。
    const paperLight = getBuiltinTheme('paper-light')!;
    registerMonacoTheme(paperLight.id, paperLight.tokens, paperLight.mode, '#00ffbb');
    const definition = defineThemeMock.mock.calls[0][1] as {
      colors: Record<string, string>;
    };
    for (const [key, value] of Object.entries(definition.colors)) {
      expect(value, `${key} 使用了非 hex 颜色值: ${value}`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
    // 行高亮：bg-hover rgba(54,32,17,0.04) → #3620110A（不再是红色）
    expect(definition.colors['editor.lineHighlightBackground']).toBe('#3620110a');
    // diff 删除行：red-bg rgba(194,24,91,0.08) → #c2185b14
    expect(definition.colors['diffEditor.removedTextBackground']).toBe('#c2185b14');
    // 补全选中：accent 派生的 accent-soft rgba(0,255,187,0.18) → #00ffbb2e
    expect(definition.colors['editorSuggestWidget.selectedBackground']).toBe('#00ffbb2e');
    // 选中高亮（浅色模式字面量）
    expect(definition.colors['editor.selectionHighlightBackground']).toBe('#add6ff66');
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
    // 语法色来自 base（paper-light）回退，不随强调色变红
    expect(keyword?.foreground).toBe('#1a5fb4');
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
