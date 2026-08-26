import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentIdleTimeoutError,
  bindChatIdle,
  onChatIdleFired,
  pauseChatIdle,
  pulseChatIdle,
  resumeChatIdle,
  unbindChatIdle,
  wrapFetchForChatIdle,
} from './chatIdleWatchdog';

describe('chatIdleWatchdog', () => {
  const arm = vi.fn();
  const clear = vi.fn();

  afterEach(() => {
    unbindChatIdle(arm);
    arm.mockReset();
    clear.mockReset();
  });

  it('pulses only while bound and not paused', () => {
    pulseChatIdle();
    expect(arm).not.toHaveBeenCalled();

    bindChatIdle(arm, clear);
    pulseChatIdle();
    expect(arm).toHaveBeenCalledTimes(1);

    pauseChatIdle();
    expect(clear).toHaveBeenCalledTimes(1);
    pulseChatIdle();
    expect(arm).toHaveBeenCalledTimes(1);

    resumeChatIdle();
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('resets idle on SSE keepalive body chunks, not only parsed events', async () => {
    bindChatIdle(arm, clear);
    const ping = new TextEncoder().encode(': ping\n\n');
    const token = new TextEncoder().encode('data: {"choices":[]}\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ping);
        controller.enqueue(token);
        controller.close();
      },
    });
    const wrapped = wrapFetchForChatIdle(async () => new Response(body, { status: 200 }));
    const response = await wrapped('https://api.example/v1/chat');
    const text = await response.text();

    expect(text).toContain(': ping');
    expect(text).toContain('data:');
    // start + headers + two body chunks
    expect(arm.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('does not pulse body chunks while paused for UI-bound RPCs', async () => {
    bindChatIdle(arm, clear);
    pauseChatIdle();
    arm.mockClear();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': ping\n\n'));
        controller.close();
      },
    });
    const wrapped = wrapFetchForChatIdle(async () => new Response(body, { status: 200 }));
    await (await wrapped('https://api.example/v1/chat')).text();
    expect(arm).not.toHaveBeenCalled();
  });

  it('rearms instead of aborting the turn while an LLM fetch is in flight', async () => {
    bindChatIdle(arm, clear);
    let resolveFetch!: (response: Response) => void;
    const wrapped = wrapFetchForChatIdle(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const pending = wrapped('https://api.example/v1/chat');
    const abortTurn = vi.fn();
    const rearm = vi.fn();
    onChatIdleFired({ abortTurn, rearm });
    expect(abortTurn).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledTimes(1);

    resolveFetch(new Response('ok', { status: 200 }));
    await (await pending).text();
    abortTurn.mockClear();
    rearm.mockClear();
    onChatIdleFired({ abortTurn, rearm });
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(rearm).not.toHaveBeenCalled();
  });

  it('defers abort while the streaming body is still open', async () => {
    bindChatIdle(arm, clear);
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* headers arrived; body stays open */
      },
    });
    const wrapped = wrapFetchForChatIdle(async () => new Response(body, { status: 200 }));
    const response = await wrapped('https://api.example/v1/chat');
    const abortTurn = vi.fn();
    const rearm = vi.fn();
    onChatIdleFired({ abortTurn, rearm });
    expect(abortTurn).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalled();
    await response.body?.cancel();
  });

  it('aborts only when nothing is in flight or paused', () => {
    bindChatIdle(arm, clear);
    const abortTurn = vi.fn();
    const rearm = vi.fn();
    onChatIdleFired({ abortTurn, rearm });
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(rearm).not.toHaveBeenCalled();
  });

  it('names the last-resort error so the UI can localize it', () => {
    const error = new AgentIdleTimeoutError(300_000);
    expect(error.name).toBe('AgentIdleTimeoutError');
    expect(error.message).not.toMatch(/Agent idle timeout/i);
  });
});
