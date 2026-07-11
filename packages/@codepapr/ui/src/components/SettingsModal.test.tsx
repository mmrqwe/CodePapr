// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { SettingsModal } from './SettingsModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SettingsModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ settingsJson: null });

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        lang: 'zh-CN',
        apiMode: 'deepseek',
        apiFormat: 'openai',
        model: 'deepseek-v4-pro',
        fastModelEnabled: false,
        systemPrompt: '',
      }),
      showSettings: true,
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('shows tab labels so each settings area is reachable', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    expect(container.innerHTML).toContain('w-[min(96vw,1480px)]');
    expect(container.innerHTML).toContain('h-[94vh]');

    const generalTab = container.querySelector('button[title="配置语言、调试、许可证等全局界面行为。"]');
    const llmTab = container.querySelector('button[title="配置主模型、快速模型、API 接入方式和采样参数。"]');

    expect(generalTab?.textContent).toContain('通用');
    expect(llmTab?.textContent).toContain('LLM');
  });
});
