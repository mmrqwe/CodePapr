import { describe, expect, it, vi } from 'vitest';
import { yieldToMainThread } from './taskScheduling';

describe('yieldToMainThread', () => {
  it('resolves on a later turn so the UI can paint before more work runs', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const promise = yieldToMainThread().then(() => {
      order.push('yielded');
    });

    order.push('sync');
    expect(order).toEqual(['sync']);

    await vi.runAllTimersAsync();
    await promise;

    expect(order).toEqual(['sync', 'yielded']);
    vi.useRealTimers();
  });
});