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
    expect(calledBody.thinking).toBeUndefined();
    expect(calledBody.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(calledBody.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);

    expect(res.id).toBe('resp_123');
    expect(res.choices[0].message.content).toBe('Hello from Responses API!');
    expect(res.choices[0].message.reasoningContent).toBe('Thinking about the answer...');
    expect(res.choices[0].message.toolCalls).toHaveLength(1);
    expect(res.choices[0].message.toolCalls?.[0].name).toBe('get_weather');
    expect(res.choices[0].finishReason).toBe('tool_calls');
    expect(res.usage?.cache_read_input_tokens).toBe(10);
    expect(res.usage?.input_tokens).toBe(40);
    expect(res.usage?.output_tokens).toBe(30);
  });

  it('does not subtract top-level cache_read_input_tokens from already-uncached input_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_claude_style',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 5,
          cache_read_input_tokens: 10,
        },
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const res = await provider.chat({
      model: 'gpt-4o',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
    });

    expect(res.usage?.cache_read_input_tokens).toBe(10);
    expect(res.usage?.input_tokens).toBe(50);
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

    const toolStarts = events.filter((e) => e.type === 'tool-call-start');
    expect(toolStarts).toEqual([
      {
        type: 'tool-call-start',
        toolCallId: 'call_999',
        toolName: 'read_file',
        arguments: {},
      },
    ]);
  });

  it('default thinkingPayload (reasoning) omits thinking.type on Responses endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_ark',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Need to inspect the file first.' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const res = await provider.chat({
      model: 'muse-spark-1.2-contributor',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: {
        type: 'enabled',
        reasoningEffort: 'max',
      },
    });

    const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(calledBody.thinking).toBeUndefined();
    expect(calledBody.reasoning).toEqual({ effort: 'max', summary: 'auto' });
    expect(res.choices[0].message.reasoningContent).toBe('Need to inspect the file first.');
  });

  it('thinkingPayload both sends thinking.type plus reasoning.effort', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_both',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await provider.chat({
      model: 'doubao-1.5-pro-32k',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: {
        type: 'enabled',
        reasoningEffort: 'max',
        payload: 'both',
      },
    });

    const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(calledBody.thinking).toEqual({ type: 'enabled' });
    expect(calledBody.reasoning).toEqual({ effort: 'max', summary: 'auto' });
  });

  it('thinkingPayload thinking sends only thinking.type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_thinking',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await provider.chat({
      model: 'doubao-1.5-pro-32k',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: {
        type: 'enabled',
        reasoningEffort: 'high',
        payload: 'thinking',
      },
    });

    const calledBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(calledBody.thinking).toEqual({ type: 'enabled' });
    expect(calledBody.reasoning).toBeUndefined();
  });

  it('streams nested reasoning deltas and summary parts', async () => {
    const sseChunks = [
      'data: {"type":"response.created","response":{"id":"resp_nested"}}\n\n',
      'data: {"type":"response.reasoning_summary_part.added","part":{"type":"summary_text","text":"First "}}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":{"text":"thought"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":{"text":"answer"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_nested","status":"completed"}}\n\n',
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
    const res = await provider.streamChat({
      model: 'muse-spark-1.2-contributor',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: { type: 'enabled', reasoningEffort: 'high' },
    }, (e) => events.push(e));

    const reasoningDeltas = events.filter((e) => e.type === 'reasoning-delta');
    expect(reasoningDeltas.map((e) => (e as { delta: string }).delta).join('')).toBe('First thought');
    expect(res.choices[0].message.content).toBe('answer');
    expect(res.choices[0].message.reasoningContent).toBe('First thought');
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

  function okJsonProvider(fetchMock: ReturnType<typeof vi.fn>): ResponseProvider {
    return new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
  }

  function okJsonFetch(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_ok',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    });
  }

  it('sends user-typed reasoning effort as-is (xhigh / max) and always asks for summary', async () => {
    const fetchMock = okJsonFetch();
    await okJsonProvider(fetchMock).chat({
      model: 'muse-spark-1.2-contributor',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: { type: 'enabled', reasoningEffort: 'xhigh', payload: 'reasoning' },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({
      effort: 'xhigh',
      summary: 'auto',
    });

    const maxMock = okJsonFetch();
    await okJsonProvider(maxMock).chat({
      model: 'muse-spark-1.2-contributor',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: { type: 'enabled', reasoningEffort: 'max', payload: 'reasoning' },
    });
    expect(JSON.parse(maxMock.mock.calls[0][1].body).reasoning).toEqual({
      effort: 'max',
      summary: 'auto',
    });
  });

  it('defaults empty reasoning effort to medium', async () => {
    const fetchMock = okJsonFetch();
    await okJsonProvider(fetchMock).chat({
      model: 'gpt-4o',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now() }],
      thinking: { type: 'enabled', payload: 'reasoning' },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    });
  });

  it('encodes history assistant replies as typed message items so later turns keep them', async () => {
    const fetchMock = okJsonFetch();
    await okJsonProvider(fetchMock).chat({
      model: 'muse-spark-1.2-contributor',
      messages: [
        { id: 'u1', role: 'user', content: '做个体检报告', timestamp: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: '体检完成 — 已修复 4 项',
          timestamp: 2,
        },
        {
          id: 'a2',
          role: 'assistant',
          content: '正在读 index.html',
          timestamp: 3,
          toolCalls: [{ id: 'call_read', name: 'read', arguments: { relativePath: 'index.html' } }],
        },
        {
          id: 't1',
          role: 'tool',
          content: '{"bytes":12}',
          timestamp: 4,
          toolResult: { toolCallId: 'call_read', success: true, result: { bytes: 12 } },
        },
        { id: 'u2', role: 'user', content: '按钮挤在一起了', timestamp: 5 },
      ],
    });

    const input = JSON.parse(fetchMock.mock.calls[0][1].body).input as unknown[];
    expect(input).toEqual([
      { role: 'user', content: '做个体检报告' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '体检完成 — 已修复 4 项' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '正在读 index.html' }],
      },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read',
        arguments: JSON.stringify({ relativePath: 'index.html' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: '{"bytes":12}',
      },
      { role: 'user', content: '按钮挤在一起了' },
    ]);
  });

  it('merges fc_ item id and call_id into one named tool and announces it during the stream', async () => {
    const sseChunks = [
      'data: {"type":"response.output_item.added","item":{"id":"fc_01a01fbf","type":"function_call","call_id":"call_01a01fbf","name":"app_render"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_01a01fbf","delta":"{\\"appId\\": "}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_01a01fbf","delta":"\\"learning-health-report\\"}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"fc_01a01fbf","type":"function_call","call_id":"call_01a01fbf","name":"app_render","arguments":"{\\"appId\\":\\"learning-health-report\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_dup","status":"completed"}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });
    const events: IChatStreamEvent[] = [];
    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      { model: 'muse-spark-1.2-contributor', messages: [{ id: '1', role: 'user', content: '精简', timestamp: 1 }] },
      (e) => events.push(e),
    );

    expect(res.choices[0].message.toolCalls).toEqual([
      {
        id: 'call_01a01fbf',
        name: 'app_render',
        arguments: { appId: 'learning-health-report' },
      },
    ]);
    expect(events.filter((e) => e.type === 'tool-call-start')).toEqual([
      {
        type: 'tool-call-start',
        toolCallId: 'call_01a01fbf',
        toolName: 'app_render',
        arguments: {},
      },
    ]);
  });

  it('does not create a second empty-name tool when argument deltas arrive before output_item.added', async () => {
    const sseChunks = [
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_pre","delta":"{\\"title\\": "}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_pre","delta":"\\"report\\"}"}\n\n',
      'data: {"type":"response.output_item.added","item":{"id":"fc_pre","type":"function_call","call_id":"call_pre","name":"app_render"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_pre","status":"completed"}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });
    const events: IChatStreamEvent[] = [];
    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      { model: 'muse-spark-1.2-contributor', messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] },
      (e) => events.push(e),
    );

    expect(res.choices[0].message.toolCalls).toEqual([
      {
        id: 'call_pre',
        name: 'app_render',
        arguments: { title: 'report' },
      },
    ]);
    expect(events.filter((e) => e.type === 'tool-call-start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool-call-start')[0]).toMatchObject({
      toolCallId: 'call_pre',
      toolName: 'app_render',
    });
  });

  it('emits reasoning and assistant text from a completed payload that had no deltas', async () => {
    const sseChunks = [
      'data: {"type":"response.completed","response":{"id":"resp_dump","status":"completed","output":[{"type":"reasoning","summary":"先看现有布局"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已按 Canvas 风格精简"}]}]}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });
    const events: IChatStreamEvent[] = [];
    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      { model: 'muse-spark-1.2-contributor', messages: [{ id: '1', role: 'user', content: '精简', timestamp: 1 }] },
      (e) => events.push(e),
    );

    expect(events.filter((e) => e.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', delta: '先看现有布局' },
    ]);
    expect(events.filter((e) => e.type === 'content-delta')).toEqual([
      { type: 'content-delta', delta: '已按 Canvas 风格精简' },
    ]);
    expect(res.choices[0].message.reasoningContent).toBe('先看现有布局');
    expect(res.choices[0].message.content).toBe('已按 Canvas 风格精简');
  });

  // ── 7.3 截断守卫回归 ──────────────────────────────────────────────

  it('stream: partial content without any completion signal throws retriable error (not silent stop)', async () => {
    // 网关截断的典型形态：已发出部分内容，然后直接关连接——没有
    // response.completed，也没有 choices finish_reason。旧实现会放行
    // 半截内容并以 finishReason='stop' 返回；现在必须抛可重试错误。
    const sseChunks = [
      'data: {"type":"response.created","response":{"id":"resp_trunc"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"half of the answer"}\n\n',
    ];
    // 重试时每次调用都要拿到全新的流，否则第二次读同一条已锁定的流会报
    // "ReadableStream is locked"，掩盖真实的终止信号缺失错误。
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    }));

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
      streamMaxRetries: 1,
      streamRetryDelayMs: () => 0,
    });

    await expect(
      provider.streamChat(
        { model: 'gpt-4o', messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] },
        () => {},
      ),
    ).rejects.toThrow('Stream ended prematurely');
  });

  it('stream: response.completed with status incomplete maps to length (overrides tool_calls)', async () => {
    const sseChunks = [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"{\\"path\\": \\"src\\"}"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"partial text"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_inc","status":"incomplete","usage":{"input_tokens":10,"output_tokens":4000,"total_tokens":4010}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });

    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      {
        model: 'gpt-4o',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }],
        maxTokens: 4000,
      },
      () => {},
    );

    // 截断证据优先：incomplete → length，绝不放行截断的 tool call。
    expect(res.choices[0].finishReason).toBe('length');
    expect(res.choices[0].message.content).toBe('partial text');
  });

  it('stream: done without status degrades to length when output tokens hit max_tokens', async () => {
    // 部分中转只发 response.done + usage、不带 status/finish_reason：
    // 与 OpenAIProvider 对齐，以输出 token 达顶作为截断证据。
    const sseChunks = [
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_nostatus","usage":{"input_tokens":10,"output_tokens":2048,"total_tokens":2058}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });

    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      {
        model: 'gpt-4o',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }],
        maxTokens: 2048,
      },
      () => {},
    );

    expect(res.choices[0].finishReason).toBe('length');
  });

  it('stream: done without status and under budget is marked unknown (never fake stop)', async () => {
    const sseChunks = [
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_nostatus2","usage":{"input_tokens":10,"output_tokens":12,"total_tokens":22}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createMockStream(sseChunks),
    });

    const res = await new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    }).streamChat(
      { model: 'gpt-4o', messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] },
      () => {},
    );

    expect(res.choices[0].finishReason).toBe('unknown');
  });

  it('non-stream: status incomplete maps to length even when tool_calls present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_inc_ns',
        status: 'incomplete',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'cut off' }],
          },
          {
            type: 'function_call',
            call_id: 'call_trunc',
            name: 'write_file',
            arguments: '{"path":"a.txt","content":"par',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 4096, total_tokens: 4101 },
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const res = await provider.chat({
      model: 'gpt-4o',
      messages: [{ id: '1', role: 'user', content: 'write a file', timestamp: 1 }],
      maxTokens: 4096,
    });

    expect(res.choices[0].finishReason).toBe('length');
  });

  it('non-stream: failed status throws retriable ProviderRequestError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_failed',
        status: 'failed',
        output: [],
        error: { message: 'generation exceeded max length', type: 'server_error' },
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.chat({
        model: 'gpt-4o',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }],
      }),
    ).rejects.toThrow('generation exceeded max length');
  });

  it('non-stream: missing status is marked unknown instead of fake stop', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        id: 'resp_nostatus_ns',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    });

    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const res = await provider.chat({
      model: 'gpt-4o',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }],
    });

    expect(res.choices[0].finishReason).toBe('unknown');
  });
});

describe('ResponseProvider: OpenCode Go gateway contract', () => {
  // 真实事故回归测试：OpenCode Go 端点强制要求 x-opencode-session，
  // 缺失时所有请求 400 MissingSessionID（整个 opencode 配置不可用）。
  // 契约：命中 opencode 域名必带头 + prompt_cache_key/store；其余网关零注入。
  function okFetch() {
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
  const chat = { model: 'muse', messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }] };

  it('injects session/client headers and cache fields for opencode.ai endpoints', async () => {
    const fetchMock = okFetch();
    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://opencode.ai/zen/go/v1',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    await provider.chat(chat);

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers['x-opencode-session']).toMatch(/\S/);
    expect(init.headers['x-opencode-client']).toBe('codepapr');
    const body = JSON.parse(init.body);
    expect(body.prompt_cache_key).toBe(true);
    expect(body.store).toBe(false);
  });

  it('honors an explicit sessionId for stable conversation routing', async () => {
    const fetchMock = okFetch();
    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://opencode.ai/zen/go/v1',
      sessionId: 'sess-fixed',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    await provider.chat(chat);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-opencode-session']).toBe('sess-fixed');
  });

  it('sends no opencode headers or cache fields to other gateways', async () => {
    const fetchMock = okFetch();
    const provider = new ResponseProvider({
      apiKey: 'sk-test',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    await provider.chat(chat);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers['x-opencode-session']).toBeUndefined();
    expect(init.headers['x-opencode-client']).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.store).toBeUndefined();
  });
});
