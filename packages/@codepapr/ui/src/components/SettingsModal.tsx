import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprAppSettings } from '@codepapr/types';
import { getSettingsError, normalizeSettings, useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';
import { useSettingsForm } from '../hooks/useSettingsForm';
import { tabResetKeys } from './settings/constants';
import { SettingsGeneralTab } from './settings/SettingsGeneralTab';
import { SettingsAppearanceTab } from './settings/SettingsAppearanceTab';
import { SettingsLlmTab } from './settings/SettingsLlmTab';
import { SettingsSearchTab } from './settings/SettingsSearchTab';
import { SettingsMentorTab } from './settings/SettingsMentorTab';
import { SettingsAdvancedTab } from './settings/SettingsAdvancedTab';
import { SettingsAppTab } from './settings/SettingsAppTab';
import { useThemeStore } from '../store/themeStore';
import type { SettingsTab } from './settings/types';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { syncRunningBackendsToAccess } from '../tools/workspaceAppTools';

function tabButtonClass(active: boolean): string {
  return `rounded-xl border px-3 py-3 text-left transition-colors ${
    active
      ? 'border-accent-soft bg-accent-soft text-fg shadow-[0_0_14px_rgba(99,102,241,0.12)]'
      : 'border-line text-fg-muted hover:border-line-strong hover:bg-raised hover:text-fg'
  }`;
}

export function SettingsModal() {
  const { setSettings, setShowSettings } = useAgentStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { local, update, clampOnBlur } = useSettingsForm();
  const currentLang = local.lang ?? 'zh-CN';
  const t = getTranslation(currentLang);
  const settingsError = getSettingsError(local);

  const [appDraft, setAppDraft] = useState<PaprAppSettings | null>(null);
  const [appLoadError, setAppLoadError] = useState('');
  useEffect(() => {
    invoke<PaprAppSettings>('papr_get_app_settings')
      .then((settings) => {
        const next =
          settings && typeof settings.defaultLocal === 'string'
            ? settings
            : { defaultLocal: 'none' as const, defaultNetwork: false, appOverrides: {} };
        setAppDraft(next);
        usePaprPermissionStore.getState().setAppSettings(next);
      })
      .catch((err) => setAppLoadError(String(err)));
  }, []);

  const resetTab = (tab: SettingsTab) => {
    if (tab === 'app') {
      setAppDraft({ defaultLocal: 'none', defaultNetwork: false, appOverrides: {} });
      return;
    }
    const defaults = normalizeSettings({});
    const resetPart: Partial<typeof local> = {};
    for (const key of tabResetKeys(local.apiMode)[tab]) {
      (resetPart as Record<string, unknown>)[key] = (defaults as unknown as Record<string, unknown>)[key];
    }
    update(resetPart);
  };

  // 主题相关草稿即时应用到 DOM（实时预览）；取消保存时回滚到已持久化值。
  useEffect(() => {
    useThemeStore.getState().applyFromSettings({
      lightTheme: local.lightTheme,
      darkTheme: local.darkTheme,
      followSystem: local.followSystem,
      themeMode: useThemeStore.getState().mode,
      accent: local.accent,
      customThemes: local.customThemes,
    });
  }, [local.lightTheme, local.darkTheme, local.followSystem, local.accent, local.customThemes]);

  const save = () => {
    if (appDraft && !appLoadError) {
      const prev = usePaprPermissionStore.getState().appSettings;
      invoke('papr_set_app_settings', { settings: appDraft }).catch(() => {
        /* best-effort: app permission persistence mirrors the draft model */
      });
      usePaprPermissionStore.getState().setAppSettings(appDraft);
      // CSP 在 HTML 响应头里，必须重挂 iframe 才生效。权限没改则不必重载。
      const openedAppId = useAppRuntimeStore.getState().openedAppId;
      const permissionsChanged = JSON.stringify(prev) !== JSON.stringify(appDraft);
      if (permissionsChanged) {
        const workspacePath = useAgentStore.getState().workspacePath;
        void syncRunningBackendsToAccess(prev, appDraft, workspacePath).finally(() => {
          if (openedAppId) useAppRuntimeStore.getState().reloadApp(openedAppId);
        });
      }
    }
    setSettings(local);
    setShowSettings(false);
  };

  // 外观页会实时把草稿主题应用到 DOM（预览）；取消保存时回滚到已持久化值。
  const closeWithoutSave = () => {
    const persisted = useAgentStore.getState().settings;
    useThemeStore.getState().applyFromSettings({
      lightTheme: persisted.lightTheme,
      darkTheme: persisted.darkTheme,
      followSystem: persisted.followSystem,
      themeMode: persisted.themeMode,
      accent: persisted.accent,
      customThemes: persisted.customThemes,
    });
    setShowSettings(false);
  };

  const tabs: Array<{ id: SettingsTab; label: string; tip: string }> = [
    { id: 'general', label: t.settingsGeneralTab, tip: t.settingsGeneralTabTip },
    { id: 'appearance', label: t.settingsAppearanceTab, tip: t.settingsAppearanceTabTip },
    { id: 'llm', label: t.settingsLlmTab, tip: t.settingsLlmTabTip },
    { id: 'search', label: t.settingsSearchTab, tip: t.settingsSearchTabTip },
    { id: 'mentor', label: t.settingsMentorTab, tip: t.settingsMentorTabTip },
    { id: 'advanced', label: t.settingsAdvancedTab, tip: t.settingsAdvancedTabTip },
    { id: 'app', label: t.settingsAppTab, tip: t.settingsAppTabTip },
  ];

  const tabProps = { local, update, t, currentLang };

  return (
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-overlay backdrop-blur-sm animate-fade-in">
      {/* onBlur bubbles (React focusout), so leaving any field clamps/trims the
          whole draft once — numeric ranges snap on blur instead of mid-typing. */}
      <div
        onBlur={clampOnBlur}
        className="flex max-h-[94vh] h-[94vh] w-[min(96vw,1480px)] flex-col overflow-hidden rounded-3xl border border-line bg-raised shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-line px-7 py-5">
          <div>
            <h2 className="text-lg font-semibold text-fg">{t.modelSettings}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t.settingsLlmDesc}</p>
          </div>
          <button
            onClick={closeWithoutSave}
            title={t.cancel}
            className="text-2xl leading-none text-fg-muted hover:text-fg-soft"
          >
            ×
          </button>
        </div>

        <div className="border-b border-line bg-base px-5 py-3">
          <div className="grid grid-cols-7 gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={tabButtonClass(activeTab === tab.id)}
                onClick={() => setActiveTab(tab.id)}
                title={tab.tip}
              >
                <div className="text-sm font-semibold">{tab.label}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-7 py-6 scrollbar-thin">
          {activeTab === 'general' && <SettingsGeneralTab {...tabProps} />}
          {activeTab === 'appearance' && <SettingsAppearanceTab {...tabProps} />}
          {activeTab === 'llm' && <SettingsLlmTab {...tabProps} />}
          {activeTab === 'search' && <SettingsSearchTab {...tabProps} />}
          {activeTab === 'mentor' && <SettingsMentorTab {...tabProps} />}
          {activeTab === 'advanced' && <SettingsAdvancedTab {...tabProps} />}
          {activeTab === 'app' && (
            <SettingsAppTab
              currentLang={currentLang}
              value={appDraft}
              onChange={setAppDraft}
              loadError={appLoadError}
            />
          )}

          {settingsError && (
            <div className="mt-5 rounded-2xl border border-warn-bg bg-warn-bg px-4 py-3 text-sm text-warn">
              {settingsError}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-line bg-base px-7 py-5">
          <button type="button" onClick={() => resetTab(activeTab)} className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-danger-bg hover:text-danger" title={currentLang === 'en' ? 'Reset current tab to defaults' : '重置当前分页为默认'}>
            &#8634;
          </button>
          <div className="flex-1" />
          <button
            onClick={closeWithoutSave}
            title={currentLang === 'en' ? 'Close settings without saving the current edits.' : '关闭设置，不保存当前修改。'}
            className="px-5 py-2.5 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            {t.cancel}
          </button>
          <button
            onClick={save}
            title={
              currentLang === 'en'
                ? 'Save the current settings for the desktop runtime and internal automation host.'
                : '保存当前设置，并同时影响桌面端与内部自动化宿主的运行行为。'
            }
            className="rounded-xl bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            {t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
