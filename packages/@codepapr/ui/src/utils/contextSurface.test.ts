import { describe, expect, it } from 'vitest';
import type { PruneOptions } from '@codepapr/core';
import {
  computeCheckpointProvenanceRanges,
  computeSurfaceNodes,
  findCheckpointInsertIndex,
  freezePruneParams,
  getLatestCheckpointPayload,
  hydrateSurfaceMessages,
  isModelVisibleUiMessage,
  serializeRenderParams,
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

  it('inserts after the last source message when sources are found', () => {
    expect(findCheckpointInsertIndex(messages, ['a', 'b'], ['c', 'd'])).toBe(2);
  });

  it('falls back to the first retained message when sources are missing', () => {
    expect(findCheckpointInsertIndex(messages, ['x'], ['c', 'd'])).toBe(2);
  });

  it('returns null when neither side matches', () => {
    expect(findCheckpointInsertIndex(messages, ['x'], ['y'])).toBeNull();
  });
});

describe('hydrateSurfaceMessages', () => {
  it('filters messages by node ids and reports completeness', () => {
    const messages = [user('a'), assistant('b'), user('c')];
    const hydrated = hydrateSurfaceMessages(messages, ['b', 'c']);
    expect(hydrated.complete).toBe(true);
    expect(hydrated.messages.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('reports incomplete when a node id is missing', () => {
    const hydrated = hydrateSurfaceMessages([user('a')], ['a', 'z']);
    expect(hydrated.complete).toBe(false);
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
});

describe('getLatestCheckpointPayload', () => {
  it('returns the latest checkpoint payload or null', () => {
    const payload = checkpointPayload();
    expect(getLatestCheckpointPayload([checkpointMessage('cp1', payload)])).toEqual(payload);
    expect(getLatestCheckpointPayload([user('u1')])).toBeNull();
  });
});
