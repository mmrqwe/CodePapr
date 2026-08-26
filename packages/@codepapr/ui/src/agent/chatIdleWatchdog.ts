/**
 * Chat-turn idle backstop shared by the sidecar and worker loops.
 *
 * LLM silence is owned by stream idle + reconnect (stream-restart). This
 * timer must not abort the chat AbortSignal while a fetch is in flight —
 * that looks like user-cancel and kills withStreamIdleRetry. Pulse on HTTP
 * bytes so thinking-model keepalives keep the backstop aligned. Pause across
 * UI-bound RPCs and tools. Only abort the turn when nothing is in flight.
 */

let armChatIdle: (() => void) | null = null;
let clearChatIdle: (() => void) | null = null;
let chatIdlePauseDepth = 0;
let inflightFetchCount = 0;

export class AgentIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs = 300_000) {
    super('The model did not respond; this turn was stopped.');
    this.name = 'AgentIdleTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export function bindChatIdle(arm: () => void, clear: () => void): void {
  armChatIdle = arm;
  clearChatIdle = clear;
  chatIdlePauseDepth = 0;
  inflightFetchCount = 0;
}

export function unbindChatIdle(arm: () => void): void {
  if (armChatIdle !== arm) {
    return;
  }
  armChatIdle = null;
  clearChatIdle = null;
  chatIdlePauseDepth = 0;
  inflightFetchCount = 0;
}

export function pulseChatIdle(): void {
  if (chatIdlePauseDepth > 0) {
    return;
  }
  armChatIdle?.();
}

export function pauseChatIdle(): void {
  chatIdlePauseDepth += 1;
  clearChatIdle?.();
}

export function resumeChatIdle(): void {
  if (chatIdlePauseDepth > 0) {
    chatIdlePauseDepth -= 1;
  }
  if (chatIdlePauseDepth === 0) {
    armChatIdle?.();
  }
}

export function onChatIdleFired(handlers: {
  abortTurn: () => void;
  rearm: () => void;
}): void {
  if (chatIdlePauseDepth > 0 || inflightFetchCount > 0) {
    handlers.rearm();
    return;
  }
  handlers.abortTurn();
}

export function wrapFetchForChatIdle(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    inflightFetchCount += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      if (inflightFetchCount > 0) {
        inflightFetchCount -= 1;
      }
    };
    pulseChatIdle();
    try {
      const response = await baseFetch(input, init);
      pulseChatIdle();
      const originalBody = response.body;
      if (!originalBody) {
        release();
        return response;
      }
      const reader = originalBody.getReader();
      const streamed = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              release();
              controller.close();
              return;
            }
            if (value) {
              pulseChatIdle();
              controller.enqueue(value);
            }
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(reason);
        },
      });
      return new Response(streamed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  };
}
