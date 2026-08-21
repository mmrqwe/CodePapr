import { useState } from 'react';
import { BUILTIN_AGENTS, resolveAgentPrompt } from '@codepapr/core';
import type { Settings } from '../../store/agentStore';
import { SelectField } from '../forms';
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

  const mentorProfile =
    local.modelProfiles?.find((p) => p.id === local.mentorProfileId);
  const mentorModelDisplay =
    (mentorProfile?.model || local.mentorModel || '').trim();

  const promptFieldFor = (key: SubAgentKey): keyof Settings =>
    key === 'explore' ? 'explorePrompt' : key === 'scout' ? 'scoutPrompt' : 'mentorPrompt';

  const isSub = (key: SubAgentKey): key is 'explore' | 'scout' =>
    key === 'explore' || key === 'scout';

  return (
    <div className="space-y-5">
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
          <h3 className="mb-4 text-sm font-semibold text-fg">
            {subAgent === 'explore' ? t.subAgentExplore : t.subAgentScout}
          </h3>

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
            <div className="flex items-center justify-end mt-1">
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
          <h3 className="mb-4 text-sm font-semibold text-fg">{t.subAgentMentor}</h3>

          <div className="mb-5 rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg-muted">
            {local.mentorEnabled ? (
              <p>
                {t.subAgentMentorModel}
                {mentorModelDisplay ? (
                  <>
                    {' · '}
                    <span className="font-mono text-accent-text">
                      {mentorProfile?.name ? `${mentorProfile.name} / ${mentorModelDisplay}` : mentorModelDisplay}
                    </span>
                  </>
                ) : null}
              </p>
            ) : (
              <p>{t.mentorApiDisabledNote}</p>
            )}
          </div>

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
              <div className="flex items-center justify-end mt-1">
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
                title={t.maxMentorConsultationsHint}
                className={FIELD_CLASS}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
