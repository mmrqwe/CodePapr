import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import {
  buildReasoningPlaceholder,
  isLegacyReasoningPlaceholder,
  isReasoningPlaceholderEcho,
  LEGACY_REASONING_PLACEHOLDER,
  REASONING_PLACEHOLDER_FALLBACK,
  resolveReasoningContent,
  stripReasoningPlaceholderEchoes,
} from '../src/providers/reasoningRoundTrip';

function toolCallAssistantMessage(
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
): IMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    toolCalls,
    timestamp: 1,
  };
}

describe('buildReasoningPlaceholder（动态占位符）', () => {
  it('取首个工具名生成自然句式', () => {
    const message = toolCallAssistantMessage([
      { id: 'c1', name: 'bash', arguments: { command: 'sleep 1' } },
    ]);
    expect(buildReasoningPlaceholder(message)).toBe('Called bash to proceed.');
  });

  it('多工具调用只用第一个（顺序稳定即字节稳定）', () => {
    const message = toolCallAssistantMessage([
      { id: 'c1', name: 'read', arguments: {} },
      { id: 'c2', name: 'grep', arguments: {} },
    ]);
    expect(buildReasoningPlaceholder(message)).toBe('Called read to proceed.');
  });

  it('工具名空白时回退固定句', () => {
    const message = toolCallAssistantMessage([{ id: 'c1', name: '   ', arguments: {} }]);
    expect(buildReasoningPlaceholder(message)).toBe(REASONING_PLACEHOLDER_FALLBACK);
    const noTools: IMessage = { id: 'a', role: 'assistant', content: '', timestamp: 1 };
    expect(buildReasoningPlaceholder(noTools)).toBe(REASONING_PLACEHOLDER_FALLBACK);
  });

  it('工具名两侧空白会被修剪且不拼入参数', () => {
    const message = toolCallAssistantMessage([
      { id: 'c1', name: ' browser ', arguments: { action: 'read', selector: '.x' } },
    ]);
    expect(buildReasoningPlaceholder(message)).toBe('Called browser to proceed.');
  });

  it('确定性：同一消息多次调用字节一致（前缀缓存的前提）', () => {
    const message = toolCallAssistantMessage([
      { id: 'c1', name: 'patch', arguments: { patches: [{ relativePath: 'a.ts' }] } },
    ]);
    const results = new Set(
      Array.from({ length: 50 }, () => buildReasoningPlaceholder(message))
    );
    expect(results.size).toBe(1);
  });
});

describe('isLegacyReasoningPlaceholder / isReasoningPlaceholderEcho / stripReasoningPlaceholderEchoes', () => {
  it('精确识别旧字面量（含首尾空白）', () => {
    expect(isLegacyReasoningPlaceholder(LEGACY_REASONING_PLACEHOLDER)).toBe(true);
    expect(isLegacyReasoningPlaceholder(`  ${LEGACY_REASONING_PLACEHOLDER}\n`)).toBe(true);
    expect(isLegacyReasoningPlaceholder('[Reasoning not captured]')).toBe(false);
    expect(isLegacyReasoningPlaceholder('real reasoning')).toBe(false);
    expect(isLegacyReasoningPlaceholder(undefined)).toBe(false);
    expect(isLegacyReasoningPlaceholder(null)).toBe(false);
  });

  it('识别各代占位符回声（trim 后精确匹配）', () => {
    expect(isReasoningPlaceholderEcho(LEGACY_REASONING_PLACEHOLDER)).toBe(true);
    expect(isReasoningPlaceholderEcho('Called browser to proceed.')).toBe(true);
    expect(isReasoningPlaceholderEcho('Called read_image to proceed.')).toBe(true);
    expect(isReasoningPlaceholderEcho('  Called bash to proceed.\n')).toBe(true);
    expect(isReasoningPlaceholderEcho(REASONING_PLACEHOLDER_FALLBACK)).toBe(true);
  });

  it('真实推理不误判为回声', () => {
    expect(isReasoningPlaceholderEcho('Called browser to proceed')).toBe(false);
    expect(isReasoningPlaceholderEcho('Called browser to proceed. Now check the dialog.')).toBe(false);
    expect(isReasoningPlaceholderEcho('I called browser to proceed.')).toBe(false);
    expect(isReasoningPlaceholderEcho('先想清楚再回答')).toBe(false);
    expect(isReasoningPlaceholderEcho('')).toBe(false);
    expect(isReasoningPlaceholderEcho(undefined)).toBe(false);
    expect(isReasoningPlaceholderEcho(null)).toBe(false);
  });

  it('strip：各代回声与空串置空，真实推理原样保留', () => {
    expect(stripReasoningPlaceholderEchoes(LEGACY_REASONING_PLACEHOLDER)).toBeUndefined();
    expect(stripReasoningPlaceholderEchoes('Called browser to proceed.')).toBeUndefined();
    expect(stripReasoningPlaceholderEchoes(REASONING_PLACEHOLDER_FALLBACK)).toBeUndefined();
    expect(stripReasoningPlaceholderEchoes('')).toBeUndefined();
    expect(stripReasoningPlaceholderEchoes(undefined)).toBeUndefined();
    expect(stripReasoningPlaceholderEchoes('先想清楚再回答')).toBe('先想清楚再回答');
  });
});

describe('resolveReasoningContent', () => {
  it('工具轮缺 reasoning 且支持 thinking 载荷 → 动态占位符', () => {
    const message = toolCallAssistantMessage([{ id: 'c1', name: 'bash', arguments: {} }]);
    expect(resolveReasoningContent(message, { supportsThinkingPayload: true })).toBe(
      'Called bash to proceed.'
    );
  });

  it('工具轮缺 reasoning 但不支持 thinking 载荷 → 不注入', () => {
    const message = toolCallAssistantMessage([{ id: 'c1', name: 'bash', arguments: {} }]);
    expect(resolveReasoningContent(message, { supportsThinkingPayload: false })).toBeUndefined();
  });

  it('工具轮存有 reasoning → 原样回传（不受占位符逻辑影响）', () => {
    const message: IMessage = {
      ...toolCallAssistantMessage([{ id: 'c1', name: 'bash', arguments: {} }]),
      reasoningContent: '本轮真实推理',
    };
    expect(resolveReasoningContent(message, { supportsThinkingPayload: true })).toBe(
      '本轮真实推理'
    );
  });

  it('旧占位符作为已存 reasoning 时原样回传（保持历史字节稳定）', () => {
    const message: IMessage = {
      ...toolCallAssistantMessage([{ id: 'c1', name: 'bash', arguments: {} }]),
      reasoningContent: LEGACY_REASONING_PLACEHOLDER,
    };
    expect(resolveReasoningContent(message, { supportsThinkingPayload: true })).toBe(
      LEGACY_REASONING_PLACEHOLDER
    );
  });
});
