import { ProviderRequestError, StreamIdleTimeoutError } from '@codepapr/api';
import { describe, expect, it } from 'vitest';
import { AgentIdleTimeoutError } from '../../agent/chatIdleWatchdog';
import { formatAgentError } from './errorFormatting';

const OPENCODE_CREDITS_BODY =
  '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing"}}';

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

describe('formatAgentError envelope unwrapping', () => {
  const creditsError = new ProviderRequestError({
    provider: 'response',
    message: `HTTP 401: ${OPENCODE_CREDITS_BODY}`,
    status: 401,
    responseBody: OPENCODE_CREDITS_BODY,
  });

  it('shows the inner message with a type label instead of the raw JSON (zh-CN)', () => {
    const text = formatAgentError(creditsError, 'zh-CN');
    expect(text).toBe(
      '错误：response 请求失败（HTTP 401）。CreditsError: Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing。'
    );
    expect(text).not.toContain('{"type"');
  });

  it('shows the inner message with a type label instead of the raw JSON (en)', () => {
    const text = formatAgentError(creditsError, 'en');
    expect(text).toContain('(HTTP 401). CreditsError: Insufficient balance.');
    expect(text).not.toContain('{"type"');
  });

  it('unwraps reconstructed worker errors that only carry provider fields on the message', () => {
    const reconstructed = new Error(`HTTP 401: ${OPENCODE_CREDITS_BODY}`);
    reconstructed.name = 'ProviderRequestError';
    const text = formatAgentError(
      Object.assign(reconstructed, { provider: 'response', status: 401 }),
      'zh-CN'
    );
    expect(text).toContain('CreditsError: Insufficient balance');
    expect(text).not.toContain('{"type"');
  });

  it('unwraps plain Errors carrying an HTTP-prefixed JSON message at the generic tail', () => {
    const text = formatAgentError(new Error(`HTTP 401: ${OPENCODE_CREDITS_BODY}`), 'zh-CN');
    expect(text).toBe('错误：请求失败（HTTP 401）。CreditsError: Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing。');
  });

  it('reduces HTML gateway pages to one sentence', () => {
    const htmlBody = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';
    const error = new ProviderRequestError({
      provider: 'openai',
      message: `HTTP 502: ${htmlBody}`,
      status: 502,
      responseBody: htmlBody,
    });
    const text = formatAgentError(error, 'zh-CN');
    expect(text).toContain('HTML 错误页');
    expect(text).not.toContain('<html>');
  });

  it('keeps plain-text bodies exactly as before (raw fallback)', () => {
    const error = new ProviderRequestError({
      provider: 'openai',
      message: 'HTTP 503: backend is busy',
      status: 503,
      responseBody: 'backend is busy',
    });
    expect(formatAgentError(error, 'zh-CN')).toBe(
      '错误：openai 请求失败（HTTP 503）。HTTP 503: backend is busy。'
    );
  });

  it('does not touch the dedicated 429 copy even when the body is JSON', () => {
    const error = new ProviderRequestError({
      provider: 'response',
      message: `HTTP 429: ${OPENCODE_CREDITS_BODY}`,
      status: 429,
      responseBody: OPENCODE_CREDITS_BODY,
    });
    expect(formatAgentError(error, 'zh-CN')).toContain('速率限制');
  });
});
