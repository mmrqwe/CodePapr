import { StreamIdleTimeoutError } from '@codepapr/api';
import { describe, expect, it } from 'vitest';
import { AgentIdleTimeoutError } from '../../agent/chatIdleWatchdog';
import { formatAgentError } from './errorFormatting';

describe('formatAgentError', () => {
  it('localizes AgentIdleTimeoutError instead of dumping the internal message', () => {
    const error = new AgentIdleTimeoutError(300_000);
    expect(formatAgentError(error, 'zh-CN')).toBe(
      '模型长时间没有响应，已停止本回合。请再试一次。'
    );
    expect(formatAgentError(error, 'zh-TW')).toBe(
      '模型長時間沒有回應，已停止本回合。請再試一次。'
    );
    expect(formatAgentError(error, 'en')).toBe(
      'The model did not respond for a while, so this turn was stopped. Please try again.'
    );
  });

  it('localizes reconstructed worker errors by name or legacy message', () => {
    const byName = new Error('The model did not respond; this turn was stopped.');
    byName.name = 'AgentIdleTimeoutError';
    expect(formatAgentError(byName, 'zh-CN')).toContain('请再试一次');

    const legacy = new Error('Agent idle timeout: no activity for 300s');
    expect(formatAgentError(legacy, 'zh-CN')).toBe(
      '模型长时间没有响应，已停止本回合。请再试一次。'
    );
    expect(formatAgentError(legacy, 'zh-CN')).not.toMatch(/Agent idle timeout/i);
  });

  it('keeps stream idle as a network interruption, not a raw timeout dump', () => {
    const error = new StreamIdleTimeoutError(300_000);
    expect(formatAgentError(error, 'zh-CN')).toMatch(/连接中断/);
    expect(formatAgentError(error, 'zh-CN')).not.toMatch(/Stream idle timeout/i);
  });
});
