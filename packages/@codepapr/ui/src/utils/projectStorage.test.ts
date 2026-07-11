import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMessage, ProjectStateSnapshot } from './projectStorage';

interface DeferredWrite {
  workspacePath: string;
  stateJson: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<
    (command: string, payload?: Record<string, unknown>) => Promise<{ stateJson: string | null; dbPath: string } | void>
  >(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function buildSnapshot(messageContents: string[]): ProjectStateSnapshot {
  return {
    version: 1 as const,
    sessions: [
      {
        id: 'session-1',
        name: '恢复会话',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        createdAt: 1,
      },
    ],
    activeSessionId: 'session-1',
    sessionMessages: {
      'session-1': messageContents.map((content, index): ProjectMessage => {
        const role: ProjectMessage['role'] = index % 2 === 0 ? 'user' : 'assistant';

        return {
          id: `message-${index + 1}`,
          role,
          content,
          timestamp: index + 1,
        };
      }),
    },
    cumulativeStats: {
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      rounds: 0,
    },
    sessionCumulativeStats: {
      'session-1': {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        rounds: 0,
      },
    },
    projectDiagnosticsReport: null,
    updatedAt: 1,
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe('projectStorage', () => {
  let storedStateJsonByWorkspace: Map<string, string>;
  let deferredStateWrites: DeferredWrite[];
  let deferStateWrites: boolean;

  beforeEach(() => {
    vi.resetModules();
    storedStateJsonByWorkspace = new Map([
      ['/tmp/codepapr-test', JSON.stringify(buildSnapshot([]), null, 2)],
    ]);
    deferredStateWrites = [];
    deferStateWrites = false;

    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      if (command === 'load_project_state') {
        const workspacePath = String(payload?.workspacePath ?? '');
        return {
          stateJson: storedStateJsonByWorkspace.get(workspacePath) ?? null,
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
                storedStateJsonByWorkspace.set(workspacePath, stateJson);
                resolve();
              },
              reject,
            });
          });
        }

        storedStateJsonByWorkspace.set(workspacePath, stateJson);
        return;
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });
  });

  it('serializes overlapping saves so the newest chat history wins', async () => {
    const { saveProjectState } = await import('./projectStorage');
    deferStateWrites = true;

    const firstSave = saveProjectState('/tmp/codepapr-test', buildSnapshot(['较早消息']));
    const secondSave = saveProjectState('/tmp/codepapr-test', buildSnapshot(['较早消息', '较新消息']));

    await flushMicrotasks();
    expect(deferredStateWrites).toHaveLength(1);
  expect(JSON.parse(deferredStateWrites[0]!.stateJson).sessionMessages['session-1']).toHaveLength(1);

    deferredStateWrites[0]!.resolve();
    await flushMicrotasks();

    expect(deferredStateWrites).toHaveLength(2);
  expect(JSON.parse(deferredStateWrites[1]!.stateJson).sessionMessages['session-1']).toHaveLength(2);

    deferredStateWrites[1]!.resolve();
    await Promise.all([firstSave, secondSave]);

  const finalState = JSON.parse(storedStateJsonByWorkspace.get('/tmp/codepapr-test') ?? '{}');
    expect(finalState.sessionMessages['session-1']).toHaveLength(2);
    expect(finalState.sessionMessages['session-1'][1].content).toBe('较新消息');
  });

  it('waits for an in-flight save before loading chat history', async () => {
    const { loadProjectState, saveProjectState } = await import('./projectStorage');
    deferStateWrites = true;

    const savePromise = saveProjectState('/tmp/codepapr-test', buildSnapshot(['最新历史']));
    await flushMicrotasks();
    expect(deferredStateWrites).toHaveLength(1);

    let resolved = false;
    const loadPromise = loadProjectState('/tmp/codepapr-test').then((snapshot) => {
      resolved = true;
      return snapshot;
    });

    await flushMicrotasks();
    expect(resolved).toBe(false);

    deferredStateWrites[0]!.resolve();
    await savePromise;

    const loaded = await loadPromise;
    expect(loaded.sessionMessages['session-1'][0].content).toBe('最新历史');
  });

  it('continues saving newer snapshots after an earlier write fails', async () => {
    const { saveProjectState } = await import('./projectStorage');
    deferStateWrites = true;

    const firstSave = saveProjectState('/tmp/codepapr-test', buildSnapshot(['旧历史']));
    const firstSaveFailure = expect(firstSave).rejects.toThrow('disk full');
    const secondSave = saveProjectState('/tmp/codepapr-test', buildSnapshot(['旧历史', '恢复后的新历史']));

    await flushMicrotasks();
    expect(deferredStateWrites).toHaveLength(1);
    deferredStateWrites[0]!.reject(new Error('disk full'));
    await flushMicrotasks();

    expect(deferredStateWrites).toHaveLength(2);
    deferredStateWrites[1]!.resolve();

    await firstSaveFailure;
    await expect(secondSave).resolves.toBeUndefined();

    const finalState = JSON.parse(storedStateJsonByWorkspace.get('/tmp/codepapr-test') ?? '{}');
    expect(finalState.sessionMessages['session-1']).toHaveLength(2);
    expect(finalState.sessionMessages['session-1'][1].content).toBe('恢复后的新历史');
  });

  it('persists skill enablement inside the project sqlite snapshot payload', async () => {
    const { loadProjectState, saveProjectState } = await import('./projectStorage');

    await saveProjectState('/tmp/codepapr-test', {
      ...buildSnapshot([]),
      skillEnabledById: {
        search: false,
      },
    });

    const loaded = await loadProjectState('/tmp/codepapr-test');
    expect(loaded.skillEnabledById).toEqual({ search: false });
  });
});
