import { invoke } from '@tauri-apps/api/core';

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await invoke<string | null>('cache_get', { key });
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, data: T, ttlMs?: number): Promise<void> {
  try {
    await invoke('cache_set', { key, value: JSON.stringify(data), ttlMs: ttlMs ?? null });
  } catch {
    // Best-effort cache only.
  }
}

export async function cacheRemove(key: string): Promise<void> {
  try {
    await invoke('cache_remove', { key });
  } catch {
    // Best-effort.
  }
}
