// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command?: string) => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { ConversationSearch } from './ConversationSearch';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function msg(id: string, content: string, role: 'user' | 'assistant' = 'user') {
  return { id, role, content, timestamp: 1 };
}

describe('ConversationSearch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ lang: 'zh-CN' }),
      workspacePath: '/ws',
      sessions: [
        { id: 's-1', name: 'A', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 2, updatedAt: 2 },
        { id: 's-2', name: 'B', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 's-1',
      messages: [msg('m-a1', '苹果 相关讨论')],
      sessionMessages: {
        's-1': [msg('m-a1', '苹果 相关讨论')],
        's-2': [msg('m-b1', '香蕉 相关讨论')],
      },
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
    document.body.innerHTML = '';
  });

  async function typeQuery(text: string): Promise<void> {
    const input = container.querySelector('input');
    if (!input) throw new Error('search input not found');
    act(() => {
      input.focus();
    });
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('N14：切换会话后对话搜索结果失效重算（旧会话结果不残留）', async () => {
    act(() => {
      root.render(<ConversationSearch onNavigateToFile={() => undefined} />);
    });

    await typeQuery('苹果');
    expect(document.body.textContent).toContain('苹果 相关讨论');

    // 切换到会话 B（旧会话 A 没有「香蕉」消息）
    act(() => {
      useAgentStore.setState((state) => ({
        ...state,
        activeSessionId: 's-2',
        messages: state.sessionMessages['s-2'] ?? [],
      }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 旧会话的搜索结果必须消失，面板基于当前会话重算（无「苹果」命中）
    expect(document.body.textContent).not.toContain('苹果 相关讨论');
    expect(document.body.textContent).toContain('无匹配结果');
  });

  it('N14：切换会话后查询词命中新会话消息时能显示新结果', async () => {
    act(() => {
      root.render(<ConversationSearch onNavigateToFile={() => undefined} />);
    });

    await typeQuery('香蕉');
    expect(document.body.textContent).toContain('无匹配结果');

    act(() => {
      useAgentStore.setState((state) => ({
        ...state,
        activeSessionId: 's-2',
        messages: state.sessionMessages['s-2'] ?? [],
      }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('香蕉 相关讨论');
  });
});
