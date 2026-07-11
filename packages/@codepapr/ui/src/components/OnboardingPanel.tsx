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
    setSettings({
      apiMode: 'deepseek',
      apiFormat: 'openai',
      provider: 'deepseek',
      baseURL: '',
      apiKey: trimmedKey,
      model,
      fastModel: 'deepseek-v4-flash',
    });
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
        <div className="border-b border-[#2a2d3a] px-6 py-5">
          <h2 className="text-base font-semibold text-slate-100">{t.onboardingTitle}</h2>
          <p className="mt-1 text-xs text-slate-400">{t.onboardingSubtitle}</p>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div className="rounded-lg border border-[#2a2d3a] bg-[#0f1117] px-3 py-2 text-xs text-slate-400">
            <span className="text-slate-300">{t.onboardingGetKey}</span>
            <span className="ml-1 break-all text-indigo-300">{DEEPSEEK_KEYS_URL}</span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-300">{t.onboardingApiKeyLabel}</span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t.onboardingApiKeyPlaceholder}
                autoFocus
                spellCheck={false}
                className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-3 py-2 pr-16 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-[#202434] hover:text-slate-200"
              >
                {showKey ? t.onboardingHideKey : t.onboardingShowKey}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-300">{t.onboardingModelLabel}</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-3 py-2 text-sm text-slate-100 focus:border-indigo-500/60 focus:outline-none"
            >
              {DEEPSEEK_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <p className="text-[11px] text-slate-500">{t.onboardingHint}</p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#2a2d3a] bg-[#0f1117] px-6 py-4">
          <button
            type="button"
            onClick={handleUseOther}
            className="text-xs text-slate-400 underline-offset-2 hover:text-indigo-300 hover:underline"
          >
            {t.onboardingUseOther}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSkip}
              className="rounded-xl border border-[#2a2d3a] px-4 py-2 text-xs text-slate-300 transition-colors hover:border-slate-500/60 hover:bg-[#202434]"
            >
              {t.onboardingSkip}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className={`rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
                canSave
                  ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                  : 'cursor-not-allowed bg-indigo-500/30 text-indigo-200/50'
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
