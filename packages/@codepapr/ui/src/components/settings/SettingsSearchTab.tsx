import { useState } from 'react';
import { FieldCard, FieldLabel, TextField } from '../forms';
import type { SettingsTabProps } from './types';

const SEARXNG_CATEGORIES = [
  { key: 'general', labelKey: 'searxngCategoryGeneral' as const },
  { key: 'images', labelKey: 'searxngCategoryImages' as const },
  { key: 'videos', labelKey: 'searxngCategoryVideos' as const },
  { key: 'news', labelKey: 'searxngCategoryNews' as const },
  { key: 'science', labelKey: 'searxngCategoryScience' as const },
  { key: 'map', labelKey: 'searxngCategoryMap' as const },
  { key: 'it', labelKey: 'searxngCategoryIt' as const },
  { key: 'music', labelKey: 'searxngCategoryMusic' as const },
  { key: 'files', labelKey: 'searxngCategoryFiles' as const },
  { key: 'social media', labelKey: 'searxngCategorySocialMedia' as const },
];

export function SettingsSearchTab({ local, update, t }: SettingsTabProps) {
  const [showSearxngAdvanced, setShowSearxngAdvanced] = useState(false);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
        {t.settingsSearchDesc}
      </div>

      <FieldCard padding="loose">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={local.searxngEnabled}
            onChange={(e) => update({ searxngEnabled: e.target.checked })}
            className="h-5 w-5 rounded accent-indigo-500"
          />
          <div>
            <span className="text-sm font-medium text-slate-200">{t.searxngEnable}</span>
            <p className="mt-0.5 text-xs text-slate-500">{t.searxngEnableDesc}</p>
          </div>
        </label>
      </FieldCard>

      {local.searxngEnabled && (
        <>
          <FieldCard padding="loose">
            <TextField
              label={t.searxngBaseUrlLabel}
              labelTight
              hint={t.searxngBaseUrlHint}
              type="text"
              value={local.searxngBaseUrl}
              onChange={(e) => update({ searxngBaseUrl: e.target.value })}
              placeholder="http://localhost:8080"
              title={t.searxngBaseUrlLabel}
            />
          </FieldCard>

          <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b]">
            <button
              type="button"
              onClick={() => setShowSearxngAdvanced(!showSearxngAdvanced)}
              className="flex w-full items-center justify-between px-5 py-4 text-sm font-medium text-slate-300 hover:text-slate-100 transition-colors"
            >
              <span>{t.searxngAdvancedLabel}</span>
              <span className={`text-xs text-slate-500 transition-transform ${showSearxngAdvanced ? 'rotate-90' : ''}`}>
                {'\u25B8'}
              </span>
            </button>

            {showSearxngAdvanced && (
              <div className="px-5 pb-5 space-y-5 border-t border-[#2a2d3a] pt-4">
                <div>
                  <FieldLabel tight>{t.searxngCategoriesLabel}</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {SEARXNG_CATEGORIES.map((cat) => {
                      const cats = local.searxngCategories.split(',').map((c: string) => c.trim()).filter(Boolean);
                      const active = cats.includes(cat.key);
                      const toggle = () => {
                        const next = active
                          ? cats.filter((c: string) => c !== cat.key)
                          : [...cats, cat.key];
                        update({ searxngCategories: next.join(',') });
                      };
                      return (
                        <button
                          key={cat.key}
                          onClick={toggle}
                          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                            active
                              ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-200'
                              : 'border-[#2a2d3a] text-slate-500 hover:border-slate-500/60 hover:text-slate-300'
                          }`}
                        >
                          {t[cat.labelKey]}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">{t.searxngCategoriesHint}</p>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <FieldLabel tight>{t.searxngTimeRangeLabel}</FieldLabel>
                    <select
                      value={local.searxngTimeRange}
                      onChange={(e) => update({ searxngTimeRange: e.target.value })}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    >
                      <option value="">{t.searxngTimeRangeNone}</option>
                      <option value="day">{t.searxngTimeRangeDay}</option>
                      <option value="week">{t.searxngTimeRangeWeek}</option>
                      <option value="month">{t.searxngTimeRangeMonth}</option>
                      <option value="year">{t.searxngTimeRangeYear}</option>
                    </select>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.searxngTimeRangeHint}</p>
                  </div>
                  <div>
                    <TextField
                      label={t.searxngLanguageLabel}
                      labelTight
                      hint={t.searxngLanguageHint}
                      type="text"
                      value={local.searxngLanguage}
                      onChange={(e) => update({ searxngLanguage: e.target.value })}
                      placeholder="zh-CN / en / ja"
                      title={t.searxngLanguageLabel}
                    />
                  </div>
                </div>

                <div>
                  <FieldLabel tight>{t.searxngSafeSearchLabel}</FieldLabel>
                  <div className="flex gap-4">
                    {[0, 1, 2].map((level) => (
                      <label key={level} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="searxngSafeSearch"
                          checked={local.searxngSafeSearch === level}
                          onChange={() => update({ searxngSafeSearch: level })}
                          className="h-4 w-4 accent-indigo-500"
                        />
                        <span className="text-sm text-slate-300">
                          {level === 0 ? t.searxngSafeSearch0 : level === 1 ? t.searxngSafeSearch1 : t.searxngSafeSearch2}
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">{t.searxngSafeSearchHint}</p>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-5 py-4 text-xs leading-relaxed text-amber-400/80">
            启用后将使用自部署 SearXNG 聚合搜索，替代所有内置搜索源。分类、时间等参数默认知别 SearXNG 实例配置，无需额外设置。
          </div>
        </>
      )}
    </div>
  );
}
