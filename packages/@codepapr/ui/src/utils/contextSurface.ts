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

import type { CompactionTrigger, FrozenPruneParams } from '@codepapr/types';
import type { PruneOptions } from '@codepapr/core';
import {
  getLatestCheckpoint,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from './contextCompaction';

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
 */
export function isModelVisibleUiMessage(message: ContextMessageLike): boolean {
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
 * 按 surface 节点 ID 从消息数组水合模型历史子集（ADR-003：surface 是唯一
 * 选择权威）。`complete=false` 表示有节点 ID 在数组里不存在（degraded），
 * 调用方应回退整数组并重新引导 surface。
 */
export function hydrateSurfaceMessages(
  messages: readonly ContextMessageLike[],
  nodeIds: readonly string[]
): { messages: ContextMessageLike[]; complete: boolean } {
  const idSet = new Set(nodeIds);
  const filtered = messages.filter((message) => idSet.has(message.id));
  const complete =
    filtered.length === nodeIds.length &&
    nodeIds.every((id) => messages.some((message) => message.id === id));
  return { messages: filtered, complete };
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

/** PruneOptions（Set）→ 可序列化冻结形式（ADR-006）。 */
export function freezePruneParams(pruneOptions: PruneOptions): FrozenPruneParams {
  return {
    enabled: pruneOptions.enabled,
    protectRecentRounds: pruneOptions.protectRecentRounds,
    minPrunableChars: pruneOptions.minPrunableChars,
    protectedTools: [...pruneOptions.protectedTools],
    placeholder: pruneOptions.placeholder,
  };
}

/**
 * generation 0（未压缩会话）的冻结参数：该 epoch 从未经过 prune，重启重建
 * 必须同样不 prune 才能与 live 字节一致（ADR-006）。
 */
export function buildDisabledFrozenPruneParams(): FrozenPruneParams {
  return {
    enabled: false,
    protectRecentRounds: 0,
    minPrunableChars: 0,
    protectedTools: [],
    placeholder: '',
  };
}

/** 冻结形式 → PruneOptions（string[] → Set）。解析失败返回 null。 */
export function parseRenderParams(json: string): { pruneOptions: PruneOptions } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { pruneParams?: FrozenPruneParams };
    const params = record.pruneParams;
    if (!params || typeof params !== 'object') return null;
    const protectedTools = new Set<string>();
    if (Array.isArray(params.protectedTools)) {
      for (const tool of params.protectedTools) {
        if (typeof tool === 'string') protectedTools.add(tool);
      }
    }
    return {
      pruneOptions: {
        enabled: params.enabled === true,
        protectRecentRounds: typeof params.protectRecentRounds === 'number' ? params.protectRecentRounds : 0,
        minPrunableChars: typeof params.minPrunableChars === 'number' ? params.minPrunableChars : 0,
        protectedTools,
        placeholder: typeof params.placeholder === 'string' ? params.placeholder : '',
      },
    };
  } catch {
    return null;
  }
}

/** generation 行 render_params 列的 JSON（ADR-006）。 */
export function serializeRenderParams(pruneOptions: PruneOptions): string {
  return JSON.stringify({
    pruneParams: freezePruneParams(pruneOptions),
    renderVersion: CONTEXT_SURFACE_RENDER_VERSION,
  });
}

/** generation 0 的 render_params JSON（禁用 prune，见 buildDisabledFrozenPruneParams）。 */
export function serializeDisabledRenderParams(): string {
  return JSON.stringify({
    pruneParams: buildDisabledFrozenPruneParams(),
    renderVersion: CONTEXT_SURFACE_RENDER_VERSION,
  });
}

/** 从 payload 派生 trigger/summary 兜底（payload 缺 provenance 时）。 */
export function resolveCheckpointSummaryInfo(
  payload: ContextCheckpointPayload
): { kind: 'llm' | 'local-fallback'; provider?: string; model?: string } {
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
