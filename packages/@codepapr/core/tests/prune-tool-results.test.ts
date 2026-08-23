import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { pruneOldToolResults, type PruneOptions } from '../src/tool/pruneToolResults';
import { TOOL_SUMMARY_METADATA_KEY } from '../src/tool/toolOutputSummary';

const PLACEHOLDER = '[Old tool result content cleared]';

function baseOptions(overrides: Partial<PruneOptions> = {}): PruneOptions {
  return {
    enabled: true,
    protectRecentRounds: 1,
    minPrunableChars: 100,
    protectedTools: new Set(['todo']),
    placeholder: PLACEHOLDER,
    ...overrides,
  };
}

let seq = 0;

function userMsg(content: string): IMessage {
  seq += 1;
  return { id: `u${seq}`, role: 'user', content, timestamp: seq };
}

function assistantTextMsg(content: string): IMessage {
  seq += 1;
  return { id: `a${seq}`, role: 'assistant', content, timestamp: seq };
}

/** assistant(发起工具调用) + tool(结果) 一对。 */
function toolRound(toolCallId: string, toolName: string, resultText: string): IMessage[] {
  seq += 1;
  const assistant: IMessage = {
    id: `a${seq}`,
    role: 'assistant',
    content: '',
    timestamp: seq,
    toolCalls: [{ id: toolCallId, name: toolName, arguments: {} }],
  };
  seq += 1;
  const tool: IMessage = {
    id: `t${seq}`,
    role: 'tool',
    content: resultText,
    timestamp: seq,
    toolResult: { toolCallId, success: true, result: resultText },
  };
  return [assistant, tool];
}

const LONG = 'x'.repeat(500);

describe('pruneOldToolResults — 短路分支', () => {
  it('options 未提供或 enabled=false 时返回原数组引用', () => {
    const messages = [...toolRound('c1', 'read', LONG)];

    expect(pruneOldToolResults(messages, undefined)).toBe(messages);
    expect(pruneOldToolResults(messages, baseOptions({ enabled: false }))).toBe(messages);
  });

  it('空消息数组返回原数组引用', () => {
    const messages: IMessage[] = [];
    expect(pruneOldToolResults(messages, baseOptions())).toBe(messages);
  });

  it('可裁剪总量低于 minPrunableChars 时返回原数组引用（不裁剪）', () => {
    // 单条 500 字符，门槛设为 600 → 不裁剪，必须返回同一引用。
    const messages = [
      ...toolRound('c1', 'read', LONG),
      ...toolRound('c2', 'read', LONG),
      assistantTextMsg('done'),
    ];
    const result = pruneOldToolResults(messages, baseOptions({ minPrunableChars: 1100, protectRecentRounds: 0 }));
    expect(result).toBe(messages);
  });
});

describe('pruneOldToolResults — 轮次保护边界', () => {
  it('protectRecentRounds=1：最近 1 个 assistant 轮内的工具结果受保护，更早的被裁剪', () => {
    const messages = [
      userMsg('start'),
      ...toolRound('c1', 'read', LONG), // 旧轮
      ...toolRound('c2', 'read', LONG), // 紧邻最终 assistant 的轮
      assistantTextMsg('final'),
    ];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 1 }));

    // 反向遍历：final(assistant → round=1)，c2 的 tool 处 round=1 ≤ 1 → 保护；
    // 再往前遇到 a2(assistant → round=2)，c1 的 tool 处 round=2 > 1 → 可裁剪。
    expect(result[2]!.content).toBe(PLACEHOLDER); // c1 被裁剪
    expect(result[4]!.content).toBe(LONG);        // c2 保留
  });

  it('多轮历史中超出保护区的旧工具结果被裁剪，保护区内的保留', () => {
    const messages = [
      userMsg('start'),
      ...toolRound('c1', 'read', LONG), // 旧轮 → 裁剪
      assistantTextMsg('mid'),
      ...toolRound('c2', 'read', LONG), // 中间轮 → 裁剪
      ...toolRound('c3', 'read', LONG), // 最近轮 → 保护
      assistantTextMsg('final'),
    ];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 1 }));

    expect(result[2]!.content).toBe(PLACEHOLDER); // c1
    expect(result[5]!.content).toBe(PLACEHOLDER); // c2
    expect(result[7]!.content).toBe(LONG);        // c3 受保护
    expect(result.filter((m) => m.content === PLACEHOLDER)).toHaveLength(2);
  });

  it('protectRecentRounds=0：所有超长工具结果都可裁剪', () => {
    const messages = [
      userMsg('start'),
      ...toolRound('c1', 'read', LONG),
      assistantTextMsg('final'),
    ];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result[2]!.content).toBe(PLACEHOLDER);
    expect(result[2]!.toolResult?.result).toBe(PLACEHOLDER);
    // 未裁剪的消息保持原引用
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[3]).toBe(messages[3]);
  });

  it('不修改原始消息对象（只改副本）', () => {
    const messages = [
      ...toolRound('c1', 'read', LONG),
      assistantTextMsg('final'),
    ];
    const original = messages[1]!;

    pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(original.content).toBe(LONG);
    expect(original.toolResult?.result).toBe(LONG);
    expect(original.metadata).toBeUndefined();
  });
});

describe('pruneOldToolResults — 过滤条件', () => {
  it('protectedTools 中的工具（如 todo）永不裁剪', () => {
    const messages = [
      ...toolRound('c-todo', 'todo', LONG),
      assistantTextMsg('final'),
    ];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result).toBe(messages);
  });

  it('短内容（< 200 字符）不裁剪', () => {
    const messages = [
      ...toolRound('c1', 'read', 'short result'),
      assistantTextMsg('final'),
    ];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result).toBe(messages);
  });

  it('没有 toolResult 的 tool 消息不裁剪', () => {
    seq += 1;
    const bare: IMessage = {
      id: `t${seq}`,
      role: 'tool',
      content: LONG,
      timestamp: seq,
    };
    const messages = [bare, assistantTextMsg('final')];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result).toBe(messages);
  });

  it('未注册的 toolCallId（找不到工具名）不受 protectedTools 保护，正常裁剪', () => {
    seq += 1;
    const orphanTool: IMessage = {
      id: `t${seq}`,
      role: 'tool',
      content: LONG,
      timestamp: seq,
      toolResult: { toolCallId: 'ghost-call', success: true, result: LONG },
    };
    const messages = [orphanTool, assistantTextMsg('final')];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result[0]!.content).toBe(PLACEHOLDER);
  });
});

describe('pruneOldToolResults — toolSummary 元数据剥离', () => {
  it('裁剪时剥离 toolSummary，防止后续摘要复活被裁剪内容', () => {
    const [assistant, tool] = toolRound('c1', 'read', LONG);
    tool.metadata = {
      [TOOL_SUMMARY_METADATA_KEY]: '一段会复活的摘要',
      otherKey: '保留我',
    };
    const messages = [assistant, tool, assistantTextMsg('final')];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result[1]!.content).toBe(PLACEHOLDER);
    expect(result[1]!.metadata).toEqual({ otherKey: '保留我' });
    // 原始消息的 metadata 不被破坏
    expect(messages[1]!.metadata).toEqual({
      [TOOL_SUMMARY_METADATA_KEY]: '一段会复活的摘要',
      otherKey: '保留我',
    });
  });

  it('metadata 仅含 toolSummary 时，裁剪后 metadata 置为 undefined', () => {
    const [assistant, tool] = toolRound('c1', 'read', LONG);
    tool.metadata = { [TOOL_SUMMARY_METADATA_KEY]: '摘要' };
    const messages = [assistant, tool, assistantTextMsg('final')];

    const result = pruneOldToolResults(messages, baseOptions({ protectRecentRounds: 0 }));

    expect(result[1]!.metadata).toBeUndefined();
  });
});
