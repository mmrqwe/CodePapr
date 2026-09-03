import { useEffect, useRef } from 'react';
import { useAgentStore } from './store/agentStore';
import { useThemeStore } from './store/themeStore';
import { cacheGet, cacheSet } from './utils/cacheStorage';
import {
  THEME_CACHE_KEY,
  parseThemeCache,
  type ParsedThemeCache,
  type ThemeCacheValue,
} from './appThemeCache';

/** 启动顺序：index.html 静态 data-theme="paper-light" 保证首帧可用；缓存镜像（防闪烁）→ Settings（权威）→ 旧偏好迁移进 Settings。 */
export function useAppThemeBoot(settingsLoaded: boolean): void {
  const cachedThemeRef = useRef<ParsedThemeCache | null>(null);
  const themeHydratedRef = useRef(false);
  const themeId = useThemeStore((state) => state.resolvedThemeId);
  const themeMode = useThemeStore((state) => state.mode);
  const themeLightTheme = useThemeStore((state) => state.lightTheme);
  const themeDarkTheme = useThemeStore((state) => state.darkTheme);
  const themeFollowSystem = useThemeStore((state) => state.followSystem);
  const themeAccent = useThemeStore((state) => state.accent);

  useEffect(() => {
    void cacheGet<unknown>(THEME_CACHE_KEY).then((cached) => {
      const parsed = parseThemeCache(cached);
      if (parsed) cachedThemeRef.current = parsed;
      const cachedTheme = cachedThemeRef.current;
      const { settings, settingsLoaded } = useAgentStore.getState();
      if (settingsLoaded) {
        const pristineSlots =
          settings.lightTheme === 'paper-light' &&
          settings.darkTheme === 'paper-dark' &&
          settings.followSystem === true;
        if (cachedTheme?.legacy && pristineSlots) {
          // 旧版偏好迁移进 Settings（一次性），随后以 Settings 为准应用。
          const patch =
            cachedTheme.kind === 'string'
              ? { followSystem: false, themeMode: cachedTheme.value.mode }
              : {
                  lightTheme: cachedTheme.value.light,
                  darkTheme: cachedTheme.value.dark,
                  followSystem: cachedTheme.value.followSystem,
                  themeMode: cachedTheme.value.mode,
                };
          useAgentStore.getState().setSettings(
            { ...patch, accent: settings.accent ?? cachedTheme.value.accent },
            { preserveAgent: true },
          );
        }
        const current = useAgentStore.getState().settings;
        useThemeStore.getState().applyFromSettings({
          lightTheme: current.lightTheme,
          darkTheme: current.darkTheme,
          followSystem: current.followSystem,
          themeMode: current.themeMode,
          accent: current.accent,
          customThemes: current.customThemes,
        });
      } else {
        // Settings 尚未加载：先用缓存防闪烁，加载后由下方 effect 接管。
        const value = cachedTheme?.value ?? null;
        useThemeStore.getState().applyFromSettings({
          lightTheme: value?.light ?? 'paper-light',
          darkTheme: value?.dark ?? 'paper-dark',
          followSystem: value?.followSystem ?? true,
          themeMode: value?.mode ?? 'light',
          accent: value?.accent ?? null,
          customThemes: {},
        });
      }
      themeHydratedRef.current = true;
    });
  }, []);

  // Settings 加载完成后以 Settings 为准（含旧偏好迁移兜底）。
  useEffect(() => {
    if (!settingsLoaded) return;
    const current = useAgentStore.getState().settings;
    const cachedTheme = cachedThemeRef.current;
    const pristineSlots =
      current.lightTheme === 'paper-light' &&
      current.darkTheme === 'paper-dark' &&
      current.followSystem === true;
    if (cachedTheme?.legacy && pristineSlots) {
      useAgentStore.getState().setSettings(
        {
          ...(cachedTheme.kind === 'v1'
            ? {
                lightTheme: cachedTheme.value.light,
                darkTheme: cachedTheme.value.dark,
                followSystem: cachedTheme.value.followSystem,
              }
            : { followSystem: false }),
          themeMode: cachedTheme.value.mode,
          accent: current.accent ?? cachedTheme.value.accent,
        },
        { preserveAgent: true },
      );
      const migrated = useAgentStore.getState().settings;
      useThemeStore.getState().applyFromSettings({
        lightTheme: migrated.lightTheme,
        darkTheme: migrated.darkTheme,
        followSystem: migrated.followSystem,
        themeMode: migrated.themeMode,
        accent: migrated.accent,
        customThemes: migrated.customThemes,
      });
      return;
    }
    useThemeStore.getState().applyFromSettings({
      lightTheme: current.lightTheme,
      darkTheme: current.darkTheme,
      followSystem: current.followSystem,
      themeMode: current.themeMode,
      accent: current.accent,
      customThemes: current.customThemes,
    });
  }, [settingsLoaded]);

  // 启动缓存镜像回写：仅在水合完成后允许，避免空值覆盖旧版缓存。
  useEffect(() => {
    if (!themeHydratedRef.current) return;
    const theme = useThemeStore.getState();
    void cacheSet<ThemeCacheValue>(THEME_CACHE_KEY, {
      mode: theme.mode,
      light: theme.lightTheme,
      dark: theme.darkTheme,
      followSystem: theme.followSystem,
      accent: theme.accent,
    });
  }, [themeId, themeMode, themeLightTheme, themeDarkTheme, themeFollowSystem, themeAccent]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      useThemeStore.getState().syncFromSystem(e.matches);
    };
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);
}
