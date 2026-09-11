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

  it('includes request-only insertion tokens (ADR-009 rule 15)', () => {
    const breakdown = buildContextBudgetBreakdown({ ...stages, insertionTokens: 1_200 }, 2_000);
    expect(breakdown.totalInputTokens).toBe(29_400);
    expect(breakdown.totalTokens).toBe(31_400);
  });

  it('treats missing insertionTokens as zero (backward compatible)', () => {
    const breakdown = buildContextBudgetBreakdown(stages, 0);
    expect(breakdown.totalInputTokens).toBe(28_200);
  });
});

describe('decideContextBudgetAction（v4 单层触发线）', () => {
  const trigger = 60_000;

  it('below the trigger line → none', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown(stages, 2_000),
      hardBudgetTokens: trigger,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('none');
    expect(decision.overHardBy).toBe(0);
  });

  it('over the trigger line → compact', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown({ ...stages, retainedTailTokens: 90_000 }, 2_000),
      hardBudgetTokens: trigger,
      estimateSource: 'provider',
    });
    expect(decision.action).toBe('compact');
    expect(decision.overHardBy).toBeGreaterThan(0);
  });

  it('over provider limit → emergency-compact', () => {
    const decision = decideContextBudgetAction({
      breakdown: buildContextBudgetBreakdown({ ...stages, retainedTailTokens: 90_000 }, 2_000),
      hardBudgetTokens: trigger,
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
        hardBudgetTokens: trigger,
        providerOverflowDetected: true,
        estimateSource: 'provider',
      }).action
    ).toBe('emergency-compact');
    expect(
      decideContextBudgetAction({
        breakdown,
        hardBudgetTokens: trigger,
        providerOverflowDetected: true,
        emergencyAlreadyAttempted: true,
        estimateSource: 'provider',
      }).action
    ).toBe('reject-request');
  });

  it('PR2：provider 实测 token 覆盖 heuristic 估算（estimateSource=provider）', () => {
    const heuristic = buildContextBudgetBreakdown(stages, 2_000);
    expect(heuristic.totalTokens).toBeLessThan(trigger);
    // 实测越过触发线 → compact，来源标记 provider。
    const decision = decideContextBudgetAction({
      breakdown: heuristic,
      hardBudgetTokens: trigger,
      providerMeasuredTotalTokens: 70_000,
      estimateSource: 'heuristic',
    });
    expect(decision.action).toBe('compact');
    expect(decision.estimateSource).toBe('provider');
    expect(decision.overHardBy).toBe(10_000);
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
