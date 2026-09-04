import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FieldCard, FieldLabel, TextField } from '../forms';
import type { SettingsTabProps } from './types';

interface SearxngProbeResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  sampleResults: number;
}

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
  const [testingConnection, setTestingConnection] = useState(false);
  const [probeResult, setProbeResult] = useState<SearxngProbeResult | null>(null);

  const runConnectionTest = async () => {
    setTestingConnection(true);
    setProbeResult(null);
    try {
      const result = await invoke<SearxngProbeResult>('test_searxng_connection', {
        baseUrl: local.searxngBaseUrl,
      });
      setProbeResult(result);
    } catch (err) {
      setProbeResult({ ok: false, latencyMs: 0, message: String(err), sampleResults: 0 });
    } finally {
      setTestingConnection(false);
    }
  };

  const baseUrlCard = (
    <FieldCard padding="loose">
      <TextField
        label={t.searxngBaseUrlLabel}
        labelTight
        type="text"
        value={local.searxngBaseUrl}
        onChange={(e) => {
          update({ searxngBaseUrl: e.target.value });
          setProbeResult(null);
        }}
        placeholder="http://localhost:8080"
        title={t.searxngBaseUrlLabel}
      />
      <p className="mt-2 text-xs text-fg-muted">{t.searxngBaseUrlHint}</p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={runConnectionTest}
          disabled={testingConnection}
          className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-fg-soft transition-colors hover:border-accent-soft hover:text-fg disabled:opacity-50"
        >
          {testingConnection ? t.searxngTesting : t.searxngTestConnection}
        </button>
        {probeResult && (
          <span className={`text-xs ${probeResult.ok ? 'text-ok' : 'text-danger'}`}>
            {probeResult.message}
          </span>
        )}
      </div>
      {probeResult?.ok && !local.searxngEnabled && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-accent-soft bg-accent-soft px-4 py-3">
          <span className="text-xs text-accent-text">{t.searxngTestSuggestEnable}</span>
          <button
            type="button"
            onClick={() => update({ searxngEnabled: true })}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-base transition-opacity hover:opacity-90"
          >
            {t.searxngTestEnableNow}
          </button>
        </div>
      )}
    </FieldCard>
  );

  return (
    <div className="space-y-5">
      <FieldCard padding="loose">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={local.searxngEnabled}
            onChange={(e) => update({ searxngEnabled: e.target.checked })}
            className="h-5 w-5 rounded accent-accent"
          />
          <div>
            <span className="text-sm font-medium text-fg">{t.searxngEnable}</span>
            <p className="mt-0.5 text-xs text-fg-muted">{t.searxngEnableDesc}</p>
          </div>
        </label>
      </FieldCard>

      {!local.searxngEnabled && (
        <div className="rounded-2xl border border-line bg-base px-5 py-4 text-xs leading-relaxed text-fg-muted">
          {t.searxngBuiltinModeNote}
        </div>
      )}

      {local.searxngEnabled ? (
        <>
          {baseUrlCard}

          <div className="rounded-2xl border border-line bg-base">
            <button
              type="button"
              onClick={() => setShowSearxngAdvanced(!showSearxngAdvanced)}
              className="flex w-full items-center justify-between px-5 py-4 text-sm font-medium text-fg-soft hover:text-fg transition-colors"
            >
              <span>{t.searxngAdvancedLabel}</span>
              <span className={`text-xs text-fg-muted transition-transform ${showSearxngAdvanced ? 'rotate-90' : ''}`}>
                {'\u25B8'}
              </span>
            </button>

            {showSearxngAdvanced && (
              <div className="px-5 pb-5 space-y-5 border-t border-line pt-4">
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
                              ? 'border-accent-soft bg-accent-soft text-accent-text'
                              : 'border-line text-fg-muted hover:border-line-strong hover:text-fg-soft'
                          }`}
                        >
                          {t[cat.labelKey]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <FieldLabel tight>{t.searxngTimeRangeLabel}</FieldLabel>
                    <select
                      value={local.searxngTimeRange}
                      onChange={(e) => update({ searxngTimeRange: e.target.value })}
                      className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
                    >
                      <option value="">{t.searxngTimeRangeNone}</option>
                      <option value="day">{t.searxngTimeRangeDay}</option>
                      <option value="week">{t.searxngTimeRangeWeek}</option>
                      <option value="month">{t.searxngTimeRangeMonth}</option>
                      <option value="year">{t.searxngTimeRangeYear}</option>
                    </select>
                  </div>
                  <div>
                    <TextField
                      label={t.searxngLanguageLabel}
                      labelTight
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
                          className="h-4 w-4 accent-accent"
                        />
                        <span className="text-sm text-fg-soft">
                          {level === 0 ? t.searxngSafeSearch0 : level === 1 ? t.searxngSafeSearch1 : t.searxngSafeSearch2}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-warn-bg bg-warn-bg px-5 py-4 text-xs leading-relaxed text-warn">
            {t.searxngNotice}
          </div>
        </>
      ) : (
        baseUrlCard
      )}
    </div>
  );
}
