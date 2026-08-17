/**
 * Serializes memory.md read-modify-write (bootstrap, ledger projection,
 * tool/panel re-projection). They share one file and each does a full-overwrite
 * write; without a lock a slow bootstrap write can land between another
 * projection's read and write and clobber it.
 *
 * The chain never rejects, so a failing task does not wedge subsequent ones.
 * Not reentrant: callers already inside the lock must use unlocked helpers.
 */

let memoryWriteChain: Promise<void> = Promise.resolve();

export function withMemoryLock<T>(task: () => Promise<T>): Promise<T> {
  const result = memoryWriteChain.then(task);
  memoryWriteChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
