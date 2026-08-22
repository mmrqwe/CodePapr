import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import { ClaudeProvider } from '../src/providers/ClaudeProvider';
import { ProviderRequestError } from '../src/providers/ILLMProvider';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** SSE response whose body breaks mid-stream (reqwest surfaces connection
 *  resets as "error decoding response body"). The optional chunk is delivered
 *  first; the break happens on the following read. */
function brokenSseResponse(emitBeforeBreak?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (emitBeforeBreak) {
        controller.enqueue(new TextEncoder().encode(emitBeforeBreak));
      }
    },
    pull(controller) {
      controller.error(new Error('error decoding response body'));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('ClaudeProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('separates system prompt, forwards tools, and preserves cache usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 20,
          output_tokens: 6,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 10,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    const request: IChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          id: 's1',
          role: 'system',
          content: 'Stable system',
          metadata: { isPrefixSystem: true },
          timestamp: 0,
        },
        {
          id: 'u1',
          role: 'user',
          content: 'hello',
          timestamp: 1,
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Lookup docs',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      maxTokens: 1024,
    };

    const response = await provider.chat(request);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      system?: Array<{ text: string }>;
      tools?: Array<{ name: string }>;
      messages: Array<{ role: string }>;
    };

    expect(body.system?.[0]?.text).toBe('Stable system');
    expect(body.tools?.[0]?.name).toBe('lookup');
    expect((body.system?.[0] as { cache_control?: unknown } | undefined)?.cache_control).toBeUndefined();
    expect((body.tools?.[0] as { cache_control?: unknown } | undefined)?.cache_control).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    expect(response.usage).toEqual({
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 10,
      input_tokens: 20,
      output_tokens: 6,
    });
  });

  it('applies prompt cache hints to system and tools when cacheControl is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          id: 's1',
          role: 'system',
          content: 'Stable system',
          metadata: { isPrefixSystem: true },
          timestamp: 0,
        },
        {
          id: 'u1',
          role: 'user',
          content: 'hello',
          timestamp: 1,
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Lookup docs',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      cacheControl: {
        type: 'session',
        budgetTokens: 128,
      },
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      system?: Array<{ cache_control?: { type: string } }>;
      tools?: Array<{ cache_control?: { type: string } }>;
    };

    expect(body.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('streamChat assembles text and tool_use deltas', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"claude-stream","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"docs\\"}"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5,"cache_read_input_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    const events: string[] = [];
    const response = await provider.streamChat?.(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      (event) => {
        if (event.type === 'content-delta') {
          events.push(event.delta);
        }
      }
    );

    expect(events).toEqual(['Hello ', 'world']);
    expect(response?.choices[0]?.message.content).toBe('Hello world');
    expect(response?.choices[0]?.message.toolCalls?.[0]).toEqual({
      id: 'tool-1',
      name: 'lookup',
      arguments: { q: 'docs' },
    });
    expect(response?.usage?.cache_read_input_tokens).toBe(7);
    expect(response?.usage?.output_tokens).toBe(5);
  });

  it('P1-15: message_delta usage merges instead of clobbering message_start input/cache tokens', async () => {
    // message_start 携带 input_tokens + cache_creation；message_delta 只带
    // output_tokens。旧实现整体替换 → input/cache 统计归零。必须按字段合并。
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"claude-usage","usage":{"input_tokens":120,"output_tokens":0,"cache_creation_input_tokens":30,"cache_read_input_tokens":40}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    const response = await provider.streamChat?.(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => undefined
    );

    expect(response?.usage?.input_tokens).toBe(120);
    expect(response?.usage?.cache_creation_input_tokens).toBe(30);
    expect(response?.usage?.cache_read_input_tokens).toBe(40);
    expect(response?.usage?.output_tokens).toBe(9);
  });

  it('流式截断：stop_reason="max_tokens" 归一化为 "length" 触发续写守卫', async () => {
    // Anthropic 的输出耗尽信号是 stop_reason='max_tokens'，而 Agent 的续写守卫
    // 只认统一的 'length'——不归一化时截断被当正常完成，回合静默结束。
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"claude-trunc","usage":{"input_tokens":50,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1024}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    const response = await provider.streamChat?.(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => undefined
    );

    expect(response?.choices[0]?.finishReason).toBe('length');
  });

  it('非流式截断：stop_reason="max_tokens" 归一化为 "length"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-trunc-nonstream',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '半截' }],
        model: 'claude-sonnet',
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 1024 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 1024,
    });

    expect(response.choices[0]?.finishReason).toBe('length');
  });

  it('P0-3: parallel tool calls merge into one user message and omit empty text blocks', async () => {
    // 并行工具调用：assistant 一条消息带两个 tool_use，随后两条 tool 结果消息。
    // Anthropic 要求角色严格交替且拒绝空 text 块——两条 tool_result 必须合并进
    // 同一个 user 消息，空 assistant 文本不得产生空 text 块。
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [
        { id: 'u1', role: 'user', content: 'do two things', timestamp: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolCalls: [
            { id: 'tc-1', name: 'read', arguments: { path: 'a' } },
            { id: 'tc-2', name: 'read', arguments: { path: 'b' } },
          ],
        },
        {
          id: 't1',
          role: 'tool',
          content: 'result-a',
          timestamp: 3,
          toolResult: { toolCallId: 'tc-1', result: 'A', success: true },
        },
        {
          id: 't2',
          role: 'tool',
          content: 'result-b',
          timestamp: 4,
          toolResult: { toolCallId: 'tc-2', result: 'B', success: true },
        },
      ],
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };

    // 角色必须严格交替：user, assistant, user（两条 tool_result 合并）
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // assistant 消息：空文本不产生 text 块，只保留两个 tool_use
    const assistantBlocks = body.messages[1].content;
    expect(assistantBlocks.filter((b) => b.type === 'text')).toHaveLength(0);
    expect(assistantBlocks.filter((b) => b.type === 'tool_use')).toHaveLength(2);

    // 合并后的 user 消息包含两个 tool_result
    const mergedUserBlocks = body.messages[2].content;
    expect(mergedUserBlocks.filter((b) => b.type === 'tool_result')).toHaveLength(2);
  });

  it('retries a mid-stream break after content was emitted, emitting stream-restart so the caller can reset', async () => {
    const okChunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完整"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        brokenSseResponse(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半"}}\n\n'
        )
      )
      .mockResolvedValueOnce(
        new Response(okChunks, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
      streamMaxRetries: 6,
    });
    const events: string[] = [];
    const response = await provider.streamChat(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      (event) => {
        if (event.type === 'content-delta') {
          events.push(`content:${event.delta}`);
        } else if (event.type === 'stream-restart') {
          events.push(`restart:${event.attempt}/${event.maxRetries}`);
        }
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['content:半', 'restart:1/6', 'content:完整']);
    expect(response?.choices[0]?.message.content).toBe('完整');
  });

  it('surfaces a retriable error after exhausting mid-stream retries', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        brokenSseResponse(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半"}}\n\n'
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
      streamMaxRetries: 6,
    });
    const restarts: number[] = [];
    let caught: unknown;
    try {
      await provider.streamChat(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
          maxTokens: 1024,
        },
        (event) => {
          if (event.type === 'stream-restart') {
            restarts.push(event.attempt);
          }
        }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).retriable).toBe(true);
    expect((caught as Error).message).toContain('Stream interrupted');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(restarts).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('retries a stream break when nothing was emitted yet', async () => {
    const okChunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完整"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(brokenSseResponse())
      .mockResolvedValueOnce(
        new Response(okChunks, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    const response = await provider.streamChat(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.choices[0]?.message.content).toBe('完整');
  });

  it('surfaces a deterministic SSE error event as non-retriable instead of retrying forever', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(errorEvent, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    let caught: unknown;
    try {
      await provider.streamChat(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
          maxTokens: 1024,
        },
        () => {}
      );
    } catch (err) {
      caught = err;
    }

    // 确定性错误（鉴权失败）必须立即终止且不重试——旧实现把它当瞬态断流
    // 无限重连（欠费/配置错误永久卡死）。
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).retriable).toBe(false);
    expect((caught as Error).message).toContain('authentication_error');
    expect((caught as Error).message).toContain('invalid x-api-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks overloaded_error SSE events as retriable', async () => {
    const errorEvent =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
    const okChunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(errorEvent, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
      .mockResolvedValueOnce(
        new Response(okChunks, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0, streamMaxRetries: 6 });
    const response = await provider.streamChat(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.choices[0]?.message.content).toBe('好');
  });

  it('sends budget_tokens and temperature=1 when thinking is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-thinking',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 8192,
      temperature: 0.5,
      thinking: { type: 'enabled' },
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      temperature?: number;
      thinking?: { type?: string; budget_tokens?: number };
    };

    // 旧实现：thinking 只有 {type:"enabled"}——Anthropic 要求 budget_tokens
    // 且 temperature=1，任何启用 thinking 的调用都会 400。
    expect(body.temperature).toBe(1);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('keeps the configured temperature when thinking is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-no-thinking',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 8192,
      temperature: 0.5,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      temperature?: number;
      thinking?: unknown;
    };
    expect(body.temperature).toBe(0.5);
    expect(body.thinking).toBeUndefined();
  });

  it('uses the caller-provided budget_tokens when thinking is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'claude-budget-custom',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 20000,
      thinking: { type: 'enabled', budgetTokens: 8000 },
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      thinking?: { budget_tokens?: number };
    };
    expect(body.thinking?.budget_tokens).toBe(8000);
  });

  it('clamps the caller budget into [1024, maxTokens-1]', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'claude-budget-clamp-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'claude-budget-clamp-2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    // 过小 → 抬到 1024；过大 → 压到 maxTokens-1
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 100 },
    });
    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u2', role: 'user', content: 'hello', timestamp: 2 }],
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 999999 },
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const first = JSON.parse(calls[0][1].body as string) as { thinking?: { budget_tokens?: number } };
    const second = JSON.parse(calls[1][1].body as string) as { thinking?: { budget_tokens?: number } };
    expect(first.thinking?.budget_tokens).toBe(1024);
    expect(second.thinking?.budget_tokens).toBe(4095);
  });
});
