import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import { ClaudeProvider } from '../src/providers/ClaudeProvider';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
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
});
