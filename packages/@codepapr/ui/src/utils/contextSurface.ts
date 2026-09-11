/**
 * Context Surface 纯函数（PR1，ADR-001/003/006）。
 *
 * 只含确定性计算，不 import tauri/IPC（编排逻辑见
 * store/internals/contextSurfaceStore.ts），保证可直接单测。
 *
 * Surface 节点 = 当前 model-visible 投影：checkpoint 节点 + retained tail
 * 中被 toCoreTailMessages 保留的 UI 消息（过滤规则镜像
 * contextCompaction.ts:185-191）。
 */

import type { CompactionTrigger } from '@codepapr/types';
import {
  getLatestCheckpoint,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from './contextCompaction';
import { CONTEXT_CHECKPOINT_VERSION_3, type ContextCheckpointPayloadV3 } from './contextCheckpointState';
import { CONTEXT_COMPACTION_VERSION_V4 } from '@codepapr/core';
import { validateContextCheckpointStateV3 } from './contextStateMerge';

/** Worker log / 重建注入的 session bootstrap 消息 ID（不属于 archive / surface）。 */
export const SESSION_BOOTSTRAP_MESSAGE_ID = 'session-bootstrap';

export function isSessionBootstrapMessage(message: {
  id: string;
  sessionBootstrap?: boolean;
  metadata?: { sessionBootstrap?: unknown };
}): boolean {
  return (
    message.id === SESSION_BOOTSTRAP_MESSAGE_ID ||
    message.sessionBootstrap === true ||
    message.metadata?.sessionBootstrap === true
  );
}

/** PR1 首版渲染参数版本；编译器代码升级时递增并接受一次性 cache miss（ADR-006）。 */
export const CONTEXT_SURFACE_RENDER_VERSION = 1;

export type SurfaceNodeKind = 'checkpoint' | 'conversation' | 'injected';

export interface SurfaceNodeInput {
  position: number;
  messageId: string;
  nodeKind: SurfaceNodeKind;
}

/**
 * toCoreTailMessages 的 UI 层过滤规则镜像：
 * 只保留 user/assistant；synthetic 仅当 assistant 且 carryForwardInContext。
 * session-bootstrap 不是 archive 消息，不进入 surface / 溯源 ID。
 */
export function isModelVisibleUiMessage(message: ContextMessageLike): boolean {
  if (isSessionBootstrapMessage(message)) {
    return false;
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  if (message.synthetic) {
    return message.role === 'assistant' && message.carryForwardInContext === true;
  }
  return true;
}

/** 计算当前 model-visible 投影的 surface 节点序列。 */
export function computeSurfaceNodes(
  messages: readonly ContextMessageLike[]
): SurfaceNodeInput[] {
  const checkpoint = getLatestCheckpoint(messages);
  const tailStart = checkpoint ? checkpoint.index + 1 : 0;
  const nodes: SurfaceNodeInput[] = [];
  if (checkpoint) {
    nodes.push({ position: 0, messageId: checkpoint.message.id, nodeKind: 'checkpoint' });
  }
  for (const message of messages.slice(tailStart)) {
    if (isModelVisibleUiMessage(message)) {
      nodes.push({
        position: nodes.length,
        messageId: message.id,
        nodeKind: 'conversation',
      });
    }
  }
  return nodes;
}

/** 当前数组里的最新 checkpoint payload（无则为 null）。 */
export function getLatestCheckpointPayload(
  messages: readonly ContextMessageLike[]
): ContextCheckpointPayload | null {
  return getLatestCheckpoint(messages)?.payload ?? null;
}

/**
 * 按 surface 节点 position / nodeIds 顺序从消息数组水合模型历史子集
 * （ADR-003：surface 是唯一选择权威）。不得按 archive 数组序重排。
 * `complete=false` 表示有节点 ID 在数组里不存在（degraded），
 * 调用方应回退整数组并重新引导 surface。
 */
export function hydrateSurfaceMessages(
  messages: readonly ContextMessageLike[],
  nodeIds: readonly string[]
): { messages: ContextMessageLike[]; complete: boolean } {
  const byId = new Map<string, ContextMessageLike>();
  for (const message of messages) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  const hydrated: ContextMessageLike[] = [];
  let complete = true;
  for (const id of nodeIds) {
    const message = byId.get(id);
    if (!message) {
      complete = false;
      continue;
    }
    hydrated.push(message);
  }
  return { messages: hydrated, complete };
}

/**
 * 计算压缩的 UI 级来源区间（ADR-001 不可变 provenance 用 message ID）：
 * - source = 最新 checkpoint 之后、insertIndex 之前的可见消息；
 * - retained tail = insertIndex 之后（含）的可见消息。
 */
export function computeCheckpointProvenanceRanges(
  messages: readonly ContextMessageLike[],
  insertIndex: number
): {
  sourceStartMessageId?: string;
  sourceEndMessageId?: string;
  retainedTailStartMessageId?: string;
  retainedMessageCount: number;
} {
  const checkpoint = getLatestCheckpoint(messages);
  const tailStart = checkpoint ? checkpoint.index + 1 : 0;
  const clamped = Math.min(Math.max(insertIndex, 0), messages.length);
  const sourceVisible = messages.slice(tailStart, clamped).filter(isModelVisibleUiMessage);
  const retainedVisible = messages.slice(clamped).filter(isModelVisibleUiMessage);
  return {
    sourceStartMessageId: sourceVisible[0]?.id,
    sourceEndMessageId: sourceVisible[sourceVisible.length - 1]?.id,
    retainedTailStartMessageId: retainedVisible[0]?.id,
    retainedMessageCount: retainedVisible.length,
  };
}

/** mid-loop 提交的本回合锚点：主线程 user 消息 ID + source 区间内本回合的
 *  model-visible assistant 回合数（worker log 坐标，compactionHandler 计算）。 */
export interface TurnAnchor {
  userMessageId: string;
  sourceAssistantRoundsInTurn: number;
}

/**
 * mid-loop 压缩的 checkpoint 在 store 消息数组里的安全插入位置（按 ID 定位，
 * 抗 insertIndex 漂移）：
 * 1. 优先插入到第一条 retained 消息之前（retained 起点在 archive 可解析时
 *    这是精确边界）；
 * 2. retained 起点整体落在 worker-only 区域（本回合 assistant/tool 消息的 ID
 *    由 worker 生成、不在 archive）时，按回合映射：anchor user 消息之后跳过
 *    sourceAssistantRoundsInTurn 条 model-visible assistant 消息，插在其后——
 *    worker log 与 UI 的 assistant 回合按顺序一一对应；
 * 3. 回退：插入到最后一条 source 消息之后（legacy 兼容，无 anchor 时）；
 * 4. 都定位不到返回 null（调用方应放弃提交并标记失败——宁可放弃压缩，
 *    不可错位插入，同 ADR-009 anchor miss 兜底语义）。
 */
export function findCheckpointInsertIndex(
  liveMessages: readonly ContextMessageLike[],
  sourceMessageIds: readonly string[],
  retainedMessageIds: readonly string[],
  turnAnchor?: TurnAnchor
): number | null {
  const retainedIndex = firstIndexOfAny(liveMessages, retainedMessageIds);
  if (retainedIndex !== null) {
    return retainedIndex;
  }

  if (turnAnchor && turnAnchor.sourceAssistantRoundsInTurn >= 0) {
    const userIndex = firstIndexOfAny(liveMessages, [turnAnchor.userMessageId]);
    if (userIndex !== null) {
      if (turnAnchor.sourceAssistantRoundsInTurn === 0) {
        return userIndex + 1;
      }
      let seen = 0;
      for (let i = userIndex + 1; i < liveMessages.length; i++) {
        const message = liveMessages[i]!;
        if (message.role === 'assistant' && isModelVisibleUiMessage(message)) {
          seen += 1;
          if (seen === turnAnchor.sourceAssistantRoundsInTurn) {
            return i + 1;
          }
        }
      }
      // archive 里本回合 assistant 回合数少于 source 声称的数量（消息被
      // reset/取消、回合计数漂移）：映射不可信，不回退旧逻辑（会把已摘要
      // 内容留在 checkpoint 之后造成重复），直接放弃。
      return null;
    }
  }

  const sourceIndex = lastIndexOfAny(liveMessages, sourceMessageIds);
  if (sourceIndex !== null) {
    return sourceIndex + 1;
  }
  return null;
}

function firstIndexOfAny(
  messages: readonly ContextMessageLike[],
  ids: readonly string[]
): number | null {
  if (ids.length === 0) return null;
  const idSet = new Set(ids);
  for (let i = 0; i < messages.length; i++) {
    if (idSet.has(messages[i]!.id)) return i;
  }
  return null;
}

function lastIndexOfAny(
  messages: readonly ContextMessageLike[],
  ids: readonly string[]
): number | null {
  if (ids.length === 0) return null;
  const idSet = new Set(ids);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (idSet.has(messages[i]!.id)) return i;
  }
  return null;
}

/**
 * generation 行 render_params 列的 JSON（ADR-006 列保留，v4 起恒为「禁用
 * prune」常量形状）：prune 层随 v4 骨架引擎删除，但该列是 Rust/DB 与旧存档
 * 的既有契约，保留列与形状、只停止语义化使用——旧行里的 prune 参数不再被
 * 读取，重建路径与实时路径天然一致。
 */
export function serializeDisabledRenderParams(): string {
  return JSON.stringify({
    pruneParams: {
      enabled: false,
      protectRecentRounds: 0,
      minPrunableChars: 0,
      protectedTools: [],
      placeholder: '',
    },
    renderVersion: CONTEXT_SURFACE_RENDER_VERSION,
  });
}

/** 从 payload 派生 trigger/summary 兜底（payload 缺 provenance 时）。 */
export function resolveCheckpointSummaryInfo(payload: ContextCheckpointPayload): {
  kind: 'llm' | 'local-fallback';
  provider?: string;
  model?: string;
  /** F：local-fallback 的具体原因（compactor_unavailable / empty_output /
   *  parse_failed / pinned_validation_failed / merge_failed），落到
   *  context_compactions.failure_code。 */
  failureCode?: string;
} {
  if (payload.summaryInfo) return payload.summaryInfo;
  if (payload.modelTier === 'local') {
    return { kind: 'local-fallback' };
  }
  return { kind: 'llm', model: payload.modelName };
}

export function resolveCheckpointTrigger(
  payload: ContextCheckpointPayload,
  fallback: CompactionTrigger
): CompactionTrigger {
  return payload.trigger ?? fallback;
}

/**
 * 主线程压缩提交校验（ADR-005）：schema 有效 + 有效缩容。
 * pinned 内容在 maybeGenerateContextCheckpoint 生成时已校验；此处再拦
 * 无 compactionId / 未缩容 / v3 state 不合法的 intent。
 */
export function validateCompactionCommit(
  payload: ContextCheckpointPayload | null | undefined
): { ok: true } | { ok: false; error: string } {
  if (!payload) {
    return { ok: false, error: '缺少 checkpoint payload' };
  }
  if (!payload.compactionId?.trim()) {
    return { ok: false, error: '缺少 compactionId' };
  }
  if (typeof payload.sourceMessageCount === 'number' && payload.sourceMessageCount <= 0) {
    return { ok: false, error: '无效缩容：sourceMessageCount 为 0' };
  }
  const before = payload.tokenStats?.estimatedTokensBefore;
  const after = payload.tokenStats?.estimatedTokensAfter;
  if (typeof before === 'number' && typeof after === 'number' && after >= before) {
    return { ok: false, error: `无效缩容：${after} 未小于压缩前 ${before}` };
  }
  if (payload.version === CONTEXT_CHECKPOINT_VERSION_3) {
    const state = (payload as ContextCheckpointPayloadV3).state;
    if (!validateContextCheckpointStateV3(state)) {
      return { ok: false, error: 'checkpoint state schema 不合法' };
    }
  }
  if (payload.version === CONTEXT_COMPACTION_VERSION_V4) {
    // v4 骨架块：skeleton 必须是数组且每行有 userId/q/a；或走二级摘要
    // （summaryBlock 非空）。两者都空 = 空转 checkpoint，拒绝。
    const skeleton = payload.skeleton;
    const hasSkeleton =
      Array.isArray(skeleton) &&
      skeleton.length > 0 &&
      skeleton.every((e) => e && typeof e.userId === 'string' && typeof e.q === 'string' && typeof e.a === 'string');
    const hasSummary = Boolean(payload.summaryBlock?.trim());
    if (!hasSkeleton && !hasSummary) {
      return { ok: false, error: 'v4 checkpoint 缺少骨架与摘要块' };
    }
    if (!payload.renderedContent?.trim()) {
      return { ok: false, error: 'v4 checkpoint 缺少渲染文本' };
    }
  }
  return { ok: true };
}
