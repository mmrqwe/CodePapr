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

  it('exposes ProjectGraph limit settings in the advanced tab', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    const advancedTab = container.querySelector(
      'button[title="配置上下文压缩、子任务规划的 token 上限和模型选择。"]'
    );
    expect(advancedTab).not.toBeNull();

    await act(async () => {
      advancedTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const html = container.innerHTML;
    expect(html).toContain('源文件上限');
    expect(html).toContain('文件树条目上限');
    expect(html).toContain('0 表示不限制');

    const inputs = Array.from(container.querySelectorAll('input[type="number"]'));
    const filesInput = inputs.find(
      (input) => input.getAttribute('title') === '参与 ProjectGraph 构建的最大文件数，0 表示不限制。'
    );
    const treeInput = inputs.find(
      (input) => input.getAttribute('title') === '项目文件树的最大条目数，0 表示不限制。'
    );
    expect(filesInput).toBeDefined();
    expect(treeInput).toBeDefined();
    expect(filesInput!.getAttribute('min')).toBe('0');
    expect(treeInput!.getAttribute('min')).toBe('0');
  });
});
