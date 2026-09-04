import { describe, expect, it, vi } from 'vitest';
import { ListModelsError } from '@codepapr/api';
import { getTranslation } from '../../utils/i18n';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  assertCanFetchProfileModels,
  filterModelCatalog,
  formatListModelsError,
  listModelsAuthForProfile,
  listModelsForProfile,
  profileModelsCacheKey,
  resolveProfileModelsBaseURL,
} from './listProfileModels';
import type { ModelProfile } from '../../store/agentStore';

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    name: 'test',
    apiMode: 'custom',
    apiFormat: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or',
    model: 'x',
    maxTokens: 4096,
    ...overrides,
  };
}

describe('resolveProfileModelsBaseURL', () => {
  it('uses DeepSeek official URL when the field is empty', () => {
    expect(resolveProfileModelsBaseURL({ apiMode: 'deepseek', baseURL: '' })).toBe(
      DEFAULT_DEEPSEEK_BASE_URL
    );
  });

  it('uses local default when the field is empty', () => {
    expect(resolveProfileModelsBaseURL({ apiMode: 'local', baseURL: '  ' })).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });

  it('requires a URL for custom endpoints', () => {
    expect(resolveProfileModelsBaseURL({ apiMode: 'custom', baseURL: '' })).toBeNull();
  });
});

describe('assertCanFetchProfileModels', () => {
  it('requires a key except for local', () => {
    expect(() => assertCanFetchProfileModels(profile({ apiKey: '' }))).toThrow('need-key');
    expect(() =>
      assertCanFetchProfileModels(profile({ apiMode: 'local', apiKey: '', baseURL: '' }))
    ).not.toThrow();
  });

  it('requires a URL for custom', () => {
    expect(() => assertCanFetchProfileModels(profile({ baseURL: '' }))).toThrow('need-url');
  });
});

describe('listModelsAuthForProfile / cache key', () => {
  it('uses Anthropic auth only for Claude custom', () => {
    expect(listModelsAuthForProfile({ apiMode: 'custom', apiFormat: 'claude' })).toBe('anthropic');
    expect(listModelsAuthForProfile({ apiMode: 'custom', apiFormat: 'openai' })).toBe('bearer');
    expect(listModelsAuthForProfile({ apiMode: 'deepseek', apiFormat: 'openai' })).toBe('bearer');
  });

  it('changes when URL, format, or key change', () => {
    const a = profileModelsCacheKey(profile());
    const b = profileModelsCacheKey(profile({ apiKey: 'sk-other' }));
    const c = profileModelsCacheKey(profile({ apiFormat: 'response' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('listModelsForProfile', () => {
  it('GET /models with the resolved URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'openrouter/auto' }] }), { status: 200 })
    );
    const ids = await listModelsForProfile(profile(), { fetchFn: fetchFn as unknown as typeof fetch });
    expect(ids).toEqual(['openrouter/auto']);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models');
  });
});

describe('formatListModelsError', () => {
  const t = getTranslation('zh-CN');

  it('maps known kinds to settings copy', () => {
    expect(formatListModelsError(new Error('need-key'), t)).toBe(t.fetchModelsNeedKey);
    expect(formatListModelsError(new ListModelsError('unauthorized', 'nope', 401), t)).toBe(
      t.fetchModelsUnauthorized
    );
    expect(formatListModelsError(new ListModelsError('not_found', 'missing', 404), t)).toBe(
      t.fetchModelsNotFound
    );
    expect(formatListModelsError(new DOMException('aborted', 'AbortError'), t)).toBe('');
  });

  it('unwraps HTTP-prefixed JSON bodies instead of dumping raw JSON', () => {
    const body =
      '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance."}}';
    const text = formatListModelsError(new ListModelsError('http', `HTTP 401: ${body}`, 401), t);
    expect(text).toContain('CreditsError: Insufficient balance.');
    expect(text).not.toContain('{"type"');
  });
});

describe('filterModelCatalog', () => {
  it('filters locally without changing order', () => {
    expect(filterModelCatalog(['gpt-4o', 'claude-3', 'gpt-4o-mini'], 'gpt')).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });
});
