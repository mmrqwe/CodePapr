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

// 设置保存串行化：Rust 侧命令在 blocking 线程池上执行，并发调用可能乱序
// 完成，导致旧状态覆盖新状态。所有 fire-and-forget 保存都走本队列，保证
// 后发的保存在先发的落库之后才开始。
let saveQueue: Promise<void> = Promise.resolve();

export function queueAppSettingsSave(settings: Settings): Promise<void> {
  const next = saveQueue.then(
    () => saveAppSettings(settings),
    () => saveAppSettings(settings),
  );
  saveQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}