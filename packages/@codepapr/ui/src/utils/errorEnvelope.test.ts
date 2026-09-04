import { describe, expect, it } from 'vitest';
import { unwrapErrorBody, unwrappedDetail } from './errorEnvelope';

const OPENCODE_CREDITS_BODY =
  '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing"}}';

describe('unwrapErrorBody', () => {
  it('unwraps the opencode/Anthropic-style error envelope with prefix and label', () => {
    const u = unwrapErrorBody(`HTTP 401: ${OPENCODE_CREDITS_BODY}`);
    expect(u).toMatchObject({
      kind: 'json',
      status: 401,
      label: 'CreditsError',
      text: 'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing',
    });
  });

  it('unwraps OpenAI-style errors (type + code inside error)', () => {
    const u = unwrapErrorBody(
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"quota_exceeded"}}'
    );
    expect(u.kind).toBe('json');
    if (u.kind === 'json') {
      expect(u.label).toBe('insufficient_quota');
      expect(u.text).toBe('You exceeded your current quota');
    }
  });

  it('unwraps AWS-style nested envelopes (errorType)', () => {
    const u = unwrapErrorBody('{"message":"Bad request","errorType":"InvalidRequestException"}');
    expect(u.kind).toBe('json');
    if (u.kind === 'json') {
      expect(u.text).toBe('Bad request');
      expect(u.label).toBe('InvalidRequestException');
    }
  });

  it('handles FastAPI detail string and pydantic array bodies', () => {
    expect(unwrapErrorBody('{"detail":"Not Found"}')).toMatchObject({
      kind: 'json',
      text: 'Not Found',
    });
    const pydantic = unwrapErrorBody(
      '{"detail":[{"loc":["body","model"],"msg":"field required","type":"value_error.missing"}]}'
    );
    expect(pydantic.kind).toBe('json');
    if (pydantic.kind === 'json') {
      expect(pydantic.text).toContain('field required');
    }
  });

  it('falls back to the longest string when no message-ish key exists', () => {
    expect(unwrapErrorBody('{"foo":"bar"}')).toMatchObject({ kind: 'json', text: 'bar' });
  });

  it('detects HTML error pages (gateway/relay bodies)', () => {
    expect(
      unwrapErrorBody('HTTP 502: <!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>oops</body></html>')
    ).toEqual({ kind: 'html', status: 502 });
  });

  it('keeps non-JSON plain-text bodies raw', () => {
    expect(unwrapErrorBody('HTTP 503: backend is busy')).toEqual({ kind: 'raw', status: 503 });
    expect(unwrapErrorBody('Service Unavailable')).toEqual({ kind: 'raw', status: undefined });
  });

  it('keeps malformed JSON-looking bodies raw', () => {
    expect(unwrapErrorBody('{"error": broken')).toEqual({ kind: 'raw', status: undefined });
  });

  it('caps very long inner messages', () => {
    const u = unwrapErrorBody(JSON.stringify({ error: { message: 'x'.repeat(2000) } }));
    expect(u.kind).toBe('json');
    if (u.kind === 'json') {
      expect(u.text.length).toBeLessThanOrEqual(500);
      expect(u.text.endsWith('…')).toBe(true);
    }
  });

  it('ignores generic type values like "error" as labels', () => {
    const u = unwrapErrorBody('{"type":"error","message":"boom"}');
    expect(u.kind).toBe('json');
    if (u.kind === 'json') {
      expect(u.label).toBeUndefined();
      expect(u.text).toBe('boom');
    }
  });
});

describe('unwrappedDetail', () => {
  it('joins label and text for json, undefined for the rest', () => {
    expect(unwrappedDetail(unwrapErrorBody(OPENCODE_CREDITS_BODY))).toBe(
      'CreditsError: Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_x/billing'
    );
    expect(unwrappedDetail({ kind: 'raw' })).toBeUndefined();
  });
});
