import { getBuiltinTheme } from './theme/themes';

export const THEME_CACHE_KEY = 'ui.theme';

/** 启动缓存镜像（防闪烁）。v2：浅/深主题槽位 + 模式。 */
export interface ThemeCacheValue {
  mode: 'light' | 'dark';
  light: string;
  dark: string;
  followSystem: boolean;
  accent: string | null;
}

export interface ParsedThemeCache {
  value: ThemeCacheValue;
  /** 旧格式（'dark'|'light' 字符串或 v1 {theme} 对象）：settings 加载后需一次性迁移。 */
  legacy: boolean;
  kind: 'string' | 'v1' | 'v2';
}

export function parseThemeCache(cached: unknown): ParsedThemeCache | null {
  if (typeof cached === 'string') {
    const mode = cached === 'dark' ? 'dark' : cached === 'light' ? 'light' : null;
    if (!mode) return null;
    return {
      value: { mode, light: 'paper-light', dark: 'paper-dark', followSystem: false, accent: null },
      legacy: true,
      kind: 'string',
    };
  }
  if (cached && typeof cached === 'object') {
    const record = cached as Record<string, unknown>;
    // v2 格式
    if (record.mode === 'light' || record.mode === 'dark') {
      return {
        value: {
          mode: record.mode,
          light: typeof record.light === 'string' ? record.light : 'paper-light',
          dark: typeof record.dark === 'string' ? record.dark : 'paper-dark',
          followSystem: record.followSystem === true,
          accent: typeof record.accent === 'string' ? record.accent : null,
        },
        legacy: false,
        kind: 'v2',
      };
    }
    // v1 格式 {theme, accent}
    if ('theme' in record) {
      const theme = typeof record.theme === 'string' ? record.theme : null;
      const accent = typeof record.accent === 'string' ? record.accent : null;
      if (!theme) {
        return {
          value: {
            mode: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            light: 'paper-light',
            dark: 'paper-dark',
            followSystem: true,
            accent,
          },
          legacy: true,
          kind: 'v1',
        };
      }
      const def = getBuiltinTheme(theme);
      if (!def) return null;
      return {
        value: {
          mode: def.mode,
          light: def.mode === 'light' ? theme : 'paper-light',
          dark: def.mode === 'dark' ? theme : 'paper-dark',
          followSystem: false,
          accent,
        },
        legacy: true,
        kind: 'v1',
      };
    }
  }
  return null;
}
