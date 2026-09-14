import { afterEach, describe, expect, it } from 'vitest';
import {
  buildStreamStallLogText,
  clearStreamStallRecord,
  noteStreamRetry,
  noteStreamWait,
  readStreamStallRecord,
} from './streamStallLog';

const messageId = 'msg-1';

afterEach(() => {
  clearStreamStallRecord(messageId);
});

describe('streamStallLog tracker', () => {
  it('keeps the max observed wait across stream-wait events', () => {
    noteStreamWait(messageId, 15_000);
    noteStreamWait(messageId, 45_000);
    noteStreamWait(messageId, 30_000);
    expect(readStreamStallRecord(messageId)?.maxWaitMs).toBe(45_000);
  });

  it('records the first stall time once', () => {
    const before = Date.now();
    noteStreamWait(messageId, 15_000);
    const first = readStreamStallRecord(messageId)?.firstStallAt ?? 0;
    expect(first).toBeGreaterThanOrEqual(before);
    noteStreamWait(messageId, 30_000);
    expect(readStreamStallRecord(messageId)?.firstStallAt).toBe(first);
  });

  it('counts retries and returns the latest snapshot', () => {
    noteStreamWait(messageId, 300_000);
    const first = noteStreamRetry(messageId);
    expect(first.retries).toBe(1);
    expect(first.maxWaitMs).toBe(300_000);
    expect(first.firstStallAt).toBeGreaterThan(0);
    expect(noteStreamRetry(messageId).retries).toBe(2);
  });

  it('clear drops the record', () => {
    noteStreamWait(messageId, 1000);
    clearStreamStallRecord(messageId);
    expect(readStreamStallRecord(messageId)).toBeUndefined();
  });
});

describe('buildStreamStallLogText', () => {
  it('writes the retry fields needed for post-mortem', () => {
    const text = buildStreamStallLogText(
      {
        workspacePath: '/tmp/ws',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        modelName: 'deepseek-flash',
        modelTier: 'primary',
        outcome: 'retry',
        event: 'stream-restart',
        attempt: 2,
        maxWaitMs: 300_412,
        retries: 2,
        firstStallAt: Date.parse('2026-09-14T04:01:19.000Z'),
      },
      new Date('2026-09-14T04:01:20.000Z')
    );

    expect(text).toContain('outcome: retry');
    expect(text).toContain('event: stream-restart');
    expect(text).toContain('sessionId: sess-1');
    expect(text).toContain('messageId: msg-1');
    expect(text).toContain('model: deepseek-flash (primary)');
    expect(text).toContain('attempt: 2');
    expect(text).toContain('maxRetries: unlimited');
    expect(text).toContain('retriesThisRound: 2');
    expect(text).toContain('maxNoOutputWaitMs: 300412');
    expect(text).toContain('firstStallAt: 2026-09-14T04:01:19.000Z');
    expect(text).toContain('2026-09-14T04:01:20.000Z');
  });

  it('renders an explicit retry cap when present', () => {
    const text = buildStreamStallLogText({
      workspacePath: '/tmp/ws',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      outcome: 'retry',
      event: 'request-retry',
      attempt: 1,
      maxRetries: 6,
      maxWaitMs: 0,
      retries: 1,
      firstStallAt: 0,
    });
    expect(text).toContain('maxRetries: 6');
  });

  it('writes a recovery record with the round duration', () => {
    const text = buildStreamStallLogText({
      workspacePath: '/tmp/ws',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      outcome: 'recovered',
      maxWaitMs: 300_412,
      retries: 2,
      firstStallAt: 0,
      roundDurationMs: 628_860,
    });
    expect(text).toContain('outcome: recovered');
    expect(text).toContain('roundDurationMs: 628860');
    expect(text).not.toContain('event:');
  });
});
