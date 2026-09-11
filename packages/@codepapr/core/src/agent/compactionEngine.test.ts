import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { estimateTokens } from '@codepapr/common';
import {
  deterministicSummary,
  foldRoundActivity,
  planSkeletonCompaction,
  preSizeSummaryInput,
  renderSkeletonEntries,
  roundsFromCoreMessages,
  skeletonEntryFromRound,
} from './compactionEngine';

function user(id: string, text: string): IMessage {
  return { id, role: 'user', content: text, timestamp: 1 } as IMessage;
}

function assistant(id: string, text: string, tools: string[] = []): IMessage {
  return {
    id,
    role: 'assistant',
    content: text,
    timestamp: 1,
    toolCalls: tools.map((name, index) => ({ id: `${id}-c${index}`, name, arguments: {} })),
  } as IMessage;
}

function tool(id: string, callId: string, text: string): IMessage {
  return {
    id,
    role: 'tool',
    content: text,
    timestamp: 1,
    toolResult: { toolCallId: callId, success: true, result: text },
  } as IMessage;
}

/** 一整个回合：user + assistant(1 个工具调用) + tool 结果。 */
function makeRound(index: number, toolPadChars = 2000, answerPadChars = 80): IMessage[] {
  return [
    user(`u${index}`, `question number ${index} ${'q'.repeat(80)}`),
    assistant(`a${index}`, `answer number ${index} ${'a'.repeat(answerPadChars)}`, ['bash']),
    tool(`t${index}`, `a${index}-c0`, 'x'.repeat(toolPadChars)),
  ];
}

describe('roundsFromCoreMessages', () => {
  it('splits rounds at user messages and attributes tool results to the preceding turn', () => {
    const messages: IMessage[] = [
      user('u1', 'first question'),
      assistant('a1', 'mid', ['read']),
      tool('t1', 'a1-c0', 'x'.repeat(400)),
      assistant('a2', 'final summary'),
      user('u2', 'second question'),
      assistant('a3', 'done', []),
    ];
    const rounds = roundsFromCoreMessages(messages);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.userId).toBe('u1');
    expect(rounds[0]!.turns.map((t) => t.id)).toEqual(['a1', 'a2']);
    // 400 字节的工具结果（100+ token）计入 a1 所在回合与其 turn。
    expect(rounds[0]!.originalTokens).toBeGreaterThan(estimateTokens('first question') + 100);
    expect(rounds[1]!.originalTokens).toBeLessThan(30);
    expect(rounds[0]!.sourceMessageIds).toEqual(['u1', 'a1', 't1', 'a2']);
  });

  it('groups leading assistant messages into an anonymous head round', () => {
    const rounds = roundsFromCoreMessages([assistant('a0', 'proactive'), user('u1', 'q')]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.userId).toContain('-head');
    expect(rounds[0]!.userText).toBe('');
  });
});

describe('skeleton entries', () => {
  it('truncates Q to the head and A to head+tail deterministically', () => {
    const rounds = roundsFromCoreMessages([
      user('u1', 'y'.repeat(500)),
      assistant('a1', 'z'.repeat(1000), []),
    ]);
    const entry = skeletonEntryFromRound(rounds[0]!, 'zh-CN');
    expect(entry.q.length).toBe(300);
    expect(entry.q.endsWith('…')).toBe(true);
    expect(entry.a.length).toBe(401);
    expect(entry.a).toContain('…');
    expect(entry.a.startsWith('z')).toBe(true);
    expect(entry.a.endsWith('z')).toBe(true);
    expect(entry.assistantId).toBe('a1');
  });

  it('A 结构感知：中段被丢弃时优先保留标题与代码块', () => {
    const longPlan = [
      '# 重构方案',
      '步骤说明 '.repeat(40),
      'x'.repeat(400),
      '## 关键决策',
      '```ts',
      'const value = 1;',
      '```',
      'z'.repeat(300),
    ].join('\n');
    const rounds = roundsFromCoreMessages([user('u1', 'q'), assistant('a1', longPlan, [])]);
    const entry = skeletonEntryFromRound(rounds[0]!, 'zh-CN');
    expect(entry.a).toContain('## 关键决策');
    expect(entry.a).toContain('```ts');
    expect(entry.a).toContain('const value = 1;');
    expect((entry.a.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('A 结构感知：头部切断代码块时补闭合围栏，单行可独立阅读', () => {
    const longCode = [
      '```ts',
      ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`),
      '```',
      'z'.repeat(300),
    ].join('\n');
    const rounds = roundsFromCoreMessages([user('u1', 'q'), assistant('a1', longCode, [])]);
    const entry = skeletonEntryFromRound(rounds[0]!, 'zh-CN');
    expect(entry.a.startsWith('```ts\n')).toBe(true);
    expect((entry.a.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('marks tool-only rounds with an explicit no-text note and counts dropped calls', () => {
    // 构造一个纯工具回合验证 noAnswer 分支。
    const toolOnly = roundsFromCoreMessages([
      user('u9', 'go'),
      assistant('a9', '', ['bash', 'read', 'read']),
      tool('t9', 'a9-c0', 'out'),
      tool('t9b', 'a9-c1', 'out'),
      tool('t9c', 'a9-c2', 'out'),
    ]);
    const entry = skeletonEntryFromRound(toolOnly[0]!, 'zh-CN');
    expect(entry.a).toContain('无文字总结');
    expect(entry.droppedToolCalls).toBe(3);
  });

  it('renders localized round labels', () => {
    const rounds = roundsFromCoreMessages(makeRound(1, 100));
    const entry = skeletonEntryFromRound(rounds[0]!, 'en');
    const zhText = renderSkeletonEntries([entry], 'en');
    expect(zhText).toContain('[Round 1 · 1 tool call(s)]');
    expect(zhText).toContain('Q:');
  });
});

describe('foldRoundActivity', () => {
  it('keeps the last N turns verbatim and renders older turns as activity lines', () => {
    const rounds = roundsFromCoreMessages([
      user('u1', 'big task'),
      assistant('a1', 'step one', ['read']),
      tool('t1', 'a1-c0', 'x'.repeat(200)),
      assistant('a2', 'step two', ['edit', 'bash']),
      tool('t2', 'a2-c0', 'y'.repeat(200)),
      tool('t3', 'a2-c1', 'z'.repeat(200)),
      assistant('a3', 'still working', ['test']),
      tool('t4', 'a3-c0', 'w'.repeat(200)),
      assistant('a4', 'final answer here', []),
    ]);
    const fold = foldRoundActivity(rounds[0]!, 2, 'zh-CN');
    expect(fold.retainedTurnIds).toEqual(['a3', 'a4']);
    expect(fold.activityText).toContain('[步骤 1]');
    expect(fold.activityText).toContain('[步骤 2]');
    expect(fold.activityText).toContain('edit, bash');
    expect(fold.activityText).toContain('step one');
  });
});

describe('planSkeletonCompaction', () => {
  it('returns null when there is nothing to compact', () => {
    expect(planSkeletonCompaction({
      rounds: [],
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      triggerTokens: 1000,
      summaryInputTokens: 1000,
      lang: 'zh-CN',
    })).toBeNull();
  });

  it('keeps the last 5 rounds verbatim and skeletons the rest when budget allows', () => {
    const rounds = roundsFromCoreMessages(Array.from({ length: 8 }, (_, i) => makeRound(i + 1, 200)).flat());
    const plan = planSkeletonCompaction({
      rounds,
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      // 骨架每条约几十 token + tail 5 条（含 200 字符工具输出 ≈50+ token/条）
      triggerTokens: 20_000,
      summaryInputTokens: 20_000,
      lang: 'zh-CN',
    })!;
    expect(plan.needsSummary).toBe(false);
    expect(plan.retainedRounds).toHaveLength(5);
    expect(plan.skeleton).toHaveLength(3);
    expect(plan.inRoundFold).toBeNull();
    expect(plan.estimatedTokensAfter).toBeLessThanOrEqual(20_000);
    expect(plan.boundaryMessageId).toBe('u4');
    expect(plan.questionLine).toBe('');
  });

  it('degrades the verbatim tail until the skeleton fits', () => {
    const rounds = roundsFromCoreMessages(Array.from({ length: 8 }, (_, i) => makeRound(i + 1, 4000)).flat());
    const plan = planSkeletonCompaction({
      rounds,
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      triggerTokens: 2600,
      summaryInputTokens: 2600,
      lang: 'zh-CN',
    })!;
    // 单轮 tail ≈ 1000+ token，预算 2600 只容得下 1~2 个逐字回合。
    expect(plan.needsSummary).toBe(false);
    expect(plan.retainedRounds.length).toBeLessThan(5);
    expect(plan.skeleton.length).toBeGreaterThan(8 - 5);
    expect(plan.estimatedTokensAfter).toBeLessThanOrEqual(2600);
  });

  it('folds inside the last round (activity lines) when round-level tailing is not enough', () => {
    // 一个巨型回合：9 个 turn 组，每组一个 ~1500 字节工具结果。
    const big: IMessage[] = [user('u1', 'long running task')];
    for (let i = 1; i <= 8; i += 1) {
      big.push(assistant(`a${i}`, `step ${i}`, ['bash']), tool(`t${i}`, `a${i}-c0`, 'x'.repeat(1500)));
    }
    big.push(assistant('a9', 'all done', []));
    const rounds = roundsFromCoreMessages(big);
    const plan = planSkeletonCompaction({
      rounds,
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      // 单 turn ≈ 400 token：容得下 3 个逐字 turn，容不下 9 个。
      triggerTokens: 1800,
      summaryInputTokens: 1800,
      lang: 'zh-CN',
    })!;
    expect(plan.inRoundFold).not.toBeNull();
    expect(plan.inRoundFold!.retainedTurnIds.length).toBeLessThanOrEqual(3);
    expect(plan.inRoundFold!.activityText).toContain('[步骤');
    expect(plan.needsSummary).toBe(false);
    expect(plan.estimatedTokensAfter).toBeLessThanOrEqual(1800);
    // 边界落在回合内部：首个保留 turn 的消息 id，用户问题改由 [当前任务] 行重建。
    expect(plan.boundaryMessageId).toBe(plan.inRoundFold!.retainedTurnIds[0]);
    expect(plan.questionLine).toContain('[当前任务]');
  });

  it('falls back to a single bounded summary level when everything else overflows', () => {
    // 每回合 A 截断后 ~400 字符 → 骨架行 ~140 token，9 条骨架远超 800 预算。
    const rounds = roundsFromCoreMessages(
      Array.from({ length: 10 }, (_, i) => makeRound(i + 1, 4000, 900)).flat()
    );
    const plan = planSkeletonCompaction({
      rounds,
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      triggerTokens: 800,
      summaryInputTokens: 800,
      lang: 'zh-CN',
    })!;
    expect(plan.needsSummary).toBe(true);
    expect(plan.summaryInput).not.toBeNull();
    expect(plan.summaryInput!.length).toBeGreaterThan(0);
    // 预瘦身从最老行丢弃：省略标记在首，最新回合的骨架行仍在。
    expect(plan.summaryInput).toContain('上限省略');
    expect(plan.summaryInput).toContain('question number 9');
    expect(plan.retainedRounds.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic across invocations', () => {
    const rounds = roundsFromCoreMessages(Array.from({ length: 8 }, (_, i) => makeRound(i + 1, 4000)).flat());
    const params = {
      rounds,
      priorFoldedText: 'PRIOR NOTE',
      fixedOverheadTokens: 10,
      triggerTokens: 2600,
      summaryInputTokens: 2600,
      lang: 'zh-CN' as const,
    };
    expect(JSON.stringify(planSkeletonCompaction(params))).toBe(
      JSON.stringify(planSkeletonCompaction(params))
    );
  });

  it('accounts for prior folded text and fixed overhead in the budget', () => {
    const rounds = roundsFromCoreMessages(Array.from({ length: 6 }, (_, i) => makeRound(i + 1, 200)).flat());
    const baseline = planSkeletonCompaction({
      rounds,
      priorFoldedText: '',
      fixedOverheadTokens: 0,
      triggerTokens: 20_000,
      summaryInputTokens: 20_000,
      lang: 'zh-CN',
    })!;
    const withPrior = planSkeletonCompaction({
      rounds,
      priorFoldedText: 'h'.repeat(400),
      fixedOverheadTokens: 500,
      triggerTokens: 20_000,
      summaryInputTokens: 20_000,
      lang: 'zh-CN',
    })!;
    expect(withPrior.estimatedTokensAfter).toBeGreaterThan(baseline.estimatedTokensAfter);
  });
});

describe('summary input sizing', () => {
  it('keeps newer lines and marks older ones as omitted', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'l'.repeat(200)}`);
    const result = preSizeSummaryInput(lines, [], 300, 'zh-CN');
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.text).toContain('line 49');
    expect(result.text).not.toContain('line 0 ');
    expect(result.text).toContain('上限省略');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(320);
  });

  it('passes everything through when it already fits', () => {
    const result = preSizeSummaryInput(['short one', 'short two'], ['HEADER'], 1000, 'en');
    expect(result.omitted).toBe(0);
    expect(result.text).toContain('HEADER');
    expect(result.text).toContain('short one');
  });
});

describe('deterministicSummary', () => {
  it('keeps the newest lines within budget and prefixes an omission marker', () => {
    const text = Array.from({ length: 40 }, (_, i) => `row ${i} ${'r'.repeat(400)}`).join('\n');
    const summary = deterministicSummary(text, 60, 'zh-CN');
    expect(summary).toContain('row 39');
    expect(summary).not.toContain('row 0 ');
    expect(summary.split('\n')[0]).toContain('上限省略');
  });
});
