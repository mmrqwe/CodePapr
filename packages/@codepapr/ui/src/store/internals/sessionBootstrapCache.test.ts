import { describe, expect, it } from 'vitest';
import {
  clearSessionBootstrapCache,
  invalidateSessionBootstrap,
  primeSessionBootstrap,
  resolveSessionBootstrap,
} from './sessionBootstrapCache';

describe('sessionBootstrapCache', () => {
  it('freezes bootstrap per (session × signature) and ignores memory drift', () => {
    clearSessionBootstrapCache();
    let computes = 0;
    const first = resolveSessionBootstrap('s1', 'sig', () => {
      computes += 1;
      return 'bootstrap-v1';
    });
    const second = resolveSessionBootstrap('s1', 'sig', () => {
      computes += 1;
      return 'should-not-be-used';
    });
    expect(first).toBe('bootstrap-v1');
    expect(second).toBe('bootstrap-v1');
    expect(computes).toBe(1);
  });

  it('recomputes when the stable signature changes', () => {
    clearSessionBootstrapCache();
    resolveSessionBootstrap('s1', 'sigA', () => 'a');
    expect(resolveSessionBootstrap('s1', 'sigB', () => 'b')).toBe('b');
  });

  it('prime keeps the signature so post-compaction rebuilds see the refreshed bootstrap (CTX-02)', () => {
    clearSessionBootstrapCache();
    resolveSessionBootstrap('s1', 'sig', () => 'frozen-with-old-memory');
    primeSessionBootstrap('s1', 'sig', 'refreshed-with-new-memory');
    expect(resolveSessionBootstrap('s1', 'sig', () => 'stale-recompute')).toBe(
      'refreshed-with-new-memory'
    );
  });

  it('invalidate makes the next send recompute from fresh ledger state (CTX-01)', () => {
    clearSessionBootstrapCache();
    resolveSessionBootstrap('s1', 'sig', () => 'old');
    invalidateSessionBootstrap('s1');
    expect(resolveSessionBootstrap('s1', 'sig', () => 'fresh')).toBe('fresh');
  });

  it('is per-session and sessionless calls never touch the cache', () => {
    clearSessionBootstrapCache();
    resolveSessionBootstrap('s1', 'sig', () => 'one');
    resolveSessionBootstrap('s2', 'sig', () => 'two');
    expect(resolveSessionBootstrap('s1', 'sig', () => 'x')).toBe('one');
    expect(resolveSessionBootstrap('s2', 'sig', () => 'x')).toBe('two');
    expect(resolveSessionBootstrap(null, 'sig', () => 'anon')).toBe('anon');
    primeSessionBootstrap(null, 'sig', 'ignored');
    invalidateSessionBootstrap(null);
  });
});
