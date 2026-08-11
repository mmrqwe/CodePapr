import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../store/agentStore';
import { normalizeSettings } from '../store/internals/settingsNormalizer';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { queueAppSettingsSave, saveAppSettings } from './appSettingsStorage';

function settings(lang: 'en' | 'zh-TW'): Settings {
  return normalizeSettings({ lang });
}

describe('appSettingsStorage queue', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => ({
      settingsJson: null,
      dbPath: '',
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serializes saves so a later save starts only after the earlier one lands', async () => {
    const inFlight: Array<() => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'save_app_settings') {
        return new Promise((resolve) => {
          inFlight.push(() => resolve({ settingsJson: null, dbPath: '' }));
        });
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const first = queueAppSettingsSave(settings('en'));
    const second = queueAppSettingsSave(settings('zh-TW'));

    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    inFlight[0]!();
    await first;
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(2);

    inFlight[1]!();
    await second;
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the chain alive when a save fails', async () => {
    invokeMock
      .mockImplementationOnce(async () => {
        throw new Error('db locked');
      })
      .mockImplementationOnce(async () => ({
        settingsJson: null,
        dbPath: '',
      }));

    await expect(queueAppSettingsSave(settings('en'))).rejects.toThrow('db locked');
    // 失败的保存不阻塞后续保存
    await expect(queueAppSettingsSave(settings('zh-TW'))).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('saveAppSettings still invokes the backend with the serialized settings', async () => {
    await saveAppSettings(settings('en'));
    expect(invokeMock).toHaveBeenCalledWith('save_app_settings', {
      settingsJson: expect.any(String),
    });
  });
});
