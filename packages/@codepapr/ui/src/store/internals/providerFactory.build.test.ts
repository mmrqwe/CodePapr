import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProviderForProfile, buildProviderInstance } from './providerFactory';
import type { ModelProfile } from './types';

function responsesFetchMock() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  });
}

const chat = {
  model: 'muse',
  messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }],
};

describe('providerFactory: OpenCode Go wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes conversation sessionId and extraHeaders into the built provider', async () => {
    const fetchMock = responsesFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const provider = buildProviderInstance(
      {
        apiMode: 'custom',
        apiFormat: 'response',
        apiKey: 'sk-test',
        baseURL: 'https://opencode.ai/zen/go/v1',
        extraHeaders: { 'X-Tenant-Id': 'acme' },
      },
      'conv-42'
    );
    await provider!.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBe('conv-42');
    expect(init.headers['User-Agent']).toBe('codepapr/0.1.0');
    expect(init.headers['X-Tenant-Id']).toBe('acme');
  });

  it('omits sessionId from headers on non-opencode gateways', async () => {
    const fetchMock = responsesFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const provider = buildProviderInstance(
      {
        apiMode: 'custom',
        apiFormat: 'response',
        apiKey: 'sk-test',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      },
      'conv-42'
    );
    await provider!.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBeUndefined();
  });

  it('carries profile.extraHeaders through buildProviderForProfile', async () => {
    const fetchMock = responsesFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const profile: ModelProfile = {
      id: 'p1',
      name: 'p1',
      apiMode: 'custom',
      apiFormat: 'response',
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'sk-test',
      model: 'muse',
      maxTokens: 1000,
      extraHeaders: { 'X-Trace': 'on' },
    };
    const provider = buildProviderForProfile(profile, 30000, 'conv-7');
    await provider!.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBe('conv-7');
    expect(init.headers['X-Trace']).toBe('on');
  });
});
