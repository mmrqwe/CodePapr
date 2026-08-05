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
  const { _raw, _parseError, error, ...clean } = args as Record<string, unknown>;
  if (_parseError) {
    return { _error: String(error ?? 'JSON 解析失败') };
  }
  return clean;
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

  void signal?.addEventListener('abort', () => {
    void reader.cancel();
  }, { once: true });

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
    return Promise.race([reader.read(), timeout]).finally(() => {
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
  } catch (err) {
    if (err instanceof StreamIdleTimeoutError) {
      void reader.cancel();
    }
    throw err;
  }
}

export interface StreamIdleRetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  hasEmitted: () => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

/** Errors safe to retry a whole stream attempt for: nothing has been emitted
 *  to the caller yet, so re-running the attempt is lossless. */
function isRetriableStreamError(err: unknown): boolean {
  if (err instanceof StreamIdleTimeoutError) {
    return true;
  }
  // Provider-wrapped mid-stream breaks (connection reset / truncated body,
  // e.g. reqwest "error decoding response body"). Only the retriable ones.
  return err instanceof ProviderRequestError && err.retriable;
}

export async function withStreamIdleRetry<T>(
  runAttempt: () => Promise<T>,
  options: StreamIdleRetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  let attempt = 0;
  for (;;) {
    try {
      return await runAttempt();
    } catch (err) {
      if (
        isRetriableStreamError(err) &&
        !options.hasEmitted() &&
        !options.signal?.aborted &&
        attempt < maxRetries
      ) {
        attempt += 1;
        options.onRetry?.(attempt, err as Error);
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

  return states.map((state) => {
    const rawArguments = state.argumentsText.trim();

    return {
      id: state.id,
      name: state.name,
      arguments: safeParseToolArguments(rawArguments),
    };
  });
}
