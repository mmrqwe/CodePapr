import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprAppSettings } from '@codepapr/types';
import {
  ApiFormat,
  ApiMode,
  Settings,
  getSettingsError,
  normalizeSettings,
  useAgentStore,
} from '../store/agentStore';
import { DEEPSEEK_MAX_TOKENS } from '@codepapr/api/tokenLimits';
import { AppPermissionsTab } from './AppPermissionsTab';
import { OpenAIProvider, ClaudeProvider } from '@codepapr/api';
import { BUILTIN_AGENTS, resolveAgentPrompt } from '@codepapr/core';
import { getTranslation, Lang } from '../utils/i18n';
import { LicenseModal } from './LicenseModal';

type SettingsTab = 'general' | 'llm' | 'search' | 'mentor' | 'advanced' | 'app';

const MODEL_PRESETS: Record<ApiMode | ApiFormat, string[]> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  claude: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  custom: [],
  local: ['local-model', 'qwen2.5-coder', 'llama3.1'],
};

const LOCAL_URL_PLACEHOLDER = 'http://127.0.0.1:8080/v1（llama.cpp / Ollama / LM Studio）';

const CUSTOM_URL_PLACEHOLDERS: Record<ApiFormat, string> = {
  openai: 'https://api.openai.com/v1 或兼容服务 /v1',
  claude: 'https://api.anthropic.com/v1 或兼容 Claude Messages API',
};

function modeButtonClass(active: boolean): string {
  return `rounded-xl border px-4 py-3 text-left transition-colors ${
    active
      ? 'border-indigo-500/60 bg-indigo-500/15 text-indigo-100 shadow-[0_0_12px_rgba(99,102,241,0.1)]'
      : 'border-[#2a2d3a] bg-[#0f1117] text-slate-400 hover:border-slate-500/60 hover:text-slate-200'
  }`;
}

function tabButtonClass(active: boolean): string {
  return `rounded-xl border px-3 py-3 text-left transition-colors ${
    active
      ? 'border-indigo-500/60 bg-[#2b3150] text-slate-100 shadow-[0_0_14px_rgba(99,102,241,0.12)]'
      : 'border-[#2a2d3a] text-slate-400 hover:border-slate-500/60 hover:bg-[#202434] hover:text-slate-200'
  }`;
}

export function SettingsModal() {
  const {
    settings,
    setSettings,
    setShowSettings,
  } = useAgentStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [subAgent, setSubAgent] = useState<'explore' | 'scout' | 'mentor'>('explore');
  const [showSearxngAdvanced, setShowSearxngAdvanced] = useState(false);
  const [mentorTestStatus, setMentorTestStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [mentorTestMessage, setMentorTestMessage] = useState('');
  const [showLicense, setShowLicense] = useState(false);
  const [local, setLocal] = useState<Settings>(normalizeSettings(settings));
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

  const defaultPrompts: Record<string, string> = {};
  for (const agent of BUILTIN_AGENTS) {
    defaultPrompts[agent.name] = resolveAgentPrompt(agent, currentLang);
  }

  // No effect syncing store -> draft while open: the modal mounts on open, so
  // the initial state above captures the latest settings, and re-syncing on
  // every store change would silently discard unsaved edits when a background
  // action (e.g. openWorkspace upserting recent workspaces) updates settings.

  const update = (partial: Partial<Settings>) => {
    setLocal((current) => {
      const merged = { ...current, ...partial };
      // Shallow merge plus lightweight re-derivation of the flat fields that
      // validation reads (getSettingsError uses flat apiKey/model/baseURL).
      // We deliberately do NOT run normalizeSettings here: doing so on every
      // keystroke trimmed free-text inputs (dropping spaces in prompts/URLs)
      // and clamped numeric inputs mid-entry. Clamping/trimming happens on
      // save (setSettings) and on blur (clampOnBlur) instead.
      const activeConfig = merged[merged.apiMode];
      return {
        ...merged,
        provider:
          merged.apiMode === 'deepseek'
            ? 'deepseek'
            : merged.apiMode === 'local'
            ? 'openai'
            : merged.apiFormat,
        model: activeConfig.model,
        fastModel: activeConfig.fastModel,
        apiKey: activeConfig.apiKey,
        baseURL: activeConfig.baseURL,
      };
    });
  };

  const clampOnBlur = () => {
    setLocal((current) => normalizeSettings(current));
  };

  const resetTab = (tab: SettingsTab) => {
    if (tab === 'app') {
      setAppDraft({ defaultLevel: 1, allowLevel3: false, appOverrides: {} });
      return;
    }
    const defaults = normalizeSettings({});
    const tabKeys: Record<SettingsTab, (keyof Settings)[]> = {
      general: ['lang', 'debugEnabled', 'chatBordersEnabled'],
      // Reset only the active mode's config (local.apiMode); the other two
      // modes' configs — and therefore their API keys — are preserved. The flat
      // fields (model/apiKey/baseURL/fastModel/maxTokens) are re-derived from
      // the active mode config by update(), so they need not be listed here.
      llm: ['apiMode', 'apiFormat', 'fastModelEnabled', 'thinkingEnabled', 'thinkingEffort', 'temperature', 'topP', 'maxToolRounds', local.apiMode],
      search: ['searxngEnabled', 'searxngBaseUrl', 'searxngCategories', 'searxngTimeRange', 'searxngLanguage', 'searxngSafeSearch'],
      mentor: ['mentorEnabled', 'mentorApiFormat', 'mentorBaseURL', 'mentorApiKey', 'mentorModel', 'mentorMaxTokens', 'mentorThinkingEnabled', 'maxMentorConsultations', 'explorePrompt', 'scoutPrompt', 'mentorPrompt', 'exploreTemperature', 'exploreMaxToolRounds', 'exploreMaxTokens', 'exploreTopP', 'exploreMaxDepth', 'exploreThinkingEnabled', 'scoutTemperature', 'scoutMaxToolRounds', 'scoutMaxTokens', 'scoutTopP', 'scoutMaxDepth', 'scoutThinkingEnabled'],
      advanced: ['compactionModel', 'compactionMaxTokens', 'compactionTemperature', 'maxContextTokens', 'maxConversationRounds', 'toolContextDefaultMode', 'toolContextOverrides', 'toolContextSummaryMaxChars', 'toolContextAutoThresholdChars', 'todoMaxRetries', 'goalMaxIterations', 'goalMaxWallClockMs', 'goalRequireGitClean', 'verifierModelTier', 'verifierMaxTokens', 'verifierTemperature', 'projectGraphMaxDepth', 'projectGraphMaxFiles', 'projectGraphMaxEdges', 'projectGraphMaxSymbolsPerFile', 'projectGraphMaxFileBytes', 'projectGraphMaxTreeEntries', 'streamIdleTimeoutMs', 'toolOutputMiddleKeepChars'],
      app: [],
    };
    const resetPart: Partial<Settings> = {};
    for (const key of tabKeys[tab]) {
      (resetPart as Record<string, unknown>)[key] = (defaults as unknown as Record<string, unknown>)[key];
    }
    update(resetPart);
  };

  const setApiMode = (apiMode: ApiMode) => {
    update({ apiMode });
  };

  const setApiFormat = (apiFormat: ApiFormat) => {
    update({
      apiFormat,
      custom: { ...local.custom, model: MODEL_PRESETS[apiFormat][0] ?? local.custom.model },
    });
  };

  const activeModeConfig = local[local.apiMode];

  const handleTestMentorConnection = async () => {
    setMentorTestStatus('connecting');
    setMentorTestMessage('');
    try {
      const apiKey = (local.mentorApiKey || activeModeConfig.apiKey).trim();
      if (!apiKey) {
        throw new Error(
          currentLang === 'en'
            ? 'API Key is required'
            : currentLang === 'zh-TW'
            ? '請填寫 API Key'
            : '请填写 API Key',
        );
      }
      const baseURL = (local.mentorBaseURL || activeModeConfig.baseURL).trim().replace(/\/+$/, '');
      if (!baseURL) {
        throw new Error(
          currentLang === 'en'
            ? 'API URL is required'
            : currentLang === 'zh-TW'
            ? '請填寫 API 地址'
            : '请填写 API 地址',
        );
      }
      const model = local.mentorModel.trim() || 'gpt-4o-mini';

      const isClaude = local.mentorApiFormat === 'claude';
      const config = { apiKey, baseURL, timeout: 15000, maxRetries: 1 };
      const provider = isClaude
        ? new ClaudeProvider(config)
        : new OpenAIProvider(config);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        await provider.chat(
          {
            model,
            messages: [{ id: 'test', role: 'user' as const, content: 'Hi', timestamp: Date.now() }],
            maxTokens: 8,
            temperature: 0.3,
            topP: 0.9,
            thinking: local.mentorThinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
          },
          controller.signal,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      setMentorTestStatus('success');
      setMentorTestMessage(t.mentorTestSuccess);
    } catch (err) {
      setMentorTestStatus('error');
      const message = (typeof err === 'string' ? err : (err as Error).message).slice(0, 500);
      setMentorTestMessage(`${t.mentorTestFailed}: ${message}`);
    }
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

  const modelPresets =
    local.apiMode === 'deepseek'
      ? MODEL_PRESETS.deepseek
      : local.apiMode === 'local'
      ? MODEL_PRESETS.local
      : MODEL_PRESETS[local.apiFormat];
  const maxTokensLimit = local.apiMode === 'deepseek' ? DEEPSEEK_MAX_TOKENS : 32000;
  const isLocal = local.apiMode === 'local';
  const localLabel = currentLang === 'en' ? 'Local Model' : '本地模型';
  const localDesc =
    currentLang === 'en'
      ? 'OpenAI-compatible local server (llama.cpp / Ollama / LM Studio)'
      : '本地 OpenAI 兼容服务（llama.cpp / Ollama / LM Studio）';
  const tabs: Array<{ id: SettingsTab; label: string; type: string; desc: string; tip: string }> = [
    {
      id: 'general',
      label: t.settingsGeneralTab,
      type: t.settingsGeneralType,
      desc: t.settingsGeneralDesc,
      tip: t.settingsGeneralTabTip,
    },
    {
      id: 'llm',
      label: t.settingsLlmTab,
      type: t.settingsLlmType,
      desc: t.settingsLlmDesc,
      tip: t.settingsLlmTabTip,
    },
    {
      id: 'search',
      label: t.settingsSearchTab,
      type: t.settingsSearchType,
      desc: t.settingsSearchDesc,
      tip: t.settingsSearchTabTip,
    },
    {
      id: 'mentor',
      label: t.settingsMentorTab,
      type: t.settingsMentorType,
      desc: t.settingsMentorDesc,
      tip: t.settingsMentorTabTip,
    },
    {
      id: 'advanced',
      label: t.settingsAdvancedTab,
      type: t.settingsAdvancedType,
      desc: t.settingsAdvancedDesc,
      tip: t.settingsAdvancedTabTip,
    },
    {
      id: 'app',
      label: t.settingsAppTab,
      type: t.settingsAppType,
      desc: t.settingsAppDesc,
      tip: t.settingsAppTabTip,
    },
  ];

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
          {activeTab === 'general' && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
                {t.settingsGeneralDesc}
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.langSelect}
                </label>
                <select
                  value={local.lang}
                  onChange={(e) => update({ lang: e.target.value as Lang })}
                  title={t.langSelect}
                  className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                >
                  <option value="zh-CN">简体中文 (Simplified Chinese)</option>
                  <option value="zh-TW">繁體中文 (Traditional Chinese)</option>
                  <option value="en">English</option>
                </select>
              </div>

              <label
                className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4"
                title={t.debugModeDesc}
              >
                <input
                  type="checkbox"
                  checked={local.debugEnabled}
                  onChange={(e) => update({ debugEnabled: e.target.checked })}
                  title={t.debugModeDesc}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                />
                <span className="block">
                  <span className="block text-sm font-medium text-slate-100">{t.debugMode}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.debugModeDesc}</span>
                </span>
              </label>

              <label
                className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4"
                title={t.chatBordersDesc}
              >
                <input
                  type="checkbox"
                  checked={local.chatBordersEnabled}
                  onChange={(e) => update({ chatBordersEnabled: e.target.checked })}
                  title={t.chatBordersDesc}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                />
                <span className="block">
                  <span className="block text-sm font-medium text-slate-100">{t.chatBorders}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.chatBordersDesc}</span>
                </span>
              </label>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.licenseSection}
                </h3>
                <p className="mb-4 text-xs leading-relaxed text-slate-400">{t.licenseSectionDesc}</p>
                <div className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 max-h-64 overflow-y-auto">
                  <div className="text-xs font-semibold text-slate-200 mb-2">{t.licenseTitle}</div>
                  <div className="text-xs text-slate-500 mb-3">{t.licenseCopyright}</div>
                  <div className="text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap">{t.licenseText}</div>
                  <div className="mt-4 pt-4 border-t border-[#2a2d3a]">
                    <button type="button" onClick={() => setShowLicense(true)} className="rounded-xl border border-indigo-500/40 px-4 py-2 text-xs font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10">
                      {currentLang === 'en' ? 'View Third-Party Licenses' : currentLang === 'zh-TW' ? '檢視第三方授權' : '查看第三方许可'}
                    </button>
              </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'llm' && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
                {t.settingsLlmDesc}
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.apiType}
                </label>
<div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setApiMode('deepseek')}
                    title={t.deepseekOfficialDesc}
                    className={modeButtonClass(local.apiMode === 'deepseek')}
                  >
                    <div className="text-sm font-semibold">{t.deepseekOfficial}</div>
                    <div className="mt-1 text-xs opacity-70">{t.deepseekOfficialDesc}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiMode('custom')}
                    title={t.customApiDesc}
                    className={modeButtonClass(local.apiMode === 'custom')}
                  >
                    <div className="text-sm font-semibold">{t.customApi}</div>
                    <div className="mt-1 text-xs opacity-70">{t.customApiDesc}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiMode('local')}
                    title={localDesc}
                    className={modeButtonClass(local.apiMode === 'local')}
                  >
                    <div className="text-sm font-semibold">{localLabel}</div>
                    <div className="mt-1 text-xs opacity-70">{localDesc}</div>
                  </button>
                </div>
              </div>

              {isLocal && (
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.apiUrl}
                  </label>
                  <input
                    value={activeModeConfig.baseURL}
                    onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, baseURL: e.target.value } })}
                    title={t.apiUrl}
                    placeholder={LOCAL_URL_PLACEHOLDER}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                  />
                </div>
              )}

              {local.apiMode === 'custom' && (
                <div className="grid gap-5 xl:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.apiFormat}
                    </label>
                    <select
                      value={local.apiFormat}
                      onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
                      title={t.apiFormat}
                      className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    >
                      <option value="openai">OpenAI Chat Completions</option>
                      <option value="claude">Claude Messages</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.apiUrl}
                    </label>
                    <input
                      value={activeModeConfig.baseURL}
                      onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, baseURL: e.target.value } })}
                      title={t.apiUrl}
                      placeholder={CUSTOM_URL_PLACEHOLDERS[local.apiFormat]}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {local.apiMode === 'deepseek' && (
                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-200">
                  {t.deepseekNotice}
                </div>
              )}

              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.modelName}
                  </label>
                   <input
                    value={activeModeConfig.model}
                    list="model-presets"
                    onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, model: e.target.value } })}
                    title={t.modelName}
                    placeholder={currentLang === 'en' ? 'Enter model name...' : '输入模型名称...'}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                  />
                  <datalist id="model-presets">
                    {modelPresets.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" title={t.fastModelHint}>
                    {t.fastModelName}
                  </label>
                  <input
                    value={activeModeConfig.fastModel}
                    onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, fastModel: e.target.value } })}
                    title={t.fastModelHint}
                    placeholder={local.apiMode === 'deepseek' ? 'deepseek-v4-flash' : t.fastModelPlaceholder}
                    disabled={!local.fastModelEnabled}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none disabled:opacity-50"
                  />
                </div>
              </div>

              <label
                className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4"
                title={t.fastModelDesc}
              >
                <input
                  type="checkbox"
                  checked={local.fastModelEnabled}
                  onChange={(e) => update({ fastModelEnabled: e.target.checked })}
                  title={t.fastModelDesc}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                />
                <span className="block">
                  <span className="block text-sm font-medium text-slate-100">{t.fastModel}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.fastModelDesc}</span>
                  <span className="mt-2 block text-xs leading-relaxed text-slate-500">{t.fastModelHint}</span>
                </span>
              </label>

              {local.apiMode === 'deepseek' && (
                <>
                  <label
                    className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4"
                    title={t.thinkingModeDesc}
                  >
                    <input
                      type="checkbox"
                      checked={local.thinkingEnabled}
                      onChange={(e) => update({ thinkingEnabled: e.target.checked })}
                      title={t.thinkingModeDesc}
                      className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                    />
                    <span className="block">
                      <span className="block text-sm font-medium text-slate-100">{t.thinkingMode}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.thinkingModeDesc}</span>
                    </span>
                  </label>

                  {local.thinkingEnabled && (
                    <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="block">
                          <span className="block text-sm font-medium text-slate-100">{t.thinkingEffort}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t.thinkingEffortDesc}</span>
                        </span>
                        <select
                          value={local.thinkingEffort}
                          onChange={(e) => update({ thinkingEffort: e.target.value as 'high' | 'max' })}
                          className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-2.5 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                        >
                          <option value="max">max</option>
                          <option value="high">high</option>
                        </select>
                      </div>
                    </div>
                  )}
                </>
              )}

              <label
                className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4"
                title={t.multimodalDesc}
              >
                <input
                  type="checkbox"
                  checked={local.multimodalEnabled}
                  onChange={(e) => update({ multimodalEnabled: e.target.checked })}
                  title={t.multimodalDesc}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                />
                <span className="block">
                  <span className="block text-sm font-medium text-slate-100">{t.multimodalLabel}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.multimodalDesc}</span>
                </span>
              </label>

              {local.multimodalEnabled && (
                <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="block">
                      <span className="block text-sm font-medium text-slate-100">{t.multimodalModelTierLabel}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t.multimodalModelTierDesc}</span>
                    </span>
                    <select
                      value={local.multimodalModelTier}
                      onChange={(e) => update({ multimodalModelTier: e.target.value as 'primary' | 'fast' | 'all' })}
                      className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-2.5 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    >
                      <option value="primary">{t.primaryModelTag}</option>
                      <option value="fast">{t.fastModelTag}</option>
                      <option value="all">{currentLang === 'en' ? 'All' : '全部'}</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr]">
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.apiKey}
                    {isLocal ? (currentLang === 'en' ? ' (optional)' : '（可选）') : ''}
                  </label>
                  <input
                    type="password"
                    value={activeModeConfig.apiKey}
                    onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, apiKey: e.target.value } })}
                    title={t.apiKey}
                    placeholder={
                      isLocal
                        ? currentLang === 'en'
                          ? 'usually not required'
                          : '本地服务通常无需填写'
                        : local.apiMode === 'custom' && local.apiFormat === 'claude'
                        ? 'sk-ant-...'
                        : 'sk-...'
                    }
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.temperature}: <span className="font-mono text-indigo-300">{local.temperature}</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={local.temperature}
                    onChange={(e) => update({ temperature: parseFloat(e.target.value) })}
                    title={t.temperature}
                    className="mt-3 w-full cursor-pointer accent-indigo-500"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.topPLabel}: <span className="font-mono text-indigo-300">{local.topP}</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={local.topP}
                    onChange={(e) => update({ topP: parseFloat(e.target.value) })}
                    title={t.topPHint}
                    className="mt-3 w-full cursor-pointer accent-indigo-500"
                  />
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.topPHint}</p>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.maxTokens}
                  </label>
                  <input
                    type="number"
                    min="100"
                    max={maxTokensLimit}
                    step="500"
                    value={activeModeConfig.maxTokens}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      update({ [local.apiMode]: { ...activeModeConfig, maxTokens: Number.isFinite(parsed) ? parsed : activeModeConfig.maxTokens } });
                    }}
                    title={t.maxTokens}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.maxToolRounds}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    step="50"
                    value={local.maxToolRounds}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      update({
                        maxToolRounds: Number.isFinite(parsed) ? parsed : local.maxToolRounds,
                      });
                    }}
                    title={t.maxToolRounds}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.maxToolRoundsHint}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'search' && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
                {t.settingsSearchDesc}
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
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
              </div>

              {local.searxngEnabled && (
                <>
                  <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{t.searxngBaseUrlLabel}</label>
                      <input
                        type="text"
                        value={local.searxngBaseUrl}
                        onChange={(e) => update({ searxngBaseUrl: e.target.value })}
                        placeholder="http://localhost:8080"
                        title={t.searxngBaseUrlLabel}
                        className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                      />
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.searxngBaseUrlHint}</p>
                    </div>
                  </div>

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
                          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{t.searxngCategoriesLabel}</label>
                          <div className="flex flex-wrap gap-2">
                            {[
                              { key: 'general', label: t.searxngCategoryGeneral },
                              { key: 'images', label: t.searxngCategoryImages },
                              { key: 'videos', label: t.searxngCategoryVideos },
                              { key: 'news', label: t.searxngCategoryNews },
                              { key: 'science', label: t.searxngCategoryScience },
                              { key: 'map', label: t.searxngCategoryMap },
                              { key: 'it', label: t.searxngCategoryIt },
                              { key: 'music', label: t.searxngCategoryMusic },
                              { key: 'files', label: t.searxngCategoryFiles },
                              { key: 'social media', label: t.searxngCategorySocialMedia },
                            ].map((cat) => {
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
                                  {cat.label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">{t.searxngCategoriesHint}</p>
                        </div>

                        <div className="grid grid-cols-2 gap-5">
                          <div>
                            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{t.searxngTimeRangeLabel}</label>
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
                            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{t.searxngLanguageLabel}</label>
                            <input
                              type="text"
                              value={local.searxngLanguage}
                              onChange={(e) => update({ searxngLanguage: e.target.value })}
                              placeholder="zh-CN / en / ja"
                              title={t.searxngLanguageLabel}
                              className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                            />
                            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.searxngLanguageHint}</p>
                          </div>
                        </div>

                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{t.searxngSafeSearchLabel}</label>
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
          )}

          {activeTab === 'mentor' && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
                {t.settingsMentorDesc}
              </div>

              {/* Agent Selector */}
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.subAgentSelect}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['explore', 'scout', 'mentor'] as const).map((key) => {
                    const labels: Record<string, string> = { explore: t.subAgentExplore, scout: t.subAgentScout, mentor: t.subAgentMentor };
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSubAgent(key)}
                        className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors ${
                          subAgent === key
                            ? 'border-indigo-500/60 bg-indigo-500/15 text-indigo-100'
                            : 'border-[#2a2d3a] text-slate-400 hover:border-slate-500/60 hover:text-slate-200'
                        }`}
                      >
                        {labels[key]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {(subAgent === 'explore' || subAgent === 'scout') && (
              <div className="rounded-2xl border border-indigo-500/20 bg-[#10131b] px-5 py-5">
                <h3 className="mb-2 text-sm font-semibold text-slate-100">
                  {subAgent === 'explore' ? t.subAgentExplore : t.subAgentScout}
                </h3>
                <p className="mb-4 text-xs leading-relaxed text-slate-400">
                  {subAgent === 'explore' ? t.subAgentExploreDesc : t.subAgentScoutDesc}
                </p>

                <div className="mb-5">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.subAgentModelTierLabel}
                  </label>
                  <select
                    value={subAgent === 'explore' ? local.exploreModelTier : local.scoutModelTier}
                    onChange={(e) => {
                      const tier = e.target.value as 'primary' | 'fast';
                      if (subAgent === 'explore') update({ exploreModelTier: tier });
                      else update({ scoutModelTier: tier });
                    }}
                    className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                  >
                    <option value="fast">{t.subAgentModelTierFast}</option>
                    <option value="primary">{t.subAgentModelTierPrimary}</option>
                  </select>
                </div>

                <div className="mb-5">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {t.subAgentPromptLabel}
                  </label>
                  <textarea
                    value={
                      subAgent === 'explore' ? (local.explorePrompt || defaultPrompts.explore) :
                      (local.scoutPrompt || defaultPrompts.scout)
                    }
                    onChange={(e) => {
                      const field = subAgent === 'explore' ? 'explorePrompt' : 'scoutPrompt';
                      update({ [field]: e.target.value } as Partial<Settings>);
                    }}
                    rows={6}
                    className="w-full resize-y rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                  />
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-[10px] leading-relaxed text-slate-600">
                      {t.subAgentPromptDefaultNote}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const field = subAgent === 'explore' ? 'explorePrompt' : 'scoutPrompt';
                        update({ [field]: '' } as Partial<Settings>);
                      }}
                      className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-[10px] text-slate-500 transition-colors hover:border-red-500/30 hover:text-red-400"
                    >
                      {currentLang === 'en' ? 'Reset to default' : currentLang === 'zh-TW' ? '重設為預設' : '重置为默认'}
                    </button>
                  </div>
                </div>

                <div>
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {currentLang === 'en' ? 'Parameters' : currentLang === 'zh-TW' ? '參數' : '参数'}
                  </h4>
                  <div className="grid gap-5 md:grid-cols-3">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {t.temperature}: <span className="font-mono text-indigo-300">{subAgent === 'explore' ? local.exploreTemperature : local.scoutTemperature}</span>
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        value={subAgent === 'explore' ? local.exploreTemperature : local.scoutTemperature}
                        onChange={(e) => {
                          if (subAgent === 'explore') update({ exploreTemperature: parseFloat(e.target.value) });
                          else update({ scoutTemperature: parseFloat(e.target.value) });
                        }}
                        title={t.temperature}
                        className="mt-3 w-full cursor-pointer accent-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {t.maxToolRounds}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="500"
                        step="10"
                        value={subAgent === 'explore' ? local.exploreMaxToolRounds : local.scoutMaxToolRounds}
                        onChange={(e) => {
                          const p = parseInt(e.target.value, 10);
                          if (subAgent === 'explore') update({ exploreMaxToolRounds: Number.isFinite(p) ? p : local.exploreMaxToolRounds });
                          else update({ scoutMaxToolRounds: Number.isFinite(p) ? p : local.scoutMaxToolRounds });
                        }}
                        title={t.maxToolRounds}
                        className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {t.maxTokens}
                      </label>
                      <input
                        type="number"
                        min="100"
                        max="393216"
                        step="10000"
                        value={subAgent === 'explore' ? local.exploreMaxTokens : local.scoutMaxTokens}
                        onChange={(e) => {
                          const p = parseInt(e.target.value, 10);
                          if (subAgent === 'explore') update({ exploreMaxTokens: Number.isFinite(p) ? p : local.exploreMaxTokens });
                          else update({ scoutMaxTokens: Number.isFinite(p) ? p : local.scoutMaxTokens });
                        }}
                        title={t.maxTokens}
                        className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="grid gap-5 md:grid-cols-3 mt-4">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {t.subagentTopPLabel}: <span className="font-mono text-indigo-300">{subAgent === 'explore' ? local.exploreTopP : local.scoutTopP}</span>
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={subAgent === 'explore' ? local.exploreTopP : local.scoutTopP}
                        onChange={(e) => {
                          if (subAgent === 'explore') update({ exploreTopP: parseFloat(e.target.value) });
                          else update({ scoutTopP: parseFloat(e.target.value) });
                        }}
                        title={t.subagentTopPHint}
                        className="mt-3 w-full cursor-pointer accent-indigo-500"
                      />
                    </div>
                    <div className="flex items-end pb-3">
                      <label className="flex cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          checked={subAgent === 'explore' ? local.exploreThinkingEnabled : local.scoutThinkingEnabled}
                          onChange={(e) => {
                            if (subAgent === 'explore') update({ exploreThinkingEnabled: e.target.checked });
                            else update({ scoutThinkingEnabled: e.target.checked });
                          }}
                          title={t.subagentThinkingEnabledHint}
                          className="h-5 w-5 rounded-md border-[#2a2d3a] bg-[#0f1117] accent-indigo-500"
                        />
                        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.subagentThinkingEnabledLabel}</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
              )}

              {subAgent === 'mentor' && (
              <div className="rounded-2xl border border-indigo-500/20 bg-[#10131b] px-5 py-5">
                <h3 className="mb-2 text-sm font-semibold text-slate-100">{t.subAgentMentor}</h3>
                <p className="mb-4 text-xs leading-relaxed text-slate-400">{t.subAgentMentorDesc}</p>

                <label className="flex cursor-pointer items-start gap-3 mb-5" title={t.mentorEnabledDesc}>
                  <input
                    type="checkbox"
                    checked={local.mentorEnabled}
                    onChange={(e) => update({ mentorEnabled: e.target.checked })}
                    title={t.mentorEnabledDesc}
                    className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                  />
                  <span className="block">
                    <span className="block text-sm font-medium text-slate-100">{t.mentorEnabled}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-slate-500">{t.mentorEnabledDesc}</span>
                  </span>
                </label>

                {!local.mentorEnabled && (
                  <div className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-500">
                    {t.mentorApiDisabledNote}
                  </div>
                )}

                {local.mentorEnabled && (
                  <div className="space-y-5">
                    <div>
                      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {t.subAgentPromptLabel}
                      </label>
                      <textarea
                        value={local.mentorPrompt || defaultPrompts.mentor}
                        onChange={(e) => update({ mentorPrompt: e.target.value } as Partial<Settings>)}
                        rows={6}
                        className="w-full resize-y rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                      />
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-[10px] leading-relaxed text-slate-600">
                          {currentLang === 'en'
                            ? 'Edit to override the default agent system prompt. Clear to restore the built-in default.'
                            : currentLang === 'zh-TW'
                            ? '編輯以覆蓋預設的 Agent 系統提示詞。清空則恢復內置預設。'
                            : '编辑以覆盖默认的 Agent 系统提示词。清空则恢复内置默认。'}
                        </p>
                        <button
                          type="button"
                          onClick={() => update({ mentorPrompt: '' } as Partial<Settings>)}
                          className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-[10px] text-slate-500 transition-colors hover:border-red-500/30 hover:text-red-400"
                        >
                          {currentLang === 'en' ? 'Reset to default' : currentLang === 'zh-TW' ? '重設為預設' : '重置为默认'}
                        </button>
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {currentLang === 'en' ? 'API Configuration' : currentLang === 'zh-TW' ? 'API 配置' : 'API 配置'}
                      </h4>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.mentorApiFormatLabel}
                          </label>
                          <select
                            value={local.mentorApiFormat}
                            onChange={(e) => update({ mentorApiFormat: e.target.value as ApiFormat })}
                            title={t.mentorApiFormatLabel}
                            className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                          >
                            <option value="openai">OpenAI / 兼容 API</option>
                            <option value="claude">Claude Messages API</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.mentorModelLabel}
                          </label>
                          <input
                            value={local.mentorModel}
                            onChange={(e) => update({ mentorModel: e.target.value })}
                            title={t.mentorModelHint}
                            placeholder="claude-sonnet-4-20250514"
                            list="mentor-model-presets"
                            className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                          />
                          <datalist id="mentor-model-presets">
                            <option value="claude-sonnet-4-20250514" />
                            <option value="claude-3-5-sonnet-latest" />
                            <option value="gpt-4o" />
                            <option value="gpt-4.1" />
                            <option value="deepseek-v4-pro" />
                          </datalist>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.mentorBaseURLLabel}
                          </label>
                          <input
                            value={local.mentorBaseURL}
                            onChange={(e) => update({ mentorBaseURL: e.target.value })}
                            title={t.mentorBaseURLHint}
                            placeholder={t.mentorFallbackNote}
                            className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                          />
                          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.mentorBaseURLHint}</p>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.mentorApiKeyLabel}
                          </label>
                          <input
                            type="password"
                            value={local.mentorApiKey}
                            onChange={(e) => update({ mentorApiKey: e.target.value })}
                            title={t.mentorApiKeyHint}
                            placeholder={t.mentorFallbackNote}
                            className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                          />
                          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.mentorApiKeyHint}</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => void handleTestMentorConnection()}
                          disabled={mentorTestStatus === 'connecting'}
                          className="rounded-xl border border-indigo-500/40 px-4 py-2 text-xs font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {mentorTestStatus === 'connecting' ? (
                            <span className="inline-flex items-center gap-2">
                              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
                              {t.mentorTestConnecting}
                            </span>
                          ) : (
                            t.mentorTestButton
                          )}
                        </button>
                        {mentorTestMessage && (
                          <div
                            className={`mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
                              mentorTestStatus === 'success'
                                ? 'border border-green-500/30 bg-green-500/10 text-green-200'
                                : 'border border-red-500/30 bg-red-500/10 text-red-200'
                            }`}
                          >
                            {mentorTestMessage}
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {currentLang === 'en' ? 'Parameters' : currentLang === 'zh-TW' ? '參數' : '参数'}
                      </h4>
                      <div className="grid gap-5 md:grid-cols-2">
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.mentorMaxTokensLabel}
                          </label>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min={100}
                              max={8000}
                              step={100}
                              value={local.mentorMaxTokens}
                              onChange={(e) =>
                                update({
                                  mentorMaxTokens: Number.isFinite(Number(e.target.value))
                                    ? Number(e.target.value)
                                    : local.mentorMaxTokens,
                                })
                              }
                              title={t.mentorMaxTokensLabel}
                              className="flex-1 cursor-pointer accent-indigo-500"
                            />
                            <input
                              type="number"
                              min={100}
                              max={8000}
                              step={100}
                              value={local.mentorMaxTokens}
                              onChange={(e) => {
                                const parsed = Number(e.target.value);
                                update({
                                  mentorMaxTokens: Number.isFinite(parsed) ? parsed : local.mentorMaxTokens,
                                });
                              }}
                              title={t.mentorMaxTokensLabel}
                              className="w-20 rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-3 py-2 text-center text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                            />
                          </div>
                          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.mentorMaxTokensHint}</p>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {t.maxMentorConsultationsLabel}
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={local.maxMentorConsultations}
                            onChange={(e) => {
                              const parsed = Number(e.target.value);
                              update({
                                maxMentorConsultations: Number.isFinite(parsed) ? parsed : local.maxMentorConsultations,
                              });
                            }}
                            title={t.maxMentorConsultationsLabel}
                            className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                          />
                          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.maxMentorConsultationsHint}</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className="flex cursor-pointer items-center gap-3" title={t.mentorThinkingEnabledHint}>
                          <input
                            type="checkbox"
                            checked={local.mentorThinkingEnabled}
                            onChange={(e) => update({ mentorThinkingEnabled: e.target.checked })}
                            title={t.mentorThinkingEnabledHint}
                            className="h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
                          />
                          <span className="text-sm font-medium text-slate-100">{t.mentorThinkingEnabledLabel}</span>
                        </label>
                        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">{t.mentorThinkingEnabledHint}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              )}
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 text-sm leading-relaxed text-slate-400">
                {t.settingsAdvancedDesc}
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.contextCompactionSettings}
                </label>
                <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{t.contextCompactionDesc}</p>
                <div className="grid gap-5 md:grid-cols-3">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.compactionModelLabel}
                    </label>
                    <select
                      value={local.compactionModel}
                      onChange={(e) => update({ compactionModel: e.target.value as 'fast' | 'primary' })}
                      title={t.compactionModelLabel}
                      className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    >
                      <option value="fast">{t.compactionModelFast}</option>
                      <option value="primary">{t.compactionModelPrimary}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.compactionMaxTokensLabel}
                    </label>
                    <input
                      type="number"
                      min="100"
                      max="100000"
                      step="100"
                      value={local.compactionMaxTokens}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ compactionMaxTokens: Number.isFinite(parsed) ? parsed : local.compactionMaxTokens });
                      }}
                      title={t.compactionMaxTokensLabel}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.compactionMaxTokensHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.compactionTemperatureLabel}: <span className="font-mono text-indigo-300">{local.compactionTemperature}</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={local.compactionTemperature}
                      onChange={(e) => update({ compactionTemperature: parseFloat(e.target.value) })}
                      title={t.compactionTemperatureHint}
                      className="mt-3 w-full cursor-pointer accent-indigo-500"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.compactionTemperatureHint}</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.maxContextTokens}
                    </label>
                    <input
                      type="number"
                      min="1000"
                      max="1000000"
                      step="10000"
                      value={local.maxContextTokens}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ maxContextTokens: Number.isFinite(parsed) ? parsed : local.maxContextTokens });
                      }}
                      title={t.maxContextTokens}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.maxContextTokensHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.maxConversationRounds}
                    </label>
                    <input
                      type="number"
                      min="2"
                      max="500"
                      step="4"
                      value={local.maxConversationRounds}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ maxConversationRounds: Number.isFinite(parsed) ? parsed : local.maxConversationRounds });
                      }}
                      title={t.maxConversationRounds}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.maxConversationRoundsHint}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.streamOutputSettings}
                </label>
                <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{t.streamOutputDesc}</p>
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.streamIdleTimeoutLabel}
                    </label>
                    <input
                      type="number"
                      min="10"
                      max="1800"
                      step="10"
                      value={Math.round(local.streamIdleTimeoutMs / 1000)}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ streamIdleTimeoutMs: Number.isFinite(parsed) ? parsed * 1000 : local.streamIdleTimeoutMs });
                      }}
                      title={t.streamIdleTimeoutLabel}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.streamIdleTimeoutHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.toolOutputMiddleKeepLabel}
                    </label>
                    <input
                      type="number"
                      min="1000"
                      max="150000"
                      step="1000"
                      value={local.toolOutputMiddleKeepChars}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ toolOutputMiddleKeepChars: Number.isFinite(parsed) ? parsed : local.toolOutputMiddleKeepChars });
                      }}
                      title={t.toolOutputMiddleKeepLabel}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.toolOutputMiddleKeepHint}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t.toolContextSettings}
                </label>
                <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{t.toolContextDesc}</p>
                <div className="grid gap-5 md:grid-cols-3">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.toolContextDefaultModeLabel}
                    </label>
                    <select
                      value={local.toolContextDefaultMode}
                      onChange={(e) => update({ toolContextDefaultMode: e.target.value as 'full' | 'summary' | 'auto' })}
                      className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    >
                      <option value="full">{t.toolContextModeFull}</option>
                      <option value="summary">{t.toolContextModeSummary}</option>
                      <option value="auto">{t.toolContextModeAuto}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.toolContextSummaryMaxCharsLabel}
                    </label>
                    <input
                      type="number"
                      min="100"
                      max="5000"
                      step="100"
                      value={local.toolContextSummaryMaxChars}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ toolContextSummaryMaxChars: Number.isFinite(parsed) ? parsed : local.toolContextSummaryMaxChars });
                      }}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.toolContextSummaryMaxCharsHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.toolContextAutoThresholdLabel}
                    </label>
                    <input
                      type="number"
                      min="500"
                      max="50000"
                      step="500"
                      value={local.toolContextAutoThresholdChars}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ toolContextAutoThresholdChars: Number.isFinite(parsed) ? parsed : local.toolContextAutoThresholdChars });
                      }}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.toolContextAutoThresholdHint}</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {([
                    ['execution', t.toolContextCategoryExecution, ['bash', 'browser', 'webfetch']],
                    ['reading', t.toolContextCategoryReading, ['read', 'grep', 'glob', 'list']],
                    ['writing', t.toolContextCategoryWriting, ['write', 'edit', 'patch']],
                    ['analysis', t.toolContextCategoryAnalysis, ['graph', 'lsp', 'diagnostics', 'git']],
                  ] as const).map(([, label, tools]) => {
                    const currentOverride = local.toolContextOverrides[tools[0]];
                    const mode = currentOverride ?? local.toolContextDefaultMode;
                    return (
                      <div key={label} className="flex items-center justify-between rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3">
                        <span className="text-xs text-slate-400">{label}</span>
                        <select
                          value={mode}
                          onChange={(e) => {
                            const value = e.target.value as 'full' | 'summary' | 'auto';
                            const overrides = { ...local.toolContextOverrides };
                            for (const tool of tools) {
                              if (value === local.toolContextDefaultMode) {
                                delete overrides[tool];
                              } else {
                                overrides[tool] = value;
                              }
                            }
                            update({ toolContextOverrides: overrides });
                          }}
                          className="cursor-pointer rounded-lg border border-[#2a2d3a] bg-[#161922] px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                        >
                          <option value="full">{t.toolContextModeFull}</option>
                          <option value="summary">{t.toolContextModeSummary}</option>
                          <option value="auto">{t.toolContextModeAuto}</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">TodoList</h3>
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.todoMaxRetriesLabel}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      value={local.todoMaxRetries}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ todoMaxRetries: Number.isFinite(parsed) ? parsed : local.todoMaxRetries });
                      }}
                      title={t.todoMaxRetriesLabel}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.todoMaxRetriesHint}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.goalSettingsTitle}</h3>
                <p className="mb-4 text-[10px] leading-relaxed text-slate-600">{t.goalSettingsDesc}</p>
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.goalMaxIterationsLabel}</label>
                    <input type="number" min="1" max="100" step="1" value={local.goalMaxIterations}
                      onChange={(e) => { const p = parseInt(e.target.value, 10); update({ goalMaxIterations: Number.isFinite(p) ? p : local.goalMaxIterations }); }}
                      title={t.goalMaxIterationsHint}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none" />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.goalMaxIterationsHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.goalMaxWallClockLabel}</label>
                    <input type="number" min="1" max="180" step="1" value={Math.round((local.goalMaxWallClockMs ?? 1800000) / 60000)}
                      onChange={(e) => { const p = parseInt(e.target.value, 10); update({ goalMaxWallClockMs: Number.isFinite(p) ? p * 60000 : local.goalMaxWallClockMs }); }}
                      title={t.goalMaxWallClockHint}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none" />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.goalMaxWallClockHint}</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-5 md:grid-cols-3">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.verifierModelTierLabel}</label>
                    <select value={local.verifierModelTier} onChange={(e) => update({ verifierModelTier: e.target.value as 'fast' | 'primary' })}
                      title={t.verifierModelTierLabel}
                      className="w-full cursor-pointer rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none">
                      <option value="fast">{t.verifierModelTierFast}</option>
                      <option value="primary">{t.verifierModelTierPrimary}</option>
                    </select>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.verifierModelTierHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.verifierMaxTokensLabel}</label>
                    <input type="number" min="100" max="10000" step="100" value={local.verifierMaxTokens}
                      onChange={(e) => { const p = parseInt(e.target.value, 10); update({ verifierMaxTokens: Number.isFinite(p) ? p : local.verifierMaxTokens }); }}
                      title={t.verifierMaxTokensHint}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none" />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.verifierMaxTokensHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.verifierTemperatureLabel}: <span className="font-mono text-indigo-300">{local.verifierTemperature}</span></label>
                    <input type="range" min="0" max="2" step="0.1" value={local.verifierTemperature}
                      onChange={(e) => update({ verifierTemperature: parseFloat(e.target.value) })}
                      title={t.verifierTemperatureHint}
                      className="mt-3 w-full cursor-pointer accent-indigo-500" />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.verifierTemperatureHint}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.workspaceProjectGraph}</h3>
                <div className="mt-4 grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.projectGraphMaxFilesLabel}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={local.projectGraphMaxFiles}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ projectGraphMaxFiles: Number.isFinite(parsed) ? parsed : local.projectGraphMaxFiles });
                      }}
                      title={t.projectGraphMaxFilesHint}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.projectGraphMaxFilesHint}</p>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {t.projectGraphMaxTreeEntriesLabel}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={local.projectGraphMaxTreeEntries}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update({ projectGraphMaxTreeEntries: Number.isFinite(parsed) ? parsed : local.projectGraphMaxTreeEntries });
                      }}
                      title={t.projectGraphMaxTreeEntriesHint}
                      className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.projectGraphMaxTreeEntriesHint}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-5">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t.systemPrompt}</h3>
                <p className="mb-4 text-[10px] leading-relaxed text-slate-600">{t.settingsPromptDesc}</p>
                <textarea
                  value={local.systemPrompt}
                  onChange={(e) => update({ systemPrompt: e.target.value })}
                  rows={5}
                  placeholder={currentLang === 'en' ? 'e.g. Always respond in English. Prefer functional style.' : currentLang === 'zh-TW' ? '例如：始終使用繁體中文回覆。偏好函數式風格。' : '例如：始终使用中文回复。偏好函数式风格。'}
                  className="w-full resize-y rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none"
                />
                <p className="mt-2 text-[10px] leading-relaxed text-slate-600">{t.settingsPromptStackDesc}</p>
              </div>
          </div>
        )}

          {activeTab === 'app' && (
            <div className="flex flex-col gap-4">
              <AppPermissionsTab
                lang={currentLang}
                value={appDraft}
                onChange={setAppDraft}
                loadError={appLoadError}
              />
            </div>
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
      {showLicense && <LicenseModal onClose={() => setShowLicense(false)} />}
    </div>
  );
}
