import { useState } from 'react';
import { normalizeSettings, resolveThinkingPayload, useAgentStore, type Settings } from '../store/agentStore';

/// Draft-state form backing for the settings modal.
///
/// No effect syncing store -> draft while open: the modal mounts on open, so
/// the initial state captures the latest settings, and re-syncing on every
/// store change would silently discard unsaved edits when a background action
/// (e.g. openWorkspace upserting recent workspaces) updates settings.
export function useSettingsForm() {
  const { settings } = useAgentStore();
  const [local, setLocal] = useState<Settings>(normalizeSettings(settings));

  const update = (partial: Partial<Settings>) => {
    setLocal((current) => {
      const merged = { ...current, ...partial };
      // Shallow merge plus lightweight re-derivation of the flat fields that
      // validation reads (getSettingsError uses flat apiKey/model/baseURL).
      const primaryProfile =
        merged.modelProfiles?.find((p) => p.id === merged.primaryProfileId) ||
        merged.modelProfiles?.[0];
      const fastProfile =
        merged.modelProfiles?.find((p) => p.id === merged.fastProfileId) ||
        primaryProfile;
      const mentorProfile =
        merged.modelProfiles?.find((p) => p.id === merged.mentorProfileId) ||
        primaryProfile;

      let modelProfiles = merged.modelProfiles;
      if (partial.maxContextTokens !== undefined && primaryProfile) {
        modelProfiles = modelProfiles?.map((p) =>
          p.id === primaryProfile.id
            ? {
                ...p,
                maxContextTokens:
                  typeof partial.maxContextTokens === 'number' && Number.isFinite(partial.maxContextTokens)
                    ? partial.maxContextTokens
                    : p.maxContextTokens,
              }
            : p
        );
      }

      const activeConfig = merged[merged.apiMode] || merged.deepseek;

      const effectiveApiMode = primaryProfile ? primaryProfile.apiMode : merged.apiMode;
      const effectiveApiFormat = primaryProfile ? primaryProfile.apiFormat : merged.apiFormat;
      const effectiveProvider =
        effectiveApiMode === 'deepseek'
          ? 'deepseek'
          : effectiveApiMode === 'local'
          ? 'openai'
          : effectiveApiFormat;
      const effectiveModel = primaryProfile ? primaryProfile.model : (activeConfig?.model ?? '');
      const effectiveFastModel = fastProfile ? fastProfile.model : (activeConfig?.fastModel ?? '');
      const effectiveApiKey = primaryProfile ? primaryProfile.apiKey : (activeConfig?.apiKey ?? '');
      const effectiveBaseURL = primaryProfile ? primaryProfile.baseURL : (activeConfig?.baseURL ?? '');

      const effectiveMaxContextTokens =
        partial.maxContextTokens !== undefined
          ? partial.maxContextTokens
          : primaryProfile?.maxContextTokens !== undefined
          ? primaryProfile.maxContextTokens
          : merged.maxContextTokens;

      return {
        ...merged,
        modelProfiles,
        apiMode: effectiveApiMode,
        apiFormat: effectiveApiFormat,
        provider: effectiveProvider,
        model: effectiveModel,
        fastModel: effectiveFastModel,
        apiKey: effectiveApiKey,
        baseURL: effectiveBaseURL,
        thinkingEnabled: primaryProfile
          ? (primaryProfile.thinkingEnabled ?? false)
          : merged.thinkingEnabled,
        thinkingEffort: primaryProfile
          ? (primaryProfile.thinkingEffort ?? '')
          : merged.thinkingEffort,
        thinkingBudgetTokens: primaryProfile
          ? (primaryProfile.thinkingBudgetTokens ?? 4096)
          : merged.thinkingBudgetTokens,
        thinkingPayload: primaryProfile
          ? resolveThinkingPayload(primaryProfile.thinkingPayload, primaryProfile.apiMode)
          : merged.thinkingPayload,
        temperature: primaryProfile?.temperature !== undefined
          ? primaryProfile.temperature
          : merged.temperature,
        topP: primaryProfile?.topP !== undefined
          ? primaryProfile.topP
          : merged.topP,
        maxContextTokens: effectiveMaxContextTokens,
        multimodalEnabled: primaryProfile?.multimodalEnabled !== undefined
          ? primaryProfile.multimodalEnabled
          : merged.multimodalEnabled,
        mentorModel: mentorProfile ? mentorProfile.model : merged.mentorModel,
        mentorBaseURL: mentorProfile ? mentorProfile.baseURL : merged.mentorBaseURL,
        mentorApiKey: mentorProfile ? mentorProfile.apiKey : merged.mentorApiKey,
        mentorApiFormat: mentorProfile ? mentorProfile.apiFormat : merged.mentorApiFormat,
        mentorThinkingPayload: mentorProfile
          ? resolveThinkingPayload(mentorProfile.thinkingPayload, mentorProfile.apiMode)
          : merged.mentorThinkingPayload,
      };
    });
  };

  const clampOnBlur = () => {
    setLocal((current) => normalizeSettings(current));
  };

  return { local, update, clampOnBlur };
}
