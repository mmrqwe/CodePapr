import { describe, expect, it } from 'vitest';
import {
  buildRecallInsertion,
  buildRecallQuery,
  filterAutoRecallItems,
  MAX_RECALL_ITEMS,
  MAX_RECALL_ITEM_TOKENS,
  MAX_RECALL_TOKENS,
  MIN_RECALL_BUDGET_TOKENS,
  renderRecallBlock,
  resolveRecallBudget,
  selectDiverseRecallItems,
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

  it('caps at 24 tokens', () => {
    const tokens = buildRecallQuery('a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17 a18 a19 a20 a21 a22 a23 a24 a25 a26 a27');
    expect(tokens.length).toBeLessThanOrEqual(24);
  });

  it('M1：无空格中文切 2 字 bigram，不再整句成单 token', () => {
    const tokens = buildRecallQuery('这个项目的测试框架是什么来着');
    // 「这个」是虚词 bigram（全停用词），不应出现；实词窗口必须可召回。
    expect(tokens).toContain('测试');
    expect(tokens).toContain('框架');
    expect(tokens).toContain('项目');
    expect(tokens).not.toContain('这个项目的测试框架是什么来着');
    expect(tokens).not.toContain('这个');
    expect(tokens).not.toContain('什么');
  });

  it('M1：中英混排保留标识符、汉字段单独切窗', () => {
    const tokens = buildRecallQuery('vitest跑不过怎么办');
    expect(tokens).toContain('vitest');
    expect(tokens).toContain('跑不');
    expect(tokens).toContain('不过');
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

describe('filterAutoRecallItems', () => {
  it('drops citations from automatic recall but keeps facts and procedures', () => {
    const filtered = filterAutoRecallItems([
      { category: 'fact', content: 'pnpm' },
      { category: 'citation', content: 'blog' },
      { category: 'procedure', content: 'E0597' },
    ]);
    expect(filtered.map((item) => item.category)).toEqual(['fact', 'procedure']);
  });
});

describe('selectDiverseRecallItems', () => {
  const blob = (n: number, extra = '') =>
    `## 项目初始化记忆\n\n### 目录结构\n- \`iPod/\` (5 files): AppDelegate.swift, ViewController.swift, Music.swift, Menu.swift, normalfunc.swift\n- \`html/js/\` (8 files): control.js, music.js, script.js, jqClock.js, jquery.knob.js\n### 技术栈\n- Swift + WebKit + jQuery 1.7.1\n### 约定\n- 先读再改，只改任务所需${extra}`.repeat(1) + `\n变体 ${n}`;

  it('collapses near-identical variants so one blob cannot monopolize the block', () => {
    const items = [0, 1, 2, 3, 4, 5].map((n) => ({
      category: 'fact',
      content: blob(n, n % 2 === 0 ? '，不顺手重构' : '，不动生成物'),
    }));
    const picked = selectDiverseRecallItems(items);
    expect(picked.length).toBeLessThan(items.length);
    expect(picked.length).toBeGreaterThan(0);
  });

  it('keeps unrelated items', () => {
    const picked = selectDiverseRecallItems([
      { category: 'constraint', content: '提交前必须跑 pnpm lint 并等它通过，不通过不得推送' },
      { category: 'verification', content: 'bash: pnpm test auth → 12 passing in 3s' },
      { category: 'decision', content: 'DRM 曲目走 applicationMusicPlayer，普通曲目走 AVPlayer' },
    ]);
    expect(picked).toHaveLength(3);
  });

  it('caps a single category so one kind cannot fill every slot', () => {
    const items = Array.from({ length: 6 }, (_, n) => ({
      category: 'fact',
      content: `第 ${n} 条完全不同的事实：模块 m${n} 负责 ${'职责'.repeat(30)}，编号 ${n}${'x'.repeat(n)}`,
    }));
    const picked = selectDiverseRecallItems(items);
    expect(picked.length).toBeLessThanOrEqual(3);
  });

  it('treats a checkpoint that embeds another as a duplicate', () => {
    const inner = '## 目标\n- 排查 iPod.app 日志异常（sandbox extension / WebContent）\n## 结论\n- 日志无致命错误，问题在音频路由';
    const outer = `${inner}\n## 追加\n- 进一步定位到 applicationMusicPlayer 分流缺失`;
    const picked = selectDiverseRecallItems([
      { category: 'checkpoint', content: outer },
      { category: 'checkpoint', content: inner },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.content).toBe(outer);
  });
});
