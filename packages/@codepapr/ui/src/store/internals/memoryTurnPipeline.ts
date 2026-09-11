/**
 * memoryTurnPipeline（v5）：MEMORY.md 两个维护卡点的接线层。
 *
 * - 卡点 1（交付）：回合结束处，双信号门命中才异步调 curator（fire-and-forget，
 *   不阻塞回合收尾）。素材 = 本轮用户原话 + 最终 assistant 文本（绝不含工具输出）。
 * - 卡点 2（pre-compact）：epoch 提交前，无条件、带超时 await curator。素材 =
 *   本次压缩将折叠的 v4 骨架（[轮次 n] Q/A + 轮内步骤行）。压缩本来就重置前缀
 *   缓存，这一刀的缓存成本为零；且写入发生在 epoch 重渲染 Bootstrap 之前，
 *   新记忆立刻随 epoch 生效。
 *
 * 两个卡点都绝不抛错、绝不阻塞主流程（AbortError 除外语义在这里不适用：curator
 * 超时/失败只记审计）。pre-compact 超时即 abort 在飞会话 + 写盘前 aborted 检查，
 * 不允许压缩提交后迟到落盘（记忆与 epoch 的时序始终可解释）。最近一次动作记录在
 * 模块状态里，供面板展示「curator 状态行」。
 */

import type { CompactionSettings, UIMessage } from './types';
import type { WorkMode } from '../../utils/agentPrompts';
import {
  buildSkeletonMaterial,
  buildTurnMaterial,
  detectTurnMemorySignals,
  shouldRunDeliveryCurator,
  type SkeletonLike,
} from '../../utils/memoryGate';
import { readMemoryMd } from '../../utils/memoryFile';
import { runMemoryCurator, type CuratorOutcome } from '../../utils/memoryCuratorRunner';

const PRE_COMPACT_TIMEOUT_MS = 20_000;

export interface CuratorAuditEntry {
  kind: CuratorOutcome['kind'] | 'timeout' | 'skipped';
  reasons?: string[];
  at: number;
  /** 触发卡点：turn=交付，compact=压缩前。 */
  trigger: 'turn' | 'compact';
}

const lastOutcome = new Map<string, CuratorAuditEntry>();

export function getLastCuratorOutcome(workspacePath: string): CuratorAuditEntry | undefined {
  return lastOutcome.get(workspacePath.trim());
}

/** 测试/登出清理用。 */
export function clearCuratorOutcomes(): void {
  lastOutcome.clear();
}

function record(
  workspacePath: string,
  trigger: 'turn' | 'compact',
  outcome: { kind: CuratorAuditEntry['kind']; reasons?: string[] }
): void {
  lastOutcome.set(workspacePath.trim(), {
    kind: outcome.kind,
    reasons: outcome.reasons,
    at: Date.now(),
    trigger,
  });
  if (outcome.kind === 'rejected' || outcome.kind === 'failed') {
    console.warn(
      '[memory-curator] %s 卡点 %s: %s%s',
      workspacePath.trim(),
      trigger,
      outcome.kind,
      outcome.reasons?.length ? ` (${outcome.reasons.join(',')})` : ''
    );
  }
}

function withTimeout<T>(task: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function runCuratorSafe(params: {
  workspacePath: string;
  material: string;
  settings: CompactionSettings;
  trigger: 'turn' | 'compact';
  timeoutMs?: number;
}): Promise<void> {
  const { workspacePath, material, settings, trigger, timeoutMs } = params;
  if (!material.trim()) {
    record(workspacePath, trigger, { kind: 'skipped' });
    return;
  }
  try {
    const currentMd = await readMemoryMd(workspacePath);
    type RunOutcome = CuratorOutcome | { kind: 'timeout' };
    // 超时不只是「不再等待」：abort 在飞会话，防止它在压缩提交之后迟到写盘
    // （记忆落后/领先一个 epoch 的时序必须可控）。runMemoryCurator 在写盘前
    // 也会检查 aborted，provider 不响应取消时仍不会落盘。
    const controller = new AbortController();
    const task: Promise<RunOutcome> = runMemoryCurator({
      workspacePath,
      currentMd,
      material,
      settings,
      lang: settings.lang === 'en' ? 'en' : settings.lang === 'zh-TW' ? 'zh-TW' : 'zh-CN',
      abortSignal: controller.signal,
    });
    const outcome = timeoutMs
      ? await withTimeout<RunOutcome>(task, timeoutMs, () => {
          controller.abort();
          return { kind: 'timeout' as const };
        })
      : await task;
    record(
      workspacePath,
      trigger,
      outcome.kind === 'updated'
        ? { kind: 'updated' }
        : { kind: outcome.kind, reasons: 'reasons' in outcome ? outcome.reasons : undefined }
    );
  } catch (err) {
    record(workspacePath, trigger, {
      kind: 'failed',
      reasons: [err instanceof Error ? err.message : String(err)],
    });
  }
}

/**
 * 卡点 1：交付触发（门控）。调用方传「本回合」的消息切片（含本轮 user 消息），
 * 不传全史——否则历史里的旧线索会每回合重复触发。Ask 模式永不触发：它不产生
 * 工作事实，用户约束更多是提问语境，交给压缩前卡点兜底。
 */
export async function runDeliveryCuratorForTurn(params: {
  workspacePath: string;
  turnMessages: readonly UIMessage[];
  settings: CompactionSettings;
  workMode?: WorkMode;
}): Promise<void> {
  if (params.workMode === 'ask') {
    return;
  }
  const signals = detectTurnMemorySignals(params.turnMessages as never);
  if (!shouldRunDeliveryCurator(signals)) {
    return;
  }
  await runCuratorSafe({
    workspacePath: params.workspacePath,
    material: buildTurnMaterial(params.turnMessages as never),
    settings: params.settings,
    trigger: 'turn',
  });
}

/** 卡点 1 的 fire-and-forget 包装（sendMessage 收尾处调用，不 await）。 */
export function scheduleDeliveryCuratorForTurn(params: {
  workspacePath: string;
  turnMessages: readonly UIMessage[];
  settings: CompactionSettings;
  workMode?: WorkMode;
}): void {
  void runDeliveryCuratorForTurn(params).catch(() => undefined);
}

/**
 * 卡点 2：pre-compact 触发（无条件 + 超时）。在 epoch 重渲染 Bootstrap **之前**
 * await，让 curator 写入的新记忆随本 epoch 立即生效；超时则 abort 在飞会话，
 * 本轮记忆保持压缩前状态（落后一个 epoch，面板状态行显示 timeout）。
 */
export async function runPreCompactCurator(params: {
  workspacePath: string;
  skeleton: readonly SkeletonLike[];
  activityText?: string;
  summaryBlock?: string;
  settings: CompactionSettings;
}): Promise<void> {
  const material = buildSkeletonMaterial(params.skeleton, {
    activityText: params.activityText,
    summaryBlock: params.summaryBlock,
  });
  await runCuratorSafe({
    workspacePath: params.workspacePath,
    material,
    settings: params.settings,
    trigger: 'compact',
    timeoutMs: PRE_COMPACT_TIMEOUT_MS,
  });
}
