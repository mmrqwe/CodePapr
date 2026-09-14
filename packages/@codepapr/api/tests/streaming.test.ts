import { describe, expect, it } from 'vitest';
import { ProviderRequestError } from '../src/providers/ILLMProvider';
import {
  applyStreamingToolCallDeltas,
  DEFAULT_STREAM_RETRY_DELAYS_MS,
  defaultStreamRetryDelayMs,
  finalizeStreamingToolCalls,
  readSseStream,
  safeParseToolArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from '../src/providers/streaming';

const noDelay = { retryDelayMs: () => 0 };

describe('finalizeStreamingToolCalls（P3：稀疏 delta 空洞）', () => {
  it('skips holes explicitly and keeps call ids stable', () => {
    // provider 的首个 delta 直接用 index=1（跳过 0）→ states 出现空洞。
    const states = applyStreamingToolCallDeltas([], [
      { index: 1, id: 'call-b', function: { name: 'beta', arguments: '{"x":1}' } },
    ]);
    const calls = finalizeStreamingToolCalls(states);
    expect(calls).toHaveLength(1);
    expect(calls?.[0].id).toBe('call-b');
    expect(calls?.[0].name).toBe('beta');
  });

  it('returns undefined when every slot is a hole', () => {
    const states: Parameters<typeof finalizeStreamingToolCalls>[0] = [];
    states[2] = undefined as never; // 制造空洞
    states.length = 3;
    expect(finalizeStreamingToolCalls(states)).toBeUndefined();
  });
});

describe('safeParseToolArguments JSON 修复（P2-18：字符串感知）', () => {
  it('does not corrupt string values containing ", }" while repairing trailing commas', () => {
    // 旧实现全局替换 /,\s*([}\]])/ 且括号计数不避字符串字面量，会把
    // "enum E { A, }" 里的 ", }" 改成 "}"，产出「合法但语义不同」的 JSON。
    const raw = '{"code": "enum E { A, }",}';
    const parsed = safeParseToolArguments(raw);
    expect(parsed._parseError).toBeUndefined();
    expect(parsed.code).toBe('enum E { A, }');
  });

  it('does not count braces inside strings when balancing', () => {
    // 字符串值里花括号不平衡（{ 多于 }）不应触发补 }，否则会污染字符串。
    const raw = '{"content": "if (x) { return 1;"}';
    const parsed = safeParseToolArguments(raw);
    expect(parsed._parseError).toBeUndefined();
    expect(parsed.content).toBe('if (x) { return 1;');
  });

  it('still repairs a genuinely truncated object (missing closing brace)', () => {
    const raw = '{"a": 1, "b": 2';
    const parsed = safeParseToolArguments(raw);
    expect(parsed._parseError).toBeUndefined();
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe(2);
  });

  it('still repairs a real trailing comma outside strings', () => {
    const raw = '{"a": 1,}';
    const parsed = safeParseToolArguments(raw);
    expect(parsed._parseError).toBeUndefined();
    expect(parsed.a).toBe(1);
  });

  it('rejects non-object root JSON values (string, array, null, number) and marks _parseError', () => {
    const cases = ['"just a string"', '[1, 2, 3]', 'null', '12345', 'true'];
    for (const raw of cases) {
      const parsed = safeParseToolArguments(raw);
      expect(parsed._parseError).toBe(true);
      expect(typeof parsed.error).toBe('string');
    }
  });

  it('applyStreamingToolCallDeltas cleanly separates multiple calls when index is omitted but id is provided', () => {
    const states = applyStreamingToolCallDeltas([], [
      { id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } },
      { id: 'call-1', function: { arguments: '"a.txt"}' } },
      { id: 'call-2', function: { name: 'write_file', arguments: '{"path":' } },
      { id: 'call-2', function: { arguments: '"b.txt"}' } },
    ]);
    const calls = finalizeStreamingToolCalls(states);
    expect(calls).toHaveLength(2);
    expect(calls?.[0]).toEqual({ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } });
    expect(calls?.[1]).toEqual({ id: 'call-2', name: 'write_file', arguments: { path: 'b.txt' } });
  });
});

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

  it('resets the idle timer on each progress chunk so a slow trickle never times out', async () => {
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
      (p) => {
        received.push(p);
        // 每块都是真实输出：进度计时器被推进，慢速滴流不超时。
        return true;
      },
      undefined,
      { idleTimeoutMs: 60 }
    );
    expect(received).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);
  });

  it('does not extend the idle timer on heartbeat payloads (心跳不续命)', async () => {
    // 字节一直在流（心跳），但没有任何真实输出：旧实现按字节重置计时器，
    // 这种假活连接永不超时；新实现必须在 idleTimeoutMs 后抛错走重连。
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        return new Promise((resolve) => {
          setTimeout(() => {
            if (cancelled) {
              resolve();
              return;
            }
            try {
              c.enqueue(encoder.encode('data: {}\n\n'));
            } catch {
              // 超时路径会 cancel reader，挂起的定时器不再入队
              cancelled = true;
            }
            resolve();
          }, 20);
        });
      },
      cancel() {
        cancelled = true;
      },
    });

    const received: string[] = [];
    await expect(
      readSseStream(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
        (p) => {
          received.push(p);
          // 心跳/空载荷：不产生进度。
          return false;
        },
        undefined,
        { idleTimeoutMs: 60 }
      )
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('reports onWait periodically while no progress arrives', async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        return new Promise((resolve) => {
          setTimeout(() => {
            if (i < 5) {
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

    const waits: number[] = [];
    await readSseStream(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      () => {
        // 前两块是心跳（无进度），第三块开始是真实输出。
        return i >= 3;
      },
      undefined,
      { idleTimeoutMs: 5_000, waitNotifyIntervalMs: 20, onWait: (waitMs) => waits.push(waitMs) }
    );
    // 心跳阶段至少上报一次等待；每次上报的等待时长不小于提示间隔。
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.every((waitMs) => waitMs >= 20)).toBe(true);
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
      { maxRetries: 1, ...noDelay }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('still retries after output has been emitted (consumer resets via stream-restart)', async () => {
    let calls = 0;
    const result = await withStreamIdleRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new StreamIdleTimeoutError(50);
        return 'recovered';
      },
      { maxRetries: 3, ...noDelay }
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('defaults to unlimited retries: keeps reconnecting past the old 6x cap until success', async () => {
    let calls = 0;
    const result = await withStreamIdleRetry(
      async () => {
        calls += 1;
        // 旧默认 6 次上限之内始终失败，第 8 次才恢复：验证缺省不再提前放弃。
        if (calls <= 7) throw new StreamIdleTimeoutError(50);
        return 'recovered-late';
      },
      { ...noDelay }
    );
    expect(result).toBe('recovered-late');
    expect(calls).toBe(8);
  });

  it('honors an explicit maxRetries cap (test/escape-hatch)', async () => {
    let calls = 0;
    await expect(
      withStreamIdleRetry(
        async () => {
          calls += 1;
          throw new StreamIdleTimeoutError(50);
        },
        { maxRetries: 6, ...noDelay }
      )
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(calls).toBe(7);
  });

  it('uses the 5s/10s/15s/20s/25s/30s backoff schedule by default', () => {
    expect(DEFAULT_STREAM_RETRY_DELAYS_MS).toEqual([
      5000, 10000, 15000, 20000, 25000, 30000,
    ]);
    expect(defaultStreamRetryDelayMs(1)).toBe(5000);
    expect(defaultStreamRetryDelayMs(2)).toBe(10000);
    expect(defaultStreamRetryDelayMs(3)).toBe(15000);
    expect(defaultStreamRetryDelayMs(6)).toBe(30000);
    expect(defaultStreamRetryDelayMs(99)).toBe(30000);
  });

  it('waits the configured delay before retrying and honors abort during the wait', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withStreamIdleRetry(
      async () => {
        calls += 1;
        throw new StreamIdleTimeoutError(50);
      },
      {
        maxRetries: 3,
        signal: controller.signal,
        retryDelayMs: () => 60_000,
      }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assertion;
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
        { maxRetries: 3 }
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
        { maxRetries: 3, signal: controller.signal }
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
        maxRetries: 2,
        onRetry: (attempt) => retries.push(attempt),
        ...noDelay,
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
      { maxRetries: 1, ...noDelay }
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
        { maxRetries: 3 }
      )
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(calls).toBe(1);
  });

  it('retries retriable stream breaks even after content was emitted', async () => {
    let calls = 0;
    const retries: number[] = [];
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
        {
          maxRetries: 3,
          onRetry: (attempt) => retries.push(attempt),
          ...noDelay,
        }
      )
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(calls).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
  });
});
