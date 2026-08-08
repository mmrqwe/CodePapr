import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { ProviderRequestError } from '../src/providers/ILLMProvider';
import { safeParseToolArguments } from '../src/providers/streaming';

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

describe('OpenAIProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses reasoning_content and extended usage fields from compatible responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-openai',
        choices: [
          {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '最终答案' }],
              reasoning_content: '中间推理',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'lookup',
                    arguments: '{"a":1,',
                  },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 12,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 3,
          input_tokens: 19,
          output_tokens: 12,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 1024,
    });

    expect(response.choices[0]?.message.content).toBe('最终答案');
    expect(response.choices[0]?.message.reasoningContent).toBe('中间推理');
    expect(response.choices[0]?.message.toolCalls?.[0]?.arguments).toEqual({
      a: 1,
    });
    expect(response.usage).toEqual({
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 3,
      input_tokens: 19,
      output_tokens: 12,
    });
  });

  it('streamChat emits reasoning/content deltas and normalizes cached tokens', async () => {
    const chunks = [
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"reasoning_content":"先想"},"finish_reason":null}]}\n\n',
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"答"},"finish_reason":null}]}\n\n',
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"案"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const events: string[] = [];
    const response = await provider.streamChat?.(
      {
        model: 'gpt-4o',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      (event) => {
        if (event.type === 'reasoning-delta' || event.type === 'content-delta') {
          events.push(`${event.type}:${event.delta}`);
        }
      }
    );

    expect(events).toEqual([
      'reasoning-delta:先想',
      'content-delta:答',
      'content-delta:案',
    ]);
    expect(response?.choices[0]?.message.reasoningContent).toBe('先想');
    expect(response?.choices[0]?.message.content).toBe('答案');
    expect(response?.usage?.cache_read_input_tokens).toBe(5);
    expect(response?.usage?.input_tokens).toBe(10);
  });

  it('retries a mid-stream break after content was emitted, emitting stream-restart so the caller can reset', async () => {
    const okChunks = [
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        brokenSseResponse(
          'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"半"},"finish_reason":null}]}\n\n'
        )
      )
      .mockResolvedValueOnce(
        new Response(okChunks, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    const events: string[] = [];
    const response = await provider.streamChat(
      {
        model: 'gpt-4o',
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
    expect(events).toEqual(['content:半', 'restart:1/3', 'content:完整']);
    expect(response?.choices[0]?.message.content).toBe('完整');
  });

  it('surfaces a retriable error after exhausting mid-stream retries', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        brokenSseResponse(
          'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"半"},"finish_reason":null}]}\n\n'
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    const restarts: number[] = [];
    let caught: unknown;
    try {
      await provider.streamChat(
        {
          model: 'gpt-4o',
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(restarts).toEqual([1, 2, 3]);
  });

  it('retries a stream break when nothing was emitted yet', async () => {
    const okChunks = [
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
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

    const provider = new OpenAIProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    const response = await provider.streamChat?.(
      {
        model: 'gpt-4o',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.choices[0]?.message.content).toBe('完整');
  });

  it('skips malformed SSE chunks instead of aborting the stream', async () => {
    const chunks = [
      'data: {not json}\n\n',
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const response = await provider.streamChat?.(
      {
        model: 'gpt-4o',
        messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => {}
    );

    expect(response?.choices[0]?.message.content).toBe('ok');
  });
});

describe('safeParseToolArguments', () => {
  it('parses valid JSON', () => {
    expect(safeParseToolArguments('{"relativePath":"foo.ts","content":"bar"}')).toEqual({
      relativePath: 'foo.ts',
      content: 'bar',
    });
  });

  it('returns empty object for empty string', () => {
    expect(safeParseToolArguments('')).toEqual({});
    expect(safeParseToolArguments('   ')).toEqual({});
  });

  it('repairs missing closing braces', () => {
    expect(safeParseToolArguments('{"a":1')).toEqual({ a: 1 });
  });

  it('repairs trailing commas', () => {
    expect(safeParseToolArguments('{"a":1,}')).toEqual({ a: 1 });
  });

  it('repairs trailing comma with missing brace', () => {
    expect(safeParseToolArguments('{"a":1,')).toEqual({ a: 1 });
  });

  it('repairs raw newlines inside string values', () => {
    expect(safeParseToolArguments('{"args":["-c","line1\nline2"]}')).toEqual({
      args: ['-c', 'line1\nline2'],
    });
  });

  it('repairs raw tabs and carriage returns inside string values', () => {
    expect(safeParseToolArguments('{"sql":"col1\tcol2\r\nend"}')).toEqual({
      sql: 'col1\tcol2\r\nend',
    });
  });

  it('does not double-escape existing escape sequences', () => {
    expect(safeParseToolArguments('{"text":"a\\nb"}')).toEqual({ text: 'a\nb' });
  });

  it('returns _parseError for unrepairable JSON', () => {
    const result = safeParseToolArguments('not json at all');
    expect(result._parseError).toBe(true);
    expect((result as Record<string, unknown>).error).toMatch(/JSON 解析失败/);
    expect(typeof (result as Record<string, unknown>)._raw).toBe('string');
  });

  it('回传已存 reasoning_content 并为缺失 reasoning 的工具轮注入占位符', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-openai-reasoning',
        choices: [
          {
            message: { role: 'assistant', content: '最终答案', reasoning_content: '本轮思考' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'gpt-4o',
      thinking: { type: 'enabled' },
      messages: [
        {
          id: 'assistant-with-reasoning',
          role: 'assistant',
          content: '上一轮答案',
          reasoningContent: '上一轮推理',
          timestamp: 1,
        },
        {
          id: 'assistant-toolcall-no-reasoning',
          role: 'assistant',
          content: '调用工具中',
          toolCalls: [
            {
              id: 'call_openai_1',
              name: 'lookup',
              arguments: { b: 2, a: 1 },
            },
          ],
          timestamp: 2,
        },
        {
          id: 'user-2',
          role: 'user',
          content: '继续',
          timestamp: 3,
        },
      ],
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      messages: Array<{
        reasoning_content?: string;
        tool_calls?: Array<{ function: { arguments: string } }>;
      }>;
    };

    expect(body.messages[0]?.reasoning_content).toBe('上一轮推理');
    expect(body.messages[1]?.reasoning_content).toBe('[reasoning not captured]');
    expect(body.messages[1]?.tool_calls?.[0]?.function.arguments).toBe('{"a":1,"b":2}');
  });

  it('reasoning 回传校验 400 时自动以 thinking 关闭重试一次', async () => {
    const reasoning400 = new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message:
            'Error from provider (Console Go): Upstream request failed: [invalid_request_error] ' +
            'The reasoning_content in the thinking mode must be passed back to the API.',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reasoning400)
      .mockResolvedValue(
        jsonResponse({
          id: 'resp-openai-fallback',
          choices: [
            {
              message: { role: 'assistant', content: '兜底成功', reasoning_content: '' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'gpt-4o',
      thinking: { type: 'enabled', reasoningEffort: 'max' },
      messages: [
        {
          id: 'assistant-toolcall-no-reasoning',
          role: 'assistant',
          content: '调用工具中',
          toolCalls: [
            {
              id: 'call_fb_openai_1',
              name: 'lookup',
              arguments: { a: 1 },
            },
          ],
          timestamp: 1,
        },
        {
          id: 'user-2',
          role: 'user',
          content: '继续',
          timestamp: 2,
        },
      ],
      maxTokens: 1024,
    });

    expect(response.choices[0]?.message.content).toBe('兜底成功');
    expect(fetchMock.mock.calls.length).toBe(2);

    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { thinking?: { type: string }; reasoning_effort?: string };
    expect(firstBody.thinking).toEqual({ type: 'enabled' });

    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string
    ) as { thinking?: { type: string }; reasoning_effort?: string };
    expect(secondBody.thinking).toEqual({ type: 'disabled' });
    expect(secondBody.reasoning_effort).toBeUndefined();
  });
});
