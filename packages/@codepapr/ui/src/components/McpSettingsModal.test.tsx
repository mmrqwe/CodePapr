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
import { normalizeMcpSettings } from '../utils/mcpTypes';
import { McpSettingsModal } from './McpSettingsModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function buildStoreState(overrides: Record<string, unknown> = {}) {
  const base = normalizeSettings({
    lang: 'zh-CN',
    apiMode: 'deepseek',
    apiFormat: 'openai',
    model: 'deepseek-v4-pro',
    fastModelEnabled: false,
    systemPrompt: '',
    mcp: normalizeMcpSettings({
      ...overrides,
    }),
  });
  return base;
}

describe('McpSettingsModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: () => void;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_list_status') return [];
      return { settingsJson: null };
    });

    onClose = vi.fn() as () => void;
    useAgentStore.setState((state) => ({
      ...state,
      settings: buildStoreState(),
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

  it('renders the modal with title and rmcp badge', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    expect(container.innerHTML).toContain('MCP Host');
    expect(container.innerHTML).toContain('rmcp');
  });

  it('shows all three default preset servers', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    expect(container.innerHTML).toContain('DuckDuckGo Search MCP');
    expect(container.innerHTML).toContain('Postgres MCP');
    expect(container.innerHTML).toContain('SQLite MCP');
  });

  it('shows the search-category hint when a search server is active', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    expect(container.innerHTML).toContain('无需 API Key');
    expect(container.innerHTML).toContain('DuckDuckGo');
  });

  it('shows the database hint when selecting a database server', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    const postgresButton = container.querySelectorAll('button');
    const postgresButtonEl = Array.from(postgresButton).find(
      (btn) => btn.textContent?.includes('Postgres MCP'),
    );
    expect(postgresButtonEl).toBeTruthy();

    await act(async () => {
      postgresButtonEl!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.innerHTML).toContain('默认只读');
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_list_tools')).toBe(false);
  });

  it('shows enabled/connected stats with zero when no servers are active', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    expect(container.innerHTML).toContain('已启用服务');
    expect(container.innerHTML).toContain('已连接');
  });

  it('N17：MCP 全局关闭时刷新工具给出明确提示，不显示误导性的 0 tools', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: buildStoreState({ enabled: false, exposeTools: true }),
    }));

    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    // 找到「刷新工具」按钮（全局关闭时仍可点击）。
    const refreshButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('刷新工具')
    );
    expect(refreshButton).toBeTruthy();

    await act(async () => {
      refreshButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.innerHTML).toContain('MCP 已全局关闭');
    expect(container.innerHTML).not.toContain('0 tools');
    // 绝不能真正去连接服务器
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_list_tools')).toBe(false);
  });

  it('calls onClose when the close button is clicked', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    const closeButton = container.querySelector('button') as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    await act(async () => {
      closeButton.click();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('adds a new custom server when the add button is clicked', async () => {
    await act(async () => {
      root.render(<McpSettingsModal onClose={onClose} />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === '新增自定义服务',
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.innerHTML).toContain('Custom MCP');
  });
});
