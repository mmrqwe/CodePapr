import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentState } from './types';

vi.mock('../../utils/projectStorage', () => ({
  saveProjectStateDirect: vi.fn(async () => {
    throw new Error('RPC error [-32603]: 项目状态内容超过上限 20000000 bytes');
  }),
  saveSession: vi.fn(async () => undefined),
  saveMessageBatch: vi.fn(async () => undefined),
  deleteSessionById: vi.fn(async () => undefined),
  saveProjectMeta: vi.fn(async () => undefined),
  loadSessions: vi.fn(async () => []),
  enqueueProjectStateSave: (_path: string, fn: () => Promise<void>) => fn(),
}));
vi.mock('../toastStore', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('./contextSurfaceStore', () => ({
  maintainContextSurface: vi.fn(async () => undefined),
}));
vi.mock('../../agent/compactionHandler', () => ({
  buildPruneOptions: () => ({}),
}));

import { saveCurrentProjectState } from './projectSnapshot';
import { saveMessageBatch } from '../../utils/projectStorage';
import { toast } from '../toastStore';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const state = {
  workspacePath: '/ws',
  sessions: [{ id: 's1', name: 'n', provider: 'deepseek', model: 'm', createdAt: 1, updatedAt: 1 }],
  activeSessionId: 's1',
  sessionMessages: { s1: [] },
  skillEnabledById: {},
  sessionConversationStats: {},
  projectDiagnosticsReport: null,
  settings: {},
} as unknown as AgentState;

describe('saveCurrentProjectState 兼容快照超限降级', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('超限错误只 toast 一次，重复保存不再刷屏，新格式路径照常落盘', async () => {
    saveCurrentProjectState(state);
    await flush();
    saveCurrentProjectState(state);
    await flush();
    saveCurrentProjectState(state);
    await flush();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('超过上限');
    // 新格式表是 source of truth：兼容写失败不影响消息批写
    expect(saveMessageBatch).toHaveBeenCalledTimes(3);
  });
});
