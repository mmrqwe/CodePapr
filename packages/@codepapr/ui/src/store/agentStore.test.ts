import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChatStreamEvent, IContextSnapshot, IMessage } from '@codepapr/types';
import type { ProjectStateSnapshot, ProjectSessionMeta, ProjectMessage } from '../utils/projectStorage';
import type { Settings, UIMessage } from './agentStore';
import { createMockAgent } from './__test-utils__/createMockAgent';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string): Promise<Record<string, unknown>> => {
    if (command === 'list_workspace_files') {
      return {
        root: '',
        entries: [],
        truncated: false,
      };
    }

    if (command === 'note_recent_workspace') {
      return { settingsJson: null, dbPath: '' };
    }

    throw new Error(`Unexpected invoke call: ${command}`);
  }),
}));

const { loadProjectStateMock, saveProjectStateMock, saveProjectStateWithPurgeMock, saveProjectStateDirectMock, loadSessionsMock, loadSessionMessagesMock, loadAllProjectMetaMock, saveSessionMock, saveMessageBatchMock, deleteSessionByIdMock, saveProjectMetaMock, enqueueProjectStateSaveMock, aggregateSessionRuntimeInDbMock, waitForPendingProjectStateSaveMock } = vi.hoisted(() => ({
  loadProjectStateMock: vi.fn(async (): Promise<ProjectStateSnapshot> => ({
    version: 1,
    sessions: [],
    activeSessionId: null,
    sessionMessages: {},
    conversationStats: {
      primary: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
      fast: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
      mentor: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
    },
    sessionConversationStats: {},
    projectDiagnosticsReport: null,
    updatedAt: Date.now(),
  })),
  saveProjectStateMock: vi.fn(async () => undefined),
  saveProjectStateWithPurgeMock: vi.fn(async () => undefined),
  saveProjectStateDirectMock: vi.fn(async () => undefined),
  loadSessionsMock: vi.fn(async (): Promise<ProjectSessionMeta[]> => []),
  loadSessionMessagesMock: vi.fn(
    async (_workspacePath: string, _sessionId: string): Promise<ProjectMessage[]> => []
  ),
  loadAllProjectMetaMock: vi.fn(async () => ({})),
  saveSessionMock: vi.fn(async () => undefined),
  saveMessageBatchMock: vi.fn(async () => undefined),
  deleteSessionByIdMock: vi.fn(async () => undefined),
  saveProjectMetaMock: vi.fn(async () => undefined),
  enqueueProjectStateSaveMock: vi.fn(async (_path: string, writer: () => Promise<void>) => { await writer(); }),
  aggregateSessionRuntimeInDbMock: vi.fn(async (): Promise<Record<string, number>> => ({})),
  waitForPendingProjectStateSaveMock: vi.fn(async () => undefined),
}));

const { loadAppSettingsMock, saveAppSettingsMock, queueAppSettingsSaveMock } = vi.hoisted(() => ({
  loadAppSettingsMock: vi.fn(async (): Promise<Partial<Settings> | null> => null),
  saveAppSettingsMock: vi.fn(async (_settings?: unknown) => undefined),
  queueAppSettingsSaveMock: vi.fn(async (settings: unknown) => {
    await saveAppSettingsMock(settings);
  }),
}));

const { maybeGenerateContextCheckpointMock } = vi.hoisted(() => ({
  // 默认返回 null（与真实实现在小消息集下的行为一致）；/compact 等测试
  // 单独 mockResolvedValueOnce 注入 checkpoint。
  maybeGenerateContextCheckpointMock: vi.fn(async (): Promise<unknown> => null),
}));

const { consolidateMemoryContentMock } = vi.hoisted(() => ({
  consolidateMemoryContentMock: vi.fn(async (_content: string): Promise<string | null> => null),
}));

const { createAgentMock, createMainThreadAgentMock, actualCreateAgentRef } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  createMainThreadAgentMock: vi.fn(),
  actualCreateAgentRef: {
    current: null as null | {
      createAgent: (...args: never[]) => unknown;
      createMainThreadAgent: (...args: never[]) => unknown;
    },
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../utils/projectStorage', () => ({
  createEmptyProjectState: () => ({
    version: 1,
    sessions: [],
    activeSessionId: null,
    sessionMessages: {},
    conversationStats: {
      primary: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
      fast: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
      mentor: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
    },
    sessionConversationStats: {},
    projectDiagnosticsReport: null,
    updatedAt: Date.now(),
  }),
  loadProjectState: loadProjectStateMock,
  saveProjectState: saveProjectStateMock,
  saveProjectStateWithPurge: saveProjectStateWithPurgeMock,
  saveProjectStateDirect: saveProjectStateDirectMock,
  loadSessions: loadSessionsMock,
  loadSessionMessages: loadSessionMessagesMock,
  loadAllProjectMeta: loadAllProjectMetaMock,
  saveSession: saveSessionMock,
  saveMessageBatch: saveMessageBatchMock,
  deleteSessionById: deleteSessionByIdMock,
  saveProjectMeta: saveProjectMetaMock,
  enqueueProjectStateSave: enqueueProjectStateSaveMock,
  aggregateSessionRuntimeInDb: aggregateSessionRuntimeInDbMock,
  waitForPendingProjectStateSave: waitForPendingProjectStateSaveMock,
}));

vi.mock('../utils/appSettingsStorage', () => ({
  loadAppSettings: loadAppSettingsMock,
  saveAppSettings: saveAppSettingsMock,
  queueAppSettingsSave: queueAppSettingsSaveMock,
}));

vi.mock('./internals/contextCheckpoint', () => ({
  maybeGenerateContextCheckpoint: maybeGenerateContextCheckpointMock,
}));

vi.mock('../utils/memoryConsolidation', () => ({
  consolidateMemoryContent: consolidateMemoryContentMock,
  MEMORY_CONSOLIDATION_MAX_LINES: 200,
  planMemoryConsolidation: (content: string | undefined, maxLines = 200): boolean => {
    const count = content ? content.split('\n').length : 0;
    return count > maxLines;
  },
}));

// createAgent/createMainThreadAgent are spied so crash-recovery tests can
// inject mock agents for rebuilt instances; defaults delegate to the real
// factory.
vi.mock('./internals/agentFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./internals/agentFactory')>();
  actualCreateAgentRef.current = {
    createAgent: actual.createAgent as (...args: never[]) => unknown,
    createMainThreadAgent: actual.createMainThreadAgent as (...args: never[]) => unknown,
  };
  createAgentMock.mockImplementation((...args: never[]) =>
    actualCreateAgentRef.current!.createAgent(...args)
  );
  createMainThreadAgentMock.mockImplementation((...args: never[]) =>
    actualCreateAgentRef.current!.createMainThreadAgent(...args)
  );
  return {
    ...actual,
    createAgent: createAgentMock,
    createMainThreadAgent: createMainThreadAgentMock,
  };
});

import { getSettingsError, normalizeSettings, useAgentStore } from './agentStore';
import { useGoalStore } from './goalStore';
import { parseGoalCondition } from '@codepapr/core';
import { shouldDeferIdleWatchdog } from './internals/sendMessage';
import { cancelExternalAccessRequests, usePermissionStore } from './permissionStore';
import { buildEffectiveContextMessages } from '../utils/contextCompaction';
import { AgentDestroyedError, WorkerCrashError } from '../agent/WorkerBackedAgent';
import { SESSION_MESSAGE_CACHE_LIMIT } from './internals/defaults';

async function waitForMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(
  predicate: () => boolean,
  maxPasses: number = 6
): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (predicate()) {
      return;
    }

    await waitForMacrotask();
    await Promise.resolve();
  }
}

function createEmptyConversation() {
  return {
    primary: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
    fast: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
    mentor: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
  };
}

describe('useAgentStore.sendMessage', () => {
  it('normalizes max tool rounds and keeps the default at 500', () => {
    expect(normalizeSettings({}).maxToolRounds).toBe(500);
    expect(normalizeSettings({ maxToolRounds: 12.9 }).maxToolRounds).toBe(12);
    expect(normalizeSettings({ maxToolRounds: 0 }).maxToolRounds).toBe(1);
  });

  function createAgentResponse(
    content: string,
    overrides: Partial<{ reasoningContent: string }> = {}
  ) {
    return {
      role: 'assistant' as const,
      content,
      ...overrides,
      cacheStats: {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        newInputTokens: 1,
        outputTokens: 1,
        calls: 1,
      },
    };
  }

  function createExecutedCommandLogs(): IMessage[] {
    return [
      {
        id: 'assistant-log-1',
        role: 'assistant',
        content: 'tool calls',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-command',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
          },
        ],
      },
      {
        id: 'tool-log-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-command',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
          },
        },
      },
    ];
  }

  beforeEach(() => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        apiKey: 'sk-test',
        fastModelEnabled: false,
      }),
      workspacePath: '/tmp/codepapr-test',
      sessions: [
        {
          id: 'session-1',
          name: '任务 1',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: {
        'session-1': [],
      },
      conversationStats: createEmptyConversation(),
      sessionConversationStats: {
        'session-1': createEmptyConversation(),
      },
      projectDiagnosticsReport: null,
        isLoading: false,
      loadingSessionId: null,
      showSettings: false,
      settingsLoaded: true,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _agentSessionId: null,
      _sessionInputState: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createAgentMock.mockImplementation((...args: never[]) =>
      actualCreateAgentRef.current!.createAgent(...args)
    );
    createMainThreadAgentMock.mockImplementation((...args: never[]) =>
      actualCreateAgentRef.current!.createMainThreadAgent(...args)
    );
    createAgentMock.mockClear();
    createMainThreadAgentMock.mockClear();
    invokeMock.mockClear();
    loadProjectStateMock.mockClear();
    saveProjectStateMock.mockClear();
    saveProjectStateWithPurgeMock.mockClear();
    saveProjectStateDirectMock.mockClear();
    loadAppSettingsMock.mockClear();
    saveAppSettingsMock.mockClear();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_workspace_files') {
        return {
          root: '',
          entries: [],
          truncated: false,
        };
      }

      if (command === 'note_recent_workspace') {
        return { settingsJson: null, dbPath: '' };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });
  });

  it('persists cached project diagnostics into project state', async () => {
    const report = {
      available: true,
      packageManager: 'npm' as const,
      packageJsonPath: 'package.json',
      stages: [],
      ranAt: 123,
      overallStatus: 'passed' as const,
    };

    useAgentStore.getState().setProjectDiagnosticsReport(report);

    expect(useAgentStore.getState().projectDiagnosticsReport).toEqual(report);
    expect(saveProjectStateDirectMock).toHaveBeenCalledWith(
      '/tmp/codepapr-test',
      expect.objectContaining({
        projectDiagnosticsReport: report,
      }),
      expect.anything()
    );
  });

  it('restores the recent workspace and its saved sessions during settings load', async () => {
    loadAppSettingsMock.mockResolvedValueOnce({
      apiKey: 'sk-restored',
      recentWorkspaces: [{ path: '/tmp/restored-workspace', name: 'restored-workspace', lastOpenedAt: 1, pinned: false }],
    });
    loadSessionsMock.mockResolvedValueOnce([
      {
        id: 'session-restored',
        name: '恢复会话',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        createdAt: 1,
      },
    ]);
    loadSessionMessagesMock.mockResolvedValueOnce([
      {
        id: 'message-1',
        role: 'user',
        content: '之前的聊天',
        timestamp: 1,
      },
    ]);
    loadAllProjectMetaMock.mockResolvedValueOnce({
      active_session_id: 'session-restored',
      conversation_stats: createEmptyConversation(),
      session_conversation_stats: {
        'session-restored': createEmptyConversation(),
      },
      project_diagnostics_report: null,
    });

    await useAgentStore.getState().loadSettings();

    const state = useAgentStore.getState();
    expect(loadSessionsMock).toHaveBeenCalledWith('/tmp/restored-workspace');
    expect(state.workspacePath).toBe('/tmp/restored-workspace');
    expect(state.activeSessionId).toBe('session-restored');
    expect(state.sessions[0]?.id).toBe('session-restored');
    expect(state.messages[0]?.content).toBe('之前的聊天');
    expect(state.settings.recentWorkspaces[0]?.path).toBe('/tmp/restored-workspace');
  });

  it('does not persist settings when the initial settings load failed', async () => {
    loadAppSettingsMock.mockRejectedValueOnce(new Error('db locked'));
    await useAgentStore.getState().loadSettings();

    expect(useAgentStore.getState()._settingsPersistable).toBe(false);

    saveAppSettingsMock.mockClear();
    useAgentStore.getState().setSettings({ lang: 'en' });

    // 设置加载失败时内存中是默认值：绝不能回写磁盘（否则会清空最近项目、
    // 并把空 apiKey 当作"用户清除密钥"删掉 vault 里的 key）。
    expect(saveAppSettingsMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState()._persistenceError).toBeTruthy();
  });

  it('persists settings when the initial settings load succeeded', async () => {
    await useAgentStore.getState().loadSettings();
    useAgentStore.setState({ _persistenceError: null });

    expect(useAgentStore.getState()._settingsPersistable).toBe(true);
    saveAppSettingsMock.mockClear();
    useAgentStore.getState().setSettings({ lang: 'en' });
    expect(saveAppSettingsMock).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState()._persistenceError).toBeFalsy();
  });

  it('setSettings 保留运行中回合的 agent（N7），空闲时才销毁', async () => {
    const destroy = vi.fn();
    const fakeAgent = { destroy } as unknown as import('../agent/WorkerBackedAgent').AgentRuntimeHandle;

    // 空闲：默认销毁进行中的 agent（配置已变，需按新配置重建）
    useAgentStore.setState({ _agent: fakeAgent, isLoading: false });
    useAgentStore.getState().setSettings({ lang: 'en' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState()._agent).toBeNull();

    // 回合运行中：保存设置不得静默杀掉回合（agent 保留，回合用旧配置跑完）；
    // 但 model/promptKey 置空，强制下一条消息按新设置重建。
    useAgentStore.setState({
      _agent: fakeAgent,
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: 'old-key',
      _agentSessionId: 'session-1',
      isLoading: true,
    });
    useAgentStore.getState().setSettings({ lang: 'zh-TW' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState()._agent).not.toBeNull();
    expect(useAgentStore.getState()._agentSessionId).toBe('session-1');
    expect(useAgentStore.getState()._agentModel).toBeNull();
    expect(useAgentStore.getState()._agentPromptKey).toBeNull();
    expect(useAgentStore.getState().settings.lang).toBe('zh-TW');

    // preserveAgent：纯 UI 变更（置顶/移除项目）不打断运行中的回合
    useAgentStore.setState({
      _agent: fakeAgent,
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: 'old-key',
      isLoading: false,
    });
    useAgentStore.getState().setSettings({ lang: 'en' }, { preserveAgent: true });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState()._agent).not.toBeNull();
    expect(useAgentStore.getState()._agentModel).not.toBeNull();
  });

  it('clears a stale persistence error once a settings save succeeds', async () => {
    await useAgentStore.getState().loadSettings();
    useAgentStore.setState({ _persistenceError: '旧错误' });
    saveAppSettingsMock.mockClear();

    useAgentStore.getState().setSettings({ lang: 'en' });
    // 等待串行队列 + 成功回调（两个微任务轮）
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAgentStore.getState()._persistenceError).toBeNull();
  });

  it('records a persistence error when a settings save fails', async () => {
    await useAgentStore.getState().loadSettings();
    useAgentStore.setState({ _persistenceError: null });
    saveAppSettingsMock.mockClear();
    saveAppSettingsMock.mockRejectedValueOnce(new Error('disk full'));

    useAgentStore.getState().setSettings({ lang: 'en' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAgentStore.getState()._persistenceError).toContain('disk full');
  });

  it('switches cache stats with the active session and persists them per conversation', () => {
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [
        state.sessions[0]!,
        {
          id: 'session-2',
          name: '任务 2',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: Date.now() + 1,
          updatedAt: Date.now() + 1,
        },
      ],
      sessionMessages: {
        ...state.sessionMessages,
        'session-2': [],
      },
      sessionConversationStats: {
        'session-1': {
          primary: {
            totalCacheRead: 100,
            totalCacheCreation: 10,
            totalInput: 20,
            totalOutput: 5,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 100,
            rounds: 2,
          },
          fast: {
            totalCacheRead: 0,
            totalCacheCreation: 0,
            totalInput: 0,
            totalOutput: 0,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 0,
            rounds: 0,
          },
          mentor: {
            totalCacheRead: 0,
            totalCacheCreation: 0,
            totalInput: 0,
            totalOutput: 0,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 0,
            rounds: 0,
          },
        },
        'session-2': {
          primary: {
            totalCacheRead: 7,
            totalCacheCreation: 3,
            totalInput: 4,
            totalOutput: 2,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 7,
            rounds: 1,
          },
          fast: {
            totalCacheRead: 0,
            totalCacheCreation: 0,
            totalInput: 0,
            totalOutput: 0,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 0,
            rounds: 0,
          },
          mentor: {
            totalCacheRead: 0,
            totalCacheCreation: 0,
            totalInput: 0,
            totalOutput: 0,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 0,
            calls: 0,
            rounds: 0,
          },
        },
      },
      conversationStats: {
        primary: {
          totalCacheRead: 100,
          totalCacheCreation: 10,
          totalInput: 20,
          totalOutput: 5,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          calls: 100,
          rounds: 2,
        },
        fast: {
          totalCacheRead: 0,
          totalCacheCreation: 0,
          totalInput: 0,
          totalOutput: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          calls: 0,
          rounds: 0,
        },
        mentor: {
          totalCacheRead: 0,
          totalCacheCreation: 0,
          totalInput: 0,
          totalOutput: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          calls: 0,
          rounds: 0,
        },
      },
    }));

    useAgentStore.getState().selectSession('session-2');

    let state = useAgentStore.getState();
    expect(state.activeSessionId).toBe('session-2');
    expect(state.conversationStats).toEqual({
      primary: {
        totalCacheRead: 7,
        totalCacheCreation: 3,
        totalInput: 4,
        totalOutput: 2,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 7,
        rounds: 1,
      },
      fast: {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 0,
        rounds: 0,
      },
      mentor: {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 0,
        rounds: 0,
      },
    });
    expect(saveProjectStateDirectMock).toHaveBeenLastCalledWith(
      '/tmp/codepapr-test',
      expect.objectContaining({
        sessionConversationStats: expect.objectContaining({
          'session-1': expect.objectContaining({ primary: expect.objectContaining({ totalCacheRead: 100 }) }),
          'session-2': expect.objectContaining({ primary: expect.objectContaining({ totalCacheRead: 7 }) }),
        }),
      }),
      expect.anything()
    );

    useAgentStore.getState().selectSession('session-1');
    state = useAgentStore.getState();
    expect(state.conversationStats).toEqual({
      primary: {
        totalCacheRead: 100,
        totalCacheCreation: 10,
        totalInput: 20,
        totalOutput: 5,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 100,
        rounds: 2,
      },
      fast: {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 0,
        rounds: 0,
      },
      mentor: {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 0,
        rounds: 0,
      },
    });
  });

  it('preserves other session histories when the active session appends new messages', async () => {
    const chat = vi.fn(async () => createAgentResponse('当前会话的新回复'));
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [
        state.sessions[0]!,
        {
          id: 'session-2',
          name: '任务 2',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: Date.now() + 1,
          updatedAt: Date.now() + 1,
        },
      ],
      sessionMessages: {
        'session-1': [],
        'session-2': [
          {
            id: 'message-session-2',
            role: 'user',
            content: '会话 2 的旧历史',
            timestamp: 1,
          },
        ],
      },
      sessionConversationStats: {
        'session-1': createEmptyConversation(),
        'session-2': createEmptyConversation(),
      },
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    }));

    await useAgentStore.getState().sendMessage('处理当前会话', '处理当前会话', 'agent');

    const state = useAgentStore.getState();
    expect(state.sessionMessages['session-2']).toEqual([
      {
        id: 'message-session-2',
        role: 'user',
        content: '会话 2 的旧历史',
        timestamp: 1,
      },
    ]);
    expect(saveProjectStateDirectMock).toHaveBeenLastCalledWith(
      '/tmp/codepapr-test',
      expect.objectContaining({
        sessionMessages: expect.objectContaining({
          'session-2': expect.arrayContaining([
            expect.objectContaining({
              content: '会话 2 的旧历史',
            }),
          ]),
        }),
      }),
      expect.anything()
    );
  });

  it('/compact 后销毁旧 agent 并清空句柄，下一回合用压缩后的历史重建（不再全量照发）', async () => {
    maybeGenerateContextCheckpointMock.mockResolvedValueOnce({
      message: {
        id: 'checkpoint-1',
        role: 'assistant',
        content: '已压缩',
        timestamp: Date.now(),
        contextCheckpoint: {
          version: 1,
          summary: '压缩摘要',
          sourceMessageCount: 2,
          sourceChars: 500,
          model: 'local',
          createdAt: Date.now(),
          language: 'zh-CN',
        },
        isStreaming: false,
      },
      modelTier: 'local',
      insertIndex: 1,
    });

    const destroy = vi.fn();
    const mockAgent = createMockAgent({ destroy });
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [
        {
          id: 'session-1',
          name: '任务 1',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: 'session-1',
      sessionMessages: {
        'session-1': [
          { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
          { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
        ],
      },
      messages: [
        { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
        { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
      ],
      _agent: mockAgent,
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: 'key-1',
      _agentSessionId: 'session-1',
    }));

    await useAgentStore.getState().sendMessage('/compact', '/compact', 'agent');

    // 旧实现：只插入 checkpoint 消息，_agent 原样复用（下一回合全量历史照发）。
    const state = useAgentStore.getState();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(state._agent).toBeNull();
    expect(state._agentSessionId).toBeNull();
    expect(state._agentModel).toBeNull();
    expect(state._agentPromptKey).toBeNull();
    expect(state.sessionMessages['session-1']).toContainEqual(
      expect.objectContaining({ id: 'checkpoint-1', content: '已压缩' })
    );
  });

  it('/compact 回合在飞时不销毁 agent（留给回合后自动压缩处理）', async () => {
    maybeGenerateContextCheckpointMock.mockResolvedValueOnce({
      message: {
        id: 'checkpoint-1',
        role: 'assistant',
        content: '已压缩',
        timestamp: Date.now(),
        contextCheckpoint: {
          version: 1,
          summary: '压缩摘要',
          sourceMessageCount: 2,
          sourceChars: 500,
          model: 'local',
          createdAt: Date.now(),
          language: 'zh-CN',
        },
        isStreaming: false,
      },
      modelTier: 'local',
      insertIndex: 1,
    });

    const destroy = vi.fn();
    const mockAgent = createMockAgent({ destroy });
    useAgentStore.setState((state) => ({
      ...state,
      activeSessionId: 'session-1',
      sessionMessages: {
        'session-1': [
          { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
          { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
        ],
      },
      messages: [
        { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
        { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
      ],
      isLoading: true,
      loadingSessionId: 'session-1',
      _agent: mockAgent,
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: 'key-1',
      _agentSessionId: 'session-1',
    }));

    await useAgentStore.getState().sendMessage('/compact', '/compact', 'agent');

    const state = useAgentStore.getState();
    expect(destroy).not.toHaveBeenCalled();
    expect(state._agent).toBe(mockAgent);
  });

  it('#15 /compact 压缩模型调用期间用户清空消息：checkpoint 丢弃，已删内容不以摘要复活', async () => {
    maybeGenerateContextCheckpointMock.mockImplementationOnce(async () => {
      // 模拟：压缩模型调用期间用户清空了会话
      useAgentStore.setState({
        sessionMessages: { 'session-1': [] },
        messages: [],
      });
      return {
        message: {
          id: 'checkpoint-stale',
          role: 'assistant',
          content: '被删除内容的摘要',
          timestamp: Date.now(),
          contextCheckpoint: {
            version: 1,
            summary: '已删内容',
            sourceMessageCount: 2,
            sourceChars: 500,
            model: 'local',
            createdAt: Date.now(),
            language: 'zh-CN',
          },
          isStreaming: false,
        },
        modelTier: 'local',
        insertIndex: 1,
      };
    });

    const destroy = vi.fn();
    useAgentStore.setState((state) => ({
      ...state,
      activeSessionId: 'session-1',
      sessionMessages: {
        'session-1': [
          { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
          { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
        ],
      },
      messages: [
        { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
        { id: 'u2', role: 'user', content: '第二条', timestamp: 2 },
      ],
      _agent: createMockAgent({ destroy }),
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: 'key-1',
      _agentSessionId: 'session-1',
    }));

    await useAgentStore.getState().sendMessage('/compact', '/compact', 'agent');

    // 旧实现：insertIndex 被 clamp 到末尾 → 已删除内容以摘要形式复活
    const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
    expect(sessionMessages.some((m) => m.id === 'checkpoint-stale')).toBe(false);
    // 基座失效时也不销毁 agent（checkpoint 未应用）
    expect(destroy).not.toHaveBeenCalled();
  });

  it('#14 consolidation 模型调用期间 agent 写入 memory.md：写前重读比对，放弃覆盖', async () => {
    const longMemory = Array.from({ length: 210 }, (_, i) => `line-${i}`).join('\n');
    const agentWritten = 'agent 在 consolidation 期间写入的新记忆';
    let memoryReads = 0;
    const memoryWrites: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return { root: '', entries: [], truncated: false };
      }
      if (command === 'read_text_file' && args?.relativePath === '.CodePapr/memory.md') {
        memoryReads += 1;
        // 第 3 次读取 = 写前重读：agent 已写入新内容
        return {
          path: '.CodePapr/memory.md',
          content: memoryReads >= 3 ? agentWritten : longMemory,
          bytes: 100,
        };
      }
      if (command === 'write_text_file') {
        memoryWrites.push((args ?? {}) as Record<string, unknown>);
        return { path: String(args?.relativePath), bytes: 1, encoding: null };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    consolidateMemoryContentMock.mockResolvedValue('consolidated-result');

    useAgentStore.setState((state) => ({
      ...state,
      _agent: createMockAgent({ chat: vi.fn(async () => createAgentResponse('回复')) }),
      _agentModel: 'deepseek-v4-pro',
      _agentSessionId: 'session-1',
    }));

    await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

    // consolidation 是 fire-and-forget 的异步闭包：等待其完成（写前重读）
    await vi.waitFor(() => expect(memoryReads).toBeGreaterThanOrEqual(3));

    // 旧实现：consolidation 整文件覆盖，agent 在窗口内的写入全部丢失
    expect(
      memoryWrites.filter((w) => w.relativePath === '.CodePapr/memory.md')
    ).toHaveLength(0);
  });

  it('persists the recent workspace path after opening a workspace', async () => {
    await useAgentStore.getState().openWorkspace('/tmp/restored-workspace');

    expect(invokeMock).toHaveBeenCalledWith('note_recent_workspace', {
      path: '/tmp/restored-workspace',
    });
    expect(useAgentStore.getState().settings.recentWorkspaces[0]?.path).toBe('/tmp/restored-workspace');
    expect(saveAppSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recentWorkspaces: expect.arrayContaining([
          expect.objectContaining({ path: '/tmp/restored-workspace' }),
        ]),
      })
    );
  });

  it('applies sqlite-backed skill enablement when loading project config', async () => {
    loadAllProjectMetaMock.mockResolvedValueOnce({
      active_session_id: null,
      skill_enabled_by_id: {
        search: false,
      },
      conversation_stats: createEmptyConversation(),
      session_conversation_stats: {},
      project_diagnostics_report: null,
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === '.CodePapr/skills') {
          return {
            root: relativePath,
            entries: [
              { path: '.CodePapr/skills/search', name: 'search', kind: 'dir', isDir: true },
              { path: '.CodePapr/skills/search/SKILL.md', name: 'SKILL.md', kind: 'file' },
            ],
            truncated: false,
          };
        }
        return {
          root: relativePath,
          entries: [],
          truncated: false,
        };
      }

      if (command === 'read_text_file' && args?.relativePath === '.CodePapr/skills/search/SKILL.md') {
        return {
          path: '.CodePapr/skills/search/SKILL.md',
          content: '---\nname: 搜索\ndescription: 搜索资料\n---\n优先查官方文档。',
          bytes: 32,
        };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await useAgentStore.getState().openWorkspace('/tmp/skills-workspace');
    await waitForCondition(() => useAgentStore.getState()._skillDefinitions.length === 1);

    expect(useAgentStore.getState()._skillDefinitions[0]).toMatchObject({
      id: 'search',
      enabled: false,
    });
  });

  it('does not run startup diagnostics just because a workspace was opened', async () => {
    vi.useFakeTimers();

    try {
      await useAgentStore.getState().openWorkspace('/tmp/startup-workspace');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(
        invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command')
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes changed-file intelligence asynchronously and auto-starts a repair flow after failed post-mutation diagnostics', async () => {
    vi.useFakeTimers();
    const originalSendMessage = useAgentStore.getState().sendMessage;

    try {
      const sendMessageMock = vi.fn(async (..._args: unknown[]) => undefined);
      invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'list_workspace_files') {
          return {
            root: '/tmp/mutated-workspace',
            entries: [
              {
                path: 'package.json',
                name: 'package.json',
                isDir: false,
                bytes: 64,
              },
            ],
            truncated: false,
          };
        }

        if (command === 'read_text_file') {
          const relativePath = String(args?.relativePath ?? '');
          if (relativePath === 'package.json') {
            return {
              path: relativePath,
              content: JSON.stringify({
                name: 'codepapr-test',
                scripts: {
                  lint: 'eslint .',
                },
              }),
              bytes: 0,
            };
          }

          if (relativePath === 'src/App.tsx') {
            return {
              path: relativePath,
              content: 'export const App = () => null;\n',
              bytes: 0,
            };
          }
        }

        if (command === 'lsp_open_document') {
          return {
            message: {
              opened: true,
              diagnostics: [],
              server: {
                languageId: 'typescript',
                serverFamily: 'typescript',
                running: true,
                command: 'typescript-language-server --stdio',
                toolOrigin: 'managed',
                toolSource: 'workspace',
                toolLabel: 'typescript-language-server',
                managedCachePath: null,
                pid: 234,
                openDocuments: 1,
                stderrTail: [],
              },
            },
          };
        }

        if (command === 'lsp_request') {
          return {
            message: {
              result: [],
            },
          };
        }

        if (command === 'run_workspace_command') {
          return {
            command: 'npm',
            args: ['run', 'lint'],
            status: 1,
            stdout: '',
            stderr: 'src/App.tsx:1:1 type failure',
            timedOut: false,
          };
        }

        throw new Error(`Unexpected invoke call: ${command}`);
      });

      useAgentStore.setState((state) => ({
        ...state,
        workspacePath: '/tmp/mutated-workspace',
        isLoading: false,
        settings: normalizeSettings({
          apiKey: 'sk-test',
          fastModelEnabled: false,
        }),
        sendMessage: sendMessageMock as typeof state.sendMessage,
      }));

      useAgentStore.getState().noteWorkspaceMutation(['src/App.tsx']);

      await vi.advanceTimersByTimeAsync(80);
      expect(
        (invokeMock.mock.calls as Array<[string, Record<string, unknown>?]>).some(
          ([command, args]) => command === 'lsp_open_document' && args?.relativePath === 'src/App.tsx'
        )
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(700);
      expect(
        invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command')
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      // 诊断明细内嵌在修复提示词里；报告对象不再作为参数注入每轮 prompt。
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.stringContaining('src/App.tsx'),
        '后台诊断发现问题，自动进入修复流',
        'agent'
      );
      expect(String(sendMessageMock.mock.calls[0]?.[0])).toContain('诊断失败项');
    } finally {
      useAgentStore.setState({ sendMessage: originalSendMessage });
      vi.useRealTimers();
    }
  });

  it('purges deleted session content from project storage when deleting a session', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '要删除的会话内容',
          timestamp: 1,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'message-1',
            role: 'user',
            content: '要删除的会话内容',
            timestamp: 1,
          },
        ],
      },
    }));

    useAgentStore.getState().deleteSession('session-1');

    expect(saveProjectStateDirectMock).toHaveBeenCalledWith(
      '/tmp/codepapr-test',
      expect.objectContaining({
        sessions: [],
        sessionMessages: {},
      }),
      expect.objectContaining({ purgeDeletedContent: true })
    );
    expect(useAgentStore.getState().sessions).toEqual([]);
  });

  it('purges deleted message content from project storage when clearing messages', async () => {
    const chat = vi.fn(async () => createAgentResponse('旧 agent 不应复用'));
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '待清空的消息',
          timestamp: 1,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'message-1',
            role: 'user',
            content: '待清空的消息',
            timestamp: 1,
          },
        ],
      },
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: '旧系统提示词',
    }));

    useAgentStore.getState().clearMessages();

    expect(saveProjectStateDirectMock).toHaveBeenCalledWith(
      '/tmp/codepapr-test',
      expect.objectContaining({
        sessionMessages: {
          'session-1': [],
        },
      }),
      expect.objectContaining({ purgeDeletedContent: true })
    );
    expect(useAgentStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState()._agent).toBeNull();
    expect(useAgentStore.getState()._agentModel).toBeNull();
    expect(useAgentStore.getState()._agentPromptKey).toBeNull();
  });

  it('does not inject diagnostics or project overview into the per-turn prompt (agent fetches via tools)', async () => {
    const chat = vi.fn(async (prompt: string) => {
      void prompt;
      return createAgentResponse('已完成 App.tsx 静态错误修复。');
    });
    const diagnosticsReport = {
      available: true,
      packageManager: 'npm' as const,
      packageJsonPath: 'package.json',
      ranAt: 1,
      overallStatus: 'failed' as const,
      stages: [
        {
          id: 'typecheck' as const,
          scriptName: 'build',
          label: 'build',
          command: 'npm',
          args: ['run', 'build'],
          fallback: false,
          success: false,
          status: 1,
          timedOut: false,
          stdout: '',
          stderr: 'src/App.tsx:3:14 error Cannot find name foo',
          excerpt: 'src/App.tsx:3:14 error Cannot find name foo',
        },
      ],
    };

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: null,
      // Even with a failing report in the store, the per-turn prompt must
      // stay lean: the agent decides when to run diagnostics / graph itself.
      projectDiagnosticsReport: diagnosticsReport,
    });

    await useAgentStore
      .getState()
      .sendMessage('修复 App.tsx 里的静态错误', '修复 App.tsx 里的静态错误', 'agent');

    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = String(chat.mock.calls[0]?.[0]);
    expect(prompt).toContain('# CodePapr AGENT 模式');
    expect(prompt).toContain('修复 App.tsx 里的静态错误');
    expect(prompt).not.toContain('## 项目诊断');
    expect(prompt).not.toContain('src/App.tsx:3:14');
    expect(prompt).not.toContain('## 项目结构概览');
    const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
    expect(sessionMessages[0]?.promptContent).not.toContain('## 项目诊断');
    expect(sessionMessages[0]?.content).toBe('修复 App.tsx 里的静态错误');
  });

  it('expands custom --commands inline commands before sending to the agent', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === '.CodePapr/commands/branch.md') {
          return {
            path: relativePath,
            content: '当前分支：!`git branch --show-current`\n请处理：$ARGUMENTS',
            bytes: 0,
          };
        }
      }

      if (command === 'run_workspace_command') {
        return {
          command: 'git',
          args: ['branch', '--show-current'],
          status: 0,
          stdout: 'main\n',
          stderr: '',
          timedOut: false,
        };
      }

      if (command === 'list_workspace_files') {
        return { root: '', entries: [], truncated: false };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });
    const chat = vi.fn(async (prompt: string) => createAgentResponse(`收到：${prompt}`));

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('--branch src/App.tsx', '--branch src/App.tsx', 'agent');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(String(chat.mock.calls[0]?.[0])).toContain('当前分支：main');
    expect(String(chat.mock.calls[0]?.[0])).toContain('请处理：src/App.tsx');
    expect(invokeMock).toHaveBeenCalledWith(
      'run_workspace_command',
      expect.objectContaining({
        workspacePath: '/tmp/codepapr-test',
        command: 'git',
        args: ['branch', '--show-current'],
        timeoutSeconds: 30,
      })
    );
  });

  it('shows command descriptions in /help', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          root: '',
          entries: [{ path: '.CodePapr/commands/ship.md', name: 'ship.md', kind: 'file' }],
          truncated: false,
        };
      }

      if (command === 'read_text_file' && args?.relativePath === '.CodePapr/commands/ship.md') {
        return {
          path: '.CodePapr/commands/ship.md',
          content: '---\ndescription: 发布当前工作区改动\n---\n请发布：$ARGUMENTS',
          bytes: 0,
        };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await useAgentStore.getState().sendMessage('/help', '/help', 'agent');

    const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
    const helpMessage = sessionMessages.at(-1)?.content ?? '';
    expect(helpMessage).toContain('/help (或 /commands): 查看命令说明');
    expect(helpMessage).toContain('/review: 审查当前改动或指定范围');
    expect(helpMessage).toContain('/ship: 发布当前工作区改动');
  });

  it('keeps auto-continuing until a final execution result arrives', async () => {
    const replies = [
      '我先检查一下相关实现，然后继续修改。',
      '接下来需要更新 script.js 和 package.json。',
      '已完成修改，并执行 npm run test 验证通过。',
    ];
    const chat = vi.fn(async (_prompt: string) => {
      return createAgentResponse(replies.shift() ?? '已完成');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('按他的计划继续运行', '按他的计划继续运行', 'agent');

    const state = useAgentStore.getState();
    const sessionMessages = state.sessionMessages['session-1'] ?? [];
    const visibleMessages = sessionMessages.filter((message) => !message.hidden);
    const hiddenMessages = sessionMessages.filter((message) => message.hidden);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(String(chat.mock.calls[0]?.[0])).toContain('# CodePapr AGENT 模式');
    expect(String(chat.mock.calls[0]?.[0])).toContain('按他的计划继续运行');

    expect(visibleMessages).toHaveLength(2);
    expect(visibleMessages[0]?.role).toBe('user');
    expect(visibleMessages[1]?.role).toBe('assistant');
    expect(visibleMessages[1]?.agentStep).toBe(1);
    expect(visibleMessages[1]?.content).toContain('我先检查一下相关实现');

    expect(hiddenMessages.filter((message) => message.role === 'user')).toHaveLength(0);
    expect(hiddenMessages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    const hiddenExecutionSummary = hiddenMessages.find((message) => message.role === 'assistant');
    expect(hiddenExecutionSummary?.content).toContain('执行证据摘要');
    expect(hiddenExecutionSummary?.carryForwardInContext).toBe(true);
    const restoredMessages = buildEffectiveContextMessages(sessionMessages);
    expect(restoredMessages.some((message) => message.content.includes('执行证据摘要'))).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.conversationStats.primary.rounds).toBe(1);
  });

  it('does not schedule an internal retry when the first reply is still planning work', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(createAgentResponse('我先检查一下相关实现，然后继续修改。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('按他的计划继续运行', '按他的计划继续运行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(visibleMessages[1]?.content).toContain('我先检查一下');
    expect(visibleMessages[1]?.isStreaming).toBe(false);
  });

  it('keeps a partial-progress reply as the final visible message when the model stops there', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        createAgentResponse('已修改 agentStore.ts 的一部分，还需要继续拆分消息气泡并补验证。')
      );

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续修改代码', '继续修改代码', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(visibleMessages[1]?.content).toContain('还需要继续拆分消息气泡并补验证');
  });

  it('preserves full streamed content and reasoning instead of overwriting them with the last fragment', async () => {
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'reasoning-delta', delta: '第一段思考\n' });
      onEvent?.({ type: 'reasoning-delta', delta: '第二段思考' });
      onEvent?.({ type: 'content-delta', delta: '第一段回复\n' });
      onEvent?.({ type: 'content-delta', delta: '第二段回复' });

      return createAgentResponse('第二段回复', {
        reasoningContent: '第二段思考',
      });
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('解释一下当前实现', '解释一下当前实现', 'ask');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(visibleMessages).toHaveLength(2);
    expect(visibleMessages[1]?.content).toBe('第一段回复\n第二段回复');
    expect(visibleMessages[1]?.reasoningContent).toBe('第一段思考\n第二段思考');
  });

  it('clears partial streamed content and reasoning on stream-restart so a retried attempt does not duplicate', async () => {
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'reasoning-delta', delta: '中断前的思考' });
      onEvent?.({ type: 'content-delta', delta: '中断前的回复' });
      onEvent?.({ type: 'stream-restart', attempt: 1, maxRetries: 3 });
      onEvent?.({ type: 'reasoning-delta', delta: '完整思考' });
      onEvent?.({ type: 'content-delta', delta: '完整回复' });

      return createAgentResponse('完整回复', {
        reasoningContent: '完整思考',
      });
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('解释一下当前实现', '解释一下当前实现', 'ask');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(visibleMessages).toHaveLength(2);
    expect(visibleMessages[1]?.content).toBe('完整回复');
    expect(visibleMessages[1]?.reasoningContent).toBe('完整思考');
  });

  it('shows a reconnect status on request-retry and keeps the partial state intact', async () => {
    let statusTextDuringRetry: string | undefined;
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'request-retry', attempt: 2, maxRetries: 6 });
      // 事件处理是同步的：此刻状态栏应已显示重试进度
      statusTextDuringRetry = (useAgentStore.getState().sessionMessages['session-1'] ?? [])
        .find((message) => message.role === 'assistant')?.statusText;
      onEvent?.({ type: 'content-delta', delta: '恢复后的回复' });

      return createAgentResponse('恢复后的回复');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('解释一下当前实现', '解释一下当前实现', 'ask');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(visibleMessages).toHaveLength(2);
    expect(visibleMessages[1]?.content).toBe('恢复后的回复');
    expect(statusTextDuringRetry).toContain('2/6');
  });

  it('shows reconnect status without a cap when maxRetries is omitted (unlimited retries)', async () => {
    let statusTextDuringRetry: string | undefined;
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'stream-restart', attempt: 3 });
      statusTextDuringRetry = (useAgentStore.getState().sessionMessages['session-1'] ?? [])
        .find((message) => message.role === 'assistant')?.statusText;
      onEvent?.({ type: 'content-delta', delta: '恢复后的回复' });

      return createAgentResponse('恢复后的回复');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('解释一下当前实现', '解释一下当前实现', 'ask');

    expect(statusTextDuringRetry).toContain('(3)');
    expect(statusTextDuringRetry).not.toContain('undefined');
  });

  it('keeps partial content and shows status on round-retry (length-continue / empty)', async () => {
    let statusDuringContinue: string | undefined;
    let statusDuringEmpty: string | undefined;
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'content-delta', delta: '已输出的片段' });
      onEvent?.({ type: 'round-retry', reason: 'length-continue', attempt: 1 });
      statusDuringContinue = (useAgentStore.getState().sessionMessages['session-1'] ?? [])
        .find((message) => message.role === 'assistant')?.statusText;
      onEvent?.({ type: 'round-retry', reason: 'empty', attempt: 2 });
      statusDuringEmpty = (useAgentStore.getState().sessionMessages['session-1'] ?? [])
        .find((message) => message.role === 'assistant')?.statusText;
      onEvent?.({ type: 'content-delta', delta: '续写部分' });

      return createAgentResponse('已输出的片段续写部分');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('解释一下当前实现', '解释一下当前实现', 'ask');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    // round-retry 不清空已输出内容（与 stream-restart 不同）
    expect(visibleMessages[1]?.content).toBe('已输出的片段续写部分');
    expect(statusDuringContinue).toContain('(1)');
    expect(statusDuringEmpty).toContain('(2)');
  });

  it('stores request-context snapshots on assistant messages when debug mode is enabled', async () => {
    const requestContext = '{\n  "round": 1,\n  "model": "deepseek-v4-pro"\n}';
    const contextSnapshot: IContextSnapshot = {
      round: 1,
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'system prompt', stage: 'stable-prefix', estimatedTokens: 3 },
      ],
      toolNames: [],
      toolsTokenEstimate: 0,
      totalTokens: 3,
      tokensByStage: { 'stable-prefix': 3, 'session-state': 0, conversation: 0 },
      capturedAt: Date.now(),
    };
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'request-context', round: 1, content: requestContext, snapshot: contextSnapshot });
      onEvent?.({ type: 'content-delta', delta: '开始分析' });

      return createAgentResponse('开始分析');
    });

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        ...state.settings,
        debugEnabled: true,
      }),
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    }));

    await useAgentStore.getState().sendMessage('解释当前上下文', '解释当前上下文', 'ask');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(visibleMessages[1]?.promptContent).toBe(requestContext);

    const latest = useAgentStore.getState()._latestContextSnapshot;
    expect(latest?.sessionId).toBe('session-1');
    expect(latest?.snapshot).toBe(contextSnapshot);
  });

  it('computeContextSnapshot rebuilds the staged context from restored messages without sending', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      sessionMessages: {
        'session-1': [
          { id: 'u1', role: 'user', content: '你好，帮我看看项目', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: '好的，我来看一下。', timestamp: 2 },
        ],
      },
      _latestContextSnapshot: null,
    }));

    await useAgentStore.getState().computeContextSnapshot();

    const rebuilt = useAgentStore.getState()._latestContextSnapshot;
    expect(rebuilt?.sessionId).toBe('session-1');
    const snapshot = rebuilt?.snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot!.messages.some((m) => m.stage === 'stable-prefix' && m.role === 'system')).toBe(true);
    expect(snapshot!.messages.some((m) => m.stage === 'conversation' && m.content === '你好，帮我看看项目')).toBe(true);
    expect(snapshot!.messages.some((m) => m.stage === 'conversation' && m.content === '好的，我来看一下。')).toBe(true);
    expect(snapshot!.totalTokens).toBeGreaterThan(0);
    expect(snapshot!.tokensByStage['stable-prefix']).toBeGreaterThan(0);
  });

  it('does not append a synthetic summary for pure agent q-and-a replies', async () => {
    const chat = vi.fn(async () => createAgentResponse('这个项目目前主要是 Vite + React + TypeScript。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore
      .getState()
      .sendMessage('这个项目技术栈是什么', '这个项目技术栈是什么', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(visibleMessages).toHaveLength(2);
    expect(visibleMessages[0]?.role).toBe('user');
    expect(visibleMessages[1]?.role).toBe('assistant');
    expect(visibleMessages[1]?.content).toContain('Vite + React + TypeScript');
    expect(visibleMessages[1]?.synthetic).not.toBe(true);
  });

  it('keeps model metadata on the final assistant bubble', async () => {
    const chat = vi.fn(async () => createAgentResponse('已完成修改。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );
    const assistantMessage = visibleMessages[visibleMessages.length - 1];

    expect(assistantMessage?.synthetic).not.toBe(true);
    expect(assistantMessage?.modelName).toBe('deepseek-v4-pro');
    expect(assistantMessage?.modelTier).toBe('primary');
  });

  it('attributes subagent fast-model cache stats to the fast tier, not primary', async () => {
    const chat = vi.fn(async () => ({
      role: 'assistant' as const,
      content: '已用 explore 子代理调研完成。',
      cacheStats: {
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        newInputTokens: 5,
        outputTokens: 8,
        calls: 1,
      },
      subagentCacheStatsByTier: {
        fast: {
          cacheCreationTokens: 100,
          cacheReadTokens: 200,
          newInputTokens: 50,
          outputTokens: 30,
          calls: 1,
        },
      },
    }));

    useAgentStore.setState((state) => ({
      ...state,
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    }));

    await useAgentStore.getState().sendMessage('调研项目结构', '调研项目结构', 'agent');

    const stats = useAgentStore.getState().conversationStats;
    // Main agent usage → primary tier
    expect(stats.primary.calls).toBe(1);
    expect(stats.primary.totalOutput).toBe(8);
    expect(stats.primary.totalCacheRead).toBe(20);
    // Subagent (explore) fast-model usage → fast tier (previously misattributed to primary)
    expect(stats.fast.calls).toBe(1);
    expect(stats.fast.totalOutput).toBe(30);
    expect(stats.fast.totalCacheRead).toBe(200);
    // Primary must NOT be inflated by subagent fast usage
    expect(stats.primary.totalOutput).not.toBe(38);
  });

  it('accumulates agent wall-clock runtime into conversation stats per turn', async () => {
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const chat = vi.fn(async () => {
      // 回合在 3 秒后完成（墙钟口径：用户发送 → 回合结束）
      nowSpy.mockReturnValue(baseNow + 3000);
      return createAgentResponse('已完成。');
    });

    useAgentStore.setState((state) => ({
      ...state,
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    }));

    await useAgentStore.getState().sendMessage('帮我改个函数', '帮我改个函数', 'agent');

    const state = useAgentStore.getState();
    expect(state.conversationStats.runtimeMs).toBe(3000);
    expect(state.sessionConversationStats['session-1']?.runtimeMs).toBe(3000);

    // 第二回合继续累加
    const secondChat = vi.fn(async () => {
      nowSpy.mockReturnValue(baseNow + 5000);
      return createAgentResponse('又完成了。');
    });
    useAgentStore.setState((state2) => ({
      ...state2,
      _agent: createMockAgent({ chat: secondChat }),
      _agentModel: 'deepseek-v4-pro',
    }));
    await useAgentStore.getState().sendMessage('再来一次', '再来一次', 'agent');

    const afterSecond = useAgentStore.getState();
    expect(afterSecond.conversationStats.runtimeMs).toBe(5000);
    expect(afterSecond.sessionConversationStats['session-1']?.runtimeMs).toBe(5000);
    nowSpy.mockRestore();
  });

  it('does not issue an extra fast-model summary request at the end', async () => {
    const chat = vi.fn(async () => createAgentResponse('已完成修改。'));
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'fast-summary-1',
            choices: [
              {
                message: { role: 'assistant', content: '快模型收尾总结' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_cache_hit_tokens: 80,
              prompt_cache_miss_tokens: 20,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        ...state.settings,
        apiKey: 'sk-test',
        fastModelEnabled: true,
        fastModel: 'deepseek-v4-flash',
      }),
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    }));

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );
    const assistantMessage = visibleMessages[visibleMessages.length - 1];

    expect(fetchMock).not.toHaveBeenCalled();
    expect(assistantMessage?.synthetic).not.toBe(true);
    expect(assistantMessage?.content).toContain('已完成修改');
    expect(assistantMessage?.modelName).toBe('deepseek-v4-pro');
    expect(assistantMessage?.modelTier).toBe('primary');
    // 按 tier 断言（conversationStats 还包含运行时长 runtimeMs，随墙钟变化，
    // 不属于本用例的校验范围）。
    const finalStats = useAgentStore.getState().conversationStats;
    expect(finalStats.primary).toEqual({
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 1,
      totalOutput: 1,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      calls: 1,
      rounds: 1,
    });
    expect(finalStats.fast).toEqual({
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      calls: 0,
      rounds: 0,
    });
    expect(finalStats.mentor).toEqual({
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      calls: 0,
      rounds: 0,
    });
  });

  it('splits internal tool rounds from a single agent chat into separate assistant bubbles', async () => {
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({ type: 'content-delta', delta: '先读取 README.md' });
      onEvent?.({ type: 'assistant-round-complete', round: 1, content: '先读取 README.md' });
      onEvent?.({
        type: 'tool-call-start',
        toolCallId: 'tool-1',
        toolName: 'workspace_read_file',
        arguments: { relativePath: 'README.md' },
      });
      onEvent?.({
        type: 'tool-call-end',
        toolCallId: 'tool-1',
        toolName: 'workspace_read_file',
        success: true,
      });
      onEvent?.({ type: 'assistant-round-start', round: 2 });
      onEvent?.({ type: 'content-delta', delta: '已完成修改并整理结果' });
      onEvent?.({
        type: 'assistant-round-complete',
        round: 2,
        content: '已完成修改并整理结果',
      });

      return createAgentResponse('已完成修改并整理结果');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );
    const assistantMessages = visibleMessages.filter(
      (message) => message.role === 'assistant' && !message.synthetic
    );
    const summaryMessage = visibleMessages[visibleMessages.length - 1];

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content).toBe('先读取 README.md');
    expect(assistantMessages[0]?.toolInvocations?.[0]?.name).toBe('workspace_read_file');
    expect(assistantMessages[0]?.toolInvocations?.[0]?.status).toBe('success');
    expect(assistantMessages[1]?.content).toBe('已完成修改并整理结果');
    expect(assistantMessages[1]?.toolInvocations).toBeUndefined();
    expect(summaryMessage?.synthetic).not.toBe(true);
    expect(summaryMessage?.content).toBe('已完成修改并整理结果');
  });

  it('persists an execution evidence summary as hidden context after the final reply', async () => {
    const logMessages: IMessage[] = [
      {
        id: 'assistant-log-1',
        role: 'assistant',
        content: 'tool calls',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
          },
          {
            id: 'tool-command',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
          },
        ],
      },
      {
        id: 'tool-log-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-write',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 120,
            change: {
              kind: 'updated',
              added: 5,
              deleted: 1,
              beforeLines: 10,
              afterLines: 14,
            },
          },
        },
      },
      {
        id: 'tool-log-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-command',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
          },
        },
      },
    ];
    const chat = vi.fn(async () => createAgentResponse('已完成修改并执行验证。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logMessages }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
    const hiddenSummary = sessionMessages.find(
      (message) => message.hidden && message.content.includes('执行证据摘要')
    );

    expect(hiddenSummary?.content).toContain('src/App.tsx');
    expect(hiddenSummary?.content).toContain('npm run test -> 退出码 0');
    expect(hiddenSummary?.carryForwardInContext).toBe(true);
  });

  it('does not append a completion summary while a streamed tool invocation is still running', async () => {
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({
        type: 'tool-call-start',
        toolCallId: 'tool-command',
        toolName: 'workspace_run_command',
        arguments: { command: 'npm', args: ['run', 'test'] },
      });
      onEvent?.({
        type: 'tool-call-progress',
        toolCallId: 'tool-command',
        toolName: 'workspace_run_command',
        arguments: { command: 'npm', args: ['run', 'test'] },
        statusText: '正在验证: npm run test',
        output: 'running...',
      });

      return createAgentResponse('已完成修改，正在继续验证。');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: createExecutedCommandLogs }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );
    const assistantMessages = visibleMessages.filter((message) => message.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.synthetic).not.toBe(true);
    expect(assistantMessages[0]?.toolInvocations?.[0]?.status).toBe('running');
    expect(assistantMessages[0]?.statusText).toBeUndefined();
  });

  it('does not auto-retry when command validation fails', async () => {
    invokeMock.mockResolvedValue({
      root: '',
      entries: [
        {
          path: 'packages/@codepapr/ui/src/store/agentStore.test.ts',
          name: 'agentStore.test.ts',
          isDir: false,
          bytes: 100,
        },
      ],
      truncated: false,
    });

    const logSequences: IMessage[][] = [
      [
        {
          id: 'assistant-log-1',
          role: 'assistant',
          content: 'tool calls',
          timestamp: 1,
          toolCalls: [
            {
              id: 'tool-patch',
              name: 'workspace_apply_patch',
              arguments: { relativePath: 'packages/@codepapr/ui/src/store/agentStore.ts' },
            },
            {
              id: 'tool-build',
              name: 'workspace_run_command',
              arguments: { command: 'npm', args: ['run', 'build', '--workspace', '@codepapr/ui'] },
            },
          ],
        },
        {
          id: 'tool-log-1',
          role: 'tool',
          content: '{}',
          timestamp: 2,
          toolResult: {
            toolCallId: 'tool-patch',
            success: true,
            result: {
              path: 'packages/@codepapr/ui/src/store/agentStore.ts',
              bytes: 120,
              replacements: 1,
              change: {
                kind: 'updated',
                added: 5,
                deleted: 1,
                beforeLines: 10,
                afterLines: 14,
              },
            },
          },
        },
        {
          id: 'tool-log-2',
          role: 'tool',
          content: '{}',
          timestamp: 3,
          toolResult: {
            toolCallId: 'tool-build',
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'build', '--workspace', '@codepapr/ui'],
              status: 1,
              timedOut: false,
            },
          },
        },
      ],
      [
        {
          id: 'assistant-log-1',
          role: 'assistant',
          content: 'tool calls',
          timestamp: 1,
          toolCalls: [
            {
              id: 'tool-patch',
              name: 'workspace_apply_patch',
              arguments: { relativePath: 'packages/@codepapr/ui/src/store/agentStore.ts' },
            },
            {
              id: 'tool-build',
              name: 'workspace_run_command',
              arguments: { command: 'npm', args: ['run', 'build', '--workspace', '@codepapr/ui'] },
            },
            {
              id: 'tool-test',
              name: 'workspace_run_command',
              arguments: { command: 'npm', args: ['run', 'test', '--workspace', '@codepapr/ui', '--', '--run', 'src/store/agentStore.test.ts'] },
            },
          ],
        },
        {
          id: 'tool-log-1',
          role: 'tool',
          content: '{}',
          timestamp: 2,
          toolResult: {
            toolCallId: 'tool-patch',
            success: true,
            result: {
              path: 'packages/@codepapr/ui/src/store/agentStore.ts',
              bytes: 120,
              replacements: 1,
              change: {
                kind: 'updated',
                added: 5,
                deleted: 1,
                beforeLines: 10,
                afterLines: 14,
              },
            },
          },
        },
        {
          id: 'tool-log-2',
          role: 'tool',
          content: '{}',
          timestamp: 3,
          toolResult: {
            toolCallId: 'tool-build',
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'build', '--workspace', '@codepapr/ui'],
              status: 0,
              timedOut: false,
            },
          },
        },
        {
          id: 'tool-log-3',
          role: 'tool',
          content: '{}',
          timestamp: 4,
          toolResult: {
            toolCallId: 'tool-test',
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'test', '--workspace', '@codepapr/ui', '--', '--run', 'src/store/agentStore.test.ts'],
              status: 0,
              timedOut: false,
            },
          },
        },
      ],
    ];

    let logIndex = 0;
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => createAgentResponse('已完成修改，但构建失败。'))
      .mockImplementationOnce(async () => {
        logIndex = 1;
        return createAgentResponse('已修复构建问题，并重新验证通过。');
      });

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logSequences[logIndex] ?? [] }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );
    const hiddenMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => message.hidden
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(visibleMessages[1]?.content).toContain('构建失败');
    expect(hiddenMessages.some((message) => message.content.includes('系统自愈重试第 1 轮'))).toBe(
      false
    );
  });

  it('does not auto-run project diagnostics as a self-heal gate after changed files', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          root: '',
          entries: [
            {
              path: 'package.json',
              name: 'package.json',
              isDir: false,
              bytes: 80,
            },
            {
              path: 'src/App.tsx',
              name: 'App.tsx',
              isDir: false,
              bytes: 120,
            },
            {
              path: 'src/Consumer.tsx',
              name: 'Consumer.tsx',
              isDir: false,
              bytes: 120,
            },
          ],
          truncated: false,
        };
      }

      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({
              name: 'codepapr-test',
              scripts: {
                typecheck: 'tsc --noEmit',
              },
            }),
            bytes: 0,
          };
        }

        return {
          path: relativePath,
          content: 'export const value = 1;\n',
          bytes: 0,
        };
      }

      if (command === 'run_workspace_command') {
        return {
          command: 'npm',
          args: ['run', 'typecheck'],
          status: 1,
          stdout: '',
          stderr:
            'src/Consumer.tsx:5:11 - error TS2322: Type string is not assignable to type number',
          timedOut: false,
        };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const logMessages: IMessage[] = [
      {
        id: 'assistant-log-1',
        role: 'assistant',
        content: 'tool calls',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
          },
        ],
      },
      {
        id: 'tool-log-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-write',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 120,
            change: {
              kind: 'updated',
              added: 3,
              deleted: 1,
              beforeLines: 10,
              afterLines: 12,
            },
          },
        },
      },
    ];
    const chat = vi
      .fn()
      .mockResolvedValueOnce(createAgentResponse('已完成 App.tsx 修改。'))
      .mockResolvedValueOnce(createAgentResponse('已根据项目诊断修复 Consumer.tsx。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logMessages }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().projectDiagnosticsReport).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(
      'run_workspace_command',
      expect.objectContaining({
        args: ['run', 'typecheck'],
      })
    );
  });

  it('does not auto-retry a failed background command', async () => {
    const logSequences: IMessage[][] = [
      [
        {
          id: 'assistant-log-1',
          role: 'assistant',
          content: 'tool calls',
          timestamp: 1,
          toolCalls: [
            {
              id: 'tool-bg-fail',
              name: 'workspace_start_background_command',
              arguments: { command: 'python', args: ['main.py'] },
            },
          ],
        },
        {
          id: 'tool-log-1',
          role: 'tool',
          content: '{}',
          timestamp: 2,
          toolResult: {
            toolCallId: 'tool-bg-fail',
            success: false,
            result: {
              command: 'python',
              args: ['main.py'],
              message: '启动后台命令失败: address already in use',
            },
            error: '启动后台命令失败: address already in use',
          },
        },
      ],
      [
        {
          id: 'assistant-log-1',
          role: 'assistant',
          content: 'tool calls',
          timestamp: 1,
          toolCalls: [
            {
              id: 'tool-bg-fail',
              name: 'workspace_start_background_command',
              arguments: { command: 'python', args: ['main.py'] },
            },
            {
              id: 'tool-bg-ok',
              name: 'workspace_start_background_command',
              arguments: { command: 'python', args: ['main.py'] },
            },
          ],
        },
        {
          id: 'tool-log-1',
          role: 'tool',
          content: '{}',
          timestamp: 2,
          toolResult: {
            toolCallId: 'tool-bg-fail',
            success: false,
            result: {
              command: 'python',
              args: ['main.py'],
              message: '启动后台命令失败: address already in use',
            },
            error: '启动后台命令失败: address already in use',
          },
        },
        {
          id: 'tool-log-2',
          role: 'tool',
          content: '{}',
          timestamp: 3,
          toolResult: {
            toolCallId: 'tool-bg-ok',
            success: true,
            result: {
              command: 'python',
              args: ['main.py'],
              pid: 53100,
              started: true,
            },
          },
        },
      ],
    ];

    let logIndex = 0;
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => createAgentResponse('已安装依赖，并尝试在后台启动 python main.py。'))
      .mockImplementationOnce(async () => {
        logIndex = 1;
        return createAgentResponse('已重新启动后台服务，并确认进程已启动。');
      });

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logSequences[logIndex] ?? [] }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续处理后台启动问题', '继续处理后台启动问题', 'agent');

    const visibleMessages = (useAgentStore.getState().sessionMessages['session-1'] ?? []).filter(
      (message) => !message.hidden
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(visibleMessages[1]?.content).toContain('已安装依赖');
  });

  it('does not self-heal or rerun diagnostics after an explicit completed reply that already includes successful validation', async () => {
    const logMessages: IMessage[] = [
      {
        id: 'assistant-log-1',
        role: 'assistant',
        content: 'tool calls',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
          },
          {
            id: 'tool-test',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
          },
        ],
      },
      {
        id: 'tool-log-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-write',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 120,
            change: {
              kind: 'updated',
              added: 3,
              deleted: 1,
              beforeLines: 10,
              afterLines: 12,
            },
          },
        },
      },
      {
        id: 'tool-log-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-test',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
            stdout: 'ok',
            stderr: '',
          },
        },
      },
    ];
    const chat = vi
      .fn()
      .mockResolvedValueOnce(createAgentResponse('已完成全部修改，并执行 npm run test 验证通过。'));

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logMessages }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command')
    ).toBe(false);
  });

  it('does not auto-continue when streamed completion content is present even if the final response payload is empty', async () => {
    const logMessages: IMessage[] = [
      {
        id: 'assistant-log-1',
        role: 'assistant',
        content: 'tool calls',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
          },
          {
            id: 'tool-test',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
          },
        ],
      },
      {
        id: 'tool-log-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-write',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 120,
            change: {
              kind: 'updated',
              added: 3,
              deleted: 1,
              beforeLines: 10,
              afterLines: 12,
            },
          },
        },
      },
      {
        id: 'tool-log-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-test',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
            stdout: 'ok',
            stderr: '',
          },
        },
      },
    ];
    const chat = vi.fn(async (_input: string, onEvent?: (event: IChatStreamEvent) => void) => {
      onEvent?.({
        type: 'content-delta',
        delta: '代码干净。最终检查通过。',
      });

      return createAgentResponse('');
    });

    useAgentStore.setState({
      _agent: createMockAgent({ chat, logMessages: () => logMessages }),
      _agentModel: 'deepseek-v4-pro',
    });

    await useAgentStore.getState().sendMessage('继续执行', '继续执行', 'agent');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      (useAgentStore.getState().sessionMessages['session-1'] ?? []).some(
        (message) => message.content.includes('执行证据摘要')
      )
    ).toBe(true);
  });

  describe('worker crash recovery', () => {
    function setCrashRecoveryState(agent: ReturnType<typeof createMockAgent>): void {
      useAgentStore.setState((state) => ({
        ...state,
        isLoading: false,
        _agent: agent,
        _agentModel: 'deepseek-v4-pro',
        _agentPromptKey: null,
        _gitReady: false,
      }));
    }

    it('rebuilds the agent instead of reusing a crashed one', async () => {
      const crashedChat = vi.fn(async () => createAgentResponse('不应被调用'));
      const crashed = createMockAgent({ chat: crashedChat, isCrashed: true });
      const freshChat = vi.fn(async () => createAgentResponse('重建后的回复'));
      const fresh = createMockAgent({ chat: freshChat });
      createAgentMock.mockReturnValue(fresh);
      setCrashRecoveryState(crashed);

      await useAgentStore.getState().sendMessage('继续', '继续', 'agent');

      expect(crashedChat).not.toHaveBeenCalled();
      expect(createAgentMock).toHaveBeenCalledTimes(1);
      expect(freshChat).toHaveBeenCalledTimes(1);
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      expect(sessionMessages.some((m) => m.role === 'assistant' && m.content === '重建后的回复')).toBe(true);
      expect(sessionMessages.filter((m) => m.role === 'error')).toHaveLength(0);
      expect(useAgentStore.getState()._agent).toBe(fresh);
    });

    it('auto-retries once with a rebuilt agent when the worker crashes mid-turn', async () => {
      const crashingChat = vi.fn(
        async (): Promise<never> => {
          throw new WorkerCrashError('Agent worker crashed: Simulated OOM');
        },
      );
      const crashing = createMockAgent({ chat: crashingChat });
      const retryChat = vi.fn(async () => createAgentResponse('崩溃重试后的回复'));
      const fresh = createMockAgent({ chat: retryChat });
      createAgentMock.mockReturnValue(fresh);
      setCrashRecoveryState(crashing);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(crashingChat).toHaveBeenCalledTimes(1);
      expect(createAgentMock).toHaveBeenCalledTimes(1);
      expect(retryChat).toHaveBeenCalledTimes(1);
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      expect(sessionMessages.some((m) => m.role === 'assistant' && m.content === '崩溃重试后的回复')).toBe(true);
      expect(sessionMessages.filter((m) => m.role === 'error')).toHaveLength(0);
      expect(useAgentStore.getState()._agent).toBe(fresh);
    });

    it('falls back to the main-thread agent when worker rebuilds keep crashing', async () => {
      const crashingChat = vi.fn(
        async (): Promise<never> => {
          throw new WorkerCrashError('Agent worker crashed: Simulated kill');
        },
      );
      const crashing = createMockAgent({ chat: crashingChat });
      // 每次重建的 Worker 都立即崩溃（3 次重试全败）→ 降级主线程兜底成功。
      createAgentMock.mockImplementation(() => createMockAgent({ chat: crashingChat }));
      const fallbackChat = vi.fn(async () => createAgentResponse('主线程兜底回复'));
      const fallbackAgent = createMockAgent({ chat: fallbackChat });
      createMainThreadAgentMock.mockReturnValue(fallbackAgent);
      setCrashRecoveryState(crashing);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(crashingChat).toHaveBeenCalledTimes(4); // 首次 + 3 次 Worker 重建重试
      expect(createAgentMock).toHaveBeenCalledTimes(3);
      expect(createMainThreadAgentMock).toHaveBeenCalledTimes(1);
      expect(fallbackChat).toHaveBeenCalledTimes(1);
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      expect(sessionMessages.some((m) => m.role === 'assistant' && m.content === '主线程兜底回复')).toBe(true);
      expect(sessionMessages.filter((m) => m.role === 'error')).toHaveLength(0);
      // 兜底回合结束后清空 _agent：下一条消息重建 Worker 运行时回到常态。
      expect(useAgentStore.getState()._agent).toBeNull();
      expect(useAgentStore.getState().isLoading).toBe(false);
    });

    it('only surfaces an error when even the main-thread fallback fails', async () => {
      const crashingChat = vi.fn(
        async (): Promise<never> => {
          throw new WorkerCrashError('Agent worker crashed: Simulated kill');
        },
      );
      const crashing = createMockAgent({ chat: crashingChat });
      createAgentMock.mockImplementation(() => createMockAgent({ chat: crashingChat }));
      const fallbackChat = vi.fn(
        async (): Promise<never> => {
          throw new Error('provider exploded');
        },
      );
      createMainThreadAgentMock.mockReturnValue(createMockAgent({ chat: fallbackChat }));
      setCrashRecoveryState(crashing);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(createAgentMock).toHaveBeenCalledTimes(3);
      expect(createMainThreadAgentMock).toHaveBeenCalledTimes(1);
      expect(useAgentStore.getState().isLoading).toBe(false);
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      const errorMessages = sessionMessages.filter((m) => m.role === 'error');
      expect(errorMessages).toHaveLength(1);
      // 此时错误已是常规错误（非 Worker 崩溃），不带崩溃前缀。
      expect(errorMessages[0]?.content).toContain('provider exploded');
      expect(errorMessages[0]?.content).not.toContain('Agent Worker 崩溃');
    });

    it('stops the recovery chain immediately on user cancel', async () => {
      const crashingChat = vi.fn(
        async (): Promise<never> => {
          throw new WorkerCrashError('Agent worker crashed: Simulated kill');
        },
      );
      const crashing = createMockAgent({ chat: crashingChat });
      const cancelledChat = vi.fn(
        async (): Promise<never> => {
          throw new DOMException('Session was cancelled', 'AbortError');
        },
      );
      const retryDestroy = vi.fn();
      const retryAgent = createMockAgent({ chat: cancelledChat, isCrashed: false, destroy: retryDestroy });
      createAgentMock.mockReturnValue(retryAgent);
      setCrashRecoveryState(crashing);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      // 首次崩溃重建一次后，重试中的取消立即终止恢复链：不再继续重建。
      expect(createAgentMock).toHaveBeenCalledTimes(1);
      expect(createMainThreadAgentMock).not.toHaveBeenCalled();
      // 取消的回合不会进入 logStore：即使 agent 未崩溃也必须失效（N3），
      // 下一条消息按 sessionMessages 全量重建，避免模型上下文缺被取消回合。
      expect(useAgentStore.getState()._agent).toBeNull();
      expect(retryDestroy).toHaveBeenCalledTimes(1);
      expect(useAgentStore.getState().isLoading).toBe(false);
    });

    it('drops the agent when a cancel aborts a worker that died mid-turn', async () => {
      // Simulates: worker dies silently mid-turn, cancel times out and marks the
      // agent crashed, the pending chat rejects with AbortError. The store must
      // null _agent so the next message rebuilds instead of reusing the corpse.
      let crashedFlag = false;
      const chat = vi.fn(
        async (): Promise<never> => {
          crashedFlag = true;
          throw new DOMException('Agent was terminated', 'AbortError');
        },
      );
      const crashed = createMockAgent({ chat, isCrashed: () => crashedFlag });
      setCrashRecoveryState(crashed);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(useAgentStore.getState()._agent).toBeNull();
      expect(useAgentStore.getState().isLoading).toBe(false);
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      expect(sessionMessages.filter((m) => m.role === 'error')).toHaveLength(0);
    });

    it('invalidates the agent on a normal user cancel (N3: cancelled turn never enters the logStore)', async () => {
      const chat = vi.fn(
        async (): Promise<never> => {
          throw new DOMException('Session was cancelled', 'AbortError');
        },
      );
      const destroy = vi.fn();
      const healthy = createMockAgent({ chat, isCrashed: false, destroy });
      setCrashRecoveryState(healthy);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      // 取消的回合不会进入 agent 的 logStore：保留旧实例会让下一条消息的
      // 上下文缺少被取消回合（UI 显示但模型看不到），必须失效重建。
      expect(useAgentStore.getState()._agent).toBeNull();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(useAgentStore.getState().isLoading).toBe(false);
    });

    it('agent destroyed mid-turn stops silently: no rebuild, no re-run, no error message', async () => {
      // 用户切会话/新建/改设置导致 agent 被销毁：chat() 以 AgentDestroyedError
      // 拒绝（旧实现是 WorkerCrashError——崩溃恢复链会重建并重跑整个回合，
      // bash/git commit 等非幂等副作用重复执行且用户不可见）。
      const destroyedChat = vi.fn(
        async (): Promise<never> => {
          throw new AgentDestroyedError('Agent was destroyed');
        },
      );
      const destroyed = createMockAgent({ chat: destroyedChat, isCrashed: false });
      createAgentMock.mockClear();
      createMainThreadAgentMock.mockClear();
      setCrashRecoveryState(destroyed);

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(destroyedChat).toHaveBeenCalledTimes(1);
      // 绝不重建/重跑
      expect(createAgentMock).not.toHaveBeenCalled();
      expect(createMainThreadAgentMock).not.toHaveBeenCalled();
      // 静默停止：无错误消息
      const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
      expect(sessionMessages.filter((m) => m.role === 'error')).toHaveLength(0);
      expect(useAgentStore.getState().isLoading).toBe(false);
    });
  });

  describe('idle-sleep prevention', () => {
    it('blocks idle sleep while a turn is in flight and releases it afterwards', async () => {
      const powerCalls: string[] = [];
      invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
        if (command === 'prevent_idle_sleep' || command === 'allow_idle_sleep') {
          powerCalls.push(command);
          return {};
        }
        if (command === 'list_workspace_files') {
          return { root: '', entries: [], truncated: false };
        }
        throw new Error(`Unexpected invoke call: ${command}`);
      });
      const chat = vi.fn(async () => createAgentResponse('已完成'));
      useAgentStore.setState((state) => ({
        ...state,
        isLoading: false,
        _agent: createMockAgent({ chat }),
        _agentModel: 'deepseek-v4-pro',
        _agentPromptKey: null,
        _gitReady: false,
      }));

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(chat).toHaveBeenCalledTimes(1);
      expect(powerCalls).toEqual(['prevent_idle_sleep', 'allow_idle_sleep']);
      expect(useAgentStore.getState().isLoading).toBe(false);
    });

    it('releases the sleep block even when the turn errors out', async () => {
      const powerCalls: string[] = [];
      invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
        if (command === 'prevent_idle_sleep' || command === 'allow_idle_sleep') {
          powerCalls.push(command);
          return {};
        }
        if (command === 'list_workspace_files') {
          return { root: '', entries: [], truncated: false };
        }
        throw new Error(`Unexpected invoke call: ${command}`);
      });
      const chat = vi.fn(
        async (): Promise<never> => {
          throw new Error('provider exploded');
        },
      );
      useAgentStore.setState((state) => ({
        ...state,
        isLoading: false,
        _agent: createMockAgent({ chat }),
        _agentModel: 'deepseek-v4-pro',
        _agentPromptKey: null,
        _gitReady: false,
      }));

      await useAgentStore.getState().sendMessage('任务', '任务', 'agent');

      expect(powerCalls).toEqual(['prevent_idle_sleep', 'allow_idle_sleep']);
      expect(useAgentStore.getState().isLoading).toBe(false);
    });

    it('invalidates the agent after a turn error so the next message rebuilds with full context (N3)', async () => {
      invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
        if (command === 'prevent_idle_sleep' || command === 'allow_idle_sleep') {
          return {};
        }
        if (command === 'list_workspace_files') {
          return { root: '', entries: [], truncated: false };
        }
        throw new Error(`Unexpected invoke call: ${command}`);
      });
      const chat = vi.fn(
        async (): Promise<never> => {
          throw new Error('provider exploded');
        },
      );
      const destroy = vi.fn();
      useAgentStore.setState((state) => ({
        ...state,
        isLoading: false,
        _agent: createMockAgent({ chat, destroy }),
        _agentModel: 'deepseek-v4-pro',
        _agentPromptKey: null,
        _agentSessionId: 'session-1',
        _gitReady: false,
      }));

      await useAgentStore.getState().sendMessage('失败的任务', '失败的任务', 'agent');

      const state = useAgentStore.getState();
      expect(state.isLoading).toBe(false);
      // 出错的回合不会进入 agent 的 logStore：必须失效 agent，下一条消息
      // 按 sessionMessages（含错误提示）全量重建，模型才不会丢失失败的用户消息。
      expect(state._agent).toBeNull();
      expect(state._agentSessionId).toBeNull();
      expect(destroy).toHaveBeenCalledTimes(1);
      // 错误消息已入 UI 会话（重建上下文的依据）
      const sessionMessages = state.sessionMessages['session-1'] ?? [];
      expect(sessionMessages.some((m) => m.role === 'error')).toBe(true);
    });
  });
});

describe('_messageCheckpoints', () => {
  it('初始化为空对象', () => {
    useAgentStore.getState().openWorkspace('/tmp/codepapr-reset-test-1');
    expect(useAgentStore.getState()._messageCheckpoints).toEqual({});
  });

  it('clearMessages 只清当前会话的 checkpoints，保留其他会话的锚点', () => {
    useAgentStore.getState().openWorkspace('/tmp/codepapr-reset-test-2');
    const activeSessionId = useAgentStore.getState().activeSessionId ?? 's-current';
    useAgentStore.setState({
      activeSessionId,
      _messageCheckpoints: {
        'msg-1': { sha: 'abc123', sessionId: activeSessionId },
        'msg-2': { sha: 'def456', sessionId: 's-other' },
      },
    });
    useAgentStore.getState().clearMessages();
    // 其他会话的锚点必须保留（resetToMessage 依赖）；当前会话的被清掉。
    expect(useAgentStore.getState()._messageCheckpoints).toEqual({
      'msg-2': { sha: 'def456', sessionId: 's-other' },
    });
  });
});

describe('normalizeSettings', () => {
  it('clamps DeepSeek maxTokens to the provider limit', () => {
    const settings = normalizeSettings({
      apiMode: 'deepseek',
      provider: 'deepseek',
      maxTokens: 1_024_000,
    });

    expect(settings.maxTokens).toBe(200000);
  });

  it('defaults mentorMaxTokens to 100k for fresh settings', () => {
    expect(normalizeSettings({}).mentorMaxTokens).toBe(100_000);
  });

  it('migrates the legacy mentorMaxTokens default (10000) to 100k', () => {
    expect(normalizeSettings({ mentorMaxTokens: 10000 }).mentorMaxTokens).toBe(100_000);
  });

  it('keeps explicitly chosen mentorMaxTokens values intact', () => {
    expect(normalizeSettings({ mentorMaxTokens: 20000 }).mentorMaxTokens).toBe(20000);
    expect(normalizeSettings({ mentorMaxTokens: 200_000 }).mentorMaxTokens).toBe(200_000);
  });
});

describe('useAgentStore.setSettings onboarding 回归（N1）', () => {
  it('首次引导保存的 API Key 不被静默丢弃', () => {
    // 模拟 OnboardingPanel.handleSave 的完整调用：setSettings 合并现有
    // settings（恒含 per-mode 配置）后走 normalizeSettings，扁平字段会被
    // activeConfig 派生值覆盖，因此必须把 key/model 同步写进 deepseek 配置
    // （与 SettingsLlmTab 的写法一致）。
    useAgentStore.getState().setSettings({
      apiMode: 'deepseek',
      apiFormat: 'openai',
      provider: 'deepseek',
      baseURL: '',
      apiKey: 'sk-onboarding',
      model: 'deepseek-chat',
      fastModel: 'deepseek-v4-flash',
      deepseek: {
        ...useAgentStore.getState().settings.deepseek,
        apiKey: 'sk-onboarding',
        model: 'deepseek-chat',
        fastModel: 'deepseek-v4-flash',
      },
    });

    const settings = useAgentStore.getState().settings;
    expect(settings.deepseek.apiKey).toBe('sk-onboarding');
    expect(settings.deepseek.model).toBe('deepseek-chat');
    expect(settings.deepseek.fastModel).toBe('deepseek-v4-flash');
    expect(settings.apiKey).toBe('sk-onboarding');
    expect(settings.model).toBe('deepseek-chat');
    expect(settings.fastModel).toBe('deepseek-v4-flash');
    expect(getSettingsError(settings)).toBeNull();
  });
});

describe('shouldDeferIdleWatchdog（N6）', () => {
  afterEach(() => {
    cancelExternalAccessRequests();
  });

  it('无权限等待且无在飞工具时返回 false（正常触发恢复）', () => {
    expect(shouldDeferIdleWatchdog(null)).toBe(false);
    expect(shouldDeferIdleWatchdog({ hasInflightToolExecutions: () => false })).toBe(false);
  });

  it('权限确认弹窗等待期间返回 true（无限期等待设计，看门狗不得误杀）', () => {
    const pending = usePermissionStore.getState().requestExternalAccess('/tmp/outside', 'read');
    // afterEach 的 cancelExternalAccessRequests 会以 AbortError 拒绝该请求
    pending.catch(() => undefined);
    expect(shouldDeferIdleWatchdog(null)).toBe(true);
  });

  it('静默长工具在飞时返回 true（工具 IPC 超时兜底，看门狗不得误杀）', () => {
    expect(
      shouldDeferIdleWatchdog({ hasInflightToolExecutions: () => true })
    ).toBe(true);
  });
});

describe('resetToMessage 撤销（N8）', () => {
  const sessionId = 'session-1';

  function setResetState() {
    useAgentStore.setState((state) => ({
      ...state,
      workspacePath: '/tmp/codepapr-undo-test',
      sessions: [
        { id: sessionId, name: '任务 1', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: sessionId,
      messages: [
        { id: 'm1', role: 'user', content: '第一步', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: '回复一', timestamp: 2 },
        { id: 'm3', role: 'user', content: '第二步', timestamp: 3 },
        { id: 'm4', role: 'assistant', content: '回复二', timestamp: 4 },
      ],
      sessionMessages: {
        [sessionId]: [
          { id: 'm1', role: 'user', content: '第一步', timestamp: 1 },
          { id: 'm2', role: 'assistant', content: '回复一', timestamp: 2 },
          { id: 'm3', role: 'user', content: '第二步', timestamp: 3 },
          { id: 'm4', role: 'assistant', content: '回复二', timestamp: 4 },
        ],
      },
      _messageCheckpoints: {
        m1: { sha: 'sha-keep', sessionId },
        m3: { sha: 'sha-reset', sessionId },
      },
      _pendingRestoreUndo: null,
      isLoading: false,
      _agent: null,
      _agentSessionId: null,
    }));
  }

  beforeEach(() => {
    invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
      if (command === 'restore_execute') {
        return {
          ok: true,
          filesRestored: 1,
          filesDeleted: 0,
          backupRef: 'refs/codepapr-backup-before-reset',
          error: null,
        };
      }
      if (command === 'restore_undo' || command === 'delete_checkpoint_by_message') {
        return {};
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });
  });

  it('重置备份撤销信息，undo 恢复消息与 checkpoint 并调用 restore_undo', async () => {
    setResetState();

    const result = await useAgentStore.getState().resetToMessage('m3');
    expect(result.ok).toBe(true);

    const pending = useAgentStore.getState()._pendingRestoreUndo;
    expect(pending).not.toBeNull();
    expect(pending?.sessionId).toBe(sessionId);
    expect(pending?.filesRestored).toBe(true);
    expect(pending?.truncatedMessages.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(useAgentStore.getState().sessionMessages[sessionId]?.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(useAgentStore.getState()._messageCheckpoints['m3']).toBeUndefined();

    const undoResult = await useAgentStore.getState().undoConversationReset();
    expect(undoResult.ok).toBe(true);
    expect(
      invokeMock.mock.calls.some(([command]) => command === 'restore_undo')
    ).toBe(true);
    expect(useAgentStore.getState().sessionMessages[sessionId]?.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(useAgentStore.getState()._messageCheckpoints['m3']).toEqual({ sha: 'sha-reset', sessionId });
    expect(useAgentStore.getState()._pendingRestoreUndo).toBeNull();
  });

  it('撤销只回放仍缺失的消息（重置后用户又发送过新消息时不重复）', async () => {
    setResetState();
    await useAgentStore.getState().resetToMessage('m3');

    // 重置后用户又发了一条新消息（id 与旧消息不同）
    useAgentStore.setState((state) => ({
      ...state,
      messages: [...(state.sessionMessages[sessionId] ?? []), { id: 'm-new', role: 'user', content: '新消息', timestamp: 5 }],
      sessionMessages: {
        ...state.sessionMessages,
        [sessionId]: [...(state.sessionMessages[sessionId] ?? []), { id: 'm-new', role: 'user', content: '新消息', timestamp: 5 }],
      },
    }));

    const undoResult = await useAgentStore.getState().undoConversationReset();
    expect(undoResult.ok).toBe(true);
    expect(useAgentStore.getState().sessionMessages[sessionId]?.map((m) => m.id)).toEqual(['m1', 'm2', 'm-new', 'm3', 'm4']);
  });

  it('dismissRestoreUndo 清除撤销信息；无撤销信息时 undo 返回失败', async () => {
    setResetState();
    await useAgentStore.getState().resetToMessage('m3');
    expect(useAgentStore.getState()._pendingRestoreUndo).not.toBeNull();

    useAgentStore.getState().dismissRestoreUndo();
    expect(useAgentStore.getState()._pendingRestoreUndo).toBeNull();

    const undoResult = await useAgentStore.getState().undoConversationReset();
    expect(undoResult.ok).toBe(false);
    expect(undoResult.message).toBe('nothing-to-undo');
  });

  it('deleteSession 清除对应会话的撤销信息', async () => {
    setResetState();
    await useAgentStore.getState().resetToMessage('m3');
    expect(useAgentStore.getState()._pendingRestoreUndo).not.toBeNull();

    useAgentStore.getState().deleteSession(sessionId);
    expect(useAgentStore.getState()._pendingRestoreUndo).toBeNull();
  });
});

describe('useAgentStore.closeWorkspace', () => {
  it('清空 workspacePath 及所有相关状态（含 projectGraphLoading/Phase）', () => {
    useAgentStore.setState({
      workspacePath: '/tmp/codepapr-close-test',
      projectGraphLoading: true,
      projectGraphPhase: { phase: 'reading-files', current: 3, total: 10 },
      sessions: [
        { id: 's1', name: '任务 1', provider: 'deepseek', model: 'deepseek-chat', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 's1',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      sessionMessages: { s1: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }] },
      _gitReady: true,
      _checkpointSeq: 5,
    });

    useAgentStore.getState().closeWorkspace();

    const state = useAgentStore.getState();
    expect(state.workspacePath).toBe('');
    expect(state.projectGraphLoading).toBe(false);
    expect(state.projectGraphPhase).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.sessionMessages).toEqual({});
    expect(state._gitReady).toBe(false);
    expect(state._checkpointSeq).toBe(0);
  });

  it('openWorkspace 两步化：切换到新项目后 projectGraphLoading 不卡在 true', async () => {
    // 模拟前一项目正在加载 projectGraph 的状态
    useAgentStore.setState({
      workspacePath: '/tmp/codepapr-old',
      projectGraphLoading: true,
      projectGraphPhase: { phase: 'reading-files', current: 3, total: 10 },
      sessions: [
        { id: 's-old', name: '旧任务', provider: 'deepseek', model: 'deepseek-chat', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 's-old',
      messages: [{ id: 'm-old', role: 'user', content: 'hi', timestamp: 1 }],
    });

    await useAgentStore.getState().openWorkspace('/tmp/codepapr-new');

    const state = useAgentStore.getState();
    expect(state.workspacePath).toBe('/tmp/codepapr-new');
    expect(state.projectGraphLoading).toBe(false);
    expect(state.projectGraphPhase).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.sessions).toEqual([]);
  });

  it('openWorkspace 读前等待该工作区挂起的保存队列（读旧覆新防护）', async () => {
    waitForPendingProjectStateSaveMock.mockClear();
    await useAgentStore.getState().openWorkspace('/tmp/codepapr-flush');

    // 旧实现：新表加载路径不等待挂起的保存队列（legacy loadProjectState
    // 有 wait，迁移时漏掉）——A→B→A 快速切换会读到旧数据并被回写覆盖。
    expect(waitForPendingProjectStateSaveMock).toHaveBeenCalledWith('/tmp/codepapr-flush');
  });

  it('快速切换工作区时旧加载结果不得覆盖新工作区（身份令牌守卫）', async () => {
    let resolveFirst!: (value: ProjectSessionMeta[]) => void;
    loadSessionsMock.mockImplementationOnce(
      () => new Promise<ProjectSessionMeta[]>((resolve) => { resolveFirst = resolve; })
    );

    // A 的加载挂起中切换到 B，B 立即完成
    const openA = useAgentStore.getState().openWorkspace('/tmp/codepapr-race-A');
    await vi.waitFor(() => expect(loadSessionsMock).toHaveBeenCalled());
    await useAgentStore.getState().openWorkspace('/tmp/codepapr-race-B');
    expect(useAgentStore.getState().workspacePath).toBe('/tmp/codepapr-race-B');

    // A 的加载姗姗来迟：旧实现无条件 set()，会用 A 的空状态覆盖 B 的工作区
    resolveFirst([]);
    await openA;

    expect(useAgentStore.getState().workspacePath).toBe('/tmp/codepapr-race-B');
  });
});

describe('sendMessage /goal', () => {
  it('runs the goal loop and completes when condition is met', async () => {
    // Mock the worker agent to return a simple response
    const mockResponse = {
      role: 'assistant' as const,
      content: '已修复 bug，测试通过。',
      cacheStats: {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        newInputTokens: 1,
        outputTokens: 1,
        calls: 1,
      },
    };
    const chat = vi.fn(async (_prompt: string) => mockResponse);

    // Mock fetch for verifier LLM calls
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"verdict":"SATISFIED","evidence":"Condition met."}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
    ));

    // Mock run_workspace_command to return success (exit code 0)
    invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
      if (command === 'list_workspace_files') {
        return { root: '', entries: [], truncated: false };
      }
      if (command === 'run_workspace_command') {
        return {
          command: 'node',
          args: ['test.js'],
          status: 0,
          stdout: '5 passed, 0 failed',
          stderr: '',
          timedOut: false,
        };
      }
      if (command === 'write_text_file') {
        return { path: '', bytes: 0 };
      }
      if (command === 'load_projectgraph_cache') {
        return null as unknown as Record<string, unknown>;
      }
      if (command === 'read_text_file') {
        return { path: '', content: '', bytes: 0 };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        apiKey: 'sk-test',
        fastModelEnabled: true,
        fastModel: 'deepseek-v4-flash',
      }),
      workspacePath: '/tmp/goal-test-workspace',
      // 生产不变式：activeSessionId 必须存在于 sessions（sendMessage 的收尾
      // 写入会跳过已不存在的会话）。
      sessions: [
        { id: 'session-1', name: 'goal', provider: 'deepseek', model: 'deepseek-v4-flash', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: { 'session-1': [] },
      isLoading: false,
      _agent: createMockAgent({ chat, logMessages: [] }),
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: null,
      _gitReady: false,
    }));

    await useAgentStore.getState().sendMessage(
      '/goal exec:node test.js',
      '/goal exec:node test.js',
      'agent'
    );

    const state = useAgentStore.getState();
    const sessionMessages = state.sessionMessages['session-1'] ?? [];

    // The agent should have been called at least once (Worker turn)
    expect(chat).toHaveBeenCalled();

    // There should be NO error messages (red bubbles)
    const errorMessages = sessionMessages.filter((m) => m.role === 'error');
    expect(errorMessages).toHaveLength(0);

    // There should be an assistant message with goal completion status
    const goalSummary = sessionMessages.find((m) =>
      m.role === 'assistant' && (m.content.includes('目标达成') || m.content.includes('目標達成') || m.content.includes('Goal satisfied'))
    );
    expect(goalSummary).toBeTruthy();
  });

  it('accepts subjective goal (no exec: prefix) and starts the goal loop', async () => {
    // Mock the worker agent
    const mockResponse = {
      role: 'assistant' as const,
      content: '我正在处理这个任务。',
      cacheStats: { cacheCreationTokens: 0, cacheReadTokens: 0, newInputTokens: 1, outputTokens: 1, calls: 1 },
    };
    const chat = vi.fn(async (_prompt: string) => mockResponse);

    // Mock fetch for verifier LLM calls
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"verdict":"SATISFIED","evidence":"Task completed."}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
    ));

    invokeMock.mockImplementation(async (command: string): Promise<Record<string, unknown>> => {
      if (command === 'list_workspace_files') return { root: '', entries: [], truncated: false };
      if (command === 'run_workspace_command') return { command: '', args: [], status: 0, stdout: '', stderr: '', timedOut: false };
      if (command === 'write_text_file') return { path: '', bytes: 0 };
      if (command === 'load_projectgraph_cache') return null as unknown as Record<string, unknown>;
      if (command === 'read_text_file') return { path: '', content: '', bytes: 0 };
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ apiKey: 'sk-test', fastModelEnabled: true, fastModel: 'deepseek-v4-flash' }),
      workspacePath: '/tmp/goal-test-workspace',
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: { 'session-1': [] },
      isLoading: false,
      _agent: createMockAgent({ chat, logMessages: [] }),
      _agentModel: 'deepseek-v4-pro',
      _agentPromptKey: null,
      _gitReady: false,
    }));

    await useAgentStore.getState().sendMessage(
      '/goal 给我补充足够的真实图片',
      '/goal 给我补充足够的真实图片',
      'agent'
    );

    const sessionMessages = useAgentStore.getState().sessionMessages['session-1'] ?? [];
    // Should NOT have red error bubbles
    const errorMessages = sessionMessages.filter((m) => m.role === 'error');
    expect(errorMessages).toHaveLength(0);
    // Agent should have been called (goal loop started)
    expect(chat).toHaveBeenCalled();
  });
});

describe('session lazy loading and LRU cache', () => {
  function createSessionMeta(id: string, createdAt: number) {
    return {
      id,
      name: `任务 ${id}`,
      provider: 'deepseek' as const,
      model: 'deepseek-v4-pro',
      createdAt,
      updatedAt: createdAt,
    };
  }

  function createMessage(id: string, content: string): ProjectMessage {
    return { id, role: 'user', content, timestamp: 1 };
  }

  beforeEach(() => {
    loadSessionsMock.mockClear();
    loadSessionMessagesMock.mockClear();
    loadAllProjectMetaMock.mockClear();
    loadProjectStateMock.mockClear();
    saveProjectStateDirectMock.mockClear();
    saveMessageBatchMock.mockClear();
    saveSessionMock.mockClear();
    saveProjectMetaMock.mockClear();
    loadSessionsMock.mockResolvedValue([]);
    loadSessionMessagesMock.mockResolvedValue([]);
    loadAllProjectMetaMock.mockResolvedValue({});
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ apiKey: 'sk-test', fastModelEnabled: false }),
      workspacePath: '/tmp/codepapr-lazy-test',
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      sessionMessagesLoading: false,
      conversationStats: createEmptyConversation(),
      sessionConversationStats: {},
      isLoading: false,
      settingsLoaded: true,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _sessionLru: [],
    }));
  });

  it('openWorkspace loads only the active session messages', async () => {
    loadSessionsMock.mockResolvedValue([
      createSessionMeta('s-active', 3),
      createSessionMeta('s-other-1', 2),
      createSessionMeta('s-other-2', 1),
    ]);
    loadAllProjectMetaMock.mockResolvedValue({
      active_session_id: 's-active',
      conversation_stats: createEmptyConversation(),
      session_conversation_stats: {},
    });
    loadSessionMessagesMock.mockResolvedValue([createMessage('m-1', '活跃会话的消息')]);

    await useAgentStore.getState().openWorkspace('/tmp/codepapr-lazy-test');

    const state = useAgentStore.getState();
    expect(loadSessionMessagesMock).toHaveBeenCalledTimes(1);
    expect(loadSessionMessagesMock).toHaveBeenCalledWith('/tmp/codepapr-lazy-test', 's-active');
    expect(state.activeSessionId).toBe('s-active');
    expect(state.messages.map((m) => m.content)).toEqual(['活跃会话的消息']);
    expect(Object.keys(state.sessionMessages)).toEqual(['s-active']);
    expect(state.sessionMessagesLoading).toBe(false);
    expect(state._sessionLru).toEqual(['s-active', 's-other-1', 's-other-2']);
  });

  it('openWorkspace backfills runtimeMs for legacy session stats', async () => {
    loadSessionsMock.mockResolvedValue([createSessionMeta('s-legacy', 1)]);
    loadAllProjectMetaMock.mockResolvedValue({
      active_session_id: 's-legacy',
      conversation_stats: createEmptyConversation(),
      session_conversation_stats: {
        // 旧数据没有 runtimeMs 字段 → 触发回填
        's-legacy': createEmptyConversation(),
      },
    });
    loadSessionMessagesMock.mockResolvedValue([]);
    aggregateSessionRuntimeInDbMock.mockResolvedValueOnce({ 's-legacy': 4200 });

    await useAgentStore.getState().openWorkspace('/tmp/codepapr-lazy-test');

    const state = useAgentStore.getState();
    expect(aggregateSessionRuntimeInDbMock).toHaveBeenCalledWith('/tmp/codepapr-lazy-test');
    expect(state.sessionConversationStats['s-legacy']?.runtimeMs).toBe(4200);
    expect(state.conversationStats.runtimeMs).toBe(4200);
  });

  it('openWorkspace keeps live-tracked runtimeMs instead of overwriting it', async () => {
    loadSessionsMock.mockResolvedValue([createSessionMeta('s-live', 1)]);
    loadAllProjectMetaMock.mockResolvedValue({
      active_session_id: 's-live',
      conversation_stats: { ...createEmptyConversation(), runtimeMs: 100 },
      session_conversation_stats: {
        's-live': { ...createEmptyConversation(), runtimeMs: 100 },
      },
    });
    loadSessionMessagesMock.mockResolvedValue([]);
    aggregateSessionRuntimeInDbMock.mockResolvedValueOnce({ 's-live': 999999 });

    await useAgentStore.getState().openWorkspace('/tmp/codepapr-lazy-test');

    expect(useAgentStore.getState().sessionConversationStats['s-live']?.runtimeMs).toBe(100);
  });

  it('selectSession loads messages on demand and shows a loading state', async () => {
    const deferred: { resolve: ((messages: ProjectMessage[]) => void) | null } = { resolve: null };
    loadSessionMessagesMock.mockImplementation(
      () => new Promise<ProjectMessage[]>((resolve) => { deferred.resolve = resolve; })
    );
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [createSessionMeta('s-1', 2), createSessionMeta('s-2', 1)],
      activeSessionId: 's-1',
      sessionMessages: { 's-1': [createMessage('m-1', '会话一') as unknown as UIMessage] },
      sessionConversationStats: {
        's-1': createEmptyConversation(),
        's-2': createEmptyConversation(),
      },
      _sessionLru: ['s-1', 's-2'],
    }));

    useAgentStore.getState().selectSession('s-2');

    expect(useAgentStore.getState().activeSessionId).toBe('s-2');
    expect(useAgentStore.getState().sessionMessagesLoading).toBe(true);
    expect(useAgentStore.getState().messages).toEqual([]);

    // 懒加载路径先排空挂起的保存队列（一个微任务后才真正发起 loadSessionMessages），
    // 需等待 mock 被调用后 deferred.resolve 才就位，否则提前调用会被 ?. 跳过。
    await waitForCondition(() => deferred.resolve !== null);
    expect(waitForPendingProjectStateSaveMock).toHaveBeenCalledWith('/tmp/codepapr-lazy-test');
    deferred.resolve?.([createMessage('m-2', '会话二')]);
    await waitForCondition(() => !useAgentStore.getState().sessionMessagesLoading);

    const state = useAgentStore.getState();
    expect(loadSessionMessagesMock).toHaveBeenCalledWith('/tmp/codepapr-lazy-test', 's-2');
    expect(state.messages.map((m) => m.content)).toEqual(['会话二']);
    expect(state.sessionMessages['s-2']?.map((m) => m.content)).toEqual(['会话二']);
    expect(state._sessionLru).toEqual(['s-2', 's-1']);
  });

  it('selectSession uses the in-memory cache without hitting storage', () => {
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [createSessionMeta('s-1', 2), createSessionMeta('s-2', 1)],
      activeSessionId: 's-1',
      sessionMessages: {
        's-1': [],
        's-2': [createMessage('m-2', '缓存的消息') as unknown as UIMessage],
      },
      sessionConversationStats: {
        's-1': createEmptyConversation(),
        's-2': createEmptyConversation(),
      },
      _sessionLru: ['s-1', 's-2'],
    }));

    useAgentStore.getState().selectSession('s-2');

    expect(loadSessionMessagesMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().messages.map((m) => m.content)).toEqual(['缓存的消息']);
    expect(useAgentStore.getState().sessionMessagesLoading).toBe(false);
  });

  it('evicts the least recently used session when the cache limit is exceeded', async () => {
    const cacheLimit = SESSION_MESSAGE_CACHE_LIMIT;
    const sessionIds = Array.from({ length: cacheLimit }, (_, i) => `s-${i + 1}`);
    const sessionMessages: Record<string, UIMessage[]> = {};
    for (const id of sessionIds) {
      sessionMessages[id] = [createMessage(`m-${id}`, `消息 ${id}`) as unknown as UIMessage];
    }
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [
        ...sessionIds.map((id, i) => createSessionMeta(id, cacheLimit - i)),
        createSessionMeta('s-new', 0),
      ],
      activeSessionId: 's-1',
      messages: sessionMessages['s-1']!,
      sessionMessages,
      sessionConversationStats: Object.fromEntries(
        [...sessionIds, 's-new'].map((id) => [id, createEmptyConversation()])
      ),
      // s-1 most recently used … s-5 least recently used
      _sessionLru: [...sessionIds],
    }));
    loadSessionMessagesMock.mockResolvedValue([createMessage('m-new', '新会话的消息')]);

    useAgentStore.getState().selectSession('s-new');
    await waitForCondition(() => !useAgentStore.getState().sessionMessagesLoading);

    const state = useAgentStore.getState();
    const resident = Object.keys(state.sessionMessages);
    expect(resident).toHaveLength(cacheLimit);
    expect(resident).toContain('s-new');
    // LRU tail (s-5) got evicted; the more recently used sessions stay resident
    expect(resident).not.toContain(`s-${cacheLimit}`);
    expect(resident).toContain('s-1');
    // Evicted data is still reloadable from storage
    expect(state._sessionLru[0]).toBe('s-new');
  });

  it('does not apply on-demand load results after the user switched away', async () => {
    const deferred: { resolve: ((messages: ProjectMessage[]) => void) | null } = { resolve: null };
    loadSessionMessagesMock.mockImplementation(
      (_workspace: string, sessionId: string) => {
        if (sessionId === 's-slow') {
          return new Promise<ProjectMessage[]>((resolve) => { deferred.resolve = resolve; });
        }
        return Promise.resolve([createMessage('m-fast', '快速会话')]);
      }
    );
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [createSessionMeta('s-slow', 2), createSessionMeta('s-fast', 1)],
      activeSessionId: null,
      sessionMessages: {},
      sessionConversationStats: {
        's-slow': createEmptyConversation(),
        's-fast': createEmptyConversation(),
      },
      _sessionLru: ['s-slow', 's-fast'],
    }));

    useAgentStore.getState().selectSession('s-slow');
    expect(useAgentStore.getState().sessionMessagesLoading).toBe(true);
    // Switch away before the slow load resolves
    useAgentStore.getState().selectSession('s-fast');
    await waitForCondition(() => useAgentStore.getState().messages.length === 1);
    expect(useAgentStore.getState().messages.map((m) => m.content)).toEqual(['快速会话']);

    deferred.resolve?.([createMessage('m-slow', '迟到的消息')]);
    await waitForMacrotask();

    const state = useAgentStore.getState();
    expect(state.activeSessionId).toBe('s-fast');
    expect(state.messages.map((m) => m.content)).toEqual(['快速会话']);
    expect(state.sessionMessages['s-slow']).toBeUndefined();
  });

  it('deleteSession removes the session from the LRU order', () => {
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [createSessionMeta('s-1', 2), createSessionMeta('s-2', 1)],
      activeSessionId: 's-1',
      sessionMessages: { 's-1': [], 's-2': [] },
      sessionConversationStats: {
        's-1': createEmptyConversation(),
        's-2': createEmptyConversation(),
      },
      _sessionLru: ['s-1', 's-2'],
    }));

    useAgentStore.getState().deleteSession('s-2');

    expect(useAgentStore.getState()._sessionLru).toEqual(['s-1']);
    expect(useAgentStore.getState().sessionMessages['s-2']).toBeUndefined();
  });
});

describe('per-session execution and input state', () => {
  function setTwoSessionState(extra: Partial<ReturnType<typeof useAgentStore.getState>> = {}) {
    useAgentStore.setState((state) => ({
      ...state,
      workspacePath: '/tmp/codepapr-align',
      sessions: [
        { id: 's-a', name: 'A', provider: 'deepseek' as const, model: 'deepseek-v4-pro', createdAt: 2, updatedAt: 2 },
        { id: 's-b', name: 'B', provider: 'deepseek' as const, model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 's-a',
      messages: [],
      sessionMessages: { 's-a': [], 's-b': [] },
      sessionConversationStats: {
        's-a': createEmptyConversation(),
        's-b': createEmptyConversation(),
      },
      conversationStats: createEmptyConversation(),
      isLoading: false,
      loadingSessionId: null,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _agentSessionId: null,
      _sessionInputState: {},
      _sessionLru: ['s-a', 's-b'],
      ...extra,
    }));
  }

  it('selectSession keeps the agent handle while the leaving session is still loading', () => {
    const agent = createMockAgent();
    setTwoSessionState({
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
      _agentModel: 'deepseek-v4-pro',
    });

    useAgentStore.getState().selectSession('s-b');

    const state = useAgentStore.getState();
    expect(state.activeSessionId).toBe('s-b');
    expect(state._agent).toBe(agent);
    expect(state._agentSessionId).toBe('s-a');
    expect(state.isLoading).toBe(true);
    expect(state.loadingSessionId).toBe('s-a');
  });

  it('selectSession 连续切换两次会话不杀死运行中回合（N7）', () => {
    const destroy = vi.fn();
    const agent = createMockAgent({ destroy });
    setTwoSessionState({
      sessions: [
        { id: 's-a', name: 'A', provider: 'deepseek' as const, model: 'deepseek-v4-pro', createdAt: 2, updatedAt: 2 },
        { id: 's-b', name: 'B', provider: 'deepseek' as const, model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
        { id: 's-c', name: 'C', provider: 'deepseek' as const, model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
      _agentModel: 'deepseek-v4-pro',
    });

    // A 运行 → 切 B（保留）
    useAgentStore.getState().selectSession('s-b');
    expect(useAgentStore.getState()._agent).toBe(agent);
    expect(destroy).not.toHaveBeenCalled();

    // B → 切 C：旧实现把「既非当前也非目标」的 A 当无关会话销毁，
    // A 的回合被静默终止——必须继续保留。
    useAgentStore.getState().selectSession('s-c');
    expect(useAgentStore.getState()._agent).toBe(agent);
    expect(useAgentStore.getState()._agentSessionId).toBe('s-a');
    expect(destroy).not.toHaveBeenCalled();
    expect(useAgentStore.getState().isLoading).toBe(true);
    expect(useAgentStore.getState().loadingSessionId).toBe('s-a');
  });

  it('newSession 不静默杀掉运行中回合（N7）', () => {
    const destroy = vi.fn();
    const agent = createMockAgent({ destroy });
    setTwoSessionState({
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
      _agentModel: 'deepseek-v4-pro',
    });

    useAgentStore.getState().newSession();

    const state = useAgentStore.getState();
    expect(state._agent).toBe(agent);
    expect(state._agentSessionId).toBe('s-a');
    expect(state.isLoading).toBe(true);
    expect(state.loadingSessionId).toBe('s-a');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('selectSession drops the agent when idle', () => {
    const agent = createMockAgent();
    setTwoSessionState({ _agent: agent, _agentSessionId: 's-a', _agentModel: 'deepseek-v4-pro' });

    useAgentStore.getState().selectSession('s-b');

    expect(useAgentStore.getState()._agent).toBeNull();
    expect(useAgentStore.getState()._agentSessionId).toBeNull();
  });

  it('cancelMessage finalizes the loading session even if it is not the active one', () => {
    const cancelSession = vi.fn();
    const destroy = vi.fn();
    const agent = createMockAgent({ cancel: cancelSession, cancelSession, destroy });
    setTwoSessionState({
      activeSessionId: 's-b',
      messages: [{ id: 'b-msg', role: 'user', content: 'B 的消息', timestamp: 1 }],
      sessionMessages: {
        's-a': [{ id: 'a-stream', role: 'assistant', content: '流式中', timestamp: 1, isStreaming: true }],
        's-b': [{ id: 'b-msg', role: 'user', content: 'B 的消息', timestamp: 1 }],
      },
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
    });

    useAgentStore.getState().cancelMessage();

    const state = useAgentStore.getState();
    // 停止按钮走 cancelSession（不连带取消 app-agent）
    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(state.isLoading).toBe(false);
    expect(state.loadingSessionId).toBeNull();
    expect(state.sessionMessages['s-a']?.[0]?.isStreaming).toBe(false);
    // 当前查看会话（s-b）的消息镜像不受影响
    expect(state.messages.map((m) => m.id)).toEqual(['b-msg']);
    // N3 回归：取消的回合不会进入 agent 的 logStore，必须同步失效 agent，
    // 下一条消息按 sessionMessages 全量重建，否则模型上下文缺被取消回合。
    expect(state._agent).toBeNull();
    expect(state._agentSessionId).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('cancelMessage aborts an active goal loop (N5)', () => {
    const cancelSession = vi.fn();
    const agent = createMockAgent({ cancelSession });
    setTwoSessionState({
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
    });
    useGoalStore.getState().setGoalActive(parseGoalCondition('exec:npm test'), '跑通测试');

    useAgentStore.getState().cancelMessage();

    // N5：goal 验证阶段没有在飞 agent 请求（120s 命令 + verifier），
    // 停止按钮必须设置 aborted 标志让 GoalRunner 在验证步骤之间感知中断。
    expect(useGoalStore.getState().isAborted()).toBe(true);

    useGoalStore.getState().clearGoal();
  });

  it('deleteSession cancels a running session and clears its loading/input state', () => {
    const cancel = vi.fn();
    // 真实 WorkerBackedAgent.destroy() 内部先调 cancel() 再回收 worker；
    // deleteSession 现在走 destroy()（只 cancel 会泄漏 worker）。
    const destroy = vi.fn(() => cancel());
    const agent = createMockAgent({ cancel, destroy });
    setTwoSessionState({
      isLoading: true,
      loadingSessionId: 's-a',
      _agent: agent,
      _agentSessionId: 's-a',
      _sessionInputState: {
        's-a': { mode: 'ask', draft: '草稿 A', images: [], files: [] },
        's-b': { mode: 'agent', draft: '草稿 B', images: [], files: [] },
      },
    });

    useAgentStore.getState().deleteSession('s-a');

    const state = useAgentStore.getState();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.isLoading).toBe(false);
    expect(state.loadingSessionId).toBeNull();
    expect(state._agent).toBeNull();
    expect(state._agentSessionId).toBeNull();
    expect(state._sessionInputState['s-a']).toBeUndefined();
    expect(state._sessionInputState['s-b']?.draft).toBe('草稿 B');
  });

  it('setSessionInputState stores input state per session', () => {
    setTwoSessionState();

    useAgentStore.getState().setSessionInputState('s-a', { mode: 'plan', draft: '计划', images: [], files: [] });
    useAgentStore.getState().setSessionInputState('s-b', { mode: 'ask', draft: '问题', images: [], files: [] });

    const state = useAgentStore.getState();
    expect(state._sessionInputState['s-a']).toEqual({ mode: 'plan', draft: '计划', images: [], files: [] });
    expect(state._sessionInputState['s-b']).toEqual({ mode: 'ask', draft: '问题', images: [], files: [] });
  });
});

describe('useAgentStore.ensureAgentForApp', () => {
  beforeEach(() => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({
        apiKey: 'sk-test',
        fastModelEnabled: false,
      }),
      workspacePath: '/tmp/codepapr-test',
      sessions: [
        {
          id: 'session-1',
          name: '任务 1',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: {
        'session-1': [],
      },
      settingsLoaded: true,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _agentSessionId: null,
    }));
  });

  afterEach(() => {
    createAgentMock.mockImplementation((...args: never[]) =>
      actualCreateAgentRef.current!.createAgent(...args)
    );
    createAgentMock.mockClear();
    invokeMock.mockClear();
  });

  it('creates an agent on demand when no chat agent exists', async () => {
    const mockAgent = createMockAgent();
    createAgentMock.mockReturnValue(mockAgent);

    const agent = await useAgentStore.getState().ensureAgentForApp();

    expect(agent).toBe(mockAgent);
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock.mock.calls[0]?.[5]).toMatchObject({ mode: 'app' });
    const state = useAgentStore.getState();
    expect(state._agent).toBe(mockAgent);
    // 空上下文宿主 Agent：不绑定模型/提示词/会话，下一条聊天消息总是重建。
    expect(state._agentModel).toBeNull();
    expect(state._agentPromptKey).toBeNull();
    expect(state._agentSessionId).toBeNull();
  });

  it('reuses the existing chat agent when it is healthy', async () => {
    const existing = createMockAgent();
    useAgentStore.setState({ _agent: existing });
    createAgentMock.mockReturnValue(createMockAgent());

    const agent = await useAgentStore.getState().ensureAgentForApp();

    expect(agent).toBe(existing);
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('destroys and rebuilds a crashed agent', async () => {
    const destroySpy = vi.fn();
    const crashed = createMockAgent({ isCrashed: true, destroy: destroySpy });
    const fresh = createMockAgent();
    useAgentStore.setState({ _agent: crashed });
    createAgentMock.mockReturnValue(fresh);

    const agent = await useAgentStore.getState().ensureAgentForApp();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(agent).toBe(fresh);
    expect(useAgentStore.getState()._agent).toBe(fresh);
  });

  it('rejects with a settings error when the API key is missing', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ apiKey: '' }),
    }));
    createAgentMock.mockReturnValue(createMockAgent());

    await expect(useAgentStore.getState().ensureAgentForApp()).rejects.toThrow(/API Key/);
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState()._agent).toBeNull();
  });

  it('dedupes concurrent calls into a single agent creation', async () => {
    const mockAgent = createMockAgent();
    createAgentMock.mockReturnValue(mockAgent);

    const [first, second] = await Promise.all([
      useAgentStore.getState().ensureAgentForApp(),
      useAgentStore.getState().ensureAgentForApp(),
    ]);

    expect(first).toBe(mockAgent);
    expect(second).toBe(mockAgent);
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('creates a session when none is active', async () => {
    useAgentStore.setState({
      sessions: [],
      activeSessionId: null,
      sessionMessages: {},
    });
    const mockAgent = createMockAgent();
    createAgentMock.mockReturnValue(mockAgent);

    await useAgentStore.getState().ensureAgentForApp();

    const state = useAgentStore.getState();
    expect(state.sessions.length).toBe(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      state.activeSessionId,
      '/tmp/codepapr-test',
      [],
      expect.anything(),
      expect.anything(),
    );
  });
});
