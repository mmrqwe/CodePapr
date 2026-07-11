import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider, DEFAULT_LOCAL_BASE_URL } from '../src/providers/LocalProvider';
import type { IChatRequest } from '@codepapr/types';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseRequest(): IChatRequest {
  return {
    messages: [
      { id: 'u1', role: 'user', content: '你好', timestamp: 0 },
    ],
    model: 'local-model',
  } as IChatRequest;
}

describe('LocalProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('无 API Key 也视为可用', () => {
    expect(new LocalProvider().validate()).toBe(true);
    expect(new LocalProvider({ apiKey: '' }).validate()).toBe(true);
  });

  it('默认指向本地端点', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'r1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new LocalProvider().chat(baseRequest());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${DEFAULT_LOCAL_BASE_URL}/chat/completions`);
  });

  it('支持自定义 baseURL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'r1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new LocalProvider({ baseURL: 'http://127.0.0.1:11434/v1' }).chat(baseRequest());
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('图片输入被映射为 OpenAI 多模态 content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 'r1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = baseRequest();
    request.messages[0]!.images = [{ mediaType: 'image/png', data: 'AAAA' }];
    await new LocalProvider().chat(request);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: '你好' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});
