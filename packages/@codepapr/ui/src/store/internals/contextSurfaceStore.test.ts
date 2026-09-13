import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedContextSurface } from '../../utils/projectStorage';
import type { ContextMessageLike } from '../../utils/contextCompaction';

vi.mock('../../utils/projectStorage', () => ({
  loadContextSurface: vi.fn(),
  saveContextSurface: vi.fn(async () => undefined),
  commitContextCompaction: vi.fn(),
  markContextCompactionFailed: vi.fn(async () => undefined),
  discardContextSurfacesFromGeneration: vi.fn(async () => undefined),
}));

import {
  commitContextCompaction,
  discardContextSurfacesFromGeneration,
  loadContextSurface,
  markContextCompactionFailed,
  saveContextSurface,
} from '../../utils/projectStorage';
import {
  clearCompactionInFlight,
  commitContextCheckpoint,
  failContextCheckpoint,
  getContextSurfaceCached,
  hydrateSessionContext,
  maintainContextSurface,
  markCompactionInFlight,
  verifyCompactionLanded,
} from './contextSurfaceStore';

function user(id: string): ContextMessageLike {
  return { id, role: 'user', content: 'hi', timestamp: 1 };
}

function assistant(id: string): ContextMessageLike {
  return { id, role: 'assistant', content: 'ok', timestamp: 2 };
}

function checkpoint(id: string, payload: Record<string, unknown>): ContextMessageLike {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 3,
    synthetic: true,
    hidden: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextCheckpoint: payload as any,
  };
}

function surface(overrides: Partial<PersistedContextSurface> = {}): PersistedContextSurface {
  return {
    sessionId: 's1',
    generation: 1,
    parentGeneration: 0,
    compactionId: 'comp-1',
    renderParamsJson: JSON.stringify({ pruneParams: { enabled: false }, renderVersion: 1 }),
    createdAt: 1000,
    nodes: [
      { position: 0, messageId: 'cp-old', nodeKind: 'checkpoint' },
      { position: 1, messageId: 'u1', nodeKind: 'conversation' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 缓存是模块级状态：每个用例用独立 session 隔离（含一个一次性 session
  // 无法重置缓存时，用例之间不共享 session id）。
});

let sessionSeq = 0;
function freshSession(): string {
  sessionSeq += 1;
  return `session-${sessionSeq}`;
}

describe('getContextSurfaceCached', () => {
  it('does not cache transient load errors (no null poisoning)', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockRejectedValueOnce(new Error('IPC hiccup'));
    await expect(getContextSurfaceCached('/ws', sid)).rejects.toThrow('IPC hiccup');

    // 第二次调用必须重新加载而不是返回被缓存的 null。
    vi.mocked(loadContextSurface).mockResolvedValueOnce(surface({ sessionId: sid }));
    const loaded = await getContextSurfaceCached('/ws', sid);
    expect(loaded?.generation).toBe(1);
    expect(loadContextSurface).toHaveBeenCalledTimes(2);
  });

  it('caches a successful null (verified absence) without reloading', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValueOnce(null);
    expect(await getContextSurfaceCached('/ws', sid)).toBeNull();
    expect(await getContextSurfaceCached('/ws', sid)).toBeNull();
    expect(loadContextSurface).toHaveBeenCalledTimes(1);
  });
});

describe('maintainContextSurface', () => {
  it('skips writing while a compaction is in flight (even without generation)', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid }));
    markCompactionInFlight('comp-inflight');
    try {
      await maintainContextSurface('/ws', sid, [
        checkpoint('cp-new', { compactionId: 'comp-inflight', version: 3 }),
        user('u2'),
      ]);
      expect(saveContextSurface).not.toHaveBeenCalled();
    } finally {
      clearCompactionInFlight('comp-inflight');
    }
  });

  it('refreshes the in-memory cache so a later hydrate sees the latest nodes', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(null);
    await maintainContextSurface('/ws', sid, [user('u1')]);
    // 第二次维护时缓存还是创建时冻结的 [u1]：更新分支必须把落库后的节点
    // 同步回缓存，否则取消回合后的重建（hydrate 以缓存为权威）会拿到旧
    // 节点子集，静默截掉被取消回合（UI 显示、模型上下文没有）。
    await maintainContextSurface('/ws', sid, [user('u1'), assistant('a1')]);

    const result = await hydrateSessionContext('/ws', sid, [user('u1'), assistant('a1')]);
    expect(result.degraded).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('excludes a mid-loop orphan whose generation is still undefined', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid, generation: 2 }));
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp-old', { compactionId: 'comp-1', generation: 2 }),
      user('u1'),
      assistant('a1'),
      checkpoint('cp-orphan', { compactionId: 'comp-midloop', version: 3 }),
      user('u2'),
    ]);

    expect(saveContextSurface).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    const nodeIds = saved?.nodes.map((n) => n.messageId) ?? [];
    expect(nodeIds).not.toContain('cp-orphan');
    expect(nodeIds[0]).toBe('cp-old');
  });

  it('excludes a stale (failed/orphan) checkpoint from the projection instead of freezing', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid, generation: 2 }));
    // generation 3 ≠ surface.generation 2 且不在途 → 失败残留/崩溃孤儿。
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp-old', { compactionId: 'comp-1', generation: 2 }),
      user('u1'),
      assistant('a1'),
      checkpoint('cp-orphan', { compactionId: 'comp-orphan', generation: 3 }),
      user('u2'),
      assistant('a2'),
    ]);

    expect(saveContextSurface).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    const nodeIds = saved?.nodes.map((n) => n.messageId) ?? [];
    // 孤儿 checkpoint 不得进入节点；投影锚定上一个 checkpoint。
    expect(nodeIds).not.toContain('cp-orphan');
    expect(nodeIds[0]).toBe('cp-old');
    expect(nodeIds).toContain('u2');
    expect(nodeIds).toContain('a2');
  });

  it('keeps maintaining normally when checkpoint generation matches the surface', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid, generation: 2 }));
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp-old', { compactionId: 'comp-1', generation: 2 }),
      user('u1'),
      assistant('a1'),
    ]);
    expect(saveContextSurface).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    expect(saved?.nodes.map((n) => n.messageId)).toEqual(['cp-old', 'u1', 'a1']);
  });

  it('v4：任何 surface 创建都写禁用 render 参数常量', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(null);
    await maintainContextSurface('/ws', sid, [user('u1'), assistant('a1')]);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    expect(JSON.parse(saved?.renderParamsJson ?? '{}').pruneParams.enabled).toBe(false);
  });

  it('v4：已压缩 legacy 会话不再被跳过建面（prune 参数语义已删除）', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(null);
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp1', { compactionId: 'c1', generation: 1 }),
      user('u1'),
    ]);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    expect(saved).toBeDefined();
    const params = JSON.parse(saved?.renderParamsJson ?? '{}');
    expect(params.pruneParams.enabled).toBe(false);
    expect(params.renderVersion).toBeGreaterThan(0);
  });
});

describe('commitContextCheckpoint', () => {
  it('propagates surface load errors instead of committing from an unknown generation', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockRejectedValue(new Error('db busy'));
    await expect(
      commitContextCheckpoint({
        workspacePath: '/ws',
        sessionId: sid,
        messages: [checkpoint('cp-new', { compactionId: 'comp-x' }), user('u1')],
        trigger: 'token-limit',
      })
    ).rejects.toThrow('db busy');
    expect(commitContextCompaction).not.toHaveBeenCalled();
  });

  it('clears the in-flight registration after the transaction settles', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid }));
    vi.mocked(commitContextCompaction).mockResolvedValue({ compactionId: 'comp-x', generation: 2 });
    await commitContextCheckpoint({
      workspacePath: '/ws',
      sessionId: sid,
      messages: [checkpoint('cp-new', { compactionId: 'comp-x' }), user('u1')],
      trigger: 'token-limit',
    });

    // 提交成功后维护必须恢复：compactionId 不再在途，同 generation 正常写。
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp-new', { compactionId: 'comp-x', generation: 2 }),
      user('u1'),
    ]);
    expect(saveContextSurface).toHaveBeenCalled();
  });
});

describe('verifyCompactionLanded', () => {
  it('returns true and refreshes the cache when the compaction row is active', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(
      surface({ sessionId: sid, compactionId: 'comp-landed', generation: 4 })
    );
    expect(await verifyCompactionLanded('/ws', sid, 'comp-landed')).toBe(true);

    // 缓存已刷新：后续维护读到新 generation（不再走加载）。
    await maintainContextSurface('/ws', sid, [
      checkpoint('cp-new', { compactionId: 'comp-landed', generation: 4 }),
      user('u1'),
    ]);
    expect(loadContextSurface).toHaveBeenCalledTimes(1);
  });

  it('returns false when the active surface belongs to another compaction', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(surface({ sessionId: sid, compactionId: 'comp-other' }));
    expect(await verifyCompactionLanded('/ws', sid, 'comp-missing')).toBe(false);
  });

  it('returns false when the surface cannot be loaded', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockRejectedValue(new Error('io'));
    expect(await verifyCompactionLanded('/ws', sid, 'comp-x')).toBe(false);
  });
});

describe('failContextCheckpoint', () => {
  it('records the failed row even when the surface load fails', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockRejectedValue(new Error('io'));
    await failContextCheckpoint({
      workspacePath: '/ws',
      sessionId: sid,
      payload: { compactionId: 'comp-f', generatedAt: 123, trigger: 'token-limit' } as never,
      trigger: 'token-limit',
      failureCode: 'commit_failed',
      failureMessage: 'boom',
    });
    expect(markContextCompactionFailed).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(markContextCompactionFailed).mock.calls[0]?.[1];
    expect(arg?.id).toBe('comp-f');
    expect(arg?.sourceGeneration).toBe(0);
  });
});

describe('hydrateSessionContext', () => {
  it('falls back to parent generation and discards the degraded latest', async () => {
    const sid = freshSession();
    const parent = surface({
      sessionId: sid,
      generation: 1,
      parentGeneration: 0,
      compactionId: 'comp-parent',
      nodes: [
        { position: 0, messageId: 'cp-old', nodeKind: 'checkpoint' },
        { position: 1, messageId: 'u1', nodeKind: 'conversation' },
      ],
    });
    const latest = surface({
      sessionId: sid,
      generation: 2,
      parentGeneration: 1,
      compactionId: 'comp-broken',
      nodes: [
        { position: 0, messageId: 'cp-missing', nodeKind: 'checkpoint' },
        { position: 1, messageId: 'u1', nodeKind: 'conversation' },
      ],
    });
    vi.mocked(loadContextSurface)
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(parent);

    const result = await hydrateSessionContext(
      '/ws',
      sid,
      [checkpoint('cp-old', { compactionId: 'comp-parent', generation: 1 }), user('u1')]
    );

    expect(result.degraded).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(['cp-old', 'u1']);
    expect(discardContextSurfacesFromGeneration).toHaveBeenCalledWith('/ws', sid, 2);
  });

  it('rebuilds generation 0 from archive when parent hydrate also fails', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(
      surface({
        sessionId: sid,
        generation: 1,
        parentGeneration: null,
        nodes: [{ position: 0, messageId: 'missing-cp', nodeKind: 'checkpoint' }],
      })
    );

    const archive = [user('u1'), assistant('a1')];
    const result = await hydrateSessionContext('/ws', sid, archive);

    expect(result.degraded).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(discardContextSurfacesFromGeneration).toHaveBeenCalledWith('/ws', sid, 0);
    expect(saveContextSurface).toHaveBeenCalled();
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    expect(saved?.generation).toBe(0);
    expect(saved?.compactionId).toBeNull();
  });

  it('v4：render params 不再被解析——畸形 JSON 也不影响水合', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(
      surface({
        sessionId: sid,
        renderParamsJson: 'not-json',
        nodes: [{ position: 0, messageId: 'u1', nodeKind: 'conversation' }],
      })
    );
    const result = await hydrateSessionContext('/ws', sid, [user('u1')]);
    expect(result.degraded).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('v4：压缩归档重建 generation 0 也写禁用 render 参数', async () => {
    const sid = freshSession();
    vi.mocked(loadContextSurface).mockResolvedValue(
      surface({
        sessionId: sid,
        generation: 1,
        parentGeneration: null,
        nodes: [{ position: 0, messageId: 'missing-cp', nodeKind: 'checkpoint' }],
      })
    );
    const archive = [
      checkpoint('cp-old', { compactionId: 'comp-parent', generation: 1 }),
      user('u1'),
    ];
    const result = await hydrateSessionContext('/ws', sid, archive);
    expect(result.degraded).toBe(true);
    const saved = vi.mocked(saveContextSurface).mock.calls[0]?.[1];
    expect(JSON.parse(saved?.renderParamsJson ?? '{}').pruneParams.enabled).toBe(false);
  });
});
