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
import { THEME_STYLE_ID } from '../theme/themeEngine';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

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
    document.getElementById(THEME_STYLE_ID)?.remove();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-mode');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
  });

  it('shows tab labels so each settings area is reachable', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    expect(container.innerHTML).toContain('w-[min(96vw,1480px)]');
    expect(container.innerHTML).toContain('h-[94vh]');

    const generalTab = container.querySelector('button[title="配置语言、实验性功能和许可证等全局界面行为。"]');
    const llmTab = container.querySelector('button[title="配置主模型、快速模型、导师模型、API 接入方式和采样参数。"]');

    expect(generalTab?.textContent).toContain('通用');
    expect(llmTab?.textContent).toContain('LLM');
    expect(container.innerHTML).toContain('LSP');
    expect(container.innerHTML).toContain('MCP');
  });

  it('keeps experimental character and voice features off by default', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    expect(container.innerHTML).toContain('实验性功能');

    const characterToggle = container.querySelector(
      'input[title="主界面显示角色卡。"]'
    ) as HTMLInputElement | null;
    const voiceToggle = container.querySelector(
      'input[title="主界面显示语音控件。"]'
    ) as HTMLInputElement | null;

    expect(characterToggle).not.toBeNull();
    expect(voiceToggle).not.toBeNull();
    expect(characterToggle?.checked).toBe(false);
    expect(voiceToggle?.checked).toBe(false);
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

  it('appearance tab theme selects preview live and revert on cancel', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    // 主题选择已移至外观页：先切到外观 tab
    const appearanceTab = container.querySelector(
      'button[title="选择主题、强调色，导入自定义主题。"]'
    );
    expect(appearanceTab).not.toBeNull();
    await act(async () => {
      appearanceTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const lightSelect = container.querySelector(
      'select[title="浅色模式下使用的主题。"]'
    ) as HTMLSelectElement;
    expect(lightSelect).not.toBeNull();
    expect(container.innerHTML).toContain('Nord');
    expect(container.innerHTML).toContain('Solarized');
    expect(container.innerHTML).toContain('实验性');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        lightSelect,
        'solarized-light',
      );
      lightSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 跟随系统 + jsdom 无 matchMedia → 浅色模式 → solarized-light 生效
    expect(document.documentElement.dataset.theme).toBe('solarized-light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // 取消保存 → 回滚到已持久化设置（默认 paper-light）
    const closeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '×'
    );
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.documentElement.dataset.theme).toBe('paper-light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('appearance tab previews accent live and imports custom themes', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });
    const appearanceTab = container.querySelector(
      'button[title="选择主题、强调色，导入自定义主题。"]'
    );
    expect(appearanceTab).not.toBeNull();
    await act(async () => {
      appearanceTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 强调色预设实时预览
    const redSwatch = container.querySelector('button[title="#ef4444"]');
    expect(redSwatch).not.toBeNull();
    await act(async () => {
      redSwatch!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement;
    expect(style.textContent).toContain('--accent: #ef4444;');

    // 自定义主题导入
    const nameInput = Array.from(container.querySelectorAll('input')).find(
      (input) => input.getAttribute('placeholder') === '名称'
    ) as HTMLInputElement;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const importButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '导入'
    );
    expect(nameInput).toBeDefined();
    expect(textarea).toBeDefined();
    expect(importButton).toBeDefined();

    await act(async () => {
      setInputValue(nameInput, 'My Theme');
      setInputValue(textarea, '{ not json');
    });
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.innerHTML).toContain('JSON 无效');

    const tokens = {
      'bg-deep': '#010203',
      'bg-base': '#111111',
      'bg-raised': '#222222',
      'bg-input': '#111111',
      'bg-hover': 'rgba(255,255,255,0.05)',
      'foreground': '#eeeeee',
      'foreground-soft': '#cccccc',
      'foreground-muted': '#999999',
      'foreground-dim': '#666666',
      'border': '#333333',
      'border-strong': '#444444',
      'accent': '#ff0000',
      'accent-soft': 'rgba(255,0,0,0.16)',
      'accent-bg': 'rgba(255,0,0,0.08)',
      'accent-text': '#ff8888',
      'accent-glow': 'rgba(255,0,0,0.2)',
      'green': '#22c55e',
      'green-bg': 'rgba(34,197,94,0.08)',
      'amber': '#f59e0b',
      'amber-bg': 'rgba(245,158,11,0.08)',
      'red': '#ef4444',
      'cyan': '#22d3ee',
      'cyan-bg': 'rgba(6,182,212,0.08)',
      'code-bg': '#0b0d12',
      'code-fg': '#e2e8f0',
      'scrollbar-track': '#111111',
      'scrollbar-thumb': '#333333',
      'shadow-sm': '0 2px 8px rgba(0,0,0,0.3)',
      'shadow-md': '0 8px 24px rgba(0,0,0,0.5)',
      'surface-gradient': 'linear-gradient(180deg, #121212 0%, #101010 100%)',
    };
    await act(async () => {
      setInputValue(nameInput, 'My Theme');
      setInputValue(textarea, JSON.stringify(tokens));
    });
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.innerHTML).toContain('已导入并应用');
    expect(container.innerHTML).toContain('My Theme');
  });

  it('llm tab displays role slot assignment and model profile pool', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });
    const llmTab = container.querySelector(
      'button[title="配置主模型、快速模型、导师模型、API 接入方式和采样参数。"]'
    );
    expect(llmTab).not.toBeNull();
    await act(async () => {
      llmTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('角色模型指定');
    expect(container.textContent).toContain('模型配置池');
    expect(container.textContent).toContain('DeepSeek 官方');
    expect(container.textContent).toContain('DeepSeek Flash (快速)');
    expect(container.textContent).toContain('自定义 API (Custom)');
    expect(container.textContent).toContain('新建模型配置');
  });

  it('mentor sub-agent tab keeps prompt settings and points model config to LLM', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    const mentorTab = container.querySelector(
      'button[title="配置 Explore（代码分析）、Scout（网页搜索）、Mentor（架构指导）三种子代理。"]'
    );
    expect(mentorTab).not.toBeNull();
    await act(async () => {
      mentorTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mentorButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Mentor'),
    );
    expect(mentorButton).toBeDefined();
    await act(async () => {
      mentorButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('请到「LLM」中分配并启用导师模型');
    expect(container.textContent).toContain('自定义提示词');
    expect(container.textContent).toContain('每轮最大咨询次数');
    expect(container.textContent).not.toContain('API 配置');
    expect(container.textContent).not.toContain('导师 API 格式');
    expect(container.textContent).not.toContain('导师 API Key');
  });

  it('advanced tab allows modifying maxContextTokens with default 200000', async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    const advancedTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '高级'
    );
    expect(advancedTab).toBeDefined();
    await act(async () => {
      advancedTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const maxContextInput = container.querySelector(
      'input[title="输入上下文上限"]'
    ) as HTMLInputElement;
    expect(maxContextInput).not.toBeNull();
    expect(maxContextInput.value).toBe('200000');

    await act(async () => {
      setInputValue(maxContextInput, '150000');
    });
    expect(maxContextInput.value).toBe('150000');

    // Clicking save saves 150000 to settings and syncs to primary profile
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '保存'
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const currentSettings = useAgentStore.getState().settings;
    expect(currentSettings.maxContextTokens).toBe(150000);
    const primary = currentSettings.modelProfiles.find(
      (p) => p.id === currentSettings.primaryProfileId
    );
    expect(primary?.maxContextTokens).toBe(150000);
  });
});
