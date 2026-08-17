import { describe, expect, it } from 'vitest';
import type { PruneOptions } from '@codepapr/core';
import {
  buildDisabledFrozenPruneParams,
  computeCheckpointProvenanceRanges,
  computeSurfaceNodes,
  findCheckpointInsertIndex,
  freezePruneParams,
  getLatestCheckpointPayload,
  hydrateSurfaceMessages,
  isModelVisibleUiMessage,
  parseRenderParams,
  serializeDisabledRenderParams,
  serializeRenderParams,
  validateCompactionCommit,
} from './contextSurface';
import type { ContextCheckpointPayload, ContextMessageLike } from './contextCompaction';

function user(id: string, content = 'hi', extra: Partial<ContextMessageLike> = {}): ContextMessageLike {
  return { id, role: 'user', content, timestamp: 1, ...extra };
}

function assistant(id: string, content = 'ok', extra: Partial<ContextMessageLike> = {}): ContextMessageLike {
  return { id, role: 'assistant', content, timestamp: 2, ...extra };
}

function checkpointPayload(overrides: Partial<ContextCheckpointPayload> = {}): ContextCheckpointPayload {
  return {
    version: 2,
    summary: '摘要',
    renderedContent: '[摘要] 摘要',
    sourceMessageCount: 2,
    sourceChars: 10,
    generatedAt: 1000,
    modelName: 'fast-model',
    modelTier: 'fast',
    ...overrides,
  };
}

function checkpointMessage(id: string, payload: ContextCheckpointPayload): ContextMessageLike {
  return assistant(id, '', { synthetic: true, hidden: true, contextCheckpoint: payload });
}

const testPruneOptions: PruneOptions = {
  enabled: true,
  protectRecentRounds: 2,
  minPrunableChars: 500,
  protectedTools: new Set(['todo', 'question']),
  placeholder: '[cleared]',
};

describe('isModelVisibleUiMessage', () => {
  it('keeps plain user/assistant messages', () => {
    expect(isModelVisibleUiMessage(user('u1'))).toBe(true);
    expect(isModelVisibleUiMessage(assistant('a1'))).toBe(true);
  });

  it('drops synthetic hidden user messages but keeps carryForwardInContext assistants', () => {
    expect(isModelVisibleUiMessage(user('u1', 'x', { synthetic: true, hidden: true }))).toBe(false);
    expect(isModelVisibleUiMessage(assistant('a1', 'x', { synthetic: true, hidden: true }))).toBe(false);
    expect(
      isModelVisibleUiMessage(assistant('a1', 'x', { synthetic: true, carryForwardInContext: true }))
    ).toBe(true);
  });

  it('drops session-bootstrap (not an archive / surface message)', () => {
    expect(isModelVisibleUiMessage(assistant('session-bootstrap', '# 记忆'))).toBe(false);
    expect(isModelVisibleUiMessage(assistant('x', '# 记忆', { sessionBootstrap: true }))).toBe(false);
  });
});

describe('computeSurfaceNodes', () => {
  it('returns checkpoint node + retained tail for a compacted session', () => {
    const payload = checkpointPayload();
    const messages = [user('old1'), assistant('old2'), checkpointMessage('cp1', payload), user('u3'), assistant('a4')];
    const nodes = computeSurfaceNodes(messages);
    expect(nodes).toEqual([
      { position: 0, messageId: 'cp1', nodeKind: 'checkpoint' },
      { position: 1, messageId: 'u3', nodeKind: 'conversation' },
      { position: 2, messageId: 'a4', nodeKind: 'conversation' },
    ]);
  });

  it('returns all visible messages for a session without checkpoint (generation 0)', () => {
    const nodes = computeSurfaceNodes([
      user('u1'),
      assistant('a2'),
      user('u3', 'x', { synthetic: true, hidden: true }),
    ]);
    expect(nodes.map((n) => n.messageId)).toEqual(['u1', 'a2']);
  });
});

describe('computeCheckpointProvenanceRanges', () => {
  it('computes source and retained ranges around the insert boundary', () => {
    const payload = checkpointPayload();
    const messages = [
      checkpointMessage('cp1', payload),
      user('s1'),
      assistant('s2'),
      user('r1'),
      assistant('r2'),
    ];
    const ranges = computeCheckpointProvenanceRanges(messages, 3);
    expect(ranges.sourceStartMessageId).toBe('s1');
    expect(ranges.sourceEndMessageId).toBe('s2');
    expect(ranges.retainedTailStartMessageId).toBe('r1');
    expect(ranges.retainedMessageCount).toBe(2);
  });
});

describe('findCheckpointInsertIndex', () => {
  const messages = [user('a'), assistant('b'), user('c'), assistant('d')];

  it('inserts before the first retained message when retained ids resolve', () => {
    expect(findCheckpointInsertIndex(messages, ['a', 'b'], ['c', 'd'])).toBe(2);
  });

  it('falls back to the first retained message when sources are missing', () => {
    expect(findCheckpointInsertIndex(messages, ['x'], ['c', 'd'])).toBe(2);
  });

  it('returns null when neither side matches', () => {
    expect(findCheckpointInsertIndex(messages, ['x'], ['y'])).toBeNull();
  });

  describe('turn anchor (worker-only retained tail)', () => {
    // archive 视图：旧消息 + 本回合 user + UI 流式 assistant 回合；
    // worker-only ID（w-*）不在 archive 里。
    const turnMessages = [
      user('old1'),
      assistant('old2'),
      user('turn-user'),
      assistant('ui-round-1'),
      assistant('ui-round-2'),
      assistant('ui-round-3'),
    ];

    it('maps the boundary by assistant rounds when retained ids are worker-only', () => {
      // source 含 2 个本回合 assistant 回合（worker ID 不在 archive）→
      // 插在第 2 个 UI assistant 之后。
      expect(
        findCheckpointInsertIndex(
          turnMessages,
          ['old1', 'old2', 'turn-user', 'w-a1', 'w-a2'],
          ['w-a3'],
          { userMessageId: 'turn-user', sourceAssistantRoundsInTurn: 2 }
        )
      ).toBe(5);
    });

    it('inserts right after the user message when no turn round is in source', () => {
      // retained 起点是 worker-only 的首个 assistant 回合（user 消息是 source
      // 的最后一条）：rounds=0 → 插在 user 消息之后。
      expect(
        findCheckpointInsertIndex(turnMessages, ['old1', 'old2', 'turn-user'], ['w-a1'], {
          userMessageId: 'turn-user',
          sourceAssistantRoundsInTurn: 0,
        })
      ).toBe(3);
    });

    it('returns null when the archive has fewer turn rounds than claimed (不可信映射)', () => {
      expect(
        findCheckpointInsertIndex(turnMessages, ['turn-user', 'w-a1'], ['w-a2'], {
          userMessageId: 'turn-user',
          sourceAssistantRoundsInTurn: 5,
        })
      ).toBeNull();
    });

    it('returns null when the anchor user message is missing', () => {
      expect(
        findCheckpointInsertIndex(turnMessages, ['x'], ['w-a1'], {
          userMessageId: 'missing-user',
          sourceAssistantRoundsInTurn: 1,
        })
      ).toBeNull();
    });

    it('still prefers an archive-resolvable retained start over round mapping', () => {
      expect(
        findCheckpointInsertIndex(turnMessages, ['old1'], ['old2', 'turn-user'], {
          userMessageId: 'turn-user',
          sourceAssistantRoundsInTurn: 0,
        })
      ).toBe(1);
    });
  });
});

describe('hydrateSurfaceMessages', () => {
  it('filters messages by node ids and reports completeness', () => {
    const messages = [user('a'), assistant('b'), user('c')];
    const hydrated = hydrateSurfaceMessages(messages, ['b', 'c']);
    expect(hydrated.complete).toBe(true);
    expect(hydrated.messages.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('hydrates in nodeIds / position order, not archive array order', () => {
    const messages = [user('a'), assistant('b'), user('c')];
    const hydrated = hydrateSurfaceMessages(messages, ['c', 'b']);
    expect(hydrated.complete).toBe(true);
    expect(hydrated.messages.map((m) => m.id)).toEqual(['c', 'b']);
  });

  it('reports incomplete when a node id is missing', () => {
    const hydrated = hydrateSurfaceMessages([user('a')], ['a', 'z']);
    expect(hydrated.complete).toBe(false);
    expect(hydrated.messages.map((m) => m.id)).toEqual(['a']);
  });
});

describe('render params freeze', () => {
  it('serializes prune options with Set → string[] and a stable render version', () => {
    const frozen = freezePruneParams(testPruneOptions);
    expect(frozen.protectedTools).toEqual(['todo', 'question']);
    expect(frozen.enabled).toBe(true);
    const json = serializeRenderParams(testPruneOptions);
    const parsed = JSON.parse(json);
    expect(parsed.renderVersion).toBe(1);
    expect(parsed.pruneParams.placeholder).toBe('[cleared]');
  });

  it('generation 0 freezes disabled params so restart rebuild does not prune', () => {
    const disabled = buildDisabledFrozenPruneParams();
    expect(disabled.enabled).toBe(false);
    const json = serializeDisabledRenderParams();
    expect(JSON.parse(json).pruneParams.enabled).toBe(false);
  });

  it('parseRenderParams round-trips freezePruneParams (string[] → Set)', () => {
    const parsed = parseRenderParams(serializeRenderParams(testPruneOptions));
    expect(parsed).not.toBeNull();
    expect(parsed!.pruneOptions.enabled).toBe(true);
    expect(parsed!.pruneOptions.protectRecentRounds).toBe(2);
    expect([...parsed!.pruneOptions.protectedTools]).toEqual(['todo', 'question']);
  });

  it('parseRenderParams returns null on malformed input', () => {
    expect(parseRenderParams('not json')).toBeNull();
    expect(parseRenderParams('{}')).toBeNull();
    expect(parseRenderParams('{"pruneParams":{"enabled":"yes"}}')).not.toBeNull();
  });
});

describe('getLatestCheckpointPayload', () => {
  it('returns the latest checkpoint payload or null', () => {
    const payload = checkpointPayload();
    expect(getLatestCheckpointPayload([checkpointMessage('cp1', payload)])).toEqual(payload);
    expect(getLatestCheckpointPayload([user('u1')])).toBeNull();
  });
});

describe('validateCompactionCommit', () => {
  it('rejects missing compactionId', () => {
    expect(validateCompactionCommit(checkpointPayload()).ok).toBe(false);
  });

  it('rejects when token stats do not shrink', () => {
    const result = validateCompactionCommit(
      checkpointPayload({
        compactionId: 'c1',
        sourceMessageCount: 4,
        tokenStats: {
          estimatedTokensBefore: 100,
          estimatedTokensAfter: 120,
          sourceTokens: 80,
          checkpointTokens: 40,
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('无效缩容');
  });

  it('accepts a shrinking checkpoint with compactionId', () => {
    expect(
      validateCompactionCommit(
        checkpointPayload({
          compactionId: 'c1',
          sourceMessageCount: 4,
          tokenStats: {
            estimatedTokensBefore: 100,
            estimatedTokensAfter: 40,
            sourceTokens: 80,
            checkpointTokens: 20,
          },
        })
      ).ok
    ).toBe(true);
  });
});
