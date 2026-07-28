import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/providers/OpenAIProvider';
import { safeParseToolArguments } from '../src/providers/streaming';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
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
});
