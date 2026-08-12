// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => ({} as unknown)),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

// deleteSession 的持久化路径全部隔离为 no-op，测试只关注确认门与 store 状态。
vi.mock('../utils/projectStorage', () => ({
  saveProjectStateDirect: vi.fn(async () => undefined),
  saveSession: vi.fn(async () => undefined),
  saveMessageBatch: vi.fn(async () => undefined),
  deleteSessionById: vi.fn(async () => undefined),
  saveProjectMeta: vi.fn(async () => undefined),
  enqueueProjectStateSave: vi.fn(async (_path: string, writer: () => Promise<void>) => {
    await writer();
  }),
  loadSessions: vi.fn(async () => []),
}));

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { SessionManager } from './SessionManager';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SessionManager', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ lang: 'zh-CN' }),
      workspacePath: '/tmp/codepapr-session-manager',
      sessions: [
        { id: 's-1', name: '任务 1', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 2, updatedAt: 2 },
        { id: 's-2', name: '任务 2', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 's-1',
      messages: [],
      sessionMessages: { 's-1': [], 's-2': [] },
      isLoading: false,
      _pendingRestoreUndo: null,
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
    vi.restoreAllMocks();
  });

  function clickDeleteButton(index: number): void {
    const buttons = Array.from(
      container.querySelectorAll('button[title="删除会话"]')
    );
    act(() => {
      buttons[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('N9：确认后删除会话', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      root.render(<SessionManager />);
    });
    clickDeleteButton(0);

    const ids = useAgentStore.getState().sessions.map((s) => s.id);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(['s-2']);
  });

  it('N9：取消确认时保留会话', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await act(async () => {
      root.render(<SessionManager />);
    });
    clickDeleteButton(0);

    const ids = useAgentStore.getState().sessions.map((s) => s.id);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(['s-1', 's-2']);
  });

  it('N9：确认文案包含会话名', async () => {
    let captured = '';
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      captured = message ?? '';
      return false;
    });

    await act(async () => {
      root.render(<SessionManager />);
    });
    clickDeleteButton(1);

    expect(captured).toContain('任务 2');
  });
});
