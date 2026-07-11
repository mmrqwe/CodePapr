import type { IToolCall } from '@codepapr/types';

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

  repaired = repaired.replace(/,\s*$/, '');

  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces);
  }
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets);
  }

  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  if (repaired !== text.trim()) {
    return repaired;
  }
  return null;
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

export async function readSseStream(
  response: Response,
  onData: (payload: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.body) {
    throw new Error('Streaming response body is not available');
  }

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

  let isDone = false;

  while (!isDone) {
    if (signal?.aborted) {
      void reader.cancel();
      throw new DOMException('Stream was cancelled', 'AbortError');
    }

    const { done: readDone, value } = await reader.read();
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
