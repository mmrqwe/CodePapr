import { describe, expect, it } from 'vitest';
import type { ContextCheckpointPayload } from './contextCompaction';
import {
  CONTEXT_CHECKPOINT_VERSION_3,
  createEmptyCheckpointStateV3,
  migrateCheckpointSectionsToV3,
  migrateContextCheckpointToV3,
  type ContextCheckpointPayloadV3,
} from './contextCheckpointState';
import {
  expectedEmptyState,
  expectedFullV3,
  fullV2Payload,
  legacyNoSectionsV2Payload,
  localV2Payload,
} from './contextCheckpointMigration.fixtures';

describe('migrateCheckpointSectionsToV3', () => {
  it('maps every v2 section to the v3 state (ADR-007 table)', () => {
    const state = migrateCheckpointSectionsToV3(fullV2Payload.sections);
    expect(state.goal).toEqual(expectedFullV3.state.goal);
    expect(state.constraints).toEqual(expectedFullV3.state.constraints);
    expect(state.completedWork).toEqual(expectedFullV3.state.completedWork);
    expect(state.assumptions).toEqual(expectedFullV3.state.assumptions);
    expect(state.activeWork).toEqual(expectedFullV3.state.activeWork);
    expect(state.openQuestions).toEqual(expectedFullV3.state.openQuestions);
    expect(state.todos).toEqual(expectedFullV3.state.todos);
    expect(state.decisions).toEqual([]);
    expect(state.provenance).toEqual([]);
  });

  it('splits importantContext into confirmedFacts vs references deterministically', () => {
    const state = migrateCheckpointSectionsToV3(fullV2Payload.sections);
    expect(state.confirmedFacts).toEqual(expectedFullV3.state.confirmedFacts);
    expect(state.references).toEqual(expectedFullV3.state.references);
  });

  it('splits validationNotes into verification vs failuresAndRisks', () => {
    const state = migrateCheckpointSectionsToV3(fullV2Payload.sections);
    expect(state.verification).toEqual(expectedFullV3.state.verification);
    expect(state.failuresAndRisks).toEqual(expectedFullV3.state.failuresAndRisks);
  });

  it('returns an empty state for undefined sections without throwing', () => {
    expect(migrateCheckpointSectionsToV3(undefined)).toEqual(expectedEmptyState);
  });

  it('filters non-string and empty entries', () => {
    const sections = {
      userGoal: ['目标', '', 42, '  ', '另一个目标'],
    } as unknown as ContextCheckpointPayload['sections'];
    const state = migrateCheckpointSectionsToV3(sections);
    expect(state.goal).toEqual(['目标', '另一个目标']);
  });

  it('routes ADR-007 verification keywords (失败/failed/修复) into confirmedFacts', () => {
    const state = migrateCheckpointSectionsToV3({
      userGoal: [],
      constraints: [],
      completedWork: [],
      importantContext: ['构建失败', 'tests failed', '需要修复回调'],
      assumptions: [],
      validationNotes: [],
      pendingWork: [],
      openQuestions: [],
      todoList: [],
    });
    expect(state.confirmedFacts).toEqual(['构建失败', 'tests failed', '需要修复回调']);
    expect(state.references).toEqual([]);
  });
});

describe('migrateContextCheckpointToV3', () => {
  it('produces the expected v3 payload for a full v2 payload', () => {
    expect(migrateContextCheckpointToV3(fullV2Payload)).toEqual(expectedFullV3);
  });

  it('maps modelTier local → local-fallback summary info', () => {
    const v3 = migrateContextCheckpointToV3(localV2Payload);
    expect(v3.summaryInfo).toEqual({ kind: 'local-fallback' });
    expect(v3.state).toEqual(expectedEmptyState);
  });

  it('maps modelTier fast/primary → llm summary info with model name', () => {
    const v3 = migrateContextCheckpointToV3(fullV2Payload);
    expect(v3.summaryInfo).toEqual({ kind: 'llm', model: 'deepseek-chat' });
  });

  it('degrades legacy payload without sections to an empty state', () => {
    const v3 = migrateContextCheckpointToV3(legacyNoSectionsV2Payload);
    expect(v3.version).toBe(CONTEXT_CHECKPOINT_VERSION_3);
    expect(v3.state).toEqual(expectedEmptyState);
    expect(v3.summaryInfo).toEqual({ kind: 'local-fallback' });
  });

  it('preserves v2 rendering fields verbatim (renderer binding, ADR-007)', () => {
    const v3 = migrateContextCheckpointToV3(fullV2Payload);
    expect(v3.summary).toBe(fullV2Payload.summary);
    expect(v3.renderedContent).toBe(fullV2Payload.renderedContent);
    expect(v3.sourceMessageCount).toBe(fullV2Payload.sourceMessageCount);
    expect(v3.sourceChars).toBe(fullV2Payload.sourceChars);
    expect(v3.generatedAt).toBe(fullV2Payload.generatedAt);
    expect(v3.todoDigest).toBe(fullV2Payload.todoDigest);
  });

  it('leaves legacy provenance fields undefined', () => {
    const v3 = migrateContextCheckpointToV3(fullV2Payload);
    expect(v3.compactionId).toBeUndefined();
    expect(v3.generation).toBeUndefined();
    expect(v3.sourceStartMessageId).toBeUndefined();
    expect(v3.tokenStats).toBeUndefined();
  });

  it('is idempotent for v3 inputs', () => {
    const once = migrateContextCheckpointToV3(fullV2Payload);
    const twice = migrateContextCheckpointToV3(once);
    expect(twice).toEqual(once);
  });

  it('fills empty state partitions for partial v3 state', () => {
    const partial = {
      ...expectedFullV3,
      state: { goal: ['x'] },
    } as unknown as ContextCheckpointPayloadV3;
    const v3 = migrateContextCheckpointToV3(partial);
    expect(v3.state.goal).toEqual(['x']);
    expect(v3.state.todos).toEqual([]);
    expect(v3.state.provenance).toEqual([]);
  });

  it('normalizes sparse v3 payloads (empty strings, missing scalars)', () => {
    const v3 = migrateContextCheckpointToV3({
      version: CONTEXT_CHECKPOINT_VERSION_3,
      modelTier: 'local',
      state: { goal: ['x', '', '  '] },
    } as unknown as ContextCheckpointPayloadV3);
    expect(v3.state.goal).toEqual(['x']);
    expect(v3.state.constraints).toEqual([]);
    expect(v3.state.todos).toEqual([]);
    expect(v3.summary).toBe('');
    expect(v3.renderedContent).toBe('');
    expect(v3.sourceMessageCount).toBe(0);
    expect(v3.generatedAt).toBe(0);
    expect(v3.summaryInfo).toEqual({ kind: 'local-fallback' });
  });

  it('createEmptyCheckpointStateV3 matches the frozen empty shape', () => {
    expect(createEmptyCheckpointStateV3()).toEqual(expectedEmptyState);
  });
});
