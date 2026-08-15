import { useState } from 'react';
import { LicenseModal } from '../LicenseModal';
import { BUILTIN_THEMES } from '../../theme/themes';
import type { Lang } from '../../utils/i18n';
import type { ThemeMode } from '../../theme/types';
import { FieldCard, ToggleField } from '../forms';
import type { SettingsTabProps } from './types';

/** 组件迁移（Phase 3）完成前，新浅色主题不能完整渲染。 */
const EXPERIMENTAL_THEME_IDS = new Set(['solarized-light']);

function themeOptions(
  mode: ThemeMode,
  customThemes: Record<string, { name: string; mode: ThemeMode }>,
  lang: string,
): Array<{ id: string; label: string }> {
  const experimentalSuffix =
    lang === 'en' ? ' (Experimental)' : lang === 'zh-TW' ? '（實驗性）' : '（实验性）';
  const builtin = BUILTIN_THEMES.filter((t) => t.mode === mode).map((t) => ({
    id: t.id,
    label: EXPERIMENTAL_THEME_IDS.has(t.id) ? `${t.name}${experimentalSuffix}` : t.name,
  }));
  const custom = Object.entries(customThemes)
    .filter(([, record]) => record.mode === mode)
    .map(([id, record]) => ({ id, label: record.name }));
  return [...builtin, ...custom];
}

export function SettingsGeneralTab({ local, update, t, currentLang }: SettingsTabProps) {
  const [showLicense, setShowLicense] = useState(false);
  const lightOptions = themeOptions('light', local.customThemes, currentLang);
  const darkOptions = themeOptions('dark', local.customThemes, currentLang);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-base px-5 py-4 text-sm leading-relaxed text-fg-muted">
        {t.settingsGeneralDesc}
      </div>

      <FieldCard>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.langSelect}
        </label>
        <select
          value={local.lang}
          onChange={(e) => update({ lang: e.target.value as Lang })}
          title={t.langSelect}
          className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
        >
          <option value="zh-CN">简体中文 (Simplified Chinese)</option>
          <option value="zh-TW">繁體中文 (Traditional Chinese)</option>
          <option value="en">English</option>
        </select>
      </FieldCard>

      <FieldCard>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.themeLightSelect}
        </label>
        <select
          value={local.lightTheme}
          onChange={(e) => update({ lightTheme: e.target.value })}
          title={t.themeLightSelectDesc}
          className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
        >
          {lightOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-fg-muted">{t.themeLightSelectDesc}</p>
      </FieldCard>

      <FieldCard>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.themeDarkSelect}
        </label>
        <select
          value={local.darkTheme}
          onChange={(e) => update({ darkTheme: e.target.value })}
          title={t.themeDarkSelectDesc}
          className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
        >
          {darkOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-fg-muted">{t.themeDarkSelectDesc}</p>
      </FieldCard>

      <ToggleField
        checked={local.followSystem}
        onChange={(checked) => update({ followSystem: checked })}
        label={t.themeFollowSystem}
        desc={t.themeFollowSystemDesc}
        title={t.themeFollowSystemDesc}
      />

      <ToggleField
        checked={local.debugEnabled}
        onChange={(checked) => update({ debugEnabled: checked })}
        label={t.debugMode}
        desc={t.debugModeDesc}
        title={t.debugModeDesc}
      />

      <ToggleField
        checked={local.chatBordersEnabled}
        onChange={(checked) => update({ chatBordersEnabled: checked })}
        label={t.chatBorders}
        desc={t.chatBordersDesc}
        title={t.chatBordersDesc}
      />

      <FieldCard padding="loose">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.licenseSection}
        </h3>
        <p className="mb-4 text-xs leading-relaxed text-fg-muted">{t.licenseSectionDesc}</p>
        <div className="rounded-xl border border-line bg-base px-4 py-3 max-h-64 overflow-y-auto">
          <div className="text-xs font-semibold text-fg mb-2">{t.licenseTitle}</div>
          <div className="text-xs text-fg-muted mb-3">{t.licenseCopyright}</div>
          <div className="text-[10px] leading-relaxed text-fg-muted whitespace-pre-wrap">{t.licenseText}</div>
          <div className="mt-4 pt-4 border-t border-line">
            <button type="button" onClick={() => setShowLicense(true)} className="rounded-xl border border-accent-soft px-4 py-2 text-xs font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft">
              {currentLang === 'en' ? 'View Third-Party Licenses' : currentLang === 'zh-TW' ? '檢視第三方授權' : '查看第三方许可'}
            </button>
          </div>
        </div>
      </FieldCard>

      {showLicense && <LicenseModal onClose={() => setShowLicense(false)} />}
    </div>
  );
}
