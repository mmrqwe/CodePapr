import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { ClaudeProvider } from '../src/providers/ClaudeProvider';
import {
  CODEPAPR_OPENCODE_USER_AGENT,
  applyOpencodeGatewayHeaders,
  isOpencodeGatewayBase,
  resolveOpencodeSessionId,
} from '../src/providers/opencodeGateway';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OPENCODE_BASE = 'https://opencode.ai/zen/go/v1';

describe('opencodeGateway helpers', () => {
  it('detects opencode.ai gateway bases (zen and go)', () => {
    expect(isOpencodeGatewayBase(OPENCODE_BASE)).toBe(true);
    expect(isOpencodeGatewayBase('https://opencode.ai/zen/v1')).toBe(true);
    expect(isOpencodeGatewayBase('https://OpenCode.AI/zen/go/v1')).toBe(true);
    expect(isOpencodeGatewayBase('https://api.openai.com/v1')).toBe(false);
    expect(isOpencodeGatewayBase(undefined)).toBe(false);
  });

  it('resolves a trimmed explicit session id and falls back to a random one', () => {
    expect(resolveOpencodeSessionId('  conv-1  ')).toBe('conv-1');
    expect(resolveOpencodeSessionId(undefined)).toMatch(/^codepapr-\S+$/);
    expect(resolveOpencodeSessionId('')).toMatch(/^codepapr-\S+$/);
  });

  it('injects contract headers only for opencode bases', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer sk' };
    applyOpencodeGatewayHeaders(headers, {
      baseURL: OPENCODE_BASE,
      sessionId: 'sess-1',
    });
    expect(headers['x-opencode-session']).toBe('sess-1');
    expect(headers['x-opencode-client']).toBe('codepapr');
    expect(headers['User-Agent']).toBe(CODEPAPR_OPENCODE_USER_AGENT);

    const untouched: Record<string, string> = { Authorization: 'Bearer sk' };
    applyOpencodeGatewayHeaders(untouched, {
      baseURL: 'https://api.openai.com/v1',
      sessionId: 'sess-1',
    });
    expect(untouched).toEqual({ Authorization: 'Bearer sk' });
  });
});

describe('OpenAIProvider: OpenCode Go gateway contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const chat = {
    model: 'kimi-k3',
    messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }],
  };

  it('injects session/client/user-agent headers for opencode.ai endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'chat-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseURL: OPENCODE_BASE,
      sessionId: 'conv-42',
    });
    await provider.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBe('conv-42');
    expect(init.headers['x-opencode-client']).toBe('codepapr');
    expect(init.headers['User-Agent']).toBe(CODEPAPR_OPENCODE_USER_AGENT);
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
  });

  it('sends no opencode headers to non-opencode endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'chat-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.moonshot.cn/v1',
      sessionId: 'conv-42',
    });
    await provider.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBeUndefined();
    expect(init.headers['x-opencode-client']).toBeUndefined();
    expect(init.headers['User-Agent']).toBeUndefined();
  });
});

describe('ClaudeProvider: OpenCode Go gateway contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const chat = {
    model: 'minimax-m3',
    messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }],
  };

  it('keeps anthropic auth headers and adds opencode contract headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'minimax-m3',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({
      apiKey: 'sk-test',
      baseURL: OPENCODE_BASE,
      sessionId: 'conv-42',
    });
    await provider.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBe('conv-42');
    expect(init.headers['x-opencode-client']).toBe('codepapr');
    expect(init.headers['User-Agent']).toBe(CODEPAPR_OPENCODE_USER_AGENT);
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends no opencode headers to native anthropic endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({
      apiKey: 'sk-test',
      sessionId: 'conv-42',
    });
    await provider.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBeUndefined();
    expect(init.headers['x-opencode-client']).toBeUndefined();
    expect(init.headers['User-Agent']).toBeUndefined();
  });
});
