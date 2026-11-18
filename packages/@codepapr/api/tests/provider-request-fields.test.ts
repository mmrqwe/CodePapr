import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import { ClaudeProvider } from '../src/providers/ClaudeProvider';
import { DeepSeekProvider } from '../src/providers/DeepSeekProvider';
import { LocalProvider } from '../src/providers/LocalProvider';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { ResponseProvider } from '../src/providers/ResponseProvider';

const request: IChatRequest = {
  model: 'gpt-5.6-luna',
  messages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 1 }],
  temperature: 0.3,
  topP: 0.9,
  maxTokens: 2048,
  thinking: { type: 'enabled', payload: 'both', reasoningEffort: 'high', budgetTokens: 1024 },
};

function mockFetch(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function requestBody(fetchFn: ReturnType<typeof mockFetch>) {
  expect(fetchFn).toHaveBeenCalledTimes(1);
  return JSON.parse(fetchFn.mock.calls[0][1]?.body as string) as Record<string, unknown>;
}

function chatResponse() {
  return Response.json({
    id: 'chat',
    choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  });
}

function messageResponse() {
  return Response.json({
    id: 'message',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
  });
}

describe('provider request fields', () => {
  it.each(['chat', 'stream'] as const)('uses the official Chat Completions fields in %s mode', async (mode) => {
    const fetchFn = mockFetch(mode === 'chat' ? chatResponse() : new Response(
      'data: {"id":"chat","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1/chat/completions/',
      fetchFn,
    });
    const input: IChatRequest = {
      ...request,
      messages: [
        {
          id: 'a1', role: 'assistant', content: '', timestamp: 0,
          reasoningContent: 'Reasoning stored by a previous provider',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
        },
        ...request.messages,
      ],
    };
    await (mode === 'chat' ? provider.chat(input) : provider.streamChat(input, () => {}));
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({ max_completion_tokens: 2048, reasoning_effort: 'high' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('messages.0.reasoning_content');
  });

  it('keeps sampling for a non-reasoning OpenAI model and handles tool-only results', async () => {
    const fetchFn = mockFetch(Response.json({
      id: 'chat',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const result = await new OpenAIProvider({ apiKey: 'test-key', fetchFn }).chat({
      ...request, model: 'gpt-4.1',
    });
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({ max_completion_tokens: 2048, temperature: 0.3, top_p: 0.9 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(result.choices[0].message).toMatchObject({
      content: '', toolCalls: [{ id: 'call_1', name: 'lookup' }],
    });
  });

  it.each([
    ['OpenCode', (fetchFn: typeof fetch) => new OpenAIProvider({
      apiKey: 'test-key', baseURL: 'https://opencode.ai/zen/go/v1', fetchFn,
    })],
    ['DeepSeek', (fetchFn: typeof fetch) => new DeepSeekProvider({ apiKey: 'test-key', fetchFn })],
    ['local', (fetchFn: typeof fetch) => new LocalProvider({ fetchFn })],
  ] as const)('keeps the chat request fields for %s', async (_name, makeProvider) => {
    const fetchFn = mockFetch(chatResponse());
    await makeProvider(fetchFn).chat({ ...request, model: 'deepseek-v4-pro' });
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      max_tokens: 2048,
      temperature: 0.3,
      top_p: 0.9,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('uses the official Responses minimum when sending and checking the output budget', async () => {
    const fetchFn = mockFetch(new Response(
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
      'data: {"type":"response.completed","response":{"id":"response","usage":{"output_tokens":12}}}\n\n' +
      'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const provider = new ResponseProvider({ apiKey: 'test-key', fetchFn });
    const result = await provider.streamChat({ ...request, maxTokens: 8 }, () => {});
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      max_output_tokens: 16, reasoning: { effort: 'high', summary: 'auto' },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(result.choices[0].finishReason).toBe('unknown');
  });

  it('keeps the OpenCode Responses fields and session header', async () => {
    const fetchFn = mockFetch(Response.json({ id: 'response', status: 'completed', output: [] }));
    await new ResponseProvider({
      apiKey: 'test-key', baseURL: 'https://opencode.ai/zen/go/v1', sessionId: 'test-session', fetchFn,
    }).chat({ ...request, maxTokens: 8 });
    expect(requestBody(fetchFn)).toMatchObject({
      max_output_tokens: 8, thinking: { type: 'enabled' }, reasoning: { effort: 'high' },
      temperature: 0.3, top_p: 0.9, prompt_cache_key: true, store: false,
    });
    expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('x-opencode-session')).toBe('test-session');
  });

  it('lets a profile rename the token field and uses that limit for stream truncation', async () => {
    const fetchFn = mockFetch(new Response(
      'data: {"id":"chat","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n' +
      'data: {"id":"chat","choices":[],"usage":{"completion_tokens":100}}\n\n' +
      'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://relay.example.com/v1',
      fetchFn,
      requestBodyOverrides: {
        max_tokens: null,
        max_completion_tokens: 100,
        temperature: null,
        thinking: { type: 'disabled' },
        vendor_option: [1, true],
        model: 'wrong-model',
        messages: null,
        stream: false,
      },
    });
    const result = await provider.streamChat(request, () => {});
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      model: request.model, stream: true, messages: [{ role: 'user', content: 'Hello' }],
      max_completion_tokens: 100, thinking: { type: 'disabled' }, vendor_option: [1, true],
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(result.choices[0].finishReason).toBe('length');
  });

  it('uses adaptive thinking and omits sampling for official Claude 5', async () => {
    const fetchFn = mockFetch(messageResponse());
    await new ClaudeProvider({ apiKey: 'test-key', fetchFn }).chat({
      ...request, model: 'claude-opus-5',
    });
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      max_tokens: 2048,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    expect(body).not.toHaveProperty('thinking.budget_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('keeps manual thinking for a Claude-compatible endpoint', async () => {
    const fetchFn = mockFetch(messageResponse());
    await new ClaudeProvider({
      apiKey: 'test-key', baseURL: 'https://opencode.ai/inference/anthropic/v1', fetchFn,
    }).chat({ ...request, model: 'claude-opus-5' });
    expect(requestBody(fetchFn)).toMatchObject({
      max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 },
      temperature: 1, top_p: 0.9,
    });
  });
});
