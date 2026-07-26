/**
 * CacheStatsRepository: 缓存统计仓库
 */

import { ICacheStatistics } from '@codepapr/types';
import { Logger } from '@codepapr/common';
import { DSDatabase } from '../Database';

const log = new Logger('CacheStatsRepository');

interface CacheStatsRow {
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_hit_rate: number | null;
}

interface CacheStatsAggregateRow {
  total_cache_read: number | null;
  total_cache_creation: number | null;
  total_input: number | null;
  total_output: number | null;
  count: number;
}

export class CacheStatsRepository {
  constructor(private db: DSDatabase) {}

  save(
    sessionId: string,
    stats: ICacheStatistics & {
      prefixHash?: string;
      prefixBytes?: number;
      logMessages?: number;
      logBytes?: number;
    }
  ): void {
    this.db
      .prepare(
        `INSERT INTO cache_stats (
          session_id, timestamp, prefix_hash, prefix_bytes,
          log_messages, log_bytes,
          cache_creation_tokens, cache_read_tokens,
          input_tokens, output_tokens, cache_hit_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        Date.now(),
        stats.prefixHash ?? null,
        stats.prefixBytes ?? null,
        stats.logMessages ?? null,
        stats.logBytes ?? null,
        stats.cacheCreationTokens,
        stats.cacheReadTokens,
        stats.newInputTokens,
        stats.outputTokens,
        stats.cacheHitRate ?? 0
      );

    log.debug(`Cache stats saved for session ${sessionId}`);
  }

  getRecent(sessionId: string, limit: number = 100): ICacheStatistics[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cache_stats WHERE session_id = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(sessionId, limit) as CacheStatsRow[];

    return rows.map((row) => ({
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
      newInputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheHitRate: row.cache_hit_rate ?? undefined,
    }));
  }

  getAggregate(sessionId: string): {
    totalCacheRead: number;
    totalCacheCreation: number;
    totalInput: number;
    totalOutput: number;
    avgHitRate: number;
    count: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(cache_read_tokens) as total_cache_read,
          SUM(cache_creation_tokens) as total_cache_creation,
          SUM(input_tokens) as total_input,
          SUM(output_tokens) as total_output,
          COUNT(*) as count
         FROM cache_stats WHERE session_id = ?`
      )
      .get(sessionId) as CacheStatsAggregateRow;

    const totalCacheRead = row.total_cache_read ?? 0;
    const totalCacheCreation = row.total_cache_creation ?? 0;
    const totalInput = row.total_input ?? 0;
    const totalOutput = row.total_output ?? 0;
    // Weighted aggregate hit rate: sum(read) / sum(all input tokens). Averaging
    // the per-row rates (AVG(cache_hit_rate)) would mis-weight calls that
    // processed very different token volumes.
    const totalInputTokens = totalCacheRead + totalCacheCreation + totalInput;
    const avgHitRate = totalInputTokens > 0 ? totalCacheRead / totalInputTokens : 0;

    return {
      totalCacheRead,
      totalCacheCreation,
      totalInput,
      totalOutput,
      avgHitRate,
      count: row.count ?? 0,
    };
  }
}
