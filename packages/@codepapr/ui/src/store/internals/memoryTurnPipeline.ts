/**
 * memoryTurnPipeline（v5）：MEMORY.md 两个维护卡点的接线层。
 *
 * - 卡点 1（交付）：回合结束处异步调 curator（fire-and-forget，不阻塞回合收尾）。
 *   双信号门命中走 update 模式；文件预算达压力线（≥90% 硬顶）时切 consolidate。
 *   整理未落盘且文件未变则节流：之后只有显式记住 / 持久禁令 / 记忆候选能再试，
 *   成功的测试命令不再每次冲破节流墙。素材 = 本轮用户原话 + 最终 assistant 文本
 *   （绝不含工具输出）。
 * - 卡点 2（pre-compact）：epoch 提交前，无条件、带超时 await curator；文件达
 *   压力线时同样切 consolidate 模式。素材 = 本次压缩将折叠的 v4 骨架
 *   （[轮次 n] Q/A + 轮内步骤行）。压缩本来就重置前缀缓存，这一刀的缓存成本
 *   为零；且写入发生在 epoch 重渲染 Bootstrap 之前，新记忆立刻随 epoch 生效。
 *
 * 两个卡点都绝不抛错、绝不阻塞主流程（AbortError 除外语义在这里不适用：curator
 * 超时/失败只记审计）。pre-compact 超时即 abort 在飞会话 + 写盘前 aborted 检查，
 * 不允许压缩提交后迟到落盘（记忆与 epoch 的时序始终可解释）。最近一次动作记录在
 * 模块状态里，供面板展示「curator 状态行」；每次动作另追加 JSON 行到
 * `.CodePapr/logs/memory-curator.log`（best-effort，滚动保留最近若干条）——
 * 内存审计重启即失，事故后需要能查「为什么没整理」。
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
import { getMemoryMdPressure, readMemoryMd } from '../../utils/memoryFile';
import {
  runMemoryCurator,
  type CuratorOutcome,
  type MemoryCuratorMode,
} from '../../utils/memoryCuratorRunner';

const PRE_COMPACT_TIMEOUT_MS = 20_000;
const CURATOR_LOG_PATH = '.CodePapr/logs/memory-curator.log';
const CURATOR_LOG_MAX_ENTRIES = 20;

export interface CuratorAuditEntry {
  kind: CuratorOutcome['kind'] | 'timeout' | 'skipped';
  reasons?: string[];
  at: number;
  /** 触发卡点：turn=交付，compact=压缩前。 */
  trigger: 'turn' | 'compact';
  /** 本轮模式：update=常规归整，consolidate=预算压力整理（ADR-017）。 */
  mode?: MemoryCuratorMode;
}

const lastOutcome = new Map<string, CuratorAuditEntry>();

/**
 * 预算压力整理节流：记录上次「未落盘」整理尝试时的文件内容。文件未变时，
 * 无信号与「仅有成功测试/构建」都不再重试。显式记住、持久禁令、记忆候选
 * 可以破墙（新事实还得有机会写进去）。成功落盘后清墙；内容仍超线则下一回合
 * 再试一次，直到压到目标线或再次被拒绝。
 */
const consolidationWall = new Map<string, string>();

export function getLastCuratorOutcome(workspacePath: string): CuratorAuditEntry | undefined {
  return lastOutcome.get(workspacePath.trim());
}

/** 测试/登出清理用。 */
export function clearCuratorOutcomes(): void {
  lastOutcome.clear();
  consolidationWall.clear();
}

/** 追加审计行到 .CodePapr/logs/memory-curator.log（best-effort，不阻塞主流程）。 */
async function writeCuratorLog(
  workspacePath: string,
  entry: CuratorAuditEntry,
  pressure: { tokens: number; lines: number } | null
): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    let previous = '';
    try {
      const read = await invoke<{ content?: string } | null>('read_text_file', {
        workspacePath: workspacePath.trim(),
        relativePath: CURATOR_LOG_PATH,
        maxBytes: 64_000,
      });
      previous = typeof read?.content === 'string' ? read.content : '';
    } catch {
      previous = '';
    }
    const lines = previous
      .split('\n')
      .filter((line) => line.trim())
      .slice(-(CURATOR_LOG_MAX_ENTRIES - 1));
    lines.push(
      JSON.stringify({
        time: new Date(entry.at).toISOString(),
        trigger: entry.trigger,
        mode: entry.mode ?? 'update',
        kind: entry.kind,
        reasons: entry.reasons ?? [],
        tokens: pressure?.tokens ?? null,
        lines: pressure?.lines ?? null,
      })
    );
    await invoke('write_text_file', {
      workspacePath: workspacePath.trim(),
      relativePath: CURATOR_LOG_PATH,
      content: `${lines.join('\n')}\n`,
    });
  } catch {
    // 诊断写入失败不得影响记忆维护
  }
}

/** 显式记忆意图才能冲破整理节流。成功的测试命令不算。 */
function memorySignalBypassesWall(signals: {
  cue: boolean;
  constraint: boolean;
  agentProposal: boolean;
}): boolean {
  return signals.cue || signals.constraint || signals.agentProposal;
}

function noteConsolidationAttempt(
  workspacePath: string,
  currentMd: string | null,
  mode: MemoryCuratorMode,
  outcome: RunOutcome
): void {
  if (mode !== 'consolidate' || currentMd == null) return;
  const key = workspacePath.trim();
  if (outcome.kind === 'updated') consolidationWall.delete(key);
  else consolidationWall.set(key, currentMd);
}

function record(
  workspacePath: string,
  trigger: 'turn' | 'compact',
  outcome: { kind: CuratorAuditEntry['kind']; reasons?: string[] },
  mode: MemoryCuratorMode,
  pressure: { tokens: number; lines: number } | null
): void {
  const entry: CuratorAuditEntry = {
    kind: outcome.kind,
    reasons: outcome.reasons,
    at: Date.now(),
    trigger,
    mode,
  };
  lastOutcome.set(workspacePath.trim(), entry);
  if (outcome.kind === 'rejected' || outcome.kind === 'failed') {
    console.warn(
      '[memory-curator] %s 卡点 %s: %s%s',
      workspacePath.trim(),
      trigger,
      outcome.kind,
      outcome.reasons?.length ? ` (${outcome.reasons.join(',')})` : ''
    );
  }
  void writeCuratorLog(workspacePath, entry, pressure);
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

type RunOutcome = CuratorOutcome | { kind: 'timeout' } | { kind: 'skipped' };

async function runCuratorSafe(params: {
  workspacePath: string;
  material: string;
  settings: CompactionSettings;
  trigger: 'turn' | 'compact';
  mode?: MemoryCuratorMode;
  timeoutMs?: number;
  /** 调用方已读过文件时带入，避免重复读；null=文件缺失。 */
  currentMd?: string | null;
}): Promise<{ outcome: RunOutcome; currentMd: string | null }> {
  const { workspacePath, material, settings, trigger, timeoutMs } = params;
  const mode: MemoryCuratorMode = params.mode ?? 'update';
  const fallbackMd = params.currentMd ?? null;
  // consolidate 模式允许空素材（预算整理不依赖新事实）；update 模式空素材无意义。
  if (!material.trim() && mode !== 'consolidate') {
    record(workspacePath, trigger, { kind: 'skipped' }, mode, null);
    return { outcome: { kind: 'skipped' }, currentMd: fallbackMd };
  }
  try {
    const currentMd =
      params.currentMd !== undefined ? params.currentMd : await readMemoryMd(workspacePath);
    const pressure = getMemoryMdPressure(currentMd);
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
      mode,
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
        : { kind: outcome.kind, reasons: 'reasons' in outcome ? outcome.reasons : undefined },
      mode,
      pressure
    );
    return { outcome, currentMd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(workspacePath, trigger, { kind: 'failed', reasons: [message] }, mode, null);
    return { outcome: { kind: 'failed', message }, currentMd: fallbackMd };
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
  const key = params.workspacePath.trim();
  const currentMd = await readMemoryMd(params.workspacePath);
  const material = buildTurnMaterial(params.turnMessages as never);
  // 达压力线时 update 也切 consolidate：新事实照常合并，同时把文件压回目标线
  // （整理附录明确要求「有新事实一并合并，同时完成压缩」）。
  const overPressure = currentMd ? getMemoryMdPressure(currentMd).overPressure : false;
  const signaled = shouldRunDeliveryCurator(signals);
  if (!signaled && !overPressure) return;
  // 整理节流覆盖「无信号」和「只有成功测试/构建」。显式记住 / 禁令 / 记忆候选破墙。
  if (
    overPressure &&
    currentMd &&
    consolidationWall.get(key) === currentMd &&
    !memorySignalBypassesWall(signals)
  ) {
    return;
  }
  const mode: MemoryCuratorMode = overPressure ? 'consolidate' : 'update';
  const { outcome } = await runCuratorSafe({
    workspacePath: params.workspacePath,
    material,
    settings: params.settings,
    trigger: 'turn',
    mode,
    currentMd,
  });
  noteConsolidationAttempt(params.workspacePath, currentMd, mode, outcome);
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
  const currentMd = await readMemoryMd(params.workspacePath);
  // 达压力线 → consolidate（折叠内容照常合并，同时把文件压回目标线）。
  const mode: MemoryCuratorMode = getMemoryMdPressure(currentMd).overPressure
    ? 'consolidate'
    : 'update';
  const { outcome } = await runCuratorSafe({
    workspacePath: params.workspacePath,
    material,
    settings: params.settings,
    trigger: 'compact',
    mode,
    currentMd,
    timeoutMs: PRE_COMPACT_TIMEOUT_MS,
  });
  noteConsolidationAttempt(params.workspacePath, currentMd, mode, outcome);
}
