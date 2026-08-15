import type { CustomThemeRecord, ThemeDefinition, ThemeMode, ThemeTokens } from './types';
import { getBuiltinTheme, systemThemeId } from './themes';

export const THEME_STYLE_ID = 'codepapr-theme';
export const THEME_CHANGED_EVENT = 'codepapr-theme-changed';

/** 自定义主题必须提供的核心 token（其余 token 缺省时从同 mode 的基础主题回退）。 */
export const CORE_TOKEN_KEYS = [
  'bg-deep',
  'bg-base',
  'bg-raised',
  'bg-input',
  'bg-hover',
  'foreground',
  'foreground-soft',
  'foreground-muted',
  'foreground-dim',
  'border',
  'border-strong',
  'accent',
  'accent-soft',
  'accent-bg',
  'accent-text',
  'accent-glow',
  'green',
  'green-bg',
  'amber',
  'amber-bg',
  'red',
  'cyan',
  'cyan-bg',
  'code-bg',
  'code-fg',
  'scrollbar-track',
  'scrollbar-thumb',
  'shadow-sm',
  'shadow-md',
  'surface-gradient',
] as const;

export type CoreTokenKey = (typeof CORE_TOKEN_KEYS)[number];

/** 可选 token（内置主题全量定义；自定义主题缺失时回退）。 */
export const AUX_TOKEN_KEYS = [
  'bg-control',
  'red-bg',
  'overlay',
  'goal-banner-running-bg',
  'goal-banner-running-border',
  'goal-banner-running-fg',
  'goal-banner-satisfied-bg',
  'goal-banner-satisfied-border',
  'goal-banner-satisfied-fg',
  'goal-banner-error-bg',
  'goal-banner-error-border',
  'goal-banner-error-fg',
  'gantt-user',
  'gantt-think',
  'gantt-body',
  'gantt-tool',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-type',
  'syntax-function',
  'syntax-comment',
  'syntax-variable',
  'syntax-tag',
  'syntax-attribute',
  'syntax-regexp',
  'syntax-operator',
  'syntax-bool',
  'syntax-delimiter',
] as const;

/** 防止注入/破坏规则块：剔除 CSS 值中可逃逸出声明块的字符。 */
function sanitizeCssValue(value: string): string {
  return value.replace(/[;{}]/g, '');
}

export function tokensToCss(tokens: ThemeTokens): string {
  const declarations: string[] = [];
  for (const [key, raw] of Object.entries(tokens)) {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) continue;
    declarations.push(`--${key}: ${sanitizeCssValue(raw)};`);
  }
  return declarations.join(' ');
}

export function buildThemeCss(def: ThemeDefinition, accent: string | null): string {
  const scope = `:root[data-theme="${def.id}"]`;
  const blocks = [`${scope} { ${tokensToCss(def.tokens)} }`];
  if (accent) {
    // 同作用域、同特异性：强调色块置于主题块之后，天然覆盖主题自带 accent。
    blocks.push(`${scope} { ${tokensToCss(deriveAccentTokens(accent, def.mode))} }`);
  }
  return blocks.join('\n');
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }
  const style = document.createElement('style');
  style.id = THEME_STYLE_ID;
  document.head.appendChild(style);
  return style;
}

export interface ThemeDomState {
  themeId: string;
  mode: ThemeMode;
  accent: string | null;
}

/** 把主题应用到 DOM：data-theme/data-mode/class/color-scheme + 注入 token CSS。 */
export function applyThemeToDom(
  themeId: string,
  def: ThemeDefinition,
  accent: string | null,
): ThemeDomState {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.mode = def.mode;
  root.classList.toggle('dark', def.mode === 'dark');
  root.style.colorScheme = def.mode;
  ensureThemeStyleElement().textContent = buildThemeCss(def, accent);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGED_EVENT, { detail: { themeId, mode: def.mode, accent } }),
  );
  return { themeId, mode: def.mode, accent };
}

/** 解析主题 id → 运行时定义。null 表示跟随系统；未知 id 返回 null。 */
export function resolveTheme(
  themeId: string | null,
  customThemes: Record<string, CustomThemeRecord> = {},
): ThemeDefinition | null {
  if (!themeId) {
    return null;
  }
  const builtin = getBuiltinTheme(themeId);
  if (builtin) {
    return builtin;
  }
  const custom = customThemes[themeId];
  if (!custom) {
    return null;
  }
  const base = custom.mode === 'dark'
    ? getBuiltinTheme('paper-dark')
    : getBuiltinTheme('paper-light');
  const merged = { ...base?.tokens, ...custom.tokens };
  return {
    id: themeId,
    name: custom.name,
    builtin: false,
    mode: custom.mode,
    monacoTheme: custom.mode === 'dark' ? 'vs-dark' : 'vs',
    preview: {
      bg: merged['bg-base'] ?? '#000',
      surface: merged['bg-raised'] ?? '#000',
      fg: merged['foreground'] ?? '#fff',
      accent: merged['accent'] ?? '#888',
    },
    tokens: merged,
  };
}

/** 解析出实际生效的主题 id（跟随系统时按 prefersDark 落点；未知 id 回退系统主题）。 */
export function resolveEffectiveThemeId(
  themeId: string | null,
  customThemes: Record<string, CustomThemeRecord> = {},
  prefersDark: boolean = systemPrefersDark(),
): string {
  if (themeId && resolveTheme(themeId, customThemes)) {
    return themeId;
  }
  return systemThemeId(prefersDark);
}

/** 系统深色偏好（无 matchMedia 的环境安全回退 false）。 */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.replace(/^#/, '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function mixHex(hex: string, other: [number, number, number], ratio: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  const mixed: [number, number, number] = [
    Math.round(r + (other[0] - r) * ratio),
    Math.round(g + (other[1] - g) * ratio),
    Math.round(b + (other[2] - b) * ratio),
  ];
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.join(', ')}, ${alpha})`;
}

/** 由单个强调色推导完整 accent 家族（覆盖主题自带值）。 */
export function deriveAccentTokens(hex: string, mode: ThemeMode): ThemeTokens {
  const dark = mode === 'dark';
  return {
    'accent': hex,
    'accent-soft': rgba(hex, dark ? 0.16 : 0.18),
    'accent-bg': rgba(hex, dark ? 0.08 : 0.06),
    'accent-text': dark ? mixHex(hex, [255, 255, 255], 0.45) : mixHex(hex, [0, 0, 0], 0.22),
    'accent-glow': rgba(hex, dark ? 0.2 : 0.12),
  };
}

export interface CustomThemeValidation {
  ok: boolean;
  error?: string;
  missingTokens?: string[];
}

/** 校验自定义主题记录：核心 token 齐全 + id/名称合法。 */
export function validateCustomTheme(
  id: string,
  record: CustomThemeRecord,
): CustomThemeValidation {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    return { ok: false, error: 'invalid id: only lowercase letters, digits and hyphens' };
  }
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'invalid theme record' };
  }
  if (!record.name || typeof record.name !== 'string') {
    return { ok: false, error: 'missing name' };
  }
  if (record.mode !== 'light' && record.mode !== 'dark') {
    return { ok: false, error: 'invalid mode: must be "light" or "dark"' };
  }
  if (!record.tokens || typeof record.tokens !== 'object') {
    return { ok: false, error: 'missing tokens' };
  }
  const missingTokens = CORE_TOKEN_KEYS.filter(
    (key) => typeof (record.tokens as ThemeTokens)[key] !== 'string',
  );
  if (missingTokens.length > 0) {
    return { ok: false, error: 'missing required tokens', missingTokens };
  }
  return { ok: true };
}
