import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMessage, ProjectStateSnapshot } from '../utils/projectStorage';
import { saveAppSettings } from '../utils/appSettingsStorage';
import { saveProjectState } from '../utils/projectStorage';
import { normalizeSettings, useAgentStore } from './agentStore';

const WORKSPACE_PATH = '/tmp/codepapr-restore-e2e';

interface DeferredWrite {
  workspacePath: string;
  stateJson: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<
    (command: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | void>
  >(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function createEmptyStats() {
  return {
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInput: 0,
    totalOutput: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    rounds: 0,
  };
}

function buildSnapshot(messageContents: string[]): ProjectStateSnapshot {
  return {
    version: 1,
    sessions: [
      {
        id: 'session-restored',
        name: '恢复会话',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        createdAt: 1,
      },
    ],
    activeSessionId: 'session-restored',
    sessionMessages: {
      'session-restored': messageContents.map((content, index): ProjectMessage => {
        const role: ProjectMessage['role'] = index % 2 === 0 ? 'user' : 'assistant';

        return {
          id: `message-${index + 1}`,
          role,
          content,
          timestamp: index + 1,
        };
      }),
    },
    cumulativeStats: createEmptyStats(),
    sessionCumulativeStats: {
      'session-restored': createEmptyStats(),
    },
    projectDiagnosticsReport: null,
    updatedAt: 1,
  };
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe('desktop restore e2e', () => {
  let storedProjectStateJsonByWorkspace: Map<string, string>;
  let storedSettingsJson: string | null;
  let deferredStateWrites: DeferredWrite[];
  let deferStateWrites: boolean;

  beforeEach(() => {
    storedProjectStateJsonByWorkspace = new Map([
      [WORKSPACE_PATH, JSON.stringify(buildSnapshot([]), null, 2)],
    ]);
    storedSettingsJson = null;
    deferredStateWrites = [];
    deferStateWrites = false;

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false }),
      workspacePath: '',
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      cumulativeStats: createEmptyStats(),
      sessionCumulativeStats: {},
      projectDiagnosticsReport: null,
      isLoading: false,
      showSettings: false,
      settingsLoaded: false,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _projectRulesSection: '',
      _agentDefinitions: [],
    }));

    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      if (command === 'load_app_settings') {
        return {
          settingsJson: storedSettingsJson,
          dbPath: '/tmp/codepapr.sqlite',
        };
      }

      if (command === 'save_app_settings') {
        storedSettingsJson = String(payload?.settingsJson ?? 'null');
        return {
          settingsJson: storedSettingsJson,
          dbPath: '/tmp/codepapr.sqlite',
        };
      }

      if (command === 'note_recent_workspace') {
        const workspacePath = String(payload?.path ?? '');
        const current = storedSettingsJson ? JSON.parse(storedSettingsJson) : {};
        const recent = Array.isArray(current.recentWorkspaces)
          ? current.recentWorkspaces.filter(
              (entry: { path: string }) => entry.path !== workspacePath
            )
          : [];
        recent.unshift({
          path: workspacePath,
          name: workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath,
          lastOpenedAt: Date.now(),
          pinned: false,
        });
        current.recentWorkspaces = recent.slice(0, 10);
        storedSettingsJson = JSON.stringify(current);
        return {
          settingsJson: storedSettingsJson,
          dbPath: '/tmp/codepapr.sqlite',
        };
      }

      if (command === 'load_project_state') {
        const workspacePath = String(payload?.workspacePath ?? '');
        return {
          stateJson: storedProjectStateJsonByWorkspace.get(workspacePath) ?? null,
          dbPath: `${workspacePath}/.CodePapr/project.sqlite`,
        };
      }

      if (command === 'save_project_state') {
        const workspacePath = String(payload?.workspacePath ?? '');
        const stateJson = String(payload?.stateJson ?? '');

        if (deferStateWrites) {
          return await new Promise<void>((resolve, reject) => {
            deferredStateWrites.push({
              workspacePath,
              stateJson,
              resolve: () => {
                storedProjectStateJsonByWorkspace.set(workspacePath, stateJson);
                resolve();
              },
              reject,
            });
          });
        }

        storedProjectStateJsonByWorkspace.set(workspacePath, stateJson);
        return;
      }

      if (command === 'list_workspace_files') {
        return {
          root: String(payload?.workspacePath ?? ''),
          entries: [],
          truncated: false,
        };
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the newest chat history on startup even when the latest save is still pending', async () => {
    deferStateWrites = true;

    const firstSave = saveProjectState(WORKSPACE_PATH, buildSnapshot(['较早消息']));
    const secondSave = saveProjectState(WORKSPACE_PATH, buildSnapshot(['较早消息', '最终保留的最新消息']));

    await flushMicrotasks();
    expect(deferredStateWrites).toHaveLength(1);

    deferredStateWrites[0]!.resolve();
    await flushMicrotasks();
    expect(deferredStateWrites).toHaveLength(2);

    await saveAppSettings(
      normalizeSettings({
        apiKey: 'sk-restored',
        recentWorkspaces: [{ path: WORKSPACE_PATH, name: 'test-workspace', lastOpenedAt: Date.now(), pinned: false }],
        fastModelEnabled: false,
      })
    );

    let loadResolved = false;
    const loadPromise = useAgentStore.getState().loadSettings().then(() => {
      loadResolved = true;
    });

    await flushMicrotasks();
    expect(loadResolved).toBe(false);

    deferredStateWrites[1]!.resolve();
    deferStateWrites = false;
    await Promise.all([firstSave, secondSave, loadPromise]);

    const state = useAgentStore.getState();
    expect(state.settingsLoaded).toBe(true);
    expect(state.workspacePath).toBe(WORKSPACE_PATH);
    expect(state.activeSessionId).toBe('session-restored');
    expect(state.sessions.map((session) => session.id)).toEqual(['session-restored']);
    expect(state.messages.map((message) => message.content)).toEqual([
      '较早消息',
      '最终保留的最新消息',
    ]);
    expect((state.sessionMessages['session-restored'] ?? []).map((message) => message.content)).toEqual([
      '较早消息',
      '最终保留的最新消息',
    ]);
    expect(state.settings.recentWorkspaces[0]?.path).toBe(WORKSPACE_PATH);
  });
});
