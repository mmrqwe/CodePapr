// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../store/agentStore';
import { normalizeSettings } from '../store/internals/settingsNormalizer';

const { listenMock, flushAppSettingsSavesMock, queueAppSettingsSaveMock, flushCharactersStateMock } =
  vi.hoisted(() => ({
    listenMock: vi.fn(),
    flushAppSettingsSavesMock: vi.fn(),
    queueAppSettingsSaveMock: vi.fn(),
    flushCharactersStateMock: vi.fn(),
  }));

let listenerCallback: (() => void) | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('./appSettingsStorage', () => ({
  saveAppSettings: vi.fn(async () => undefined),
  queueAppSettingsSave: queueAppSettingsSaveMock,
  flushAppSettingsSaves: flushAppSettingsSavesMock,
}));

vi.mock('../store/agentStore', () => ({
  useAgentStore: {
    getState: () => storeState,
  },
}));

vi.mock('../store/charactersStore', () => ({
  flushCharactersState: flushCharactersStateMock,
}));

let storeState: { settingsLoaded: boolean; _settingsPersistable: boolean; settings: Settings };
let registerSettingsFlushListener: () => void;

describe('registerSettingsFlushListener', () => {
  beforeEach(async () => {
    // 模块级 registered 标记是单例，需重置模块让每个测试从零注册。
    vi.resetModules();
    ({ registerSettingsFlushListener } = await import('./settingsFlush'));

    listenerCallback = null;
    listenMock.mockClear();
    flushAppSettingsSavesMock.mockClear();
    queueAppSettingsSaveMock.mockClear();
    flushCharactersStateMock.mockClear();
    flushAppSettingsSavesMock.mockImplementation(async () => undefined);
    queueAppSettingsSaveMock.mockImplementation(async () => undefined);
    flushCharactersStateMock.mockImplementation(async () => undefined);
    storeState = {
      settingsLoaded: true,
      _settingsPersistable: true,
      settings: normalizeSettings({ lang: 'en' }),
    };
    listenMock.mockImplementation(async (event: string, cb: () => void) => {
      if (event === 'codepapr:flush-settings') {
        listenerCallback = cb;
      }
      return () => undefined;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function triggerFlush(): Promise<void> {
    listenerCallback!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('registers the flush listener only once', () => {
    registerSettingsFlushListener();
    registerSettingsFlushListener();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith('codepapr:flush-settings', expect.any(Function));
  });

  it('awaits in-flight saves then persists the latest settings and flushes characters', async () => {
    registerSettingsFlushListener();

    let pendingResolve!: () => void;
    flushAppSettingsSavesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          pendingResolve = resolve;
        }),
    );

    const flushPromise = (async () => {
      listenerCallback!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    })();

    // 在途保存未完成前，不应发送最终保存
    expect(queueAppSettingsSaveMock).not.toHaveBeenCalled();
    pendingResolve();
    await flushPromise;

    expect(queueAppSettingsSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en' }),
    );
    expect(flushCharactersStateMock).toHaveBeenCalledTimes(1);
  });

  it('skips the final settings save when the store is not persistable', async () => {
    storeState = {
      settingsLoaded: true,
      _settingsPersistable: false,
      settings: normalizeSettings({}),
    };
    registerSettingsFlushListener();
    await triggerFlush();

    expect(flushAppSettingsSavesMock).toHaveBeenCalledTimes(1);
    expect(queueAppSettingsSaveMock).not.toHaveBeenCalled();
    expect(flushCharactersStateMock).toHaveBeenCalledTimes(1);
  });
});
