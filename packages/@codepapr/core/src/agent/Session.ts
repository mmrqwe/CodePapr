/**
 * Session: 会话状态容器
 */

import { ImmutablePrefix } from '../cache/ImmutablePrefix';
import { AppendOnlyLog } from '../cache/AppendOnlyLog';
import { VolatileScratch } from '../cache/VolatileScratch';
import { CachePartition } from '../cache/CachePartition';
import { ToolRegistry } from '../tool/ToolRegistry';
import { ICacheStatistics, IMessage } from '@codepapr/types';
import { Logger } from '@codepapr/common';

const log = new Logger('Session');

export function mergeOptionalTokenCount(left?: number, right?: number): number | undefined {
  if (typeof left !== 'number' && typeof right !== 'number') {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}

export interface SessionOptions {
  sessionId: string;
  prefix: ImmutablePrefix;
  toolRegistry: ToolRegistry;
  log?: AppendOnlyLog;
  scratch?: VolatileScratch;
}

export class Session {
  readonly sessionId: string;
  readonly prefix: ImmutablePrefix;
  readonly logStore: AppendOnlyLog;
  readonly scratch: VolatileScratch;
  readonly toolRegistry: ToolRegistry;
  readonly partition: CachePartition;
  readonly toolsHash: string;

  private statsHistory: ICacheStatistics[] = [];

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.prefix = opts.prefix;
    this.logStore = opts.log ?? new AppendOnlyLog(opts.sessionId);
    this.scratch = opts.scratch ?? new VolatileScratch();
    this.toolRegistry = opts.toolRegistry;

    if (!this.toolRegistry.isFrozen()) {
      this.toolsHash = this.toolRegistry.freeze();
    } else {
      this.toolsHash = this.toolRegistry.getHash();
    }

    this.partition = new CachePartition(this.prefix, this.logStore, this.scratch);
    log.info(`Session created: ${this.sessionId} prefixHash=${this.prefix.computeHash().slice(0, 12)}`);
  }

  recordStats(stats: ICacheStatistics): void {
    this.statsHistory.push(stats);
  }

  getAggregateStats(): ICacheStatistics {
    if (this.statsHistory.length === 0) {
      return {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        newInputTokens: 0,
        outputTokens: 0,
        cacheHitRate: 0,
      };
    }
    type AggregateAccumulator = ICacheStatistics & { calls: number };
    const agg = this.statsHistory.reduce<AggregateAccumulator>(
      (acc, s) => ({
        cacheCreationTokens: acc.cacheCreationTokens + s.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
        newInputTokens: acc.newInputTokens + s.newInputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        cacheHitRate: 0,
        calls: acc.calls + (s.calls ?? 0),
        promptCacheHitTokens: mergeOptionalTokenCount(
          acc.promptCacheHitTokens,
          s.promptCacheHitTokens
        ),
        promptCacheMissTokens: mergeOptionalTokenCount(
          acc.promptCacheMissTokens,
          s.promptCacheMissTokens
        ),
      }),
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        newInputTokens: 0,
        outputTokens: 0,
        cacheHitRate: 0,
        calls: 0,
        promptCacheHitTokens: undefined,
        promptCacheMissTokens: undefined,
      }
    );
    const totalInput = agg.cacheReadTokens + agg.cacheCreationTokens + agg.newInputTokens;
    agg.cacheHitRate = totalInput > 0 ? agg.cacheReadTokens / totalInput : 0;
    return agg;
  }

  getMessages(): IMessage[] {
    return this.partition.toMessageArray();
  }
}
