import { useState } from 'react';
import { OpenAIProvider, ClaudeProvider } from '@codepapr/api';
import { BUILTIN_AGENTS, resolveAgentPrompt } from '@codepapr/core';
import type { ApiFormat, Settings } from '../../store/agentStore';
import { SelectField } from '../forms';
import type { SettingsTabProps } from './types';

const FIELD_CLASS =
  'w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 placeholder-slate-700 focus:border-indigo-500/60 focus:outline-none';

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500';

type SubAgentKey = 'explore' | 'scout' | 'mentor';

export function SettingsMentorTab({ local, update, t, currentLang }: SettingsTabProps) {
  const [subAgent, setSubAgent] = useState<SubAgentKey>('explore');
  const [testStatus, setTestStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const defaultPrompts: Record<string, string> = {};
  for (const agent of BUILTIN_AGENTS) {
    defaultPrompts[agent.name] = resolveAgentPrompt(agent, currentLang);
  }

  const activeModeConfig = local[local.apiMode];

  const handleTestMentorConnection = async () => {
    setTestStatus('connecting');
    setTestMessage('');
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

      setTestStatus('success');
      setTestMessage(t.mentorTestSuccess);
    } catch (err) {
      setTestStatus('error');
      const message = (typeof err === 'string' ? err : (err as Error).message).slice(0, 500);
      setTestMessage(`${t.mentorTestFailed}: ${message}`);
    }
  };

  const promptFieldFor = (key: SubAgentKey): keyof Settings =>
    key === 'explore' ? 'explorePrompt' : key === 'scout' ? 'scoutPrompt' : 'mentorPrompt';

  const isSub = (key: SubAgentKey): key is 'explore' | 'scout' =>
    key === 'explore' || key === 'scout';

  return (
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

      {isSub(subAgent) && (
        <div className="rounded-2xl border border-indigo-500/20 bg-[#10131b] px-5 py-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-100">
            {subAgent === 'explore' ? t.subAgentExplore : t.subAgentScout}
          </h3>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            {subAgent === 'explore' ? t.subAgentExploreDesc : t.subAgentScoutDesc}
          </p>

          <div className="mb-5">
            <SelectField
              label={t.subAgentModelTierLabel}
              pointer={false}
              value={subAgent === 'explore' ? local.exploreModelTier : local.scoutModelTier}
              onChange={(e) => {
                const tier = e.target.value as 'primary' | 'fast';
                if (subAgent === 'explore') update({ exploreModelTier: tier });
                else update({ scoutModelTier: tier });
              }}
            >
              <option value="fast">{t.subAgentModelTierFast}</option>
              <option value="primary">{t.subAgentModelTierPrimary}</option>
            </SelectField>
          </div>

          <div className="mb-5">
            <label className={LABEL_CLASS}>
              {t.subAgentPromptLabel}
            </label>
            <textarea
              value={
                subAgent === 'explore'
                  ? (local.explorePrompt || defaultPrompts.explore)
                  : (local.scoutPrompt || defaultPrompts.scout)
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
                onClick={() => update({ [promptFieldFor(subAgent)]: '' } as Partial<Settings>)}
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
                <label className={LABEL_CLASS}>
                  {t.temperature}: <span className="font-mono text-indigo-300">{local[`${subAgent}Temperature`]}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={local[`${subAgent}Temperature`]}
                  onChange={(e) => update({ [`${subAgent}Temperature`]: parseFloat(e.target.value) } as Partial<Settings>)}
                  title={t.temperature}
                  className="mt-3 w-full cursor-pointer accent-indigo-500"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>
                  {t.maxToolRounds}
                </label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="10"
                  value={local[`${subAgent}MaxToolRounds`]}
                  onChange={(e) => {
                    const p = parseInt(e.target.value, 10);
                    update({ [`${subAgent}MaxToolRounds`]: Number.isFinite(p) ? p : local[`${subAgent}MaxToolRounds`] } as Partial<Settings>);
                  }}
                  title={t.maxToolRounds}
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>
                  {t.maxTokens}
                </label>
                <input
                  type="number"
                  min="100"
                  max="393216"
                  step="10000"
                  value={local[`${subAgent}MaxTokens`]}
                  onChange={(e) => {
                    const p = parseInt(e.target.value, 10);
                    update({ [`${subAgent}MaxTokens`]: Number.isFinite(p) ? p : local[`${subAgent}MaxTokens`] } as Partial<Settings>);
                  }}
                  title={t.maxTokens}
                  className={FIELD_CLASS}
                />
              </div>
            </div>
            <div className="grid gap-5 md:grid-cols-3 mt-4">
              <div>
                <label className={LABEL_CLASS}>
                  {t.subagentTopPLabel}: <span className="font-mono text-indigo-300">{local[`${subAgent}TopP`]}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={local[`${subAgent}TopP`]}
                  onChange={(e) => update({ [`${subAgent}TopP`]: parseFloat(e.target.value) } as Partial<Settings>)}
                  title={t.subagentTopPHint}
                  className="mt-3 w-full cursor-pointer accent-indigo-500"
                />
              </div>
              <div className="flex items-end pb-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={local[`${subAgent}ThinkingEnabled`]}
                    onChange={(e) => update({ [`${subAgent}ThinkingEnabled`]: e.target.checked } as Partial<Settings>)}
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
                <label className={LABEL_CLASS}>
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
                  <SelectField
                    label={t.mentorApiFormatLabel}
                    value={local.mentorApiFormat}
                    onChange={(e) => update({ mentorApiFormat: e.target.value as ApiFormat })}
                    title={t.mentorApiFormatLabel}
                  >
                    <option value="openai">OpenAI / 兼容 API</option>
                    <option value="claude">Claude Messages API</option>
                  </SelectField>
                  <div>
                    <label className={LABEL_CLASS}>
                      {t.mentorModelLabel}
                    </label>
                    <input
                      value={local.mentorModel}
                      onChange={(e) => update({ mentorModel: e.target.value })}
                      title={t.mentorModelHint}
                      placeholder="claude-sonnet-4-20250514"
                      list="mentor-model-presets"
                      className={FIELD_CLASS}
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
                    <label className={LABEL_CLASS}>
                      {t.mentorBaseURLLabel}
                    </label>
                    <input
                      value={local.mentorBaseURL}
                      onChange={(e) => update({ mentorBaseURL: e.target.value })}
                      title={t.mentorBaseURLHint}
                      placeholder={t.mentorFallbackNote}
                      className={FIELD_CLASS}
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.mentorBaseURLHint}</p>
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>
                      {t.mentorApiKeyLabel}
                    </label>
                    <input
                      type="password"
                      value={local.mentorApiKey}
                      onChange={(e) => update({ mentorApiKey: e.target.value })}
                      title={t.mentorApiKeyHint}
                      placeholder={t.mentorFallbackNote}
                      className={FIELD_CLASS}
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{t.mentorApiKeyHint}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => void handleTestMentorConnection()}
                    disabled={testStatus === 'connecting'}
                    className="rounded-xl border border-indigo-500/40 px-4 py-2 text-xs font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {testStatus === 'connecting' ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
                        {t.mentorTestConnecting}
                      </span>
                    ) : (
                      t.mentorTestButton
                    )}
                  </button>
                  {testMessage && (
                    <div
                      className={`mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
                        testStatus === 'success'
                          ? 'border border-green-500/30 bg-green-500/10 text-green-200'
                          : 'border border-red-500/30 bg-red-500/10 text-red-200'
                      }`}
                    >
                      {testMessage}
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
                    <label className={LABEL_CLASS}>
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
                    <label className={LABEL_CLASS}>
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
                      className={FIELD_CLASS}
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
  );
}
