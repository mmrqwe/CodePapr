import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import { DeepSeekProvider } from '../src/providers/DeepSeekProvider';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeepSeekProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('thinking 开启时会回传 reasoning_content 并解析响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '最终答案',
              reasoning_content: '中间推理',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const request: IChatRequest = {
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '上一轮答案',
          reasoningContent: '上一轮推理',
          timestamp: 1,
        },
        {
          id: 'user-1',
          role: 'user',
          content: '继续追问',
          timestamp: 2,
        },
      ],
      maxTokens: 1024,
    };

    const response = await provider.chat(request);

    expect(response.choices[0]?.message.reasoningContent).toBe('中间推理');

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      thinking?: { type: string };
      messages: Array<{
        id?: string;
        metadata?: unknown;
        reasoning_content?: string;
        timestamp?: number;
      }>;
    };

    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.messages[0]?.reasoning_content).toBe('上一轮推理');
    expect(body.messages[0]?.id).toBeUndefined();
    expect(body.messages[0]?.timestamp).toBeUndefined();
    expect(body.messages[0]?.metadata).toBeUndefined();
  });

  it('发送 system 角色并稳定序列化工具参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-system',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-chat',
      messages: [
        {
          id: 'prefix-system',
          role: 'system',
          content: 'Stable prefix',
          timestamp: 0,
          metadata: { isPrefixSystem: true },
        },
        {
          id: 'assistant-tool',
          role: 'assistant',
          content: '',
          timestamp: 1,
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { b: 2, a: 1 } }],
        },
      ],
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      messages: Array<{
        role: string;
        tool_calls?: Array<{ function: { arguments: string } }>;
      }>;
    };

    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]?.tool_calls?.[0]?.function.arguments).toBe('{"a":1,"b":2}');
  });

  it('保留 DeepSeek 官方 prompt cache hit/miss 字段并映射到统一统计', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-cache-official',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 150,
          completion_tokens: 12,
          prompt_cache_hit_tokens: 120,
          prompt_cache_miss_tokens: 30,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'deepseek-chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'test',
          timestamp: 1,
        },
      ],
      maxTokens: 256,
    });

    expect(response.usage).toEqual({
      prompt_cache_hit_tokens: 120,
      prompt_cache_miss_tokens: 30,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 0,
      input_tokens: 30,
      output_tokens: 12,
    });
  });

  it('旧字段缺少 miss 时会用 prompt_tokens 扣除 hit 计算未命中输入', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-cache-legacy',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          cache_hit_tokens: 12,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'deepseek-chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'legacy cache usage',
          timestamp: 1,
        },
      ],
      maxTokens: 256,
    });

    expect(response.usage?.cache_read_input_tokens).toBe(12);
    expect(response?.usage?.cache_creation_input_tokens).toBe(0);
    expect(response.usage?.prompt_cache_hit_tokens).toBe(12);
    expect(response.usage?.prompt_cache_miss_tokens).toBe(8);
    expect(response.usage?.input_tokens).toBe(8);
  });

  it('legacy reasoner 模型不会发送 thinking 和 reasoning_content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-2',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '最终答案',
              reasoning_content: '中间推理',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 16,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-reasoner',
      thinking: { type: 'enabled' },
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '上一轮答案',
          reasoningContent: '上一轮推理',
          timestamp: 1,
        },
      ],
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      thinking?: { type: string };
      messages: Array<{ reasoning_content?: string }>;
    };

    expect(body.thinking).toBeUndefined();
    expect(body.messages[0]?.reasoning_content).toBeUndefined();
  });

  it('thinking=disabled 但历史 assistant 含 tool_calls 时仍必须回传 reasoning_content（API 400 根因修复）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-disabled-tc',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '已分析',
              reasoning_content: '',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-v4-pro',
      thinking: { type: 'disabled' },
      messages: [
        {
          id: 'assistant-toolcall-1',
          role: 'assistant',
          content: '调用工具中',
          reasoningContent: '上一轮工具调用前的思考',
          toolCalls: [
            {
              id: 'call_tool_1',
              name: 'read',
              arguments: { relativePath: 'src/index.ts' },
            },
          ],
          timestamp: 1,
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'file content',
          toolResult: { toolCallId: 'call_tool_1', result: 'file content' },
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
      thinking?: { type: string };
      messages: Array<{
        reasoning_content?: string;
        tool_calls?: Array<{ id: string }>;
      }>;
    };

    // thinking 关闭时本轮确实不发 thinking payload
    expect(body.thinking).toEqual({ type: 'disabled' });
    // 但带 tool_calls 的历史 assistant 必须回传 reasoning_content
    expect(body.messages[0]?.reasoning_content).toBe('上一轮工具调用前的思考');
    expect(body.messages[0]?.tool_calls?.[0]?.id).toBe('call_tool_1');
  });

  it('legacy reasoner 模型历史 assistant 含 tool_calls 时也必须回传 reasoning_content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-legacy-tc',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '完成',
              reasoning_content: '',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-reasoner',
      thinking: { type: 'enabled' },
      messages: [
        {
          id: 'assistant-toolcall-legacy',
          role: 'assistant',
          content: '准备调用',
          reasoningContent: 'reasoner 模型的工具前推理',
          toolCalls: [
            {
              id: 'call_legacy_1',
              name: 'read',
              arguments: { relativePath: 'README.md' },
            },
          ],
          timestamp: 1,
        },
      ],
      maxTokens: 1024,
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      thinking?: { type: string };
      messages: Array<{
        reasoning_content?: string;
        tool_calls?: Array<{ id: string }>;
      }>;
    };

    // legacy reasoner 不发 thinking payload
    expect(body.thinking).toBeUndefined();
    // 但带 tool_calls 的历史 assistant 仍必须回传 reasoning_content（否则 API 400 "Load fail"）
    expect(body.messages[0]?.reasoning_content).toBe('reasoner 模型的工具前推理');
    expect(body.messages[0]?.tool_calls?.[0]?.id).toBe('call_legacy_1');
  });

  it('streamChat 会按增量推送 reasoning 和 content，并组装最终响应', async () => {
    const chunks = [
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"reasoning_content":"先分析"},"finish_reason":null}]}\n\n',
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"最终"},"finish_reason":null}]}\n\n',
      'data: {"id":"resp-stream","choices":[{"index":0,"delta":{"content":"答案"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"prompt_cache_hit_tokens":3,"prompt_cache_miss_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const events: string[] = [];

    const response = await provider.streamChat?.(
      {
        model: 'deepseek-v4-pro',
        thinking: { type: 'enabled' },
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: '请流式回答',
            timestamp: 1,
          },
        ],
        maxTokens: 1024,
      },
      (event) => {
        events.push(`${event.type}:${event.delta}`);
      }
    );

    expect(events).toEqual(['reasoning-delta:先分析', 'content-delta:最终', 'content-delta:答案']);
    expect(response?.choices[0]?.message.reasoningContent).toBe('先分析');
    expect(response?.choices[0]?.message.content).toBe('最终答案');
    expect(response?.usage?.prompt_cache_hit_tokens).toBe(3);
    expect(response?.usage?.prompt_cache_miss_tokens).toBe(9);
    expect(response?.usage?.cache_read_input_tokens).toBe(3);
    expect(response?.usage?.cache_creation_input_tokens).toBe(0);
    expect(response?.usage?.input_tokens).toBe(9);

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };

    expect(body.stream).toBe(true);
    expect(body.stream_options?.include_usage).toBe(true);
  });
});