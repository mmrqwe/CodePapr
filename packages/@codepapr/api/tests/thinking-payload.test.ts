import { describe, expect, it } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import {
  resolveRequestThinkingPayload,
  shouldSendReasoningEffort,
  shouldSendThinkingType,
} from '../src/providers/thinkingPayload';

function request(payload?: IChatRequest['thinking']): IChatRequest {
  return {
    model: 'test',
    messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }],
    thinking: payload,
  };
}

describe('thinkingPayload helpers', () => {
  it('缺省 payload 回退到 fallback', () => {
    expect(resolveRequestThinkingPayload(request({ type: 'enabled' }))).toBe('reasoning');
    expect(resolveRequestThinkingPayload(request({ type: 'enabled' }), 'thinking')).toBe('thinking');
    expect(resolveRequestThinkingPayload(request({ type: 'enabled', payload: 'both' }))).toBe('both');
  });

  it('thinking / both 才发 thinking.type', () => {
    expect(shouldSendThinkingType(request({ type: 'enabled' }))).toBe(false);
    expect(shouldSendThinkingType(request({ type: 'enabled', payload: 'thinking' }))).toBe(true);
    expect(shouldSendThinkingType(request({ type: 'enabled', payload: 'both' }))).toBe(true);
    expect(shouldSendThinkingType(request({ type: 'disabled', payload: 'thinking' }))).toBe(true);
    expect(shouldSendThinkingType(request())).toBe(false);
  });

  it('reasoning / both 才发 reasoning_effort，disabled 不发', () => {
    expect(shouldSendReasoningEffort(request({ type: 'enabled', reasoningEffort: 'high' }))).toBe(true);
    expect(shouldSendReasoningEffort(request({ type: 'enabled', payload: 'thinking', reasoningEffort: 'high' }))).toBe(false);
    expect(shouldSendReasoningEffort(request({ type: 'enabled', payload: 'both', reasoningEffort: 'high' }))).toBe(true);
    expect(shouldSendReasoningEffort(request({ type: 'disabled', payload: 'reasoning' }))).toBe(false);
  });
});
