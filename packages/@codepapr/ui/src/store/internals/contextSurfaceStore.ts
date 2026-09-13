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
import { createId } from '../../utils/createId';
import {
  computeSurfaceNodes,
  hydrateSurfaceMessages,
  resolveCheckpointSummaryInfo,
  serializeDisabledRenderParams,
  validateCompactionCommit,
  type SurfaceNodeInput,
} from '../../utils/contextSurface';
import {
  getLatestCheckpoint,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from '../../utils/contextCompaction';
import {
  commitContextCompaction,
  discardContextSurfacesFromGeneration,
  loadContextSurface,
  markContextCompactionFailed,
  saveContextSurface,
  type PersistedContextSurface,
} from '../../utils/projectStorage';

const surfaceCache = new Map<string, PersistedContextSurface | null>();
/** 内存缓存上限（LRU 逐出最旧条目）：长期运行 + 多工作区不会无限增长。 */
const SURFACE_CACHE_MAX = 64;

/**
 * 在途压缩登记（compactionId 集合）：checkpoint 消息已插入消息数组、commit
 * 事务尚未结算的窗口。维护路径对该窗口内的 checkpoint 跳过写 surface
 * （commit/fail 路径拥有推进权）；窗口外的 generation 不匹配 checkpoint
 * 视为失败残留/崩溃孤儿，按孤儿处理（不采纳进节点，见 maintainContextSurface）。
 */
const inFlightCompactionIds = new Set<string>();

export function markCompactionInFlight(compactionId: string): void {
  inFlightCompactionIds.add(compactionId);
}

export function clearCompactionInFlight(compactionId: string): void {
  inFlightCompactionIds.delete(compactionId);
}

function cacheKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`;
}

function evictSurfaceCacheIfNeeded(): void {
  while (surfaceCache.size > SURFACE_CACHE_MAX) {
    const oldest = surfaceCache.keys().next().value;
    if (oldest === undefined) break;
    surfaceCache.delete(oldest);
  }
}

function rememberCacheEntry(workspacePath: string, sessionId: string, surface: PersistedContextSurface | null): void {
  const key = cacheKey(workspacePath, sessionId);
  surfaceCache.delete(key);
  surfaceCache.set(key, surface);
  evictSurfaceCacheIfNeeded();
}

export async function getContextSurfaceCached(
  workspacePath: string,
  sessionId: string
): Promise<PersistedContextSurface | null> {
  const key = cacheKey(workspacePath, sessionId);
  if (surfaceCache.has(key)) {
    const surface = surfaceCache.get(key) ?? null;
    // LRU：读取即刷新位置（重插到末尾）。
    surfaceCache.delete(key);
    surfaceCache.set(key, surface);
    return surface;
  }
  // 读取失败不得缓存 null：瞬时 IPC/IO 错误若被缓存成「无 surface」，
  // 后续 commit 会以 generation 0 为基准覆盖真实 generation（缓存投毒）。
  // 错误上抛给调用方，下次调用重试加载。
  const surface = await loadContextSurface(workspacePath, sessionId);
  rememberCacheEntry(workspacePath, sessionId, surface);
  return surface;
}

function rememberContextSurface(
  workspacePath: string,
  surface: PersistedContextSurface
): void {
  const key = cacheKey(workspacePath, surface.sessionId);
  surfaceCache.delete(key);
  surfaceCache.set(key, surface);
  evictSurfaceCacheIfNeeded();
}

/**
 * 使某会话的 surface 内存缓存失效（下次读取回源 DB）。
 * 凡是会改变会话消息集合、使缓存的 surface 与真实状态脱节的操作
 * （resetToMessage / clearMessages / deleteSession / undoConversationReset）
 * 都必须调用，否则重建会用到过期的 surface 节点。
 */
export function forgetContextSurface(workspacePath: string, sessionId: string): void {
  surfaceCache.delete(cacheKey(workspacePath, sessionId));
}

/** 切走工作区时丢掉该路径下全部 surface 内存缓存，避免读旧覆新。 */
export function forgetContextSurfacesForWorkspace(workspacePath: string): void {
  if (!workspacePath) return;
  const prefix = `${workspacePath}\u0000`;
  for (const key of surfaceCache.keys()) {
    if (key.startsWith(prefix)) {
      surfaceCache.delete(key);
    }
  }
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
    const checkpoint = getLatestCheckpoint(messages);
    const payload = checkpoint?.payload ?? null;

    // 最新 checkpoint 的三态判定：
    // 1. 在途（commit 进行中，含 mid-loop generation 未定的 checkpoint）→
    //    跳过，commit/fail 路径拥有推进权；
    // 2. 未提交孤儿（generation 未定，或 generation 与 active 不匹配，且
    //    compactionId 不是当前 surface 的 compaction）→ 不采纳进节点
    //    （不变式 5：失败压缩不得破坏上一个 completed generation）。
    //    mid-loop payload.generation 在 commit 前为 undefined，崩溃后
    //    inFlight 集合为空，必须按孤儿排除，不能落入当前 generation 节点。
    let projectionMessages: readonly ContextMessageLike[] = messages;
    if (checkpoint && payload?.compactionId) {
      if (inFlightCompactionIds.has(payload.compactionId)) {
        return;
      }
      const matchesActive =
        !!surface &&
        (payload.compactionId === surface.compactionId ||
          (typeof payload.generation === 'number' && payload.generation === surface.generation));
      if (surface && !matchesActive) {
        projectionMessages = messages.filter((m) => m.id !== checkpoint.message.id);
      }
    }

    const nodes = computeSurfaceNodes(projectionMessages);

    if (!surface) {
      // v4：prune 已删除，render_params 恒为禁用常量（列保留兼容旧存档）。
      // 旧 legacy 守卫（已压缩会话必须先冻结 live prune 才能建面）随之下线。
      const created: PersistedContextSurface = {
        sessionId,
        generation: 0,
        parentGeneration: null,
        compactionId: null,
        renderParamsJson: serializeDisabledRenderParams(),
        createdAt: Date.now(),
        nodes,
      };
      await saveContextSurface(workspacePath, created);
      rememberContextSurface(workspacePath, created);
      return;
    }

    const updated: PersistedContextSurface = {
      sessionId,
      generation: surface.generation,
      parentGeneration: surface.parentGeneration,
      compactionId: surface.compactionId,
      renderParamsJson: surface.renderParamsJson,
      createdAt: surface.createdAt,
      nodes,
    };
    await saveContextSurface(workspacePath, updated);
    // 缓存必须镜像刚落库的节点：hydrateSessionContext 视缓存为权威
    // （getContextSurfaceCached 命中不回源 DB）。不刷新的话，重建会拿到
    // 「本进程内首次加载/创建时」的旧节点子集，静默截掉之后新增的消息
    // （典型：取消回合后 agent 失效重建 → 被取消回合从模型上下文消失）。
    rememberContextSurface(workspacePath, updated);
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
}

/**
 * 压缩提交（ADR-005）：单事务 started → surface → completed。
 * 成功后更新内存缓存；失败向上抛，由调用方 failContextCheckpoint 溯源。
 *
 * 调用方契约（ADR-005 顺序）：checkpoint 消息必须先持久化进 archive
 * （saveMessageBatch 落库完成）再调用本函数，否则崩溃窗口内 surface
 * 引用的 checkpoint ID 在 archive 中不存在。
 */
export async function commitContextCheckpoint(
  options: CommitContextCheckpointOptions
): Promise<{ compactionId: string; generation: number }> {
  const checkpoint = getLatestCheckpoint(options.messages);
  if (!checkpoint) {
    throw new Error('[surface] 提交压缩失败：消息数组中没有 checkpoint');
  }
  const payload = checkpoint.payload;
  const validated = validateCompactionCommit(payload);
  if (!validated.ok) {
    throw new Error(`[surface] 提交压缩失败：${validated.error}`);
  }

  // 提交必须绕过缓存直读 DB：陈旧缓存会算出错误的 targetGeneration。
  const surface = await loadContextSurface(options.workspacePath, options.sessionId);
  rememberCacheEntry(options.workspacePath, options.sessionId, surface);
  const sourceGeneration = surface?.generation ?? 0;
  const targetGeneration = sourceGeneration + 1;

  const priorMessages = options.messages.slice(0, checkpoint.index);
  const parentCheckpoint = getLatestCheckpoint(priorMessages);

  const summaryInfo = resolveCheckpointSummaryInfo(payload);
  const nodes: SurfaceNodeInput[] = computeSurfaceNodes(options.messages);
  const createdAt = payload.generatedAt || Date.now();
  // v4：render_params 列保留（DB 契约），但恒为禁用常量——prune 层已删除。
  const renderParamsJson = serializeDisabledRenderParams();

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
    degradedReason: summaryInfo.failureCode ?? null,
    createdAt,
    nodes,
    renderParamsJson,
  };

  // 兜底登记：调用方应在插入 checkpoint 时就 markCompactionInFlight，
  // 此处确保任何路径进入事务窗口都被维护守卫感知。
  inFlightCompactionIds.add(request.id);
  try {
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
  } finally {
    inFlightCompactionIds.delete(request.id);
  }
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
  if (payload?.compactionId) {
    inFlightCompactionIds.delete(payload.compactionId);
  }
  let surface: PersistedContextSurface | null = null;
  try {
    surface = await getContextSurfaceCached(options.workspacePath, options.sessionId);
  } catch (err) {
    // 读取失败不阻断失败溯源：sourceGeneration 记 0（审计字段，可容忍）。
    console.warn('[surface] 失败溯源读取 surface 失败:', err instanceof Error ? err.message : err);
  }
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
 * 提交失败后的核实：IPC 拒绝不等于事务失败——提交可能已落库但响应丢失。
 * 绕过缓存直读最新 surface：compactionId 匹配即视为已提交（刷新缓存、
 * 保留 checkpoint）；否则按未提交处理。读取失败保守返回 false。
 */
export async function verifyCompactionLanded(
  workspacePath: string,
  sessionId: string,
  compactionId: string
): Promise<boolean> {
  try {
    const surface = await loadContextSurface(workspacePath, sessionId);
    rememberCacheEntry(workspacePath, sessionId, surface);
    return surface?.compactionId === compactionId;
  } catch (err) {
    console.warn('[surface] 核实提交落库失败:', err instanceof Error ? err.message : err);
    return false;
  }
}

export interface HydratedSessionContext {
  messages: ContextMessageLike[];
  degraded: boolean;
}

/**
 * ADR-002 水合：节点 ID 缺失时标记 degraded，回退 parent generation；
 * 无 parent 或 parent 也缺失则从 archive 重建 generation 0。
 * 禁止把全量数组写回同一 compacted generation（会破坏 generation 语义）。
 */
export async function hydrateSessionContext(
  workspacePath: string,
  sessionId: string,
  archiveMessages: readonly ContextMessageLike[]
): Promise<HydratedSessionContext> {
  const fallback: HydratedSessionContext = {
    messages: [...archiveMessages],
    degraded: false,
  };

  let surface: PersistedContextSurface | null;
  try {
    surface = await getContextSurfaceCached(workspacePath, sessionId);
  } catch {
    return fallback;
  }
  if (!surface || surface.nodes.length === 0) {
    return fallback;
  }

  const nodeIds = surface.nodes.map((node) => node.messageId);
  const hydrated = hydrateSurfaceMessages(archiveMessages, nodeIds);
  if (hydrated.complete) {
    return { messages: hydrated.messages, degraded: false };
  }

  console.warn(
    `[surface] generation ${surface.generation} degraded（节点 ID 缺失），按 ADR-002 回退`
  );

  if (typeof surface.parentGeneration === 'number') {
    try {
      const parent = await loadContextSurface(workspacePath, sessionId, surface.parentGeneration);
      if (parent && parent.nodes.length > 0) {
        const parentHydrated = hydrateSurfaceMessages(
          archiveMessages,
          parent.nodes.map((node) => node.messageId)
        );
        if (parentHydrated.complete) {
          await discardContextSurfacesFromGeneration(workspacePath, sessionId, surface.generation);
          rememberContextSurface(workspacePath, parent);
          return { messages: parentHydrated.messages, degraded: true };
        }
      }
    } catch (err) {
      console.warn(
        '[surface] parent generation 回退失败:',
        err instanceof Error ? err.message : err
      );
    }
  }

  try {
    await discardContextSurfacesFromGeneration(workspacePath, sessionId, 0);
    const nodes = computeSurfaceNodes(archiveMessages);
    const created: PersistedContextSurface = {
      sessionId,
      generation: 0,
      parentGeneration: null,
      compactionId: null,
      renderParamsJson: serializeDisabledRenderParams(),
      createdAt: Date.now(),
      nodes,
    };
    await saveContextSurface(workspacePath, created);
    rememberContextSurface(workspacePath, created);
    return { messages: [...archiveMessages], degraded: true };
  } catch (err) {
    console.warn('[surface] 重建 generation 0 失败:', err instanceof Error ? err.message : err);
    forgetContextSurface(workspacePath, sessionId);
    return { ...fallback, degraded: true };
  }
}
