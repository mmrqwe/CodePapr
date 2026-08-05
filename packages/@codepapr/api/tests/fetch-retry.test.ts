import { describe, expect, it, vi } from 'vitest';
import { BaseLLMProvider, ProviderRequestError } from '../src/providers/ILLMProvider';
import type { IChatRequest, IChatResponse } from '@codepapr/types';

/** 暴露受保护的 fetchWithRetry 以便直接测试重试/超时语义。 */
class TestProvider extends BaseLLMProvider {
  name = 'test';
  models = ['test-model'];
  async chat(_request: IChatRequest, _signal?: AbortSignal): Promise<IChatResponse> {
    throw new Error('not used');
  }
  public callFetch(url: string, options: RequestInit, signal?: AbortSignal) {
    return this.fetchWithRetry(url, options, signal);
  }
}

function makeProvider(overrides: {
  fetchFn: typeof fetch;
  timeout?: number;
  maxRetries?: number;
}) {
  return new TestProvider({
    apiKey: 'test-key',
    fetchFn: overrides.fetchFn,
    timeout: overrides.timeout ?? 60000,
    maxRetries: overrides.maxRetries ?? 3,
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
});
