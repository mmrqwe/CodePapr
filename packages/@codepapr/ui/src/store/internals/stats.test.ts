import { describe, expect, it } from 'vitest';
import {
  addConversationRuntime,
  addConversationStats,
  addTierRuntimeMs,
  aggregateProjectStats,
  cloneConversationStats,
} from './stats';
import { createEmptyConversationStats } from './defaults';

describe('addConversationRuntime', () => {
  it('accumulates wall-clock runtime onto empty stats', () => {
    const next = addConversationRuntime(createEmptyConversationStats(), 1500);
    expect(next.runtimeMs).toBe(1500);
  });

  it('accumulates across multiple turns', () => {
    const once = addConversationRuntime(createEmptyConversationStats(), 1500);
    const twice = addConversationRuntime(once, 2500);
    expect(twice.runtimeMs).toBe(4000);
  });

  it('rounds fractional milliseconds', () => {
    const next = addConversationRuntime(createEmptyConversationStats(), 1234.6);
    expect(next.runtimeMs).toBe(1235);
  });

  it('ignores zero, negative and non-finite deltas', () => {
    const base = createEmptyConversationStats();
    expect(addConversationRuntime(base, 0)).toBe(base);
    expect(addConversationRuntime(base, -10)).toBe(base);
    expect(addConversationRuntime(base, Number.NaN)).toBe(base);
    expect(addConversationRuntime(base, Number.POSITIVE_INFINITY)).toBe(base);
  });

  it('does not mutate tier stats', () => {
    const next = addConversationRuntime(createEmptyConversationStats(), 900);
    expect(next.primary).toEqual(createEmptyConversationStats().primary);
    expect(next.fast).toEqual(createEmptyConversationStats().fast);
    expect(next.mentor).toEqual(createEmptyConversationStats().mentor);
  });
});

describe('cloneConversationStats runtimeMs semantics', () => {
  it('keeps runtimeMs undefined for legacy persisted stats', () => {
    const cloned = cloneConversationStats({
      primary: {
        totalCacheRead: 1,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        calls: 1,
        rounds: 1,
      },
    });
    expect(cloned.runtimeMs).toBeUndefined();
  });

  it('preserves an existing runtimeMs value', () => {
    const cloned = cloneConversationStats({
      ...createEmptyConversationStats(),
      runtimeMs: 4200,
    });
    expect(cloned.runtimeMs).toBe(4200);
  });

  it('keeps a zero runtimeMs (already tracked, no backfill needed)', () => {
    const cloned = cloneConversationStats({
      ...createEmptyConversationStats(),
      runtimeMs: 0,
    });
    expect(cloned.runtimeMs).toBe(0);
  });
});

describe('aggregateProjectStats runtimeMs', () => {
  it('sums runtime across sessions', () => {
    const aggregated = aggregateProjectStats({
      s1: { ...createEmptyConversationStats(), runtimeMs: 1000 },
      s2: { ...createEmptyConversationStats(), runtimeMs: 2500 },
    });
    expect(aggregated.runtimeMs).toBe(3500);
  });

  it('ignores sessions without runtime data but keeps defined result', () => {
    const aggregated = aggregateProjectStats({
      s1: { ...createEmptyConversationStats(), runtimeMs: 800 },
      s2: createEmptyConversationStats(),
    });
    expect(aggregated.runtimeMs).toBe(800);
  });

  it('stays undefined when no session has runtime data', () => {
    const aggregated = aggregateProjectStats({
      s1: createEmptyConversationStats(),
    });
    expect(aggregated.runtimeMs).toBeUndefined();
  });
});

describe('addTierRuntimeMs (model/tool durations)', () => {
  it('accumulates model runtime onto the target tier', () => {
    const next = addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 1200);
    expect(next.primary.modelRuntimeMs).toBe(1200);
    expect(next.primary.toolRuntimeMs).toBeUndefined();
  });

  it('accumulates tool runtime onto the target tier', () => {
    const next = addTierRuntimeMs(createEmptyConversationStats(), 'fast', 'tool', 640);
    expect(next.fast.toolRuntimeMs).toBe(640);
    expect(next.fast.modelRuntimeMs).toBeUndefined();
  });

  it('accumulates across turns and rounds fractional values per add', () => {
    const once = addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 500.4);
    const twice = addTierRuntimeMs(once, 'primary', 'model', 300.4);
    expect(twice.primary.modelRuntimeMs).toBe(800);
  });

  it('ignores zero, negative and non-finite deltas', () => {
    const base = createEmptyConversationStats();
    expect(addTierRuntimeMs(base, 'primary', 'model', 0)).toBe(base);
    expect(addTierRuntimeMs(base, 'primary', 'tool', -5)).toBe(base);
    expect(addTierRuntimeMs(base, 'primary', 'model', Number.NaN)).toBe(base);
  });

  it('does not mutate other tiers', () => {
    const next = addTierRuntimeMs(createEmptyConversationStats(), 'mentor', 'tool', 100);
    expect(next.primary).toEqual(createEmptyConversationStats().primary);
    expect(next.fast).toEqual(createEmptyConversationStats().fast);
  });
});

describe('runtime fields survive cache-stats accumulation', () => {
  it('addConversationStats preserves measured durations', () => {
    const withRuntime = addTierRuntimeMs(
      addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 900),
      'primary',
      'tool',
      400
    );
    const next = addConversationStats(withRuntime, 'primary', {
      cacheReadTokens: 10,
      cacheCreationTokens: 2,
      newInputTokens: 5,
      outputTokens: 8,
    });
    expect(next.primary.modelRuntimeMs).toBe(900);
    expect(next.primary.toolRuntimeMs).toBe(400);
    expect(next.primary.totalCacheRead).toBe(10);
  });

  it('aggregateProjectStats sums tier durations across sessions', () => {
    const s1 = addTierRuntimeMs(
      addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 1000),
      'primary',
      'tool',
      500
    );
    const s2 = addTierRuntimeMs(
      addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 2000),
      'fast',
      'tool',
      300
    );
    const aggregated = aggregateProjectStats({ s1, s2 });
    expect(aggregated.primary.modelRuntimeMs).toBe(3000);
    expect(aggregated.primary.toolRuntimeMs).toBe(500);
    expect(aggregated.fast.toolRuntimeMs).toBe(300);
    expect(aggregated.fast.modelRuntimeMs).toBeUndefined();
    expect(aggregated.mentor.modelRuntimeMs).toBeUndefined();
    expect(aggregated.mentor.toolRuntimeMs).toBeUndefined();
  });

  it('cloneConversationStats preserves tier durations', () => {
    const source = addTierRuntimeMs(
      addTierRuntimeMs(createEmptyConversationStats(), 'primary', 'model', 700),
      'primary',
      'tool',
      250
    );
    const cloned = cloneConversationStats(source);
    expect(cloned.primary.modelRuntimeMs).toBe(700);
    expect(cloned.primary.toolRuntimeMs).toBe(250);
  });
});
