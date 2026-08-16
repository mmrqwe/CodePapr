/**
 * Context Surface 编排层（PR1，ADR-005）：主线程 Store 是唯一 DB 写者。
 *
 * 职责：
 * - legacy 引导 / 普通保存维护（maintainContextSurface）；
 * - 压缩单事务提交（commitContextCheckpoint）与失败溯源（failContextCheckpoint）；
 * - 内存缓存（loadContextSurface 结果），供重建路径与维护路径共用。
 *
 * 不变式（ADR-002/005）：
 * - 失败压缩不得破坏上一个 completed generation：维护路径检测到未提交
 *   checkpoint（payload.generation ≠ surface.generation）时跳过写 surface，
 *   由 commit/failed 路径负责推进。
 */

import type { CompactionTrigger } from '@codepapr/types';
import type { PruneOptions } from '@codepapr/core';
import { createId } from '../../utils/createId';
import {
  computeSurfaceNodes,
  getLatestCheckpointPayload,
  parseRenderParams,
  resolveCheckpointSummaryInfo,
  serializeDisabledRenderParams,
  serializeRenderParams,
  type SurfaceNodeInput,
} from '../../utils/contextSurface';
import {
  getLatestCheckpoint,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from '../../utils/contextCompaction';
import {
  commitContextCompaction,
  loadContextSurface,
  markContextCompactionFailed,
  saveContextSurface,
  type PersistedContextSurface,
} from '../../utils/projectStorage';

const surfaceCache = new Map<string, PersistedContextSurface | null>();

function cacheKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`;
}

export async function getContextSurfaceCached(
  workspacePath: string,
  sessionId: string
): Promise<PersistedContextSurface | null> {
  const key = cacheKey(workspacePath, sessionId);
  if (surfaceCache.has(key)) {
    return surfaceCache.get(key) ?? null;
  }
  let surface: PersistedContextSurface | null = null;
  try {
    surface = await loadContextSurface(workspacePath, sessionId);
  } catch (err) {
    console.warn('[surface] 读取 surface 失败:', err instanceof Error ? err.message : err);
  }
  surfaceCache.set(key, surface);
  return surface;
}

function rememberContextSurface(
  workspacePath: string,
  surface: PersistedContextSurface
): void {
  surfaceCache.set(cacheKey(workspacePath, surface.sessionId), surface);
}

export function forgetContextSurface(workspacePath: string, sessionId: string): void {
  surfaceCache.delete(cacheKey(workspacePath, sessionId));
}

/**
 * 普通保存维护：把当前 model-visible 投影写回 surface。
 * - 无 surface：创建 generation 0（legacy 引导）；
 * - 有 surface 但存在未提交压缩（payload.generation ≠ surface.generation）：
 *   跳过（commit/failed 路径拥有推进权）；
 * - 其余：按当前投影替换该 generation 节点（幂等）。
 */
export async function maintainContextSurface(
  workspacePath: string,
  sessionId: string,
  messages: readonly ContextMessageLike[]
): Promise<void> {
  try {
    const surface = await getContextSurfaceCached(workspacePath, sessionId);
    const nodes = computeSurfaceNodes(messages);

    if (!surface) {
      const created: PersistedContextSurface = {
        sessionId,
        generation: 0,
        parentGeneration: null,
        compactionId: null,
        // generation 0 的 epoch 从未 prune，冻结禁用参数保证重启重建字节一致
        // （ADR-006）。
        renderParamsJson: serializeDisabledRenderParams(),
        createdAt: Date.now(),
        nodes,
      };
      await saveContextSurface(workspacePath, created);
      rememberContextSurface(workspacePath, created);
      return;
    }

    const payload = getLatestCheckpointPayload(messages);
    if (
      payload?.compactionId &&
      typeof payload.generation === 'number' &&
      payload.generation !== surface.generation
    ) {
      // 未提交/失败的压缩在途：等 commit/fail 路径处理，不覆盖旧 generation。
      return;
    }

    await saveContextSurface(workspacePath, {
      sessionId,
      generation: surface.generation,
      parentGeneration: surface.parentGeneration,
      compactionId: surface.compactionId,
      renderParamsJson: surface.renderParamsJson,
      nodes,
    });
  } catch (err) {
    console.warn('[surface] 维护 surface 失败:', err instanceof Error ? err.message : err);
  }
}

export interface CommitContextCheckpointOptions {
  workspacePath: string;
  sessionId: string;
  /** 已插入 checkpoint 的消息数组（checkpoint 位于 insertIndex 处）。 */
  messages: readonly ContextMessageLike[];
  /** payload 缺 trigger 时的兜底。 */
  trigger: CompactionTrigger;
  pruneOptions: PruneOptions;
}

/**
 * 压缩提交（ADR-005）：单事务 started → surface → completed。
 * 成功后更新内存缓存；失败向上抛，由调用方 failContextCheckpoint 溯源。
 */
export async function commitContextCheckpoint(
  options: CommitContextCheckpointOptions
): Promise<{ compactionId: string; generation: number }> {
  const checkpoint = getLatestCheckpoint(options.messages);
  if (!checkpoint) {
    throw new Error('[surface] 提交压缩失败：消息数组中没有 checkpoint');
  }
  const payload = checkpoint.payload;

  const surface = await getContextSurfaceCached(options.workspacePath, options.sessionId);
  const sourceGeneration = surface?.generation ?? 0;
  const targetGeneration = sourceGeneration + 1;

  const priorMessages = options.messages.slice(0, checkpoint.index);
  const parentCheckpoint = getLatestCheckpoint(priorMessages);

  const summaryInfo = resolveCheckpointSummaryInfo(payload);
  const nodes: SurfaceNodeInput[] = computeSurfaceNodes(options.messages);
  const createdAt = payload.generatedAt || Date.now();
  const renderParamsJson = serializeRenderParams(options.pruneOptions);

  const request = {
    id: payload.compactionId ?? createId(),
    sessionId: options.sessionId,
    trigger: payload.trigger ?? options.trigger,
    sourceGeneration,
    targetGeneration,
    checkpointMessageId: checkpoint.message.id,
    parentCheckpointMessageId: parentCheckpoint?.message.id ?? null,
    sourceStartMessageId: payload.sourceStartMessageId ?? null,
    sourceEndMessageId: payload.sourceEndMessageId ?? null,
    retainedTailStartMessageId: payload.retainedTailStartMessageId ?? null,
    sourceMessageCount: payload.sourceMessageCount ?? 0,
    retainedMessageCount: payload.retainedMessageCount ?? 0,
    estimatedTokensBefore: payload.tokenStats?.estimatedTokensBefore ?? null,
    estimatedTokensAfter: payload.tokenStats?.estimatedTokensAfter ?? null,
    sourceTokens: payload.tokenStats?.sourceTokens ?? null,
    checkpointTokens: payload.tokenStats?.checkpointTokens ?? null,
    summaryMode: summaryInfo.kind,
    summaryProvider: summaryInfo.provider ?? null,
    summaryModel: summaryInfo.model ?? payload.modelName ?? null,
    createdAt,
    nodes,
    renderParamsJson,
  };

  const result = await commitContextCompaction(options.workspacePath, request);

  rememberContextSurface(options.workspacePath, {
    sessionId: options.sessionId,
    generation: targetGeneration,
    parentGeneration: sourceGeneration,
    compactionId: request.id,
    renderParamsJson,
    createdAt,
    nodes,
  });

  return result;
}

export interface FailContextCheckpointOptions {
  workspacePath: string;
  sessionId: string;
  payload: ContextCheckpointPayload | null;
  trigger: CompactionTrigger;
  failureCode: string;
  failureMessage: string;
}

/** 失败压缩溯源（不变式 5：只新增 failed 行，不触碰 surface）。 */
export async function failContextCheckpoint(
  options: FailContextCheckpointOptions
): Promise<void> {
  const payload = options.payload;
  const surface = await getContextSurfaceCached(options.workspacePath, options.sessionId);
  const summaryInfo = payload ? resolveCheckpointSummaryInfo(payload) : { kind: 'local-fallback' as const };
  try {
    await markContextCompactionFailed(options.workspacePath, {
      id: payload?.compactionId ?? createId(),
      sessionId: options.sessionId,
      trigger: payload?.trigger ?? options.trigger,
      sourceGeneration: surface?.generation ?? 0,
      summaryMode: summaryInfo.kind,
      createdAt: payload?.generatedAt ?? Date.now(),
      failureCode: options.failureCode,
      failureMessage: options.failureMessage,
    });
  } catch (err) {
    console.warn('[surface] 记录压缩失败失败:', err instanceof Error ? err.message : err);
  }
}

/**
 * 会话重建用的 prune 参数（ADR-006）：优先取 surface 冻结参数（压缩 epoch
 * 与 generation 0 分别冻结「压缩时参数」与「禁用」），无 surface / 解析失败
 * 时回退调用方提供的当前 settings 参数。
 */
export async function getSessionPruneOptions(
  workspacePath: string,
  sessionId: string,
  fallback: PruneOptions
): Promise<PruneOptions> {
  const surface = await getContextSurfaceCached(workspacePath, sessionId);
  if (!surface) return fallback;
  const parsed = parseRenderParams(surface.renderParamsJson);
  return parsed?.pruneOptions ?? fallback;
}

/**
 * PR3 prune-first：更新最新 generation 的冻结渲染参数（节点不变、generation
 * 不变——这不是压缩，只是该 epoch 的重渲染参数变化）。下一次重建按新参数
 * 重放编译器裁剪旧工具结果。
 */
export async function updateSurfaceRenderParams(
  workspacePath: string,
  sessionId: string,
  renderParamsJson: string
): Promise<void> {
  const surface = await getContextSurfaceCached(workspacePath, sessionId);
  if (!surface) return;
  const updated: PersistedContextSurface = { ...surface, renderParamsJson };
  await saveContextSurface(workspacePath, updated);
  rememberContextSurface(workspacePath, updated);
}
