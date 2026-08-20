import React, { useState } from 'react';
import type { ModelProfile } from '../../store/agentStore';
import { createDefaultProfile, resolveProviderName, resolveThinkingPayload } from '../../store/internals/settingsNormalizer';
import { buildProviderForProfile } from '../../store/internals/providerFactory';
import { TextField } from '../forms';
import { ConnectionTestButton } from './ConnectionTestButton';
import { ProfileEditorModal } from './ProfileEditorModal';
import { runConnectionTest } from './testConnection';
import type { SettingsTabProps } from './types';

export function SettingsLlmTab({ local, update, t, currentLang }: SettingsTabProps) {
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null);

  const profiles: ModelProfile[] =
    local.modelProfiles && local.modelProfiles.length > 0
      ? local.modelProfiles
      : [];

  const primaryProfile =
    profiles.find((p) => p.id === local.primaryProfileId) || profiles[0];
  const fastProfile =
    profiles.find((p) => p.id === local.fastProfileId) || primaryProfile;
  const mentorProfile =
    profiles.find((p) => p.id === local.mentorProfileId) || primaryProfile;

  const handleCreateProfile = () => {
    const newProf = createDefaultProfile(
      currentLang === 'en' ? 'New Model Profile' : '新建模型配置',
      'custom'
    );
    setEditingProfile(newProf);
  };

  const handleEditProfile = (prof: ModelProfile) => {
    setEditingProfile({ ...prof });
  };

  const handleDuplicateProfile = (prof: ModelProfile) => {
    const copySuffix = currentLang === 'en' ? ' (Copy)' : ' (副本)';
    const cloned: ModelProfile = {
      ...prof,
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${prof.name}${copySuffix}`,
    };
    const nextProfiles = [...profiles, cloned];
    update({ modelProfiles: nextProfiles });
  };

  const handleDeleteProfile = (prof: ModelProfile) => {
    if (prof.id === local.primaryProfileId) {
      alert(t.cannotDeleteInUseProfile);
      return;
    }
    if (profiles.length <= 1) {
      alert(currentLang === 'en' ? 'At least one model profile must be retained.' : '至少需要保留一个模型配置。');
      return;
    }
    if (!confirm(t.deleteProfileConfirm)) {
      return;
    }

    const nextProfiles = profiles.filter((p) => p.id !== prof.id);
    const nextSlots: {
      modelProfiles: ModelProfile[];
      fastProfileId?: string;
      mentorProfileId?: string;
    } = { modelProfiles: nextProfiles };

    if (local.fastProfileId === prof.id) {
      nextSlots.fastProfileId = nextProfiles[0].id;
    }
    if (local.mentorProfileId === prof.id) {
      nextSlots.mentorProfileId = nextProfiles[0].id;
    }

    update(nextSlots);
  };

  const handleSaveProfile = (saved: ModelProfile) => {
    let nextProfiles: ModelProfile[];
    const exists = profiles.some((p) => p.id === saved.id);
    if (exists) {
      nextProfiles = profiles.map((p) => (p.id === saved.id ? saved : p));
    } else {
      nextProfiles = [...profiles, saved];
    }
    update({ modelProfiles: nextProfiles });
    setEditingProfile(null);
  };

  const runTestForProfile = async (prof: ModelProfile) => {
    if (!prof.model.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the model name first'
          : currentLang === 'zh-TW'
          ? '請先填寫模型名稱'
          : '请先填写模型名称'
      );
    }
    if (prof.apiMode === 'custom' && !prof.baseURL.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API address first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API 地址'
          : '请先填写 API 地址'
      );
    }
    if (prof.apiMode !== 'local' && !prof.apiKey.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API Key first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API Key'
          : '请先填写 API Key'
      );
    }

    const provider = buildProviderForProfile(prof, local.streamIdleTimeoutMs);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      await runConnectionTest(provider, {
        model: prof.model.trim(),
        providerName: resolveProviderName(prof),
        thinkingEnabled: prof.thinkingEnabled ?? false,
        reasoningEffort: prof.thinkingEffort ?? '',
        thinkingBudgetTokens: prof.thinkingBudgetTokens ?? 4096,
        thinkingPayload: resolveThinkingPayload(prof.thinkingPayload, prof.apiMode),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const getProfileBadge = (p: ModelProfile) => {
    if (p.apiMode === 'deepseek') return 'DeepSeek 官方';
    if (p.apiMode === 'local') return currentLang === 'en' ? 'Local' : '本地模型';
    if (p.apiFormat === 'response') return 'Responses API';
    return p.apiFormat === 'claude' ? 'Claude' : 'OpenAI';
  };

  return (
    <div className="space-y-7">
      {/* 1. 角色模型指定 (Role Slots) */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-fg">
            {t.modelSlotsTitle}
          </h3>
          <p className="text-xs text-fg-muted mt-1">
            {currentLang === 'en'
              ? 'Assign configured profiles to primary, fast, and mentor roles.'
              : '将配置好的模型分配给主模型、快速模型与导师模型角色。'}
          </p>
        </div>

        <div className="grid gap-4">
          {/* 主模型插槽 (Primary Model) */}
          <div className="rounded-2xl border border-accent-soft/40 bg-accent-soft/5 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent text-xs font-bold text-white shadow-sm">
                  ★
                </span>
                <div>
                  <div className="text-sm font-semibold text-fg">
                    {t.primaryModelSlot}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {t.primaryModelSlotDesc}
                  </div>
                </div>
              </div>

              {primaryProfile && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleEditProfile(primaryProfile)}
                    className="rounded-lg border border-line bg-base px-2.5 py-1 text-xs text-fg-muted hover:border-line-strong hover:text-fg transition-colors"
                  >
                    {t.editProfile}
                  </button>
                  <ConnectionTestButton
                    labels={{
                      idle: t.testProfileConnection,
                      connecting: t.llmTestConnecting,
                      success: t.llmTestSuccess,
                      failedPrefix: t.llmTestFailed,
                    }}
                    onTest={() => runTestForProfile(primaryProfile)}
                  />
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <select
                value={local.primaryProfileId || primaryProfile?.id}
                onChange={(e) => update({ primaryProfileId: e.target.value })}
                className="w-full cursor-pointer rounded-xl border border-line bg-base px-3.5 py-2.5 text-sm font-medium text-fg focus:border-accent focus:outline-none"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({getProfileBadge(p)} · {p.model || '未设模型'})
                  </option>
                ))}
              </select>

              {primaryProfile && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted bg-base px-3 py-2 rounded-xl border border-line">
                  <span className="font-mono text-accent-text font-semibold">
                    {primaryProfile.model || '未设模型'}
                  </span>
                  <span>·</span>
                  <span>{getProfileBadge(primaryProfile)}</span>
                  {primaryProfile.multimodalEnabled && (
                    <>
                      <span>·</span>
                      <span className="text-accent font-medium">🖼️ {currentLang === 'en' ? 'Vision' : '多模态'}</span>
                    </>
                  )}
                  {primaryProfile.maxContextTokens && (
                    <>
                      <span>·</span>
                      <span>{Math.round(primaryProfile.maxContextTokens / 1000)}k {currentLang === 'en' ? 'Context' : '上下文'}</span>
                    </>
                  )}
                  {primaryProfile.thinkingEnabled && (
                    <>
                      <span>·</span>
                      <span className="text-ok">🧠 {currentLang === 'en' ? 'Thinking' : '思考模式'}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 快速模型插槽 (Fast Model) */}
          <div className="rounded-2xl border border-line bg-base p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-warn-bg text-xs font-bold text-warn">
                  ⚡
                </span>
                <div>
                  <div className="text-sm font-semibold text-fg">
                    {t.fastModelSlot}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {t.fastModelSlotDesc}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={local.fastModelEnabled}
                    onChange={(e) => update({ fastModelEnabled: e.target.checked })}
                    className="h-4 w-4 cursor-pointer rounded border-line-strong bg-base accent-accent"
                  />
                  <span className="text-xs font-medium text-fg">
                    {local.fastModelEnabled ? (currentLang === 'en' ? 'Enabled' : '已启用') : (currentLang === 'en' ? 'Disabled' : '已关闭')}
                  </span>
                </label>

                {local.fastModelEnabled && fastProfile && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleEditProfile(fastProfile)}
                      className="rounded-lg border border-line bg-base px-2.5 py-1 text-xs text-fg-muted hover:border-line-strong hover:text-fg transition-colors"
                    >
                      {t.editProfile}
                    </button>
                    <ConnectionTestButton
                      labels={{
                        idle: t.testProfileConnection,
                        connecting: t.llmTestConnecting,
                        success: t.llmTestSuccess,
                        failedPrefix: t.llmTestFailed,
                      }}
                      onTest={() => runTestForProfile(fastProfile)}
                    />
                  </div>
                )}
              </div>
            </div>

            {local.fastModelEnabled && (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] pt-1">
                <select
                  value={local.fastProfileId || fastProfile?.id}
                  onChange={(e) => update({ fastProfileId: e.target.value })}
                  className="w-full cursor-pointer rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm font-medium text-fg focus:border-accent focus:outline-none"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({getProfileBadge(p)} · {p.model || '未设模型'})
                    </option>
                  ))}
                </select>

                {fastProfile && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted bg-raised px-3 py-2 rounded-xl border border-line">
                    <span className="font-mono text-warn font-semibold">
                      {fastProfile.model || '未设模型'}
                    </span>
                    <span>·</span>
                    <span>{getProfileBadge(fastProfile)}</span>
                    {fastProfile.multimodalEnabled && (
                      <>
                        <span>·</span>
                        <span className="text-accent font-medium">🖼️ {currentLang === 'en' ? 'Vision' : '多模态'}</span>
                      </>
                    )}
                    {fastProfile.maxContextTokens && (
                      <>
                        <span>·</span>
                        <span>{Math.round(fastProfile.maxContextTokens / 1000)}k {currentLang === 'en' ? 'Context' : '上下文'}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 导师模型插槽 (Mentor Model) */}
          <div className="rounded-2xl border border-line bg-base p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-info-bg text-xs font-bold text-info">
                  🎓
                </span>
                <div>
                  <div className="text-sm font-semibold text-fg">
                    {t.mentorModelSlot}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {t.mentorModelSlotDesc}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={local.mentorEnabled}
                    onChange={(e) => update({ mentorEnabled: e.target.checked })}
                    className="h-4 w-4 cursor-pointer rounded border-line-strong bg-base accent-accent"
                  />
                  <span className="text-xs font-medium text-fg">
                    {local.mentorEnabled ? (currentLang === 'en' ? 'Enabled' : '已启用') : (currentLang === 'en' ? 'Disabled' : '已关闭')}
                  </span>
                </label>

                {local.mentorEnabled && mentorProfile && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleEditProfile(mentorProfile)}
                      className="rounded-lg border border-line bg-base px-2.5 py-1 text-xs text-fg-muted hover:border-line-strong hover:text-fg transition-colors"
                    >
                      {t.editProfile}
                    </button>
                    <ConnectionTestButton
                      labels={{
                        idle: t.testProfileConnection,
                        connecting: t.llmTestConnecting,
                        success: t.llmTestSuccess,
                        failedPrefix: t.llmTestFailed,
                      }}
                      onTest={() => runTestForProfile(mentorProfile)}
                    />
                  </div>
                )}
              </div>
            </div>

            {local.mentorEnabled && (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] pt-1">
                <select
                  value={local.mentorProfileId || mentorProfile?.id}
                  onChange={(e) => update({ mentorProfileId: e.target.value })}
                  className="w-full cursor-pointer rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm font-medium text-fg focus:border-accent focus:outline-none"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({getProfileBadge(p)} · {p.model || '未设模型'})
                    </option>
                  ))}
                </select>

                {mentorProfile && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted bg-raised px-3 py-2 rounded-xl border border-line">
                    <span className="font-mono text-info font-semibold">
                      {mentorProfile.model || '未设模型'}
                    </span>
                    <span>·</span>
                    <span>{getProfileBadge(mentorProfile)}</span>
                    {mentorProfile.multimodalEnabled && (
                      <>
                        <span>·</span>
                        <span className="text-accent font-medium">🖼️ {currentLang === 'en' ? 'Vision' : '多模态'}</span>
                      </>
                    )}
                    {mentorProfile.maxContextTokens && (
                      <>
                        <span>·</span>
                        <span>{Math.round(mentorProfile.maxContextTokens / 1000)}k {currentLang === 'en' ? 'Context' : '上下文'}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2. 模型配置池 (Model Profiles Pool) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-fg">
              {t.modelProfilesTitle}
            </h3>
            <p className="text-xs text-fg-muted mt-0.5">
              {t.modelProfilesDesc}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreateProfile}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition-opacity"
          >
            <span>+</span>
            <span>{t.addProfile}</span>
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((prof) => {
            const isPrimary = local.primaryProfileId === prof.id;
            const isFast = local.fastModelEnabled && local.fastProfileId === prof.id;
            const isMentor = local.mentorEnabled && local.mentorProfileId === prof.id;

            const maskedKey = prof.apiKey
              ? `${prof.apiKey.slice(0, 3)}••••${prof.apiKey.slice(-4)}`
              : prof.apiMode === 'local'
              ? (currentLang === 'en' ? 'No key required' : '无需 Key')
              : (currentLang === 'en' ? 'No key' : '未填 Key');

            return (
              <div
                key={prof.id}
                className={`rounded-2xl border p-4 space-y-3 transition-colors ${
                  isPrimary
                    ? 'border-accent-soft bg-accent-soft/5 shadow-[0_0_12px_rgba(99,102,241,0.08)]'
                    : 'border-line bg-base hover:border-line-strong'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-fg truncate">
                        {prof.name || t.unnamedProfile}
                      </span>
                      <span className="rounded-md border border-line bg-raised px-2 py-0.5 text-[10px] text-fg-muted font-mono">
                        {getProfileBadge(prof)}
                      </span>
                    </div>
                    <div className="font-mono text-xs text-accent-text mt-1 truncate">
                      {prof.model || (currentLang === 'en' ? 'No model set' : '未设置模型')}
                    </div>
                  </div>

                  {/* In-use badges */}
                  <div className="flex flex-wrap gap-1 items-center justify-end">
                    {isPrimary && (
                      <span className="rounded bg-accent/20 px-2 py-0.5 text-[10px] font-bold text-accent-text">
                        ★ {t.profileInUsePrimary}
                      </span>
                    )}
                    {isFast && (
                      <span className="rounded bg-warn-bg px-2 py-0.5 text-[10px] font-bold text-warn">
                        ⚡ {t.profileInUseFast}
                      </span>
                    )}
                    {isMentor && (
                      <span className="rounded bg-info-bg px-2 py-0.5 text-[10px] font-bold text-info">
                        🎓 {t.profileInUseMentor}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-fg-muted space-y-1">
                  {prof.baseURL && (
                    <div className="truncate" title={prof.baseURL}>
                      URL: <span className="font-mono">{prof.baseURL}</span>
                    </div>
                  )}
                  <div>
                    Key: <span className="font-mono">{maskedKey}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-muted">
                  {prof.multimodalEnabled && (
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent font-medium">
                      🖼️ {currentLang === 'en' ? 'Vision' : '多模态'}
                    </span>
                  )}
                  {prof.maxContextTokens && (
                    <span className="rounded bg-raised border border-line px-1.5 py-0.5 font-mono">
                      {Math.round(prof.maxContextTokens / 1000)}k {currentLang === 'en' ? 'ctx' : '上下文'}
                    </span>
                  )}
                  {prof.temperature !== undefined && (
                    <span className="rounded bg-raised border border-line px-1.5 py-0.5 font-mono">
                      T: {prof.temperature}
                    </span>
                  )}
                  {prof.thinkingEnabled && (
                    <span className="rounded bg-ok/10 px-1.5 py-0.5 text-ok font-medium">
                      🧠 {currentLang === 'en' ? 'Thinking' : '思考'}
                    </span>
                  )}
                </div>

                {/* Card Actions */}
                <div className="flex items-center justify-between border-t border-line/60 pt-2.5">
                  <ConnectionTestButton
                    labels={{
                      idle: t.testProfileConnection,
                      connecting: t.llmTestConnecting,
                      success: t.llmTestSuccess,
                      failedPrefix: t.llmTestFailed,
                    }}
                    onTest={() => runTestForProfile(prof)}
                  />

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleEditProfile(prof)}
                      className="rounded-lg px-2.5 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg transition-colors"
                      title={t.editProfile}
                    >
                      {t.editProfile}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDuplicateProfile(prof)}
                      className="rounded-lg px-2.5 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg transition-colors"
                      title={t.duplicateProfile}
                    >
                      {t.duplicateProfile}
                    </button>
                    <button
                      type="button"
                      disabled={isPrimary || profiles.length <= 1}
                      onClick={() => handleDeleteProfile(prof)}
                      className="rounded-lg px-2 py-1 text-xs text-danger hover:bg-danger-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title={t.deleteProfile}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. 工具执行与运行控制 */}
      <div className="space-y-4 border-t border-line pt-6">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-fg">
            {currentLang === 'en' ? 'Execution Control' : '执行控制参数'}
          </h3>
          <p className="text-xs text-fg-muted mt-1">
            {currentLang === 'en'
              ? 'Temperature, Top P, Vision, and Context limits are configured per model profile.'
              : '温度、Top P、多模态识图与上下文上限均在具体模型配置中独立设置。'}
          </p>
        </div>

        <div className="max-w-md">
          <TextField
            label={t.maxToolRounds}
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
          />
        </div>
      </div>

      {/* Profile Editor Modal */}
      {editingProfile && (
        <ProfileEditorModal
          profile={editingProfile}
          isOpen={true}
          onSave={handleSaveProfile}
          onClose={() => setEditingProfile(null)}
          t={t}
          currentLang={currentLang}
        />
      )}
    </div>
  );
}
