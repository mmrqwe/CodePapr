import { describe, expect, it } from 'vitest';
import {
  buildContextBudgetBreakdown,
  decideContextBudgetAction,
  type ContextBudgetStageTokens,
} from './ContextBudget';
import {
  CONTEXT_FACT_MAX_SUMMARY_CHARS,
  truncateFactSummary as truncateFact,
} from './ContextFacts';

const stages: ContextBudgetStageTokens = {
  stablePrefixTokens: 2_000,
  bootstrapTokens: 1_500,
  toolsTokens: 3_000,
  checkpointTokens: 1_200,
  retainedTailTokens: 20_000,
  currentUserInputTokens: 500,
  suffixTokens: 0,
};

describe('buildContextBudgetBreakdown', () => {
  it('sums all input stages plus output reserve', () => {
    const breakdown = buildContextBudgetBreakdown(stages, 2_000);
    expect(breakdown.totalInputTokens).toBe(28_200);
    expect(breakdown.totalTokens).toBe(30_200);
    expect(breakdown.outputReserveTokens).toBe(2_000);
  });
});

describe('decideContextBudgetAction', () => {
  const soft = 40_000;
  const hard = 60_000;

  it('below soft budget → none', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown(stages, 2_000),
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('none');
    expect(decision.overSoftBy).toBe(0);
  });

  it('over soft but under hard → prune-tool-results', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown({ ...stages, retainedTailTokens: 45_000 }, 2_000),
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('prune-tool-results');
    expect(decision.overSoftBy).toBeGreaterThan(0);
    expect(decision.overHardBy).toBe(0);
  });

  it('over hard without provider limit → compact', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown({ ...stages, retainedTailTokens: 90_000 }, 2_000),
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      estimateSource: 'provider',
    });
    expect(decision.action).toBe('compact');
    expect(decision.overHardBy).toBeGreaterThan(0);
  });

  it('over provider limit → emergency-compact', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown({ ...stages, retainedTailTokens: 90_000 }, 2_000),
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      providerContextLimitTokens: 80_000,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('emergency-compact');
  });

  it('provider overflow detected → emergency-compact; already attempted → reject-request', () => {
    const breakdown = buildContextBudgetBreakdown(stages, 2_000);
    expect(
      decideContextBudgetAction({
        breakdown,
        softBudgetTokens: soft,
        hardBudgetTokens: hard,
        providerOverflowDetected: true,
        estimateSource: 'provider',
      }).action
    ).toBe('emergency-compact');
    expect(
      decideContextBudgetAction({
        breakdown,
        softBudgetTokens: soft,
        hardBudgetTokens: hard,
        providerOverflowDetected: true,
        emergencyAlreadyAttempted: true,
        estimateSource: 'provider',
      }).action
    ).toBe('reject-request');
  });

  it('labels the estimate source', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown(stages, 2_000),
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      estimateSource: 'provider',
    });
    expect(decision.estimateSource).toBe('provider');
  });

  it('PR2：provider 实测 token 覆盖 heuristic 估算（estimateSource=provider）', () => {
    // heuristic 估算低于 soft，但 provider 实测高于 soft 且低于 hard → prune。
    const heuristic = buildContextBudgetBreakdown(stages, 2_000);
    expect(heuristic.totalTokens).toBeLessThan(soft);
    const decision = decideContextBudgetAction({
      breakdown: heuristic,
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      providerMeasuredTotalTokens: 50_000,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('prune-tool-results');
    expect(decision.estimateSource).toBe('provider');
    expect(decision.overSoftBy).toBe(10_000);

    // 实测高于 hard → compact。
    const overHard = decideContextBudgetAction({
      breakdown: heuristic,
      softBudgetTokens: soft,
      hardBudgetTokens: hard,
      providerMeasuredTotalTokens: 70_000,
      estimateSource: 'heuristic',
    });
    expect(overHard.action).toBe('compact');
    expect(overHard.estimateSource).toBe('provider');
    expect(overHard.overHardBy).toBe(10_000);
  });
});

describe('fact summary truncation', () => {
  it('caps fact summaries', () => {
    expect(truncateFact('x'.repeat(2_000)).length).toBe(CONTEXT_FACT_MAX_SUMMARY_CHARS);
  });

  it('normalizes whitespace', () => {
    expect(truncateFact('  a\n\n b  ')).toBe('a b');
  });
});
