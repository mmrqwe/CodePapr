import { describe, expect, it } from 'vitest';
import { ProviderRequestError } from '../src/providers/ILLMProvider';
import {
  readSseStream,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from '../src/providers/streaming';

const encoder = new TextEncoder();

function streamResponse(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void
): Response {
  const stream = new ReadableStream<Uint8Array>({ start });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('readSseStream idle timeout', () => {
  it('throws StreamIdleTimeoutError when the stream stalls mid-body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"a":1}\n\n'));
      },
      // Never resolves and never closes → models a stalled, still-open connection.
      pull() {
        return new Promise(() => {});
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const received: string[] = [];
    await expect(
      readSseStream(response, (p) => received.push(p), undefined, { idleTimeoutMs: 50 })
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(received).toEqual(['{"a":1}']);
  });

  it('completes normally when all chunks arrive within the idle window', async () => {
    const response = streamResponse((c) => {
      c.enqueue(encoder.encode('data: {"a":1}\n\n'));
      c.enqueue(encoder.encode('data: {"b":2}\n\n'));
      c.close();
    });

    const received: string[] = [];
    await readSseStream(response, (p) => received.push(p), undefined, { idleTimeoutMs: 50 });
    expect(received).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('resets the idle timer on each chunk so a slow trickle never times out', async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        return new Promise((resolve) => {
          setTimeout(() => {
            if (i < 3) {
              c.enqueue(encoder.encode(`data: {"n":${i}}\n\n`));
              i += 1;
            } else {
              c.close();
            }
            resolve();
          }, 20);
        });
      },
    });

    const received: string[] = [];
    await readSseStream(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      (p) => received.push(p),
      undefined,
      { idleTimeoutMs: 60 }
    );
    expect(received).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);
  });

  it('still honors abort even with an idle timeout armed', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"a":1}\n\n'));
      },
      pull() {
        return new Promise(() => {});
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const promise = readSseStream(response, () => {}, controller.signal, {
      idleTimeoutMs: 5000,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('withStreamIdleRetry', () => {
  it('retries the whole attempt when nothing has been emitted yet', async () => {
    let calls = 0;
    const result = await withStreamIdleRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new StreamIdleTimeoutError(50);
        return 'ok';
      },
      { hasEmitted: () => false, maxRetries: 1 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('fails fast once output has been emitted (no duplicate content)', async () => {
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new StreamIdleTimeoutError(50);
        },
        { hasEmitted: () => true, maxRetries: 3 }
      )
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(calls).toBe(1);
  });

  it('rethrows non-idle errors without retrying', async () => {
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { hasEmitted: () => false, maxRetries: 3 }
      )
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('does not retry after the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new StreamIdleTimeoutError(50);
        },
        { hasEmitted: () => false, maxRetries: 3, signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(calls).toBe(1);
  });

  it('invokes onRetry with the attempt number', async () => {
    const retries: number[] = [];
    let calls = 0;
    await withStreamIdleRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw new StreamIdleTimeoutError(50);
        return 'done';
      },
      {
        hasEmitted: () => false,
        maxRetries: 2,
        onRetry: (attempt) => retries.push(attempt),
      }
    );
    expect(retries).toEqual([1, 2]);
    expect(calls).toBe(3);
  });

  it('retries retriable provider stream breaks when nothing was emitted', async () => {
    let calls = 0;
    const result = await withStreamIdleRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderRequestError({
            provider: 'openai',
            message: 'Stream interrupted: error decoding response body',
            retriable: true,
          });
        }
        return 'recovered';
      },
      { hasEmitted: () => false, maxRetries: 1 }
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry non-retriable provider errors', async () => {
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new ProviderRequestError({
            provider: 'openai',
            message: 'HTTP 400: bad request',
            retriable: false,
          });
        },
        { hasEmitted: () => false, maxRetries: 3 }
      )
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(calls).toBe(1);
  });

  it('does not retry retriable stream breaks once content was emitted', async () => {
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new ProviderRequestError({
            provider: 'openai',
            message: 'Stream interrupted: error decoding response body',
            retriable: true,
          });
        },
        { hasEmitted: () => true, maxRetries: 3 }
      )
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(calls).toBe(1);
  });
});
