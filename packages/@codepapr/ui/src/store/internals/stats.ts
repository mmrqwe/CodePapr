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

export type ModelTier = 'primary' | 'fast';

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
  };
}

export function aggregateProjectStats(
  sessionConversationStats: Record<string, ConversationStats>
): ConversationStats {
  const result = createEmptyConversationStats();
  for (const stats of Object.values(sessionConversationStats)) {
    result.primary = addModelTierStatsToStats(result.primary, stats.primary);
    result.fast = addModelTierStatsToStats(result.fast, stats.fast);
  }
  return result;
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
  };
}
