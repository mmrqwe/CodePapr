import { describe, expect, it } from 'vitest';
import { createTaskSlot, TASK_PARALLEL_CONCURRENCY } from '../src/agent/taskSlot';

describe('createTaskSlot', () => {
  it('caps concurrent executions at the given limit', async () => {
    const slot = createTaskSlot(4);
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 5 }, async () => {
      await slot.withTaskSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    });
    await Promise.all(jobs);
    expect(peak).toBe(4);
    expect(TASK_PARALLEL_CONCURRENCY).toBe(4);
  });
});
