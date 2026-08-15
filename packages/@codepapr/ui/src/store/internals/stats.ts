import { createEmptyModelTierStats, createEmptyConversationStats } from './defaults';
import type { ConversationStats, CumulativeStats, ModelTierStats } from './types';

export function cloneStats(stats?: Partial<CumulativeStats> | null): CumulativeStats {
  return {
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInput: 0,
    totalOutput: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    rounds: 0,
    ...(stats ?? {}),
  };
}

export function getSessionStats(
  sessionCumulativeStats: Record<string, CumulativeStats>,
  sessionId: string | null
): CumulativeStats {
  if (!sessionId) {
    return cloneStats(null);
  }
  return cloneStats(sessionCumulativeStats[sessionId]);
}

export function cloneConversationStats(
  stats?: Partial<ConversationStats> | null
): ConversationStats {
  if (!stats) return createEmptyConversationStats();
  return {
    primary: { ...createEmptyModelTierStats(), ...(stats.primary ?? {}) },
    fast: { ...createEmptyModelTierStats(), ...(stats.fast ?? {}) },
    mentor: { ...createEmptyModelTierStats(), ...(stats.mentor ?? {}) },
    // 保持 undefined 语义：旧持久化数据没有该字段，回填逻辑依赖它做幂等判断。
    runtimeMs: typeof stats.runtimeMs === 'number' ? stats.runtimeMs : undefined,
  };
}

export function getSessionConversationStats(
  sessionConversationStats: Record<string, ConversationStats>,
  sessionId: string | null
): ConversationStats {
  if (!sessionId) {
    return createEmptyConversationStats();
  }
  return cloneConversationStats(sessionConversationStats[sessionId]);
}

export function addCacheStats(
  current: CumulativeStats,
  delta: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    newInputTokens: number;
    outputTokens: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  },
  options?: { incrementRounds?: boolean }
): CumulativeStats {
  return {
    totalCacheRead: current.totalCacheRead + delta.cacheReadTokens,
    totalCacheCreation: current.totalCacheCreation + delta.cacheCreationTokens,
    totalInput: current.totalInput + delta.newInputTokens,
    totalOutput: current.totalOutput + delta.outputTokens,
    promptCacheHitTokens: current.promptCacheHitTokens + (delta.promptCacheHitTokens ?? 0),
    promptCacheMissTokens: current.promptCacheMissTokens + (delta.promptCacheMissTokens ?? 0),
    rounds: current.rounds + (options?.incrementRounds ? 1 : 0),
  };
}

export type ModelTier = 'primary' | 'fast' | 'mentor';

export function addModelTierStats(
  current: ModelTierStats,
  delta: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    newInputTokens: number;
    outputTokens: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
    calls?: number;
  },
  options?: { incrementRounds?: boolean }
): ModelTierStats {
  return {
    totalCacheRead: current.totalCacheRead + delta.cacheReadTokens,
    totalCacheCreation: current.totalCacheCreation + delta.cacheCreationTokens,
    totalInput: current.totalInput + delta.newInputTokens,
    totalOutput: current.totalOutput + delta.outputTokens,
    promptCacheHitTokens: current.promptCacheHitTokens + (delta.promptCacheHitTokens ?? 0),
    promptCacheMissTokens: current.promptCacheMissTokens + (delta.promptCacheMissTokens ?? 0),
    calls: current.calls + (delta.calls ?? 0),
    rounds: current.rounds + (options?.incrementRounds ? 1 : 0),
    // 耗时字段不进 delta：由 addTierRuntimeMs 单独累加，这里必须原样保留，
    // 否则常规 cache stats 累加会把已有的耗时测量清掉。
    modelRuntimeMs: current.modelRuntimeMs,
    toolRuntimeMs: current.toolRuntimeMs,
  };
}

export function addConversationStats(
  current: ConversationStats,
  tier: ModelTier,
  delta: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    newInputTokens: number;
    outputTokens: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
    calls?: number;
  },
  options?: { incrementRounds?: boolean }
): ConversationStats {
  return {
    ...current,
    [tier]: addModelTierStats(current[tier], delta, options),
  };
}

export function addModelTierStatsToStats(
  base: ModelTierStats,
  other: ModelTierStats
): ModelTierStats {
  return {
    totalCacheRead: base.totalCacheRead + other.totalCacheRead,
    totalCacheCreation: base.totalCacheCreation + other.totalCacheCreation,
    totalInput: base.totalInput + other.totalInput,
    totalOutput: base.totalOutput + other.totalOutput,
    promptCacheHitTokens: base.promptCacheHitTokens + other.promptCacheHitTokens,
    promptCacheMissTokens: base.promptCacheMissTokens + other.promptCacheMissTokens,
    calls: base.calls + other.calls,
    rounds: base.rounds + other.rounds,
    ...(typeof base.modelRuntimeMs === 'number' || typeof other.modelRuntimeMs === 'number'
      ? { modelRuntimeMs: (base.modelRuntimeMs ?? 0) + (other.modelRuntimeMs ?? 0) }
      : {}),
    ...(typeof base.toolRuntimeMs === 'number' || typeof other.toolRuntimeMs === 'number'
      ? { toolRuntimeMs: (base.toolRuntimeMs ?? 0) + (other.toolRuntimeMs ?? 0) }
      : {}),
  };
}

export function aggregateProjectStats(
  sessionConversationStats: Record<string, ConversationStats>
): ConversationStats {
  const result = createEmptyConversationStats();
  let runtimeMs = 0;
  let hasRuntime = false;
  for (const stats of Object.values(sessionConversationStats)) {
    result.primary = addModelTierStatsToStats(result.primary, stats.primary);
    result.fast = addModelTierStatsToStats(result.fast, stats.fast);
    result.mentor = addModelTierStatsToStats(result.mentor, stats.mentor ?? createEmptyModelTierStats());
    if (typeof stats.runtimeMs === 'number') {
      runtimeMs += stats.runtimeMs;
      hasRuntime = true;
    }
  }
  result.runtimeMs = hasRuntime ? runtimeMs : undefined;
  return result;
}

/** 累加一次回合的 Agent 实际执行时长（墙钟，毫秒）。 */
export function addConversationRuntime(
  current: ConversationStats,
  runtimeMs: number
): ConversationStats {
  if (!Number.isFinite(runtimeMs) || runtimeMs <= 0) return current;
  return {
    ...current,
    runtimeMs: (current.runtimeMs ?? 0) + Math.round(runtimeMs),
  };
}

/** 累加某 tier 的模型生成耗时 / 工具执行耗时（毫秒，undefined = 尚无测量值）。 */
export function addTierRuntimeMs(
  current: ConversationStats,
  tier: ModelTier,
  kind: 'model' | 'tool',
  runtimeMs: number
): ConversationStats {
  if (!Number.isFinite(runtimeMs) || runtimeMs <= 0) return current;
  const field = kind === 'model' ? 'modelRuntimeMs' : 'toolRuntimeMs';
  const tierStats = current[tier];
  return {
    ...current,
    [tier]: {
      ...tierStats,
      [field]: (tierStats[field] ?? 0) + Math.round(runtimeMs),
    },
  };
}

export function migrateCumulativeToConversationStats(
  cumulativeStats: CumulativeStats
): ConversationStats {
  return {
    primary: {
      totalCacheRead: cumulativeStats.totalCacheRead,
      totalCacheCreation: cumulativeStats.totalCacheCreation,
      totalInput: cumulativeStats.totalInput,
      totalOutput: cumulativeStats.totalOutput,
      promptCacheHitTokens: cumulativeStats.promptCacheHitTokens,
      promptCacheMissTokens: cumulativeStats.promptCacheMissTokens,
      calls: cumulativeStats.rounds,
      rounds: cumulativeStats.rounds,
    },
    fast: createEmptyModelTierStats(),
    mentor: createEmptyModelTierStats(),
  };
}
