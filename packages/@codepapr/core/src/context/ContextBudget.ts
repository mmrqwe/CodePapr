/**
 * Context Budget：基于最终请求形态的 token 决策（PR2）。
 *
 * 纯函数，不 import provider：预算输入是各阶段 token 估算 + 阈值，输出是
 * 动作决策。估算来源必须标注（heuristic bytes/4 vs provider usage），
 * 可用时与 provider usage 对账。
 *
 * 决策语义（用户设定的 maxContextTokens 是权威，不按 provider 名义窗口
 * 硬钳制；provider limit 仅作为 overflow 预判，真实 overflow 是实证信号）：
 * - 低于 soft budget：不压缩；
 * - soft ~ hard：先 prune/externalize；
 * - 超过 hard：compact；
 * - 超过 provider limit 或检测到 provider overflow：emergency-compact；
 * - emergency 已尝试仍超限：reject-request（调用方终止本轮并给结构化错误）。
 */

export type ContextBudgetAction =
  | 'none'
  | 'prune-tool-results'
  | 'compact'
  | 'emergency-compact'
  | 'reject-request';

/**
 * PR2：reject-request 的结构化错误（emergency-compact 已尝试仍超限）。
 * 调用方（主线程 sendMessage）据此终止本轮并给用户结构化提示，
 * 而不是把 raw provider error 展示给用户。
 */
export class ContextBudgetRejectedError extends Error {
  readonly overHardBy: number;
  readonly estimateSource: ContextEstimateSource;

  constructor(overHardBy: number, estimateSource: ContextEstimateSource) {
    super(
      `上下文超出用户设定的上限（${estimateSource} 估算，超出硬预算 ${overHardBy} token），` +
        '紧急压缩后仍然超限。请降低单次任务规模、清空旧会话或调大 maxContextTokens。'
    );
    this.name = 'ContextBudgetRejectedError';
    this.overHardBy = overHardBy;
    this.estimateSource = estimateSource;
  }
}

export type ContextEstimateSource = 'heuristic' | 'provider';

/** 各阶段输入 token（估算值，来源由 estimateSource 标注）。 */
export interface ContextBudgetStageTokens {
  /** Immutable Prefix（system prompt / few-shot）。 */
  stablePrefixTokens: number;
  /** Session Bootstrap（memory snapshot / skills / project-graph）。 */
  bootstrapTokens: number;
  /** 工具定义 schema。 */
  toolsTokens: number;
  /** 当前 checkpoint 渲染内容。 */
  checkpointTokens: number;
  /** Retained tail（模型可见历史）。 */
  retainedTailTokens: number;
  /** 当前用户输入。 */
  currentUserInputTokens: number;
  /** 请求续写 suffix（question 答案等）。 */
  suffixTokens: number;
}

export interface ContextBudgetBreakdown extends ContextBudgetStageTokens {
  /** 预留输出额度。 */
  outputReserveTokens: number;
  totalInputTokens: number;
  totalTokens: number;
}

export function buildContextBudgetBreakdown(
  stages: ContextBudgetStageTokens,
  outputReserveTokens: number
): ContextBudgetBreakdown {
  const totalInputTokens =
    stages.stablePrefixTokens +
    stages.bootstrapTokens +
    stages.toolsTokens +
    stages.checkpointTokens +
    stages.retainedTailTokens +
    stages.currentUserInputTokens +
    stages.suffixTokens;
  return {
    ...stages,
    outputReserveTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputReserveTokens,
  };
}

export interface ContextBudgetDecisionInput {
  breakdown: ContextBudgetBreakdown;
  /** 用户设定的软预算（maxContextTokens 的一部分，PR3 落地配置）。 */
  softBudgetTokens: number;
  /** 用户设定的硬预算（= effectiveMaxContextTokens）。 */
  hardBudgetTokens: number;
  /** provider 名义上下文窗口（转发网关场景可大于名义值，仅作 overflow 预判）。 */
  providerContextLimitTokens?: number;
  /** 实证信号：provider 已返回 context_length_exceeded。 */
  providerOverflowDetected?: boolean;
  /** 本次溢出已尝试过 emergency-compact（PR3：至多一次重试）。 */
  emergencyAlreadyAttempted?: boolean;
  /** provider 实测输入 token（上一次请求的 usage.input_tokens，且当前 log
   *  状态与测量时一致才可传入）——对账覆盖 heuristic 估算，
   *  estimateSource 取 'provider'。 */
  providerMeasuredTotalTokens?: number;
  estimateSource: ContextEstimateSource;
}

export interface ContextBudgetDecision {
  action: ContextBudgetAction;
  /** 超出 soft 的 token 数（0 表示未超）。 */
  overSoftBy: number;
  /** 超出 hard 的 token 数（0 表示未超）。 */
  overHardBy: number;
  estimateSource: ContextEstimateSource;
}

export function decideContextBudgetAction(input: ContextBudgetDecisionInput): ContextBudgetDecision {
  const { breakdown } = input;
  const providerLimit = input.providerContextLimitTokens;
  const measured = input.providerMeasuredTotalTokens;
  const estimateSource = measured !== undefined ? 'provider' : input.estimateSource;
  const totalTokens = measured ?? breakdown.totalTokens;
  const overSoftBy = Math.max(0, totalTokens - input.softBudgetTokens);
  const overHardBy = Math.max(0, totalTokens - input.hardBudgetTokens);

  if (input.providerOverflowDetected) {
    return {
      action: input.emergencyAlreadyAttempted ? 'reject-request' : 'emergency-compact',
      overSoftBy,
      overHardBy,
      estimateSource,
    };
  }

  if (overSoftBy === 0) {
    return { action: 'none', overSoftBy: 0, overHardBy: 0, estimateSource };
  }

  if (overHardBy === 0) {
    return {
      action: 'prune-tool-results',
      overSoftBy,
      overHardBy: 0,
      estimateSource,
    };
  }

  if (providerLimit !== undefined && totalTokens > providerLimit) {
    return {
      action: 'emergency-compact',
      overSoftBy,
      overHardBy,
      estimateSource,
    };
  }

  return { action: 'compact', overSoftBy, overHardBy, estimateSource };
}
