export type ThemeMode = 'light' | 'dark';

/** CSS 变量 token 映射：键为不带 -- 前缀的变量名，值为 CSS 值。 */
export type ThemeTokens = Record<string, string>;

/** 自定义主题的持久化形态（存 Settings.customThemes）。 */
export interface CustomThemeRecord {
  name: string;
  mode: ThemeMode;
  tokens: ThemeTokens;
}

/** 内置/自定义主题的统一运行时形态。 */
export interface ThemeDefinition {
  id: string;
  name: string;
  builtin: boolean;
  mode: ThemeMode;
  /** Monaco 编辑器主题名（Phase 4 前仅 vs / vs-dark）。 */
  monacoTheme: 'vs' | 'vs-dark';
  /** 设置页主题卡片预览色。 */
  preview: {
    bg: string;
    surface: string;
    fg: string;
    accent: string;
  };
  tokens: ThemeTokens;
}

/** 内置主题 id 合法字符：小写字母/数字/连字符。自定义主题同样受限。 */
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 强调色覆盖：单个十六进制颜色（#rgb 或 #rrggbb）。 */
export const ACCENT_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
