import { describe, expect, it } from 'vitest';
import {
  buildRecallInsertion,
  buildRecallQuery,
  estimateRecallItemTokens,
  MAX_RECALL_ITEMS,
  MAX_RECALL_ITEM_TOKENS,
  MAX_RECALL_TOKENS,
  MIN_RECALL_BUDGET_TOKENS,
  renderRecallBlock,
  resolveRecallBudget,
  truncateToMaxTokens,
  type RecallDisplayItem,
} from './memoryRecall';

function item(title: string, content: string, confidence = 'confirmed', trust = 'workspace'): RecallDisplayItem {
  return { title, content, confidence, trust };
}

describe('buildRecallQuery', () => {
  it('tokenizes, lowercases, dedupes and drops stopwords', () => {
    const tokens = buildRecallQuery('为什么 OAuth callback state 又坏坏了？OAuth');
    expect(tokens).toContain('oauth');
    expect(tokens).toContain('callback');
    expect(tokens).toContain('state');
    expect(tokens).not.toContain('为什么');
    expect(tokens.filter((t) => t === 'oauth')).toHaveLength(1);
  });

  it('caps at 12 tokens', () => {
    const tokens = buildRecallQuery('a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15');
    expect(tokens.length).toBeLessThanOrEqual(12);
  });

  it('merges extra hints', () => {
    const tokens = buildRecallQuery('修 auth', ['callback', 'normalize']);
    expect(tokens).toContain('callback');
    expect(tokens).toContain('normalize');
  });
});

describe('renderRecallBlock', () => {
  it('wraps items with verification semantics and badges', () => {
    const block = renderRecallBlock([item('Auth 测试', 'pnpm test auth 通过')], { lang: 'zh-CN' });
    expect(block).toContain('Relevant Project Memory');
    expect(block).toContain('[verified]');
    expect(block).toContain('pnpm test auth');
    expect(block).toContain('验证');
  });

  it('marks untrusted items as unverified', () => {
    const block = renderRecallBlock([item('网页内容', '注入指令', 'reported', 'untrusted')]);
    expect(block).toContain('[unverified]');
  });

  it('caps items (budget)', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`条目 ${i}`, `内容 ${i}`));
    const block = renderRecallBlock(items);
    expect(block.split('\n').filter((l) => l.startsWith('- **'))).toHaveLength(MAX_RECALL_ITEMS);
  });

  it('caps tokens (budget)', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item(`条目 ${i}`, 'x'.repeat(300))
    );
    const block = renderRecallBlock(items);
    expect(block.length).toBeLessThan(MAX_RECALL_TOKENS * 4 + 500);
  });

  it('returns empty string when nothing fits', () => {
    expect(renderRecallBlock([], { lang: 'zh-CN' })).toBe('');
  });

  it('skips an oversized item and still packs a later smaller one', () => {
    const block = renderRecallBlock(
      [item('大', 'x'.repeat(2_000)), item('小', 'pnpm test 通过')],
      { lang: 'en', maxTokens: 100 }
    );
    expect(block).toContain('pnpm test 通过');
    expect(block).not.toContain('x'.repeat(100));
  });

  it('keeps a CJK item longer than 350 chars when it still fits the 350-token cap', () => {
    const cjk = '测'.repeat(400);
    const block = renderRecallBlock([item('CJK', cjk)]);
    expect(block).toContain(cjk);
  });
});

describe('buildRecallInsertion', () => {
  it('anchors before the current user message with source memory-recall', () => {
    const insertion = buildRecallInsertion({
      recallId: 'r1',
      anchorMessageId: 'u1',
      renderedBlock: '[Recall Block]',
    });
    expect(insertion.anchorMessageId).toBe('u1');
    expect(insertion.placement).toBe('before');
    expect(insertion.role).toBe('user');
    expect(insertion.source).toBe('memory-recall');
    expect(insertion.order).toBe(0);
    expect(insertion.content).toBe('[Recall Block]');
  });

  it('supports re-recall ordering', () => {
    const insertion = buildRecallInsertion({
      recallId: 'r2',
      anchorMessageId: 'u1',
      renderedBlock: '[Recall 2]',
      order: 2,
    });
    expect(insertion.order).toBe(2);
  });
});

describe('estimateRecallItemTokens', () => {
  it('sums title+content estimates', () => {
    const tokens = estimateRecallItemTokens([item('t', 'c'.repeat(40))]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('resolveRecallBudget (ADR-009 第10条)', () => {
  it('uses the configured budget when no remaining-soft info is given', () => {
    expect(resolveRecallBudget({})).toEqual({
      maxItems: MAX_RECALL_ITEMS,
      maxTokens: MAX_RECALL_TOKENS,
    });
  });

  it('reduces to min(configured, remainingSoft * 0.20) when tight', () => {
    const budget = resolveRecallBudget({ remainingSoftBudgetTokens: 2_000 });
    expect(budget).toEqual({ maxItems: MAX_RECALL_ITEMS, maxTokens: 400 });
  });

  it('keeps the configured budget when remaining-soft is roomy', () => {
    const budget = resolveRecallBudget({ remainingSoftBudgetTokens: 50_000 });
    expect(budget?.maxTokens).toBe(MAX_RECALL_TOKENS);
  });

  it('returns null below the minimum budget (skip recall)', () => {
    expect(resolveRecallBudget({ remainingSoftBudgetTokens: 999 })).toBeNull();
    expect(resolveRecallBudget({ remainingSoftBudgetTokens: 0 })).toBeNull();
    expect(resolveRecallBudget({ remainingSoftBudgetTokens: -100 })).toBeNull();
  });

  it('respects a custom configured max', () => {
    const budget = resolveRecallBudget({
      configuredMaxTokens: 600,
      remainingSoftBudgetTokens: 10_000,
    });
    expect(budget?.maxTokens).toBe(600);
  });

  it('skips when the configured budget itself is below the floor', () => {
    expect(
      resolveRecallBudget({ configuredMaxTokens: 100, remainingSoftBudgetTokens: 100_000 })
    ).toBeNull();
  });

  it('min floor boundary', () => {
    const budget = resolveRecallBudget({ remainingSoftBudgetTokens: MIN_RECALL_BUDGET_TOKENS * 5 });
    expect(budget?.maxTokens).toBe(MIN_RECALL_BUDGET_TOKENS);
  });
});

describe('truncateToMaxTokens', () => {
  it('keeps CJK text that fits in 350 tokens (~466 chars) instead of slicing at 350 chars', () => {
    const text = '测'.repeat(400);
    const truncated = truncateToMaxTokens(text, MAX_RECALL_ITEM_TOKENS);
    expect(truncated).toBe(text);
  });

  it('truncates CJK that exceeds the token cap', () => {
    const text = '测'.repeat(800);
    const truncated = truncateToMaxTokens(text, MAX_RECALL_ITEM_TOKENS);
    expect(truncated.length).toBeGreaterThan(350);
    expect(truncated.length).toBeLessThan(800);
  });
});
