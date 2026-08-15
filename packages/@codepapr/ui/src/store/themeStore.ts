import { create } from 'zustand';
import type { CustomThemeRecord, ThemeMode } from '../theme/types';
import { applyThemeToDom, resolveTheme, systemPrefersDark } from '../theme/themeEngine';
import { useAgentStore } from './agentStore';

/**
 * 主题运行时状态。持久化源为 Settings（lightTheme/darkTheme/followSystem/
 * themeMode/accent/customThemes）。模式（浅/深）决定使用哪套主题：
 *  - 跟随系统：模式由系统深浅色决定
 *  - 手动模式：模式由主界面切换按钮切换（themeMode）
 */
export interface ThemeState {
  /** 浅色模式下使用的主题 id。 */
  lightTheme: string;
  /** 深色模式下使用的主题 id。 */
  darkTheme: string;
  /** 是否跟随系统深浅色。 */
  followSystem: boolean;
  /** 当前生效的深浅模式。 */
  mode: ThemeMode;
  /** 强调色覆盖（#rgb/#rrggbb），null = 使用主题自带。 */
  accent: string | null;
  customThemes: Record<string, CustomThemeRecord>;
  /** 实际生效的主题 id。 */
  resolvedThemeId: string;
}

export interface ThemeActions {
  /** 从 Settings 同步（启动加载/外部修改），不触发持久化。 */
  applyFromSettings: (partial: {
    lightTheme: string;
    darkTheme: string;
    followSystem: boolean;
    themeMode: ThemeMode;
    accent: string | null;
    customThemes: Record<string, CustomThemeRecord>;
  }) => void;
  /** 设置浅色模式主题（持久化并应用到 DOM）。 */
  setLightTheme: (themeId: string) => void;
  /** 设置深色模式主题（持久化并应用到 DOM）。 */
  setDarkTheme: (themeId: string) => void;
  /** 切换跟随系统（持久化）。 */
  setFollowSystem: (follow: boolean) => void;
  /** 主界面切换按钮：浅 ↔ 深（转手动模式并持久化）。 */
  toggleMode: () => void;
  /** 设置强调色（持久化并应用到 DOM）。 */
  setAccent: (accent: string | null) => void;
  /** 系统配色变化：仅当跟随系统时重新解析。 */
  syncFromSystem: (prefersDark: boolean) => void;
}

/** 模式 → 有效主题 id（未知 id 回退同模式默认主题）。 */
function effectiveThemeId(
  mode: ThemeMode,
  lightTheme: string,
  darkTheme: string,
  customThemes: Record<string, CustomThemeRecord>,
): string {
  const fallback = mode === 'dark' ? 'paper-dark' : 'paper-light';
  const preferred = mode === 'dark' ? darkTheme : lightTheme;
  return resolveTheme(preferred, customThemes) ? preferred : fallback;
}

function applyResolved(
  mode: ThemeMode,
  lightTheme: string,
  darkTheme: string,
  customThemes: Record<string, CustomThemeRecord>,
  accent: string | null,
): string {
  const id = effectiveThemeId(mode, lightTheme, darkTheme, customThemes);
  const def = resolveTheme(id, customThemes);
  if (def) {
    applyThemeToDom(id, def, accent);
  }
  return id;
}

export const useThemeStore = create<ThemeState & ThemeActions>()((set, get) => ({
  lightTheme: 'paper-light',
  darkTheme: 'paper-dark',
  followSystem: true,
  mode: 'light',
  accent: null,
  customThemes: {},
  resolvedThemeId: 'paper-light',

  applyFromSettings: (partial) => {
    const mode: ThemeMode = partial.followSystem
      ? systemPrefersDark()
        ? 'dark'
        : 'light'
      : partial.themeMode;
    const resolvedThemeId = applyResolved(
      mode,
      partial.lightTheme,
      partial.darkTheme,
      partial.customThemes,
      partial.accent,
    );
    set({
      lightTheme: partial.lightTheme,
      darkTheme: partial.darkTheme,
      followSystem: partial.followSystem,
      mode,
      accent: partial.accent,
      customThemes: partial.customThemes,
      resolvedThemeId,
    });
  },

  setLightTheme: (themeId) => {
    const { darkTheme, customThemes, accent, mode } = get();
    if (!resolveTheme(themeId, customThemes)) return;
    const resolvedThemeId =
      mode === 'light'
        ? applyResolved('light', themeId, darkTheme, customThemes, accent)
        : get().resolvedThemeId;
    set({ lightTheme: themeId, resolvedThemeId });
    useAgentStore.getState().setSettings({ lightTheme: themeId }, { preserveAgent: true });
  },

  setDarkTheme: (themeId) => {
    const { lightTheme, customThemes, accent, mode } = get();
    if (!resolveTheme(themeId, customThemes)) return;
    const resolvedThemeId =
      mode === 'dark'
        ? applyResolved('dark', lightTheme, themeId, customThemes, accent)
        : get().resolvedThemeId;
    set({ darkTheme: themeId, resolvedThemeId });
    useAgentStore.getState().setSettings({ darkTheme: themeId }, { preserveAgent: true });
  },

  setFollowSystem: (follow) => {
    const { lightTheme, darkTheme, customThemes, accent, mode } = get();
    const nextMode: ThemeMode = follow
      ? systemPrefersDark()
        ? 'dark'
        : 'light'
      : mode;
    const resolvedThemeId = applyResolved(
      nextMode,
      lightTheme,
      darkTheme,
      customThemes,
      accent,
    );
    set({ followSystem: follow, mode: nextMode, resolvedThemeId });
    useAgentStore.getState().setSettings(
      { followSystem: follow, themeMode: nextMode },
      { preserveAgent: true },
    );
  },

  toggleMode: () => {
    const { lightTheme, darkTheme, customThemes, accent, mode } = get();
    const nextMode: ThemeMode = mode === 'dark' ? 'light' : 'dark';
    const resolvedThemeId = applyResolved(
      nextMode,
      lightTheme,
      darkTheme,
      customThemes,
      accent,
    );
    set({ followSystem: false, mode: nextMode, resolvedThemeId });
    useAgentStore.getState().setSettings(
      { followSystem: false, themeMode: nextMode },
      { preserveAgent: true },
    );
  },

  setAccent: (accent) => {
    const { lightTheme, darkTheme, customThemes, mode } = get();
    const resolvedThemeId = applyResolved(mode, lightTheme, darkTheme, customThemes, accent);
    set({ accent, resolvedThemeId });
    useAgentStore.getState().setSettings({ accent }, { preserveAgent: true });
  },

  syncFromSystem: (prefersDark) => {
    const { followSystem, lightTheme, darkTheme, customThemes, accent } = get();
    if (!followSystem) return;
    const mode: ThemeMode = prefersDark ? 'dark' : 'light';
    const resolvedThemeId = applyResolved(
      mode,
      lightTheme,
      darkTheme,
      customThemes,
      accent,
    );
    set({ mode, resolvedThemeId });
  },
}));
