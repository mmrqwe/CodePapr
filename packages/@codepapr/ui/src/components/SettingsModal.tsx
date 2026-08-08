import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprAppSettings } from '@codepapr/types';
import { getSettingsError, normalizeSettings, useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';
import { useSettingsForm } from '../hooks/useSettingsForm';
import { tabResetKeys } from './settings/constants';
import { SettingsGeneralTab } from './settings/SettingsGeneralTab';
import { SettingsLlmTab } from './settings/SettingsLlmTab';
import { SettingsSearchTab } from './settings/SettingsSearchTab';
import { SettingsMentorTab } from './settings/SettingsMentorTab';
import { SettingsAdvancedTab } from './settings/SettingsAdvancedTab';
import { SettingsAppTab } from './settings/SettingsAppTab';
import type { SettingsTab } from './settings/types';

function tabButtonClass(active: boolean): string {
  return `rounded-xl border px-3 py-3 text-left transition-colors ${
    active
      ? 'border-indigo-500/60 bg-[#2b3150] text-slate-100 shadow-[0_0_14px_rgba(99,102,241,0.12)]'
      : 'border-[#2a2d3a] text-slate-400 hover:border-slate-500/60 hover:bg-[#202434] hover:text-slate-200'
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
      .then(setAppDraft)
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

  const save = () => {
    if (appDraft && !appLoadError) {
      invoke('papr_set_app_settings', { settings: appDraft }).catch(() => {
        /* best-effort: app permission persistence mirrors the draft model */
      });
    }
    setSettings(local);
    setShowSettings(false);
  };

  const tabs: Array<{ id: SettingsTab; label: string; tip: string }> = [
    { id: 'general', label: t.settingsGeneralTab, tip: t.settingsGeneralTabTip },
    { id: 'llm', label: t.settingsLlmTab, tip: t.settingsLlmTabTip },
    { id: 'search', label: t.settingsSearchTab, tip: t.settingsSearchTabTip },
    { id: 'mentor', label: t.settingsMentorTab, tip: t.settingsMentorTabTip },
    { id: 'advanced', label: t.settingsAdvancedTab, tip: t.settingsAdvancedTabTip },
    { id: 'app', label: t.settingsAppTab, tip: t.settingsAppTabTip },
  ];

  const tabProps = { local, update, t, currentLang };

  return (
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      {/* onBlur bubbles (React focusout), so leaving any field clamps/trims the
          whole draft once — numeric ranges snap on blur instead of mid-typing. */}
      <div
        onBlur={clampOnBlur}
        className="flex max-h-[94vh] h-[94vh] w-[min(96vw,1480px)] flex-col overflow-hidden rounded-3xl border border-[#2a2d3a] bg-[#1a1d27] shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-[#2a2d3a] px-7 py-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{t.modelSettings}</h2>
            <p className="mt-1 text-sm text-slate-500">{t.settingsLlmDesc}</p>
          </div>
          <button
            onClick={() => setShowSettings(false)}
            title={t.cancel}
            className="text-2xl leading-none text-slate-500 hover:text-slate-300"
          >
            ×
          </button>
        </div>

        <div className="border-b border-[#2a2d3a] bg-[#161922] px-5 py-3">
          <div className="grid grid-cols-6 gap-2">
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
            <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {settingsError === 'Please configure model settings' ? t.errorConfigModel : settingsError}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-[#2a2d3a] bg-[#161922] px-7 py-5">
          <button type="button" onClick={() => resetTab(activeTab)} className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-xs text-slate-500 transition-colors hover:border-red-500/30 hover:text-red-400" title={currentLang === 'en' ? 'Reset current tab to defaults' : '重置当前分页为默认'}>
            &#8634;
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setShowSettings(false)}
            title={currentLang === 'en' ? 'Close settings without saving the current edits.' : '关闭设置，不保存当前修改。'}
            className="px-5 py-2.5 text-sm text-slate-400 transition-colors hover:text-slate-200"
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
            className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            {t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
