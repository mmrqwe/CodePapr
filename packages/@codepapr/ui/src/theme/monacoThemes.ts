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

/**
 * 语法高亮规则：使用主题专用 syntax-* token（与 UI 状态色/强调色解耦，
 * 每套主题手工调教，避免霓虹感与语义重叠）。缺失时回退到旧推导值。
 */
function buildThemeRules(tokens: ThemeTokens): monaco.editor.ITokenThemeRule[] {
  const fg = tokens['code-fg'] ?? tokens['foreground'] ?? '#cccccc';
  const pick = (key: string, fallback: string): string => tokens[key] ?? fallback;
  const keyword = pick('syntax-keyword', tokens['accent'] ?? '#569cd6');
  const string = pick('syntax-string', tokens['green'] ?? '#ce9178');
  const number = pick('syntax-number', tokens['amber'] ?? '#b5cea8');
  const type = pick('syntax-type', tokens['cyan'] ?? '#4ec9b0');
  const func = pick('syntax-function', tokens['amber'] ?? '#dcdcaa');
  const comment = pick('syntax-comment', tokens['foreground-dim'] ?? '#808080');
  const variable = pick('syntax-variable', fg);
  const tag = pick('syntax-tag', tokens['accent-text'] ?? keyword);
  const attribute = pick('syntax-attribute', tokens['cyan'] ?? '#9cdcfe');
  const regexp = pick('syntax-regexp', tokens['red'] ?? '#f85149');
  const operator = pick('syntax-operator', tokens['foreground-muted'] ?? '#d4d4d4');
  const bool = pick('syntax-bool', keyword);
  const delimiter = pick('syntax-delimiter', tokens['foreground-muted'] ?? '#808080');
  return [
    { token: 'comment', foreground: comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: keyword },
    { token: 'keyword.flow', foreground: keyword },
    { token: 'keyword.operator', foreground: keyword },
    { token: 'string', foreground: string },
    { token: 'string.escape', foreground: string },
    { token: 'number', foreground: number },
    { token: 'regexp', foreground: regexp },
    { token: 'type', foreground: type },
    { token: 'type.identifier', foreground: type },
    { token: 'namespace', foreground: type },
    { token: 'identifier', foreground: fg },
    { token: 'variable', foreground: variable },
    { token: 'predefined', foreground: func },
    { token: 'delimiter', foreground: delimiter },
    { token: 'tag', foreground: tag },
    { token: 'attribute.name', foreground: attribute },
    { token: 'attribute.value', foreground: string },
    { token: 'key', foreground: attribute },
    { token: 'operator', foreground: operator },
    { token: 'bool', foreground: bool },
    { token: 'null', foreground: bool },
  ];
}

/** 选区颜色：中性蓝，与强调色解耦（VS Code 同款做法）。
 *  强调色为红色系时若选区跟随 accent，会整屏泛红刺眼。 */
function selectionColors(mode: 'light' | 'dark'): { active: string; inactive: string } {
  return mode === 'dark'
    ? { active: '#264F78', inactive: '#3A3D41' }
    : { active: '#ADD6FF', inactive: '#E5EBF1' };
}

function buildThemeColors(
  tokens: ThemeTokens,
  mode: 'light' | 'dark',
): Record<string, string> {
  const selection = selectionColors(mode);
  return {
    'editor.background': tokens['code-bg'] ?? '#0b0d12',
    'editor.foreground': tokens['code-fg'] ?? '#e2e8f0',
    'editorLineNumber.foreground': tokens['foreground-dim'] ?? '#475569',
    'editorLineNumber.activeForeground': tokens['foreground-soft'] ?? '#94a3b8',
    'editorCursor.foreground': tokens['accent'] ?? '#6366f1',
    'editor.selectionBackground': selection.active,
    'editor.inactiveSelectionBackground': selection.inactive,
    'editor.lineHighlightBackground': tokens['bg-hover'] ?? 'rgba(255,255,255,0.04)',
    'editorGutter.background': tokens['code-bg'] ?? '#0b0d12',
    'editorWidget.background': tokens['bg-raised'] ?? '#1a1d27',
    'editorWidget.border': tokens['border'] ?? '#2a2d3a',
    'editorWidget.foreground': tokens['foreground'] ?? '#e2e8f0',
    'editorSuggestWidget.selectedBackground': tokens['accent-soft'] ?? 'rgba(99,102,241,0.2)',
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
      colors: buildThemeColors(effective, mode),
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
