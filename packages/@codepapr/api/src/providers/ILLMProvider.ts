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
  /** 流中断重试前的等待时长（毫秒），attempt 从 1 开始。
   *  未设置时回退到默认 5s → 10s → 15s → 20s → 25s → 30s。测试可注入 0 跳过等待。 */
  streamRetryDelayMs?: (attempt: number) => number;
  /** 流层重试次数上限。缺省（undefined）= 无限重试：只要故障可重试且用户未取消，
   *  就一直重连直到成功——网络波动/限流不终止回合。测试可注入小值模拟耗尽。 */
  streamMaxRetries?: number;
  /** 请求级（连接层失败）每次重试前的回调：attempt 从 1 开始，maxRetries 为总次数。
   *  provider 可据此向 UI 发出 request-retry 事件，让重试过程可见。 */
  onRequestRetry?: (attempt: number, maxRetries: number, error: Error) => void;
  /** 请求级重试等待时长（毫秒），attempt 从 1 开始。
   *  未设置时回退到默认 1s → 2s → 4s → 8s → 16s → 30s。测试可注入 0 跳过等待。 */
  requestRetryDelayMs?: (attempt: number) => number;
  fetchFn?: typeof globalThis.fetch;
  /** OpenCode Go 网关的 x-opencode-session 标识（仅 baseURL 命中 opencode.ai 域名时生效）。
   *  缺省时回退为 provider 实例级随机 id。该网关强制要求会话头，缺失即 400 MissingSessionID。 */
  sessionId?: string;
  /** x-opencode-client 客户端标识（仅 opencode.ai 域名生效），缺省 codepapr。 */
  sessionClient?: string;
  /** 自定义附加请求头（如企业网关的私有鉴权/路由头）。
   *  仅追加请求里不存在的键：Authorization、Content-Type、x-opencode-* 等
   *  provider 内置头永不被覆盖（防止凭证错发与会话路由头被意外破坏）。
   *  注意：浏览器/Worker 运行时 fetch 会静默丢弃 forbidden header
   *  （User-Agent、Cookie 等），仅桌面 sidecar（Node fetch）保证生效。 */
  extraHeaders?: Record<string, string>;
}

/** 把 extraHeaders 合并进请求头：只新增、不覆盖（键名按小写比较），
 *  空键/空值跳过。provider 内置头（含 opencode 契约头）因此天然受保护。 */
export function mergeExtraHeaders(
  headers: Record<string, string>,
  extra: Record<string, string> | undefined
): Record<string, string> {
  if (!extra) {
    return headers;
  }
  const taken = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const merged = { ...headers };
  for (const [rawKey, rawValue] of Object.entries(extra)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!key || !value || taken.has(key.toLowerCase())) {
      continue;
    }
    merged[key] = value;
    taken.add(key.toLowerCase());
  }
  return merged;
}

/** 请求级默认重试次数（连接层失败，如 DNS/TCP/TLS 无法建立连接）。 */
export const DEFAULT_REQUEST_MAX_RETRIES = 6;

/** 请求级重试等待时长（毫秒），按重试次序取值：1s→2s→4s→8s→16s→30s。
 *  指数退避封顶 30s，覆盖分钟级的网络波动窗口。 */
export const DEFAULT_REQUEST_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

export function defaultRequestRetryDelayMs(attempt: number): number {
  const delays = DEFAULT_REQUEST_RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(attempt, 1), delays.length) - 1] ?? 30_000;
}

export class ProviderRequestError extends Error {
  provider: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
  retriable: boolean;
  /** 请求级重试实际执行的总次数（耗尽后抛出的最终错误带此字段，
   *  供 UI 文案展示真实重试次数）。 */
  attempts?: number;
  maxRetries?: number;

  constructor(options: {
    provider: string;
    message: string;
    status?: number;
    requestId?: string;
    responseBody?: string;
    retriable?: boolean;
    attempts?: number;
    maxRetries?: number;
  }) {
    super(options.message);
    this.name = 'ProviderRequestError';
    this.provider = options.provider;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
    this.retriable = options.retriable ?? false;
    this.attempts = options.attempts;
    this.maxRetries = options.maxRetries;
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
      maxRetries: DEFAULT_REQUEST_MAX_RETRIES,
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

  /** 可被取消的退避等待：用户取消立即抛 AbortError，不再等待剩余退避时长。
   *  请求级重试（连接层失败，最长 30s 封顶）与流层重连共用此语义。 */
  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('Request was cancelled', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('Request was cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 非流式调用方传入该持有器时，2xx 响应返回后超时/取消保护保持激活
   *  （body 由调用方读取：坏中继可能只发 200 响应头后滴灌/挂起 body，
   *  脱离保护的 response.json() 会永久挂起且用户取消无效）。
   *  调用方读完 body 后必须调用 release() 释放定时器与监听器。
   *  流式调用方不传：body 由流层的空闲超时保护。 */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    signal?: AbortSignal,
    onRequestRetry?: (attempt: number, maxRetries: number, error: Error) => void,
    holdProtectionOnOk?: { release: () => void }
  ): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;
    const notifyRetry = onRequestRetry ?? this.config.onRequestRetry;
    const retryDelayMs = this.config.requestRetryDelayMs ?? defaultRequestRetryDelayMs;
    if (
      this.config.extraHeaders &&
      options.headers &&
      !(options.headers instanceof Headers) &&
      !Array.isArray(options.headers)
    ) {
      options = {
        ...options,
        headers: mergeExtraHeaders(
          options.headers as Record<string, string>,
          this.config.extraHeaders
        ),
      };
    }
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

      // 释放超时/取消监听的时机：响应成功返回（body 由流层负责），
      // 或错误体读取完毕。绝不能提前释放——坏中继可能只发响应头就挂起，
      // 非 2xx 的 response.text() 必须仍在超时与取消保护之下。
      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);
      };

      try {
        const response = await fetchFn(url, {
          ...options,
          signal: controller.signal,
        });

        if (response.ok) {
          if (holdProtectionOnOk) {
            // 保护移交给调用方：body 读取（response.json()）仍在超时与
            // 取消保护之下。调用方读完必须 release。
            holdProtectionOnOk.release = cleanup;
          } else {
            cleanup();
          }
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
          attempts: attempt + 1,
          maxRetries,
        });

        log.warn(`${this.name} request failed`, {
          attempt: attempt + 1,
          maxRetries,
          status: response.status,
          requestId,
          retriable,
          body: errorText,
        });

        cleanup();

        if (!retriable) {
          // 4xx（429 除外）重试无意义，立即失败。注意：在 catch 里必须把
          // 不可重试的 ProviderRequestError 原样重抛，否则会被当成普通异常
          // 进入重试循环（旧实现的 bug）。
          throw providerError;
        }

        lastError = providerError;
      } catch (err) {
        cleanup();
        lastError = err as Error;
        if (signal?.aborted) {
          // 用户主动取消：立即终止，不重试。
          throw new DOMException('Request was cancelled', 'AbortError');
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          // 本函数超时调用 controller.abort() 同样产生 AbortError（含
          // 响应头已到达但 body 读取被超时中止的情况），但超时 ≠ 用户取消：
          // 超时可重试。旧实现把它当取消直接重抛，导致慢端点显示「已取消」
          // 且永不重试。
          lastError = new ProviderRequestError({
            provider: this.name,
            message: `Request timed out after ${this.config.timeout}ms`,
            retriable: true,
            attempts: attempt + 1,
            maxRetries,
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

      // 指数退避，封顶 30s：给网络恢复留出时间（unstable 端点常持续
      // 数十秒到数分钟的波动，短退避根本扛不过去）。退避必须可取消：
      // 用户按下停止后，最长 30s 的等待会被立即打断。
      if (attempt < maxRetries - 1) {
        const delayMs = retryDelayMs(attempt + 1);
        notifyRetry?.(attempt + 1, maxRetries, lastError);
        await this.sleepAbortable(delayMs, signal);
      }
    }

    log.error(`${this.name} request exhausted retries`, lastError);

    if (lastError instanceof ProviderRequestError) {
      // 循环只会因可重试错误（429/5xx/网络层）耗尽次数而退出，该错误本质上
      // 仍是瞬态故障：标记 retriable 让流层（withStreamIdleRetry）继续无限重连，
      // 而不是把网络波动升级成终止回合的致命错误。
      throw lastError;
    }
    if (lastError instanceof DOMException && lastError.name === 'AbortError') {
      throw lastError;
    }
    throw new ProviderRequestError({
      provider: this.name,
      message: `Network error after ${maxRetries} attempts: ${lastError?.message ?? 'unknown'}`,
      retriable: true,
      attempts: maxRetries,
      maxRetries,
    });
  }
}
