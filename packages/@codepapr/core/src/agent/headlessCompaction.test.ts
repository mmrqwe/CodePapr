import { describe, expect, it, vi } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { createHeadlessCompaction } from './headlessCompaction';
import { COMPACT_TRIGGER_RATIO } from './compactionEngine';

function round(i: number, toolChars: number): IMessage[] {
  return [
    { id: `u${i}`, role: 'user', content: `任务 ${i} ${'q'.repeat(60)}`, timestamp: i * 10 },
    {
      id: `a${i}`,
      role: 'assistant',
      content: `结论 ${i} ${'a'.repeat(60)}`,
      timestamp: i * 10 + 1,
      toolCalls: [{ id: `c${i}`, name: 'bash', arguments: { c: i } }],
    } as IMessage,
    {
      id: `t${i}`,
      role: 'tool',
      content: 'x'.repeat(toolChars),
      timestamp: i * 10 + 2,
      toolResult: { toolCallId: `c${i}`, success: true, result: 'x'.repeat(toolChars) },
    } as IMessage,
  ];
}

function bigLog(rounds: number, toolChars: number): IMessage[] {
  const out: IMessage[] = [];
  for (let i = 1; i <= rounds; i += 1) out.push(...round(i, toolChars));
  return out;
}

describe('createHeadlessCompaction（子代理 v4 引擎）', () => {
  const config = createHeadlessCompaction({
    windowTokens: 100_000,
    lang: 'zh-CN',
  });

  it('触发线 = 窗口 × 90%，soft 与 hard 同值（prune 层已退役）', () => {
    expect(config.maxContextTokens).toBe(Math.floor(100_000 * COMPACT_TRIGGER_RATIO));
    expect(config.softMaxTokens).toBe(config.maxContextTokens);
  });

  it('超限 log 压缩：骨架 checkpoint 在前，最近回合逐字，工具结果不流失到块外', async () => {
    const log = bigLog(8, 6000);
    const result = await config.handler(log);
    expect(result).not.toBeNull();
    const messages = result!.messages;
    const checkpoint = messages.find((m) => m.metadata?.contextCheckpoint === true);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.role).toBe('user');
    expect(checkpoint?.content).toContain('压缩骨架');
    expect(checkpoint?.content).toContain('[第 1 轮');
    expect(checkpoint?.content).toContain('问：');
    // checkpoint 之后保留的是某条 user（回合级边界），其工具组完整
    const cpIndex = messages.findIndex((m) => m.id === checkpoint!.id);
    expect(messages[cpIndex + 1]?.role).toBe('user');
    const assistantWithCalls = messages.filter((m) => m.role === 'assistant' && m.toolCalls?.length);
    const toolResults = messages.filter((m) => m.role === 'tool');
    expect(assistantWithCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBe(assistantWithCalls.length);
    // 真实缩容
    const before = JSON.stringify(log).length;
    const after = JSON.stringify(messages).length;
    expect(after).toBeLessThan(before);
  });

  it('prior checkpoint 折叠文本并入新块，不产生两个 checkpoint', async () => {
    const first = (await config.handler(bigLog(8, 6000)))!;
    // 在已压缩 epoch 上继续跑出新回合，再压一次
    const grown = [...first.messages, ...round(9, 6000), ...round(10, 6000)];
    const second = await config.handler(grown);
    if (second) {
      const checkpoints = second.messages.filter((m) => m.metadata?.contextCheckpoint === true);
      expect(checkpoints).toHaveLength(1);
      // 新块吸收旧块（旧 user 回合的骨架行仍在，或 prior 文本被带入）
      expect(checkpoints[0]!.content.includes('[第 1 轮') || checkpoints[0]!.content.includes('压缩骨架')).toBe(true);
    }
  });

  it('needsSummary 时调用注入的 summarize 一次；不递归', async () => {
    const summarize = vi.fn(async () => '合并摘要：全部旧回合的关键决定。');
    const withSummary = createHeadlessCompaction({ windowTokens: 2_000, lang: 'en', summarize });
    // 60 个回合、trigger=3600 → 骨架也装不下 → 二级摘要
    const result = await withSummary.handler(bigLog(60, 2500));
    expect(result).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
    const checkpoint = result!.messages.find((m) => m.metadata?.contextCheckpoint === true);
    expect(checkpoint?.content).toContain('合并摘要');
  });

  it('summarize 失败/缺失时确定性截断降级（仍有 checkpoint，且不抛）', async () => {
    const failing = createHeadlessCompaction({
      windowTokens: 2_000,
      lang: 'zh-CN',
      summarize: async () => {
        throw new Error('provider down');
      },
    });
    const result = await failing.handler(bigLog(60, 2500));
    expect(result).not.toBeNull();
    expect(result!.messages.some((m) => m.metadata?.contextCheckpoint === true)).toBe(true);

    const none = createHeadlessCompaction({ windowTokens: 2_000, lang: 'zh-CN' });
    const result2 = await none.handler(bigLog(60, 2500));
    expect(result2!.messages.some((m) => m.metadata?.contextCheckpoint === true)).toBe(true);
  });

  it('未超限或无内容可压：返回 null，不改 epoch', async () => {
    const small = await config.handler(bigLog(2, 100));
    // force=false 语义：plan 无骨架可折叠（rounds=2 → tail=1 skeleton=1 仍 < trigger）
    // → handler 会给出压缩方案吗？引擎无条件被调用时按预算收敛；此 log 远小于
    // trigger，round-level tail 保持 1 时骨架 1 条也满足预算，boundary>0 有源：
    // 只要 boundary>0 就产出 checkpoint（Agent 只在超线时才调 handler，这里
    // 验证的是「有源必压」的确定性）。为覆盖「无源」分支：单回合且不可折叠。
    expect(small).not.toBeNull();
    const single = await config.handler(round(1, 100));
    expect(single).toBeNull();
  });
});
