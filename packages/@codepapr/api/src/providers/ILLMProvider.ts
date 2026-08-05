/**
 * ILLMProvider: 统一的 LLM 提供商接口
 *
 * 所有 LLM 提供商必须实现此接口以确保统一的调用方式
 */

import { IChatRequest, IChatResponse, ILLMProvider } from '@codepapr/types';
import { Logger } from '@codepapr/common';

const log = new Logger('LLMProvider');

let _globalFetchFn: typeof globalThis.fetch | undefined;

export function setGlobalFetchFn(fn: typeof globalThis.fetch): void {
  _globalFetchFn = fn;
}

export function getGlobalFetchFn(): typeof globalThis.fetch {
  return _globalFetchFn ?? globalThis.fetch.bind(globalThis);
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  /** SSE 流空闲超时（毫秒）：超过该时长未收到任何数据块即判定超时。
   *  未设置时回退到 DEFAULT_STREAM_IDLE_TIMEOUT_MS。推理模型 thinking 阶段建议调大。 */
  idleTimeoutMs?: number;
  fetchFn?: typeof globalThis.fetch;
}

export class ProviderRequestError extends Error {
  provider: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
  retriable: boolean;

  constructor(options: {
    provider: string;
    message: string;
    status?: number;
    requestId?: string;
    responseBody?: string;
    retriable?: boolean;
  }) {
    super(options.message);
    this.name = 'ProviderRequestError';
    this.provider = options.provider;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
    this.retriable = options.retriable ?? false;
  }
}

function truncateErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 2000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1999)}…`;
}

function extractRequestId(headers: Headers): string | undefined {
  return (
    headers.get('x-request-id') ??
    headers.get('request-id') ??
    headers.get('anthropic-request-id') ??
    undefined
  );
}

export abstract class BaseLLMProvider implements ILLMProvider {
  abstract name: string;
  abstract models: string[];

  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      timeout: 60000,
      maxRetries: 3,
      ...config,
    };
  }

  abstract chat(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse>;
  abstract streamChat?(
    request: IChatRequest,
    onEvent: (event: import('@codepapr/types').IChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<IChatResponse>;

  validate(): boolean {
    return !!this.config.apiKey;
  }

  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    signal?: AbortSignal
  ): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? 3;
    let lastError: Error | null = null;
    const fetchFn = this.config.fetchFn ?? getGlobalFetchFn();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new DOMException('Request was cancelled', 'AbortError');
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout
      );

      const abortHandler = () => controller.abort();
      signal?.addEventListener('abort', abortHandler, { once: true });

      try {
        const response = await fetchFn(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);

        if (response.ok) {
          return response;
        }

        const errorText = truncateErrorBody(await response.text());
        const requestId = extractRequestId(response.headers);
        const retriable = response.status >= 500 || response.status === 429;
        const providerError = new ProviderRequestError({
          provider: this.name,
          message: `HTTP ${response.status}: ${errorText}`,
          status: response.status,
          requestId,
          responseBody: errorText,
          retriable,
        });

        log.warn(`${this.name} request failed`, {
          attempt: attempt + 1,
          maxRetries,
          status: response.status,
          requestId,
          retriable,
          body: errorText,
        });

        if (!retriable) {
          // 4xx（429 除外）重试无意义，立即失败。注意：在 catch 里必须把
          // 不可重试的 ProviderRequestError 原样重抛，否则会被当成普通异常
          // 进入重试循环（旧实现的 bug）。
          throw providerError;
        }

        lastError = providerError;
      } catch (err) {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);
        lastError = err as Error;
        if (signal?.aborted) {
          // 用户主动取消：立即终止，不重试。
          throw new DOMException('Request was cancelled', 'AbortError');
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          // 本函数超时调用 controller.abort() 同样产生 AbortError，但超时
          // ≠ 用户取消：超时可重试。旧实现把它当取消直接重抛，导致慢端点
          // 显示「已取消」且永不重试。
          lastError = new ProviderRequestError({
            provider: this.name,
            message: `Request timed out after ${this.config.timeout}ms`,
            retriable: true,
          });
          log.warn(`${this.name} request timed out`, {
            attempt: attempt + 1,
            maxRetries,
            timeout: this.config.timeout,
          });
        } else if (err instanceof ProviderRequestError && !err.retriable) {
          throw err;
        } else {
          log.warn(`${this.name} request attempt failed`, {
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
          });
        }
      }

      // 指数退避
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }

    log.error(`${this.name} request exhausted retries`, lastError);

    if (lastError instanceof ProviderRequestError) {
      throw lastError;
    }
    if (lastError instanceof DOMException && lastError.name === 'AbortError') {
      throw lastError;
    }
    throw new ProviderRequestError({
      provider: this.name,
      message: `Network error after ${maxRetries} attempts: ${lastError?.message ?? 'unknown'}`,
      retriable: false,
    });
  }
}
