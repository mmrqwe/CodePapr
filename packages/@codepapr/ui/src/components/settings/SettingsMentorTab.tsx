import { useState } from 'react';
import { OpenAIProvider, ClaudeProvider } from '@codepapr/api';
import { BUILTIN_AGENTS, resolveAgentPrompt } from '@codepapr/core';
import type { ApiFormat, Settings } from '../../store/agentStore';
import { SelectField } from '../forms';
import {
  THINKING_EFFORT_CUSTOM,
  THINKING_EFFORT_PRESETS,
} from './constants';
import { ConnectionTestButton } from './ConnectionTestButton';
import { runConnectionTest } from './testConnection';
import type { SettingsTabProps } from './types';

const FIELD_CLASS =
  'w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none';

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted';

type SubAgentKey = 'explore' | 'scout' | 'mentor';

export function SettingsMentorTab({ local, update, t, currentLang }: SettingsTabProps) {
  const [subAgent, setSubAgent] = useState<SubAgentKey>('explore');

  const defaultPrompts: Record<string, string> = {};
  for (const agent of BUILTIN_AGENTS) {
    defaultPrompts[agent.name] = resolveAgentPrompt(agent, currentLang);
  }

  const activeModeConfig = local[local.apiMode];

  const handleTestMentorConnection = async () => {
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
    const provider = isClaude ? new ClaudeProvider(config) : new OpenAIProvider(config);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      await runConnectionTest(provider, {
        model,
        providerName: isClaude ? 'claude' : 'openai',
        thinkingEnabled: local.mentorThinkingEnabled,
        reasoningEffort: local.mentorThinkingEffort,
        thinkingBudgetTokens: local.mentorThinkingBudgetTokens,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const promptFieldFor = (key: SubAgentKey): keyof Settings =>
    key === 'explore' ? 'explorePrompt' : key === 'scout' ? 'scoutPrompt' : 'mentorPrompt';

  const isSub = (key: SubAgentKey): key is 'explore' | 'scout' =>
    key === 'explore' || key === 'scout';

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-base px-5 py-4 text-sm leading-relaxed text-fg-muted">
        {t.settingsMentorDesc}
      </div>

      {/* Agent Selector */}
      <div className="rounded-2xl border border-line bg-base px-5 py-5">
        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
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
                    ? 'border-accent-soft bg-accent-soft text-accent-text'
                    : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                }`}
              >
                {labels[key]}
              </button>
            );
          })}
        </div>
      </div>

      {isSub(subAgent) && (
        <div className="rounded-2xl border border-accent-soft bg-base px-5 py-5">
          <h3 className="mb-2 text-sm font-semibold text-fg">
            {subAgent === 'explore' ? t.subAgentExplore : t.subAgentScout}
          </h3>
          <p className="mb-4 text-xs leading-relaxed text-fg-muted">
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
              className="w-full resize-y rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-[10px] leading-relaxed text-fg-dim">
                {t.subAgentPromptDefaultNote}
              </p>
              <button
                type="button"
                onClick={() => update({ [promptFieldFor(subAgent)]: '' } as Partial<Settings>)}
                className="rounded-lg border border-line px-3 py-1.5 text-[10px] text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
              >
                {currentLang === 'en' ? 'Reset to default' : currentLang === 'zh-TW' ? '重設為預設' : '重置为默认'}
              </button>
            </div>
          </div>

          <div>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
              {currentLang === 'en' ? 'Parameters' : currentLang === 'zh-TW' ? '參數' : '参数'}
            </h4>
            <div className="grid gap-5 md:grid-cols-3">
              <div>
                <label className={LABEL_CLASS}>
                  {t.temperature}: <span className="font-mono text-accent-text">{local[`${subAgent}Temperature`]}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={local[`${subAgent}Temperature`]}
                  onChange={(e) => update({ [`${subAgent}Temperature`]: parseFloat(e.target.value) } as Partial<Settings>)}
                  title={t.temperature}
                  className="mt-3 w-full cursor-pointer accent-accent"
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
                  {t.subagentTopPLabel}: <span className="font-mono text-accent-text">{local[`${subAgent}TopP`]}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={local[`${subAgent}TopP`]}
                  onChange={(e) => update({ [`${subAgent}TopP`]: parseFloat(e.target.value) } as Partial<Settings>)}
                  title={t.subagentTopPHint}
                  className="mt-3 w-full cursor-pointer accent-accent"
                />
              </div>
              <div className="flex items-end pb-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={local[`${subAgent}ThinkingEnabled`]}
                    onChange={(e) => update({ [`${subAgent}ThinkingEnabled`]: e.target.checked } as Partial<Settings>)}
                    title={t.subagentThinkingEnabledHint}
                    className="h-5 w-5 rounded-md border-line bg-base accent-accent"
                  />
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{t.subagentThinkingEnabledLabel}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {subAgent === 'mentor' && (
        <div className="rounded-2xl border border-accent-soft bg-base px-5 py-5">
          <h3 className="mb-2 text-sm font-semibold text-fg">{t.subAgentMentor}</h3>
          <p className="mb-4 text-xs leading-relaxed text-fg-muted">{t.subAgentMentorDesc}</p>

          <label className="flex cursor-pointer items-start gap-3 mb-5" title={t.mentorEnabledDesc}>
            <input
              type="checkbox"
              checked={local.mentorEnabled}
              onChange={(e) => update({ mentorEnabled: e.target.checked })}
              title={t.mentorEnabledDesc}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border-line-strong bg-base accent-accent"
            />
            <span className="block">
              <span className="block text-sm font-medium text-fg">{t.mentorEnabled}</span>
              <span className="mt-1 block text-xs leading-relaxed text-fg-muted">{t.mentorEnabledDesc}</span>
            </span>
          </label>

          {!local.mentorEnabled && (
            <div className="rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg-muted">
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
                  className="w-full resize-y rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                />
                <div className="flex items-center justify-between mt-1">
                  <p className="text-[10px] leading-relaxed text-fg-dim">
                    {currentLang === 'en'
                      ? 'Edit to override the default agent system prompt. Clear to restore the built-in default.'
                      : currentLang === 'zh-TW'
                      ? '編輯以覆蓋預設的 Agent 系統提示詞。清空則恢復內置預設。'
                      : '编辑以覆盖默认的 Agent 系统提示词。清空则恢复内置默认。'}
                  </p>
                  <button
                    type="button"
                    onClick={() => update({ mentorPrompt: '' } as Partial<Settings>)}
                    className="rounded-lg border border-line px-3 py-1.5 text-[10px] text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
                  >
                    {currentLang === 'en' ? 'Reset to default' : currentLang === 'zh-TW' ? '重設為預設' : '重置为默认'}
                  </button>
                </div>
              </div>

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
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
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.mentorBaseURLHint}</p>
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
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.mentorApiKeyHint}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <ConnectionTestButton
                    labels={{
                      idle: t.mentorTestButton,
                      connecting: t.mentorTestConnecting,
                      success: t.mentorTestSuccess,
                      failedPrefix: t.mentorTestFailed,
                    }}
                    onTest={() => handleTestMentorConnection()}
                  />
                </div>
              </div>

              <div>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
                  {currentLang === 'en' ? 'Parameters' : currentLang === 'zh-TW' ? '參數' : '参数'}
                </h4>
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <label className={LABEL_CLASS}>
                      {t.mentorMaxTokensLabel}
                    </label>
                    <input
                      type="number"
                      min={100}
                      max={200000}
                      step={1000}
                      value={local.mentorMaxTokens}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        update({
                          mentorMaxTokens: Number.isFinite(parsed) ? parsed : local.mentorMaxTokens,
                        });
                      }}
                      title={t.mentorMaxTokensLabel}
                      className={FIELD_CLASS}
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.mentorMaxTokensHint}</p>
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
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.maxMentorConsultationsHint}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="flex cursor-pointer items-center gap-3" title={t.mentorThinkingEnabledHint}>
                    <input
                      type="checkbox"
                      checked={local.mentorThinkingEnabled}
                      onChange={(e) => update({ mentorThinkingEnabled: e.target.checked })}
                      title={t.mentorThinkingEnabledHint}
                      className="h-4 w-4 cursor-pointer rounded border-line-strong bg-base accent-accent"
                    />
                    <span className="text-sm font-medium text-fg">{t.mentorThinkingEnabledLabel}</span>
                  </label>
                  <p className="mt-2 text-[10px] leading-relaxed text-fg-dim">{t.mentorThinkingEnabledHint}</p>
                </div>

                {local.mentorThinkingEnabled && local.mentorApiFormat !== 'claude' && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className={LABEL_CLASS}>{t.mentorThinkingEffortLabel}</label>
                      <select
                        value={
                          (THINKING_EFFORT_PRESETS as readonly string[]).includes(local.mentorThinkingEffort)
                            ? local.mentorThinkingEffort
                            : THINKING_EFFORT_CUSTOM
                        }
                        onChange={(e) => {
                          update({
                            mentorThinkingEffort:
                              e.target.value === THINKING_EFFORT_CUSTOM ? '' : e.target.value,
                          });
                        }}
                        title={t.mentorThinkingEffortLabel}
                        className={FIELD_CLASS}
                      >
                        <option value={THINKING_EFFORT_CUSTOM}>{t.thinkingEffortCustom}</option>
                        {THINKING_EFFORT_PRESETS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.mentorThinkingEffortHint}</p>
                    </div>
                    {!(THINKING_EFFORT_PRESETS as readonly string[]).includes(local.mentorThinkingEffort) && (
                      <div>
                        <label className={LABEL_CLASS}>{t.thinkingEffortCustomLabel}</label>
                        <input
                          value={local.mentorThinkingEffort}
                          onChange={(e) => update({ mentorThinkingEffort: e.target.value.trim() })}
                          title={t.thinkingEffortCustomLabel}
                          placeholder={t.thinkingEffortCustomPlaceholder}
                          className={FIELD_CLASS}
                        />
                      </div>
                    )}
                  </div>
                )}

                {local.mentorThinkingEnabled && local.mentorApiFormat === 'claude' && (
                  <div className="mt-3">
                    <label className={LABEL_CLASS}>{t.mentorThinkingBudgetLabel}</label>
                    <input
                      type="number"
                      min={1024}
                      max={200000}
                      step={512}
                      value={local.mentorThinkingBudgetTokens}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        update({
                          mentorThinkingBudgetTokens: Number.isFinite(parsed)
                            ? parsed
                            : local.mentorThinkingBudgetTokens,
                        });
                      }}
                      title={t.mentorThinkingBudgetLabel}
                      className={FIELD_CLASS}
                    />
                    <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.mentorThinkingBudgetHint}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
