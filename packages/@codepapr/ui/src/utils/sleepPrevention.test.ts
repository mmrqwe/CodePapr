import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  acquireSleepPrevention,
  releaseSleepPrevention,
  resetSleepPreventionForTest,
  sleepPreventionHolders,
} from './sleepPrevention';

describe('sleepPrevention', () => {
  beforeEach(() => {
    resetSleepPreventionForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the assertion on first acquire and releases on last release', async () => {
    await acquireSleepPrevention();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('prevent_idle_sleep');

    await releaseSleepPrevention();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('allow_idle_sleep');
    expect(sleepPreventionHolders()).toBe(0);
  });

  it('reference-counts overlapping holders', async () => {
    await acquireSleepPrevention();
    await acquireSleepPrevention();
    expect(sleepPreventionHolders()).toBe(2);
    // Only the first acquire creates the assertion.
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await releaseSleepPrevention();
    // First release still leaves one holder: no allow_idle_sleep yet.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(sleepPreventionHolders()).toBe(1);

    await releaseSleepPrevention();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('allow_idle_sleep');
  });

  it('tolerates unbalanced releases', async () => {
    await releaseSleepPrevention();
    await releaseSleepPrevention();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(sleepPreventionHolders()).toBe(0);
  });

  it('re-acquires after a full release', async () => {
    await acquireSleepPrevention();
    await releaseSleepPrevention();
    await acquireSleepPrevention();
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith('prevent_idle_sleep');
    await releaseSleepPrevention();
  });

  it('swallows invoke failures without breaking the holder count', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command not found'));
    await acquireSleepPrevention();
    expect(sleepPreventionHolders()).toBe(1);

    invokeMock.mockRejectedValueOnce(new Error('command not found'));
    await releaseSleepPrevention();
    expect(sleepPreventionHolders()).toBe(0);
  });
});
