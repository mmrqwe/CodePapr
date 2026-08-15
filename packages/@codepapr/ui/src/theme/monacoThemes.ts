import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { resolveTheme, deriveAccentTokens, THEME_CHANGED_EVENT } from './themeEngine';
import { useThemeStore } from '../store/themeStore';
import type { ThemeTokens } from './types';

/**
 * Monaco 编辑器主题：从应用主题 token 生成（defineTheme），
 * 语法高亮与编辑器配色随主题/强调色实时联动。
 */

const MONACO_THEME_PREFIX = 'codepapr-';

/** 已注册的 monaco 主题键（themeId + accent），避免重复 define。 */
const registered = new Set<string>();

export function monacoThemeNameFor(themeId: string): string {
  return `${MONACO_THEME_PREFIX}${themeId}`;
}

/** 当前生效的 monaco 主题名：有 data-theme 时返回生成主题，否则回退 vs/vs-dark。 */
export function detectMonacoThemeName(): string {
  if (typeof document === 'undefined') return 'vs-dark';
  const themeId = document.documentElement.dataset.theme;
  if (!themeId) {
    return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
  }
  return monacoThemeNameFor(themeId);
}

function buildThemeRules(tokens: ThemeTokens): monaco.editor.ITokenThemeRule[] {
  const fg = tokens['code-fg'] ?? tokens['foreground'] ?? '#cccccc';
  const dim = tokens['foreground-dim'] ?? '#808080';
  const muted = tokens['foreground-muted'] ?? '#808080';
  const accent = tokens['accent'] ?? '#569cd6';
  const accentText = tokens['accent-text'] ?? accent;
  const green = tokens['green'] ?? '#4ec9b0';
  const amber = tokens['amber'] ?? '#dcdcaa';
  const cyan = tokens['cyan'] ?? '#4fc1ff';
  const red = tokens['red'] ?? '#f85149';
  return [
    { token: 'comment', foreground: dim, fontStyle: 'italic' },
    { token: 'keyword', foreground: accent },
    { token: 'keyword.flow', foreground: accent },
    { token: 'keyword.operator', foreground: accent },
    { token: 'string', foreground: green },
    { token: 'string.escape', foreground: amber },
    { token: 'number', foreground: amber },
    { token: 'regexp', foreground: red },
    { token: 'type', foreground: cyan },
    { token: 'type.identifier', foreground: cyan },
    { token: 'namespace', foreground: cyan },
    { token: 'identifier', foreground: fg },
    { token: 'variable', foreground: fg },
    { token: 'delimiter', foreground: muted },
    { token: 'tag', foreground: accentText },
    { token: 'attribute.name', foreground: accentText },
    { token: 'attribute.value', foreground: green },
    { token: 'key', foreground: cyan },
    { token: 'operator', foreground: accent },
    { token: 'bool', foreground: accent },
    { token: 'null', foreground: accent },
  ];
}

function buildThemeColors(tokens: ThemeTokens): Record<string, string> {
  return {
    'editor.background': tokens['code-bg'] ?? '#0b0d12',
    'editor.foreground': tokens['code-fg'] ?? '#e2e8f0',
    'editorLineNumber.foreground': tokens['foreground-dim'] ?? '#475569',
    'editorLineNumber.activeForeground': tokens['foreground-soft'] ?? '#94a3b8',
    'editorCursor.foreground': tokens['accent'] ?? '#6366f1',
    'editor.selectionBackground': tokens['accent-bg'] ?? 'rgba(99,102,241,0.2)',
    'editor.inactiveSelectionBackground': tokens['accent-bg'] ?? 'rgba(99,102,241,0.12)',
    'editor.lineHighlightBackground': tokens['bg-hover'] ?? 'rgba(255,255,255,0.04)',
    'editorGutter.background': tokens['code-bg'] ?? '#0b0d12',
    'editorWidget.background': tokens['bg-raised'] ?? '#1a1d27',
    'editorWidget.border': tokens['border'] ?? '#2a2d3a',
    'editorWidget.foreground': tokens['foreground'] ?? '#e2e8f0',
    'editorSuggestWidget.selectedBackground': tokens['accent-bg'] ?? 'rgba(99,102,241,0.2)',
    'scrollbarSlider.background': tokens['scrollbar-thumb'] ?? '#2a2d3a',
    'scrollbarSlider.hoverBackground': tokens['accent'] ?? '#6366f1',
    'scrollbarSlider.activeBackground': tokens['accent'] ?? '#6366f1',
    'minimap.background': tokens['code-bg'] ?? '#0b0d12',
    'focusBorder': tokens['accent'] ?? '#6366f1',
  };
}

/** 为（主题, 强调色）注册 monaco 主题（幂等），返回主题名。 */
export function registerMonacoTheme(
  themeId: string,
  tokens: ThemeTokens,
  mode: 'light' | 'dark',
  accent: string | null,
): string {
  const key = `${themeId}:${accent ?? ''}`;
  const name = monacoThemeNameFor(themeId);
  if (!registered.has(key)) {
    const effective = accent ? { ...tokens, ...deriveAccentTokens(accent, mode) } : tokens;
    monaco.editor.defineTheme(name, {
      base: mode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: buildThemeRules(effective),
      colors: buildThemeColors(effective),
    });
    registered.add(key);
  }
  return name;
}

/** 解析当前应用主题并应用为 monaco 主题。 */
export function applyActiveMonacoTheme(): string {
  if (typeof document === 'undefined') return 'vs-dark';
  const themeId = document.documentElement.dataset.theme;
  if (!themeId) {
    const fallback = document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
    monaco.editor.setTheme(fallback);
    return fallback;
  }
  const { customThemes, accent } = useThemeStore.getState();
  const def = resolveTheme(themeId, customThemes);
  if (!def) {
    monaco.editor.setTheme('vs-dark');
    return 'vs-dark';
  }
  const name = registerMonacoTheme(def.id, def.tokens, def.mode, accent);
  monaco.editor.setTheme(name);
  return name;
}

let themeSyncInitialized = false;

/** 注册主题变更监听（幂等），并立即应用一次当前主题。 */
export function ensureMonacoThemeSync(): void {
  if (themeSyncInitialized || typeof window === 'undefined') return;
  themeSyncInitialized = true;
  window.addEventListener(THEME_CHANGED_EVENT, applyActiveMonacoTheme);
  applyActiveMonacoTheme();
}
