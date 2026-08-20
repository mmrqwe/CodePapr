// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({})),
}));

vi.mock('../../utils/projectStorage', () => ({
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

import { normalizeSettings, useAgentStore } from '../../store/agentStore';
import { SettingsArchivedSessions } from './SettingsArchivedSessions';
import { getTranslation } from '../../utils/i18n';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SettingsArchivedSessions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const t = getTranslation('zh-CN');

  beforeEach(() => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ lang: 'zh-CN' }),
      workspacePath: '/tmp/codepapr-archived',
      sessions: [],
      archivedSessions: [
        {
          id: 's-arch',
          name: '旧任务',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: 1,
          updatedAt: 1,
          archivedAt: 2,
        },
      ],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
    }));
    useAgentStore.setState({
      loadArchivedSessions: async () => undefined,
    });
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

  it('列出归档会话并支持恢复', async () => {
    const restore = vi.fn(async () => undefined);
    useAgentStore.setState({ restoreArchivedSession: restore });

    await act(async () => {
      root.render(<SettingsArchivedSessions t={t} currentLang="zh-CN" />);
    });

    expect(container.textContent).toContain('旧任务');
    const restoreButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === t.restoreSession
    );
    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(restore).toHaveBeenCalledWith('s-arch');
  });

  it('永久删除前需要确认', async () => {
    const remove = vi.fn();
    useAgentStore.setState({ deleteArchivedSession: remove });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await act(async () => {
      root.render(<SettingsArchivedSessions t={t} currentLang="zh-CN" />);
    });

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === t.deleteArchivedSession
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('旧任务');
    expect(remove).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(remove).toHaveBeenCalledWith('s-arch');
  });
});
