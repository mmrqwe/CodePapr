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

vi.mock('../utils/projectStorage', () => ({
  saveProjectStateDirect: vi.fn(async () => undefined),
  saveSession: vi.fn(async () => undefined),
  saveMessageBatch: vi.fn(async () => undefined),
  deleteSessionById: vi.fn(async () => undefined),
  archiveSessionById: vi.fn(async () => undefined),
  restoreSessionById: vi.fn(async () => undefined),
  loadArchivedSessions: vi.fn(async () => []),
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
      archivedSessions: [],
      activeSessionId: 's-1',
      messages: [],
      sessionMessages: { 's-1': [], 's-2': [] },
      isLoading: false,
      _pendingRestoreUndos: [],
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

  function clickArchiveButton(index: number): void {
    const buttons = Array.from(
      container.querySelectorAll('button[title="归档会话：从侧栏移出，内容保留，可在设置中恢复"]')
    );
    act(() => {
      buttons[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('归档会话后从侧栏移除并保留到 archivedSessions', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');

    await act(async () => {
      root.render(<SessionManager />);
    });
    clickArchiveButton(0);

    const state = useAgentStore.getState();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['s-2']);
    expect(state.archivedSessions.map((s) => s.id)).toEqual(['s-1']);
  });

  it('归档按钮文案为归档而不是删除', async () => {
    await act(async () => {
      root.render(<SessionManager />);
    });

    expect(container.querySelectorAll('button[title="删除会话"]').length).toBe(0);
    expect(container.textContent).toContain('归档');
  });
});
