import { useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';

const DEEPSEEK_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'];
const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys';

interface OnboardingPanelProps {
  onDismiss: () => void;
  onOpenFullSettings: () => void;
}

export function OnboardingPanel({ onDismiss, onOpenFullSettings }: OnboardingPanelProps) {
  const { settings, setSettings } = useAgentStore();
  const t = getTranslation(settings.lang);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-v4-pro');
  const [showKey, setShowKey] = useState(false);

  const trimmedKey = apiKey.trim();
  const canSave = trimmedKey.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    // modelProfiles 是单一真相：直接更新 primary/fast 槽位的 profile，
    // 扁平字段与 per-mode 配置都由 normalizeSettings 从其派生。
    const nextProfiles = settings.modelProfiles.map((p) => {
      if (p.id === settings.primaryProfileId) {
        return {
          ...p,
          apiMode: 'deepseek' as const,
          apiFormat: 'openai' as const,
          baseURL: '',
          apiKey: trimmedKey,
          model,
        };
      }
      if (p.id === settings.fastProfileId) {
        return {
          ...p,
          apiMode: 'deepseek' as const,
          apiFormat: 'openai' as const,
          model: 'deepseek-v4-flash',
        };
      }
      return p;
    });
    setSettings({ modelProfiles: nextProfiles });
    onDismiss();
  };

  const handleSkip = () => {
    onDismiss();
  };

  const handleUseOther = () => {
    onDismiss();
    onOpenFullSettings();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
        <div className="border-b border-line px-6 py-5">
          <h2 className="text-base font-semibold text-fg">{t.onboardingTitle}</h2>
          <p className="mt-1 text-xs text-fg-muted">{t.onboardingSubtitle}</p>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div className="rounded-lg border border-line bg-base px-3 py-2 text-xs text-fg-muted">
            <span className="text-fg-soft">{t.onboardingGetKey}</span>
            <span className="ml-1 break-all text-accent-text">{DEEPSEEK_KEYS_URL}</span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-soft">{t.onboardingApiKeyLabel}</span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t.onboardingApiKeyPlaceholder}
                autoFocus
                spellCheck={false}
                className="w-full rounded-xl border border-line bg-base px-3 py-2 pr-16 text-sm text-fg placeholder:text-fg-dim focus:border-accent-soft focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] text-fg-muted hover:bg-raised hover:text-fg"
              >
                {showKey ? t.onboardingHideKey : t.onboardingShowKey}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-soft">{t.onboardingModelLabel}</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-accent-soft focus:outline-none"
            >
              {DEEPSEEK_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <p className="text-[11px] text-fg-muted">{t.onboardingHint}</p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-base px-6 py-4">
          <button
            type="button"
            onClick={handleUseOther}
            className="text-xs text-fg-muted underline-offset-2 hover:text-accent-text hover:underline"
          >
            {t.onboardingUseOther}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSkip}
              className="rounded-xl border border-line px-4 py-2 text-xs text-fg-soft transition-colors hover:border-line-strong hover:bg-raised"
            >
              {t.onboardingSkip}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className={`rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
                canSave
                  ? 'bg-accent text-white hover:bg-accent'
                  : 'cursor-not-allowed bg-accent-soft text-accent-text/50'
              }`}
            >
              {t.onboardingSave}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
