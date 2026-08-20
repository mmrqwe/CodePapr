import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatStreamEvent } from '@codepapr/types';
import { ResponseProvider } from '../src/providers/ResponseProvider';

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('ResponseProvider', () => {
  it('instantiates with default base url', () => {
    const provider = new ResponseProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('response');
  });

  it('performs non-streaming chat request and transforms response correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_123',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: 'Thinking about the answer...',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Hello from Responses API!',
              },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_abc',
            name: 'get_weather',
            arguments: '{"city":"Beijing"}',
          },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          total_tokens: 80,
          input_tokens_details: {
            cached_tokens: 10,
          },
        },
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test-key',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const request: IChatRequest = {
      model: 'gpt-4o',
      messages: [
        { id: '1', role: 'system', content: 'You are an assistant', timestamp: Date.now() },
        { id: '2', role: 'user', content: 'What is the weather in Beijing?', timestamp: Date.now() },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      thinking: {
        type: 'enabled',
        reasoningEffort: 'high',
      },
    };

    const res = await provider.chat(request);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe('https://api.openai.com/v1/responses');

    const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(calledBody.model).toBe('gpt-4o');
    expect(calledBody.reasoning).toEqual({ effort: 'high' });
    expect(calledBody.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);

    expect(res.id).toBe('resp_123');
    expect(res.choices[0].message.content).toBe('Hello from Responses API!');
    expect(res.choices[0].message.reasoningContent).toBe('Thinking about the answer...');
    expect(res.choices[0].message.toolCalls).toHaveLength(1);
    expect(res.choices[0].message.toolCalls?.[0].name).toBe('get_weather');
    expect(res.choices[0].finishReason).toBe('tool_calls');
    expect(res.usage?.cache_read_input_tokens).toBe(10);
    expect(res.usage?.input_tokens).toBe(50);
    expect(res.usage?.output_tokens).toBe(30);
  });

  it('handles streaming SSE events with text, reasoning, and function call arguments', async () => {
    const sseChunks = [
      'data: {"type":"response.created","response":{"id":"resp_stream_001"}}\n\n',
      'data: {"type":"response.reasoning_text.delta","delta":"Step 1..."}\n\n',
      'data: {"type":"response.reasoning_text.delta","delta":"Step 2..."}\n\n',
      'data: {"type":"response.output_item.added","item":{"id":"item_call_1","type":"function_call","call_id":"call_999","name":"read_file"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","call_id":"call_999","delta":"{\\"path\\": "}\n\n',
      'data: {"type":"response.function_call_arguments.delta","call_id":"call_999","delta":"\\"src/index.ts\\"}"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"I am reading the file"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_stream_001","status":"completed","usage":{"input_tokens":100,"output_tokens":40,"total_tokens":140}}}\n\n',
      'data: [DONE]\n\n',
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const events: IChatStreamEvent[] = [];
    const request: IChatRequest = {
      model: 'ep-test',
      messages: [{ id: '1', role: 'user', content: 'read index', timestamp: Date.now() }],
    };

    const res = await provider.streamChat(request, (e) => events.push(e));

    expect(fetchMock.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/responses');

    const contentDeltas = events.filter((e) => e.type === 'content-delta');
    expect(contentDeltas.map((e) => (e as { delta: string }).delta).join('')).toBe('I am reading the file');

    const reasoningDeltas = events.filter((e) => e.type === 'reasoning-delta');
    expect(reasoningDeltas.map((e) => (e as { delta: string }).delta).join('')).toBe('Step 1...Step 2...');

    expect(res.choices[0].message.content).toBe('I am reading the file');
    expect(res.choices[0].message.reasoningContent).toBe('Step 1...Step 2...');
    expect(res.choices[0].message.toolCalls).toHaveLength(1);
    expect(res.choices[0].message.toolCalls?.[0].name).toBe('read_file');
    expect(res.choices[0].message.toolCalls?.[0].arguments).toEqual({ path: 'src/index.ts' });
  });

  it('throws ProviderRequestError on stream error events', async () => {
    const sseChunks = [
      'data: {"type":"error","error":{"message":"Invalid model endpoint","type":"invalid_request_error"}}\n\n',
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
      streamMaxRetries: 1,
    });

    await expect(
      provider.streamChat({
        model: 'test',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      }, () => {})
    ).rejects.toThrow('Invalid model endpoint');
  });
});
