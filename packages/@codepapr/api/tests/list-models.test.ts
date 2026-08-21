import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ListModelsError,
  listModels,
  parseModelCatalog,
} from '../src/providers/listModels';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseModelCatalog', () => {
  it('reads OpenAI-style data[].id and keeps first-seen order', () => {
    expect(
      parseModelCatalog({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }],
      })
    ).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('falls back to data[].model then models[].name', () => {
    expect(parseModelCatalog({ data: [{ model: 'deepseek-chat' }] })).toEqual(['deepseek-chat']);
    expect(parseModelCatalog({ models: [{ name: 'llama3.1:latest' }] })).toEqual(['llama3.1:latest']);
  });

  it('accepts a top-level string array and skips blanks', () => {
    expect(parseModelCatalog(['a', '', 'b', '  '])).toEqual(['a', 'b']);
  });
});

describe('listModels', () => {
  it('GET {baseURL}/models with Bearer auth and returns ids', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const ids = await listModels({
      baseURL: 'https://api.openai.com/v1/',
      apiKey: 'sk-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(ids).toEqual(['gpt-4o', 'o3-mini']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('sends Anthropic headers for Claude listing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }), { status: 200 })
    );

    await listModels({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      auth: 'anthropic',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps 401/403 to unauthorized and 404 to not_found', async () => {
    await expect(
      listModels({
        baseURL: 'https://example.com/v1',
        apiKey: 'bad',
        fetchFn: vi.fn().mockResolvedValue(new Response('nope', { status: 401 })) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'ListModelsError', kind: 'unauthorized', status: 401 });

    await expect(
      listModels({
        baseURL: 'https://example.com/v1',
        apiKey: 'sk',
        fetchFn: vi.fn().mockResolvedValue(new Response('', { status: 404 })) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'ListModelsError', kind: 'not_found', status: 404 });
  });

  it('maps network failure and empty catalog', async () => {
    await expect(
      listModels({
        baseURL: 'https://example.com/v1',
        apiKey: 'sk',
        fetchFn: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ kind: 'network' });

    await expect(
      listModels({
        baseURL: 'https://example.com/v1',
        apiKey: 'sk',
        fetchFn: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 })
        ) as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ListModelsError);
    await expect(
      listModels({
        baseURL: 'https://example.com/v1',
        apiKey: 'sk',
        fetchFn: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 })
        ) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ kind: 'empty' });
  });

  it('omits Authorization when api key is empty', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
    );

    await listModels({
      baseURL: 'http://127.0.0.1:8080/v1',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
