import { create } from 'zustand';
import type { CustomThemeRecord, ThemeMode } from '../theme/types';
import {
  applyThemeToDom,
  resolveEffectiveThemeId,
  resolveTheme,
  systemPrefersDark,
} from '../theme/themeEngine';
import { useAgentStore } from './agentStore';

/**
 * 主题运行时状态。持久化源为 Settings（theme/accent/customThemes），
 * 本 store 持有解析后的生效状态；所有变更同时走 agentStore.setSettings
 * 持久化，并立即应用到 DOM。
 */
export interface ThemeState {
  /** null = 跟随系统。 */
  themeId: string | null;
  /** 强调色覆盖（#rgb/#rrggbb），null = 使用主题自带。 */
  accent: string | null;
  customThemes: Record<string, CustomThemeRecord>;
  /** 实际生效的主题 id（跟随系统时已解析到具体主题）。 */
  resolvedThemeId: string;
  mode: ThemeMode;
}

export interface ThemeActions {
  /** 从 Settings 同步（启动加载/外部修改），不触发持久化。 */
  applyFromSettings: (partial: {
    theme: string | null;
    accent: string | null;
    customThemes: Record<string, CustomThemeRecord>;
  }) => void;
  /** 设置主题（持久化到 Settings 并应用到 DOM）。 */
  setTheme: (themeId: string | null) => void;
  /** 设置强调色（持久化到 Settings 并应用到 DOM）。 */
  setAccent: (accent: string | null) => void;
  /** 系统配色变化：仅当跟随系统时重新解析。 */
  syncFromSystem: (prefersDark: boolean) => void;
}

function applyResolved(
  themeId: string | null,
  accent: string | null,
  customThemes: Record<string, CustomThemeRecord>,
  prefersDark: boolean,
): { resolvedThemeId: string; mode: ThemeMode } {
  const resolvedId = resolveEffectiveThemeId(themeId, customThemes, prefersDark);
  const def = resolveTheme(resolvedId, customThemes);
  if (!def) {
    return { resolvedThemeId: resolvedId, mode: 'dark' };
  }
  applyThemeToDom(resolvedId, def, accent);
  return { resolvedThemeId: resolvedId, mode: def.mode };
}

export const useThemeStore = create<ThemeState & ThemeActions>()((set, get) => ({
  themeId: null,
  accent: null,
  customThemes: {},
  resolvedThemeId: 'paper-dark',
  mode: 'dark',

  applyFromSettings: (partial) => {
    const prefersDark = systemPrefersDark();
    const resolved = applyResolved(
      partial.theme,
      partial.accent,
      partial.customThemes,
      prefersDark,
    );
    set({
      themeId: partial.theme,
      accent: partial.accent,
      customThemes: partial.customThemes,
      resolvedThemeId: resolved.resolvedThemeId,
      mode: resolved.mode,
    });
  },

  setTheme: (themeId) => {
    const { accent, customThemes } = get();
    const prefersDark = systemPrefersDark();
    const resolved = applyResolved(themeId, accent, customThemes, prefersDark);
    set({ themeId, resolvedThemeId: resolved.resolvedThemeId, mode: resolved.mode });
    useAgentStore.getState().setSettings({ theme: themeId }, { preserveAgent: true });
  },

  setAccent: (accent) => {
    const { themeId, customThemes } = get();
    const prefersDark = systemPrefersDark();
    const resolved = applyResolved(themeId, accent, customThemes, prefersDark);
    set({ accent, resolvedThemeId: resolved.resolvedThemeId, mode: resolved.mode });
    useAgentStore.getState().setSettings({ accent }, { preserveAgent: true });
  },

  syncFromSystem: (prefersDark) => {
    const { themeId, accent, customThemes } = get();
    if (themeId !== null) {
      return;
    }
    const resolved = applyResolved(themeId, accent, customThemes, prefersDark);
    set({ resolvedThemeId: resolved.resolvedThemeId, mode: resolved.mode });
  },
}));
