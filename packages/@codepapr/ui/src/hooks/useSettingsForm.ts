import { useState } from 'react';
import { normalizeSettings, useAgentStore, type Settings } from '../store/agentStore';

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

  return { local, update, clampOnBlur };
}
