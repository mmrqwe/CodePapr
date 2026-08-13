import type { IToolCall } from '@codepapr/types';
import { ProviderRequestError } from './ILLMProvider';

interface StreamingToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamingToolCallState {
  id: string;
  name: string;
  argumentsText: string;
}

export function safeParseToolArguments(
  rawArguments: string
): Record<string, unknown> {
  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (firstError) {
    const repaired = attemptJsonRepair(trimmed);
    if (repaired) {
      try {
        return JSON.parse(repaired) as Record<string, unknown>;
      } catch {
        // 修复未能恢复可解析的 JSON，继续抛出原始错误
      }
    }

    const preview =
      trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed;
    return {
      _parseError: true,
      error: `JSON 解析失败: ${(firstError as SyntaxError).message}`,
      _raw: preview,
    };
  }
}

function attemptJsonRepair(text: string): string | null {
  let repaired = text.trim();

  repaired = repaired.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

  repaired = escapeRawControlCharsInStrings(repaired);

  repaired = repaired.replace(/,\s*$/, '');

  // 括号计数与尾逗号清理必须避开字符串字面量：代码内容里天然包含 `{`/`}`/`,`
  // （如 "enum E { A, }"），旧实现全局计数+全局替换会把字符串值静默改成
  // 另一段「合法但语义不同」的 JSON 传给工具。
  const balance = countBracketsOutsideStrings(repaired);

  if (balance.openBraces > balance.closeBraces) {
    repaired += '}'.repeat(balance.openBraces - balance.closeBraces);
  }
  if (balance.openBrackets > balance.closeBrackets) {
    repaired += ']'.repeat(balance.openBrackets - balance.closeBrackets);
  }

  repaired = stripTrailingCommasOutsideStrings(repaired);

  if (repaired !== text.trim()) {
    return repaired;
  }
  return null;
}

function countBracketsOutsideStrings(text: string): {
  openBraces: number;
  closeBraces: number;
  openBrackets: number;
  closeBrackets: number;
} {
  let openBraces = 0;
  let closeBraces = 0;
  let openBrackets = 0;
  let closeBrackets = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') openBraces++;
    else if (ch === '}') closeBraces++;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') closeBrackets++;
  }
  return { openBraces, closeBraces, openBrackets, closeBrackets };
}

function stripTrailingCommasOutsideStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // 仅当逗号之后（跳过空白）紧跟 } 或 ] 时才视为尾逗号丢弃
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j++;
      }
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 模型常把多行 SQL/脚本直接塞进 JSON 字符串值，留下未转义的换行/制表符，
// 导致 "Unterminated string" 解析失败。这里在字符串字面量内把这些原始控制字符转义掉。
function escapeRawControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        out += ch;
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

export function sanitizeToolCallArguments(
  args: Record<string, unknown>
): Record<string, unknown> {
  // 只处理 safeParseToolArguments 解析失败时写入的标记对象（_parseError:true）。
  // 旧实现对一切参数对象无条件剔除 error/_raw/_parseError 三个键——合法 schema
  // 含 `error` 参数的工具在历史回传时该参数被静默丢弃，模型下一轮看到的
  // 工具参数与当初实际执行的不一致。
  if (args._parseError !== true) {
    return args;
  }
  return { _error: String(args.error ?? 'JSON 解析失败') };
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export class StreamIdleTimeoutError extends Error {
  readonly retriable = true;
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number) {
    super(
      `Stream idle timeout: no data received for ${Math.round(idleTimeoutMs / 1000)}s`
    );
    this.name = 'StreamIdleTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export interface ReadSseStreamOptions {
  idleTimeoutMs?: number;
}

export async function readSseStream(
  response: Response,
  onData: (payload: string) => void,
  signal?: AbortSignal,
  options?: ReadSseStreamOptions
): Promise<void> {
  if (!response.body) {
    throw new Error('Streaming response body is not available');
  }

  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 命名引用 + finally 移除：signal 常由 UI 长期持有，正常结束时不清理会让
  // 每次流式请求都泄漏一个监听器（并滞留 reader/response 引用）。
  const abortHandler = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  const consumeEvent = (rawEvent: string): void => {
    const lines = rawEvent.split(/\r?\n/);
    const payload = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (payload) {
      onData(payload);
    }
  };

  const readChunk = () => {
    if (idleTimeoutMs <= 0) {
      return reader.read();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StreamIdleTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    });
    const read = reader.read();
    // 超时先胜出后，落败的 read promise 仍可能稍后 reject（超时与断流同一
    // 瞬间发生）；不挂 handler 会成为 unhandled rejection。
    read.catch(() => undefined);
    return Promise.race([read, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  };

  let isDone = false;

  try {
    while (!isDone) {
      if (signal?.aborted) {
        void reader.cancel();
        throw new DOMException('Stream was cancelled', 'AbortError');
      }

      const { done: readDone, value } = await readChunk();
      buffer += decoder.decode(value, { stream: !readDone });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        consumeEvent(event);
      }

      if (readDone) {
        isDone = true;
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      consumeEvent(trailing);
    }

    // abort 发生在 reader.read() 挂起期间时，abortHandler 的 reader.cancel()
    // 会让挂起的 read 按 fetch 规范以 {done:true} 正常解决，循环走到这里
    // 「正常结束」。不抛 AbortError 的话，provider 会因缺 [DONE]/finish_reason
    // 把它误判为「流中断错误」——用户按了停止反而可能触发 fallback 重跑
    // 整回合。取消必须原样向上传播。
    if (signal?.aborted) {
      throw new DOMException('Stream was cancelled', 'AbortError');
    }
  } catch (err) {
    if (err instanceof StreamIdleTimeoutError) {
      void reader.cancel();
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }
}

/** 历史默认值（6 次）。流层重试现已默认无限（见 withStreamIdleRetry），
 *  该常量仅保留给错误文案等展示用途。 */
export const DEFAULT_STREAM_MAX_RETRIES = 6;

/** 每次重试前的等待时长（毫秒），按重试次序取值：5s → 10s → 15s → 20s → 25s → 30s。
 *  给网络恢复留出时间，避免立即重连打在同一波故障上。 */
export const DEFAULT_STREAM_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 15_000, 20_000, 25_000, 30_000,
];

export function defaultStreamRetryDelayMs(attempt: number): number {
  const delays = DEFAULT_STREAM_RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(attempt, 1), delays.length) - 1] ?? 30_000;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new DOMException('Stream was cancelled', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Stream was cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface StreamIdleRetryOptions {
  /** 重试次数上限。缺省（undefined）= 无限重试：只要故障可重试且用户未取消，
   *  就一直重连直到成功——网络波动/限流不应终止回合。测试可注入小值。
   *  已输出内容后同样允许重试：provider 通过 onRetry 发 stream-restart 事件，
   *  由消费方丢弃死掉的尝试产生的部分输出（见 isRetriableStreamError 注释）。 */
  maxRetries?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: Error) => void;
  /** 每次重试前的等待时长（毫秒），attempt 从 1 开始。默认 5s → 10s → 15s → 20s → 25s → 30s。 */
  retryDelayMs?: (attempt: number) => number;
}

/** 流内 error 事件的确定性错误类型（Claude error 事件 / OpenAI 兼容流内
 *  error 对象）：这些错误重试无意义（配置错误、鉴权失败、上下文超限、模型
 *  不存在等），必须抛 retriable=false 让回合终止，而不是被流层当作瞬态断流
 *  无限重连。 */
export function isPersistentStreamErrorType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.trim().toLowerCase();
  return [
    'invalid_request_error',
    'invalid_request',
    'authentication_error',
    'invalid_api_key',
    'permission_error',
    'not_found_error',
    'model_not_found',
    'request_too_large',
    'context_length_exceeded',
    'content_filter',
    'insufficient_quota',
  ].includes(normalized);
}

/** 流内 error 事件里值得重试的类型（过载/限流），其余（含未知类型）一律不重试：
 *  确定性错误被误判为瞬态是「无限重连」的主要来源。 */
export function isRetriableStreamErrorType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.trim().toLowerCase();
  return normalized === 'overloaded_error' || normalized === 'rate_limit_error';
}

/** Network-level stream failures worth retrying: idle timeouts and
 *  provider-wrapped mid-stream breaks (connection reset / truncated body,
 *  e.g. reqwest "error decoding response body"). Retry is allowed even after
 *  output has been emitted — the provider emits a `stream-restart` event via
 *  onRetry so consumers can discard the partial output of the dead attempt. */
function isRetriableStreamError(err: unknown): boolean {
  if (err instanceof StreamIdleTimeoutError) {
    return true;
  }
  return err instanceof ProviderRequestError && err.retriable;
}

export async function withStreamIdleRetry<T>(
  runAttempt: () => Promise<T>,
  options: StreamIdleRetryOptions
): Promise<T> {
  // undefined = 无限重试：可重试故障（网络波动/限流/流中断）绝不终止回合，
  // 一直重连直到成功或用户取消。
  const maxRetries = options.maxRetries;
  const retryDelayMs = options.retryDelayMs ?? defaultStreamRetryDelayMs;
  let attempt = 0;
  for (;;) {
    try {
      return await runAttempt();
    } catch (err) {
      if (
        isRetriableStreamError(err) &&
        !options.signal?.aborted &&
        (maxRetries === undefined || attempt < maxRetries)
      ) {
        attempt += 1;
        options.onRetry?.(attempt, err as Error);
        await abortableDelay(retryDelayMs(attempt), options.signal);
        continue;
      }
      throw err;
    }
  }
}

export function applyStreamingToolCallDeltas(
  states: StreamingToolCallState[],
  deltas: StreamingToolCallDelta[]
): StreamingToolCallState[] {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const current = states[index] ?? {
      id: delta.id ?? `tool-call-${index}`,
      name: '',
      argumentsText: '',
    };

    states[index] = {
      id: delta.id ?? current.id,
      name: delta.function?.name ? `${current.name}${delta.function.name}` : current.name,
      argumentsText: delta.function?.arguments
        ? `${current.argumentsText}${delta.function.arguments}`
        : current.argumentsText,
    };
  }

  return states;
}

export function finalizeStreamingToolCalls(
  states: StreamingToolCallState[]
): IToolCall[] | undefined {
  if (states.length === 0) {
    return undefined;
  }

  // 显式按索引遍历：provider 的 delta 序号不连续时 states 是稀疏数组，
  // map() 会静默跳过空洞并在结果里重新编号；这里显式跳过空洞，全空洞时
  // 返回 undefined 而不是空数组。
  const toolCalls: IToolCall[] = [];
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    if (!state) {
      continue;
    }
    toolCalls.push({
      id: state.id,
      name: state.name,
      arguments: safeParseToolArguments(state.argumentsText.trim()),
    });
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}
