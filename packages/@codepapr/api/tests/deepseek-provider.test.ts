import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChatRequest } from '@codepapr/types';
import { DeepSeekProvider } from '../src/providers/DeepSeekProvider';
import { ProviderRequestError } from '../src/providers/ILLMProvider';

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

  it('工具定义使用规范的单层 function 包装，不带顶层重复字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-tools',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-chat',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
      maxTokens: 1024,
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>;
    };
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search docs',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ]);
    expect(body.tools?.[0]?.name).toBeUndefined();
    expect(body.tools?.[0]?.description).toBeUndefined();
    expect(body.tools?.[0]?.parameters).toBeUndefined();
  });

  it('响应中的占位符回声会被剥离（含旧字面量与新模板句）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp-echo-legacy',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'done',
                reasoning_content: '[reasoning not captured]',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp-echo-new',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'Called browser to proceed.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const request: IChatRequest = {
      model: 'deepseek-v4-pro',
      messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }],
      maxTokens: 1024,
    };

    const legacy = await provider.chat(request);
    expect(legacy.choices[0]?.message.reasoningContent).toBeUndefined();
    expect(legacy.choices[0]?.message.content).toBe('done');

    // 新模板句回声同样剥离：响应变为真正的空完成，交由 Agent 空完成守卫重试
    const echo = await provider.chat(request);
    expect(echo.choices[0]?.message.reasoningContent).toBeUndefined();
    expect(echo.choices[0]?.message.content).toBe('');
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

  it('thinking 开启但历史 tool_calls assistant 缺 reasoning 时注入占位符且不降级 thinking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-placeholder',
        choices: [
          {
            message: { role: 'assistant', content: '完成', reasoning_content: '本轮思考' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled' },
      messages: [
        {
          id: 'assistant-toolcall-empty-reasoning',
          role: 'assistant',
          content: '调用工具中',
          toolCalls: [
            {
              id: 'call_no_reasoning_1',
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
          toolResult: { toolCallId: 'call_no_reasoning_1', result: 'file content' },
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

    // thinking 保持开启，不降级
    expect(body.thinking).toEqual({ type: 'enabled' });
    // 缺 reasoning 的工具轮注入动态占位符（取自首个工具名），tool_calls 原样保留
    expect(body.messages[0]?.reasoning_content).toBe('Called read to proceed.');
    expect(body.messages[0]?.tool_calls?.[0]?.id).toBe('call_no_reasoning_1');
  });

  it('thinking 关闭且工具轮缺 reasoning 时同样注入占位符（与 thinking 开关解耦，字节稳定）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-placeholder-off',
        choices: [
          {
            message: { role: 'assistant', content: '完成', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      messages: [
        {
          id: 'assistant-toolcall-off',
          role: 'assistant',
          content: '调用工具中',
          toolCalls: [
            {
              id: 'call_off_1',
              name: 'read',
              arguments: { relativePath: 'src/index.ts' },
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
      messages: Array<{ reasoning_content?: string }>;
    };

    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[0]?.reasoning_content).toBe('Called read to proceed.');
  });

  it('响应带回旧占位符回声时置空（chat）：阻断渲染/持久化/再回声循环', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'resp-echo',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '继续执行',
              reasoning_content: '[reasoning not captured]',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'deepseek-v4-flash',
      messages: [{ id: 'u1', role: 'user', content: '继续', timestamp: 1 }],
      maxTokens: 1024,
    });

    expect(response.choices[0]?.message.reasoningContent).toBeUndefined();
    expect(response.choices[0]?.message.content).toBe('继续执行');
  });

  it('流式增量全程是旧占位符回声时最终 reasoning 置空（streamChat）', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"[reasoning not "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"captured]","content":"结果"}}]}\n\n',
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
    const response = await provider.streamChat?.(
      {
        model: 'deepseek-v4-flash',
        messages: [{ id: 'u1', role: 'user', content: '继续', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => undefined
    );

    expect(response?.choices[0]?.message.reasoningContent).toBeUndefined();
    expect(response?.choices[0]?.message.content).toBe('结果');
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
          id: 'resp-fallback',
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

    const provider = new DeepSeekProvider({ apiKey: 'test-key' });
    const response = await provider.chat({
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled', reasoningEffort: 'max' },
      messages: [
        {
          id: 'assistant-toolcall-no-reasoning',
          role: 'assistant',
          content: '调用工具中',
          toolCalls: [
            {
              id: 'call_fb_1',
              name: 'read',
              arguments: { relativePath: 'src/index.ts' },
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
    // 两次请求：原请求（thinking enabled）+ 兜底重试（thinking disabled）
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

  it('streamChat 兼容 reasoning 别名字段下发思考内容', async () => {
    const chunks = [
      'data: {"id":"resp-alias","choices":[{"index":0,"delta":{"reasoning":"别名思考"},"finish_reason":null}]}\n\n',
      'data: {"id":"resp-alias","choices":[{"index":0,"delta":{"content":"最终"},"finish_reason":"stop"}]}\n\n',
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
          { id: 'user-1', role: 'user', content: '请回答', timestamp: 1 },
        ],
        maxTokens: 1024,
      },
      (event) => {
        events.push(`${event.type}:${event.delta}`);
      }
    );

    expect(events).toEqual(['reasoning-delta:别名思考', 'content-delta:最终']);
    expect(response?.choices[0]?.message.reasoningContent).toBe('别名思考');
  });

  it('把无 [DONE]/finish_reason/usage 的干净截断判定为提前结束并重连', async () => {
    // 第一次：思考途中被中转截断后干净关闭（无终止信号）。
    const truncated =
      'data: {"id":"resp-trunc","choices":[{"index":0,"delta":{"reasoning_content":"思考到一半"},"finish_reason":null}]}\n\n';
    const okChunks = [
      'data: {"id":"resp-ok","choices":[{"index":0,"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(truncated, {
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

    const provider = new DeepSeekProvider({ apiKey: 'test-key', streamRetryDelayMs: () => 0 });
    const restarts: number[] = [];
    const response = await provider.streamChat?.(
      {
        model: 'deepseek-v4-pro',
        messages: [{ id: 'user-1', role: 'user', content: '请回答', timestamp: 1 }],
        maxTokens: 1024,
      },
      (event) => {
        if (event.type === 'stream-restart') restarts.push(event.attempt);
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(restarts).toEqual([1]);
    expect(response?.choices[0]?.message.content).toBe('完整');
  });

  it('持续截断时抛出可重试的 premature-EOF 错误', async () => {
    const truncated =
      'data: {"id":"resp-trunc","choices":[{"index":0,"delta":{"content":"半"},"finish_reason":null}]}\n\n';
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(truncated, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
      streamMaxRetries: 2,
    });
    let caught: unknown;
    try {
      await provider.streamChat?.(
        {
          model: 'deepseek-v4-pro',
          messages: [{ id: 'user-1', role: 'user', content: '请回答', timestamp: 1 }],
          maxTokens: 1024,
        },
        () => {}
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).retriable).toBe(true);
    expect((caught as Error).message).toContain('Stream ended prematurely');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('只收到 usage 而无 [DONE]/finish_reason 同样判定截断，不当作正常完成', async () => {
    // 坏中继：先发 usage 再直接关闭连接——旧实现把 usage 当终止信号放行，
    // 部分内容被当成正常完成返回，且 finish_reason 缺失绕过 length 守卫。
    const truncatedWithUsage =
      'data: {"id":"resp-trunc-usage","choices":[{"index":0,"delta":{"content":"半"},"finish_reason":null}]}\n\n' +
      'data: {"id":"resp-trunc-usage","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n';
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(truncatedWithUsage, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
      streamMaxRetries: 2,
    });
    let caught: unknown;
    try {
      await provider.streamChat?.(
        {
          model: 'deepseek-v4-pro',
          messages: [{ id: 'user-1', role: 'user', content: '请回答', timestamp: 1 }],
          maxTokens: 1024,
        },
        () => {}
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).retriable).toBe(true);
    expect((caught as Error).message).toContain('Stream ended prematurely');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('流内 error 对象按确定性错误分类：立即终止且不重试', async () => {
    // 中转以 SSE data 下发欠费错误后干净关流——旧实现没有 chunk.error 分支，
    // 走到「流提前结束」分支抛可重试错误，叠加流层无限重连永久卡死。
    const errorEvent =
      'data: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}\n\n' +
      'data: [DONE]\n\n';
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(errorEvent, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
    });
    let caught: unknown;
    try {
      await provider.streamChat?.(
        {
          model: 'deepseek-v4-pro',
          messages: [{ id: 'user-1', role: 'user', content: '请回答', timestamp: 1 }],
          maxTokens: 1024,
        },
        () => {}
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).retriable).toBe(false);
    expect((caught as Error).message).toContain('insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('流内 rate_limit_error 归类为可重试并恢复', async () => {
    const errorEvent =
      'data: {"error":{"type":"rate_limit_error","message":"rate limited"}}\n\n' +
      'data: [DONE]\n\n';
    const okChunks =
      'data: {"id":"resp-ok","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n';
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(errorEvent, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(okChunks, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      streamRetryDelayMs: () => 0,
      streamMaxRetries: 6,
    });
    const response = await provider.streamChat?.(
      {
        model: 'deepseek-v4-pro',
        messages: [{ id: 'user-1', role: 'user', content: '请回答', timestamp: 1 }],
        maxTokens: 1024,
      },
      () => {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.choices[0]?.message.content).toBe('好');
  });
});