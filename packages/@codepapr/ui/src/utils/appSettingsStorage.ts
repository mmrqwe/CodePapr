import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../store/agentStore';

interface AppSettingsResult {
  settingsJson: string | null;
  dbPath: string;
}

export async function loadAppSettings(): Promise<Partial<Settings> | null> {
  const result = await invoke<AppSettingsResult>('load_app_settings');
  if (!result.settingsJson) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.settingsJson);
  } catch {
    console.warn('App settings JSON is corrupted, resetting to defaults.');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return parsed as Partial<Settings>;
}

export async function saveAppSettings(settings: Settings): Promise<void> {
  await invoke<AppSettingsResult>('save_app_settings', {
    settingsJson: JSON.stringify(settings),
  });
}