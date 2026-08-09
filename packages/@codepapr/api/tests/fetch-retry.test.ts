import { describe, expect, it, vi } from 'vitest';
import {
  BaseLLMProvider,
  DEFAULT_REQUEST_MAX_RETRIES,
  defaultRequestRetryDelayMs,
  DEFAULT_REQUEST_RETRY_DELAYS_MS,
  ProviderRequestError,
} from '../src/providers/ILLMProvider';
import type { IChatRequest, IChatResponse } from '@codepapr/types';

/** 暴露受保护的 fetchWithRetry 以便直接测试重试/超时语义。 */
class TestProvider extends BaseLLMProvider {
  name = 'test';
  models = ['test-model'];
  async chat(_request: IChatRequest, _signal?: AbortSignal): Promise<IChatResponse> {
    throw new Error('not used');
  }
  public callFetch(
    url: string,
    options: RequestInit,
    signal?: AbortSignal,
    onRequestRetry?: (attempt: number, maxRetries: number, error: Error) => void
  ) {
    return this.fetchWithRetry(url, options, signal, onRequestRetry);
  }
}

function makeProvider(overrides: {
  fetchFn: typeof fetch;
  timeout?: number;
  maxRetries?: number;
  onRequestRetry?: (attempt: number, maxRetries: number, error: Error) => void;
}) {
  return new TestProvider({
    apiKey: 'test-key',
    fetchFn: overrides.fetchFn,
    timeout: overrides.timeout ?? 60000,
    maxRetries: overrides.maxRetries ?? DEFAULT_REQUEST_MAX_RETRIES,
    onRequestRetry: overrides.onRequestRetry,
    requestRetryDelayMs: () => 0,
  });
}

function statusResponse(status: number): Response {
  return new Response(`error body ${status}`, { status });
}

describe('fetchWithRetry 重试语义', () => {
  it('P1-10: 4xx（非 429）立即失败，不重试', async () => {
    const fetchMock = vi.fn().mockImplementation(() => statusResponse(401));
    const provider = makeProvider({ fetchFn: fetchMock as unknown as typeof fetch, maxRetries: 3 });

    await expect(provider.callFetch('http://x', { method: 'POST' })).rejects.toMatchObject({
      name: 'ProviderRequestError',
      status: 401,
      retriable: false,
    });
    // 旧实现会把 4xx 吞进 catch 重试 3 次；修复后只请求一次。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('P1-10: 429 视为可重试，达到最大重试次数', async () => {
    // 每次调用返回全新 Response（Response body 只能被消费一次）
    const fetchMock = vi.fn().mockImplementation(() => statusResponse(429));
    const provider = makeProvider({ fetchFn: fetchMock as unknown as typeof fetch, maxRetries: 2 });

    await expect(provider.callFetch('http://x', { method: 'POST' })).rejects.toMatchObject({
      name: 'ProviderRequestError',
      status: 429,
      retriable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('P1-11: 超时与用户取消区分——超时重试并以可重试错误结束，而非 AbortError', async () => {
    // fetch 挂起直到内部超时控制器 abort（尊重 signal）。
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const onAbort = () =>
            reject(new DOMException('The operation was aborted', 'AbortError'));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        })
    );
    const provider = makeProvider({
      fetchFn: fetchMock as unknown as typeof fetch,
      timeout: 10,
      maxRetries: 2,
    });

    const err = await provider.callFetch('http://x', { method: 'POST' }).catch((e) => e);
    // 超时必须表现为可重试的 ProviderRequestError，而不是 AbortError「已取消」。
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect((err as ProviderRequestError).retriable).toBe(true);
    expect((err as Error).message).toContain('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('P1-11: 用户主动取消立即抛出 AbortError，不重试', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const onAbort = () =>
            reject(new DOMException('The operation was aborted', 'AbortError'));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        })
    );
    const provider = makeProvider({
      fetchFn: fetchMock as unknown as typeof fetch,
      timeout: 60000,
      maxRetries: 3,
    });

    const controller = new AbortController();
    const pending = provider.callFetch('http://x', { method: 'POST' }, controller.signal);
    // 让第一次 fetch 挂起后触发用户取消
    setTimeout(() => controller.abort(), 5);

    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    // 用户取消不应触发重试
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('默认 6 次重试，连接层失败耗尽后带 attempts 字段；错误仍标记 retriable 供流层无限重连', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      throw new Error('error sending request for url (https://opencode.ai/zen/go/v1/chat/completions)');
    });
    const provider = makeProvider({ fetchFn: fetchMock as unknown as typeof fetch });

    const err = (await provider.callFetch('http://x', { method: 'POST' }).catch((e) => e)) as
      ProviderRequestError;
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_REQUEST_MAX_RETRIES);
    expect(err).toBeInstanceOf(ProviderRequestError);
    // 耗尽连接层重试只说明这波故障持续，不代表永久失败：标记 retriable 让
    // 流层（withStreamIdleRetry）继续无限重连，网络波动不终止回合。
    expect(err.retriable).toBe(true);
    expect(err.attempts).toBe(DEFAULT_REQUEST_MAX_RETRIES);
    expect(err.maxRetries).toBe(DEFAULT_REQUEST_MAX_RETRIES);
    expect(err.message).toContain(
      `Network error after ${DEFAULT_REQUEST_MAX_RETRIES} attempts`
    );
  });

  it('每次重试前调用 onRequestRetry，携带 attempt/maxRetries/错误', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const seen: Array<{ attempt: number; maxRetries: number; error: string }> = [];
    const provider = makeProvider({
      fetchFn: fetchMock as unknown as typeof fetch,
      maxRetries: 3,
      onRequestRetry: (attempt, maxRetries, error) => {
        seen.push({ attempt, maxRetries, error: error.message });
      },
    });

    await provider.callFetch('http://x', { method: 'POST' }).catch(() => undefined);
    expect(seen).toEqual([
      { attempt: 1, maxRetries: 3, error: 'boom' },
      { attempt: 2, maxRetries: 3, error: 'boom' },
    ]);
  });

  it('请求级退避封顶 30s', () => {
    expect(DEFAULT_REQUEST_RETRY_DELAYS_MS).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000,
    ]);
    expect(defaultRequestRetryDelayMs(1)).toBe(1000);
    expect(defaultRequestRetryDelayMs(6)).toBe(30000);
    expect(defaultRequestRetryDelayMs(99)).toBe(30000);
  });
});
