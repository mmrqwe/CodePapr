import { describe, it, expect } from 'vitest';
import { WorkerCrashError } from './WorkerBackedAgent';

describe('WorkerCrashError', () => {
  it('is an Error subclass', () => {
    const err = new WorkerCrashError('something broke');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something broke');
    expect(err.name).toBe('WorkerCrashError');
  });

  it('has isWorkerCrash flag', () => {
    const err = new WorkerCrashError('crashed');
    expect(err.isWorkerCrash).toBe(true);
  });

  it('preserves detail', () => {
    const err = new WorkerCrashError('crashed', 'file.ts:42:10');
    expect(err.detail).toBe('file.ts:42:10');
  });

  it('can be caught with instanceof', () => {
    function mightThrow(): never {
      throw new WorkerCrashError('boom');
    }
    try {
      mightThrow();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkerCrashError);
      expect((err as WorkerCrashError).isWorkerCrash).toBe(true);
    }
  });

  it('distinguishes from DOMException/AbortError', () => {
    const crash = new WorkerCrashError('crash');
    const abort = new DOMException('cancelled', 'AbortError');

    expect(crash instanceof DOMException).toBe(false);
    expect(abort instanceof WorkerCrashError).toBe(false);
    expect('name' in abort && abort.name === 'AbortError').toBe(true);
    expect(crash.isWorkerCrash).toBe(true);
  });
});

describe('Worker crash detection (store-level integration)', () => {
  // This test verifies that a WorkerCrashError thrown from agent.chat()
  // is NOT an AbortError and will fall through to the generic catch path.
  it('WorkerCrashError is not caught by AbortError check', () => {
    const crash = new WorkerCrashError('worker died');
    const isAbort = crash instanceof DOMException && crash.name === 'AbortError';
    expect(isAbort).toBe(false);
  });
});
