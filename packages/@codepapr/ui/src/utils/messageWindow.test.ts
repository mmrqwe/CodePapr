import { describe, expect, it } from 'vitest';
import {
  clampWindow,
  computeInitialWindow,
  computeRoundStartIndices,
  computeWindowForJump,
  computeWindowForViewport,
  estimateMessageHeight,
  findMessageIndexAtOffset,
  findRoundIndexAtMessageIndex,
  slideWindowDown,
  slideWindowUp,
  windowMessageBounds,
} from './messageWindow';
import type { UIMessage } from '../store/agentStore';

let seq = 0;
function msg(role: UIMessage['role'], content: string, extra: Partial<UIMessage> = {}): UIMessage {
  seq += 1;
  return { id: `m-${seq}`, role, content, timestamp: seq, ...extra };
}

/** Build `rounds` rounds; each round = 1 user message + `assistantPerRound` assistant messages. */
function buildConversation(rounds: number, assistantPerRound = 1): UIMessage[] {
  const list: UIMessage[] = [];
  for (let r = 0; r < rounds; r++) {
    list.push(msg('user', `question ${r + 1}`));
    for (let a = 0; a < assistantPerRound; a++) {
      list.push(msg('assistant', `answer ${r + 1}.${a + 1}`));
    }
  }
  return list;
}

describe('computeRoundStartIndices', () => {
  it('treats each non-hidden user message with content as a round start', () => {
    const messages = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('user', ''),
      msg('user', 'hidden', { hidden: true }),
      msg('assistant', 'a2'),
      msg('user', 'q3'),
    ];
    expect(computeRoundStartIndices(messages)).toEqual([0, 2, 6]);
  });

  it('returns empty for empty input', () => {
    expect(computeRoundStartIndices([])).toEqual([]);
  });
});

describe('computeInitialWindow', () => {
  it('covers everything when the conversation fits the batch', () => {
    expect(computeInitialWindow(6, 6)).toEqual({ lo: 0, hi: 6 });
    expect(computeInitialWindow(3, 6)).toEqual({ lo: 0, hi: 3 });
    expect(computeInitialWindow(0, 6)).toEqual({ lo: 0, hi: 0 });
  });

  it('keeps only the last N rounds attached to the tail', () => {
    expect(computeInitialWindow(10, 6)).toEqual({ lo: 4, hi: 10 });
  });
});

describe('slideWindowUp / slideWindowDown', () => {
  // 20 rounds, window size 6, slide step 3
  const total = 20;
  const batch = 6;
  const step = 3;
  const initial = computeInitialWindow(total, batch); // { lo: 14, hi: 20 }

  it('slides up by the step while keeping the window size', () => {
    const w1 = slideWindowUp(initial, total, batch, step);
    expect(w1).toEqual({ lo: 11, hi: 17 });
    const w2 = slideWindowUp(w1, total, batch, step);
    expect(w2).toEqual({ lo: 8, hi: 14 });
  });

  it('clamps at the first round', () => {
    const nearTop = { lo: 2, hi: 8 };
    expect(slideWindowUp(nearTop, total, batch, step)).toEqual({ lo: 0, hi: 6 });
    expect(slideWindowUp({ lo: 0, hi: 6 }, total, batch, step)).toEqual({ lo: 0, hi: 6 });
  });

  it('slides down by the step and re-attaches at the tail', () => {
    const w = slideWindowDown({ lo: 8, hi: 14 }, total, batch, step);
    expect(w).toEqual({ lo: 11, hi: 17 });
    const attached = slideWindowDown(w, total, batch, step);
    expect(attached).toEqual({ lo: 14, hi: 20 });
    expect(slideWindowDown(attached, total, batch, step)).toEqual(attached);
  });

  it('never produces a window larger than the batch', () => {
    let w = initial;
    for (let i = 0; i < 10; i++) {
      w = slideWindowUp(w, total, batch, step);
      expect(w.hi - w.lo).toBeLessThanOrEqual(batch);
    }
    for (let i = 0; i < 10; i++) {
      w = slideWindowDown(w, total, batch, step);
      expect(w.hi - w.lo).toBeLessThanOrEqual(batch);
    }
  });
});

describe('computeWindowForJump', () => {
  const messages = buildConversation(10); // round starts: 0,2,...,18

  it('places the target round at the window top', () => {
    // message index 5 is inside round 3 (start 4); batch 3 → rounds [2,5)
    const w = computeWindowForJump(messages, 5, 3);
    expect(w).toEqual({ lo: 2, hi: 5 });
    expect(windowMessageBounds(messages, w)).toEqual({ start: 4, end: 10 });
  });

  it('snaps to the tail when the target is within the last batch rounds', () => {
    // round 8 (index 8 of 10) with batch 3 → tail window [7,10)
    const w = computeWindowForJump(messages, 16, 3);
    expect(w).toEqual({ lo: 7, hi: 10 });
    expect(windowMessageBounds(messages, w).end).toBe(messages.length);
  });

  it('targets the first round for messages before the first user message', () => {
    const withHead = [msg('assistant', 'boot'), ...buildConversation(6)];
    const w = computeWindowForJump(withHead, 0, 2);
    expect(w.lo).toBe(0);
    expect(windowMessageBounds(withHead, w).start).toBe(0);
  });

  it('returns an empty window when there are no rounds', () => {
    const messages2 = [msg('assistant', 'a'), msg('assistant', 'b')];
    expect(computeWindowForJump(messages2, 0, 6)).toEqual({ lo: 0, hi: 0 });
  });
});

describe('clampWindow', () => {
  it('is idempotent for valid windows', () => {
    const w = { lo: 2, hi: 8 };
    expect(clampWindow(w, 10, 6)).toBe(w);
  });

  it('keeps a tail-attached window attached after truncation', () => {
    const w = { lo: 14, hi: 20 };
    expect(clampWindow(w, 9, 6)).toEqual({ lo: 3, hi: 9 });
  });

  it('recovers an empty window to the tail when rounds exist', () => {
    // 打开会话时 useState 初值常是 {0,0}（消息尚未到达）。若把它当成合法窗口，
    // 7 轮 / 批次 6 会渲染 [0, 6) 并露出「加载更新的 1 轮」。
    expect(clampWindow({ lo: 0, hi: 0 }, 7, 6)).toEqual({ lo: 1, hi: 7 });
    expect(clampWindow({ lo: 0, hi: 0 }, 10, 6)).toEqual({ lo: 4, hi: 10 });
  });

  it('falls back to the tail window when the window collapses', () => {
    expect(clampWindow({ lo: 6, hi: 10 }, 3, 6)).toEqual({ lo: 0, hi: 3 });
  });

  it('handles empty conversations', () => {
    expect(clampWindow({ lo: 2, hi: 5 }, 0, 6)).toEqual({ lo: 0, hi: 0 });
  });
});

describe('windowMessageBounds', () => {
  it('includes messages before the first round when lo is 0', () => {
    const messages = [msg('assistant', 'boot'), ...buildConversation(4)];
    const bounds = windowMessageBounds(messages, { lo: 0, hi: 2 });
    expect(bounds.start).toBe(0);
    expect(bounds.end).toBe(5); // rounds start at 1,3,5,7; hi=2 → start of round 3 = 5
  });

  it('runs to the end when attached to the tail', () => {
    const messages = buildConversation(4);
    const bounds = windowMessageBounds(messages, { lo: 2, hi: 4 });
    expect(bounds).toEqual({ start: 4, end: messages.length });
  });
});

describe('findMessageIndexAtOffset', () => {
  // messages of height 100: prefix = [0, 100, 200, 300]
  const prefix = [0, 100, 200, 300];

  it('finds the message containing the offset', () => {
    expect(findMessageIndexAtOffset(prefix, 0)).toBe(0);
    expect(findMessageIndexAtOffset(prefix, 50)).toBe(0);
    expect(findMessageIndexAtOffset(prefix, 100)).toBe(1);
    expect(findMessageIndexAtOffset(prefix, 250)).toBe(2);
  });

  it('clamps beyond the ends', () => {
    expect(findMessageIndexAtOffset(prefix, -50)).toBe(0);
    expect(findMessageIndexAtOffset(prefix, 10_000)).toBe(2);
  });

  it('handles empty prefix', () => {
    expect(findMessageIndexAtOffset([0], 100)).toBe(0);
  });
});

describe('findRoundIndexAtMessageIndex', () => {
  const starts = [0, 4, 8];

  it('maps a message to its containing round', () => {
    expect(findRoundIndexAtMessageIndex(starts, 0)).toBe(0);
    expect(findRoundIndexAtMessageIndex(starts, 3)).toBe(0);
    expect(findRoundIndexAtMessageIndex(starts, 4)).toBe(1);
    expect(findRoundIndexAtMessageIndex(starts, 10)).toBe(2);
  });
});

describe('computeWindowForViewport', () => {
  // 10 rounds, each = user + assistant; heights from estimateMessageHeight are
  // deterministic per content, so build a matching prefix from the same helper.
  const messages = buildConversation(10);
  const heights = messages.map((m) => estimateMessageHeight(m));
  const prefix = [0];
  for (const h of heights) prefix.push(prefix[prefix.length - 1] + h);
  const batch = 3;

  it('centers the window on the round at the viewport center', () => {
    // center of round 5 (message index 8) → lo = 4 - 1 = 3
    const offset = prefix[8] + 10;
    const w = computeWindowForViewport(messages, prefix, offset, batch);
    expect(w.lo).toBe(3);
    expect(w.hi - w.lo).toBeLessThanOrEqual(batch);
    expect(w.lo).toBeLessThanOrEqual(4);
    expect(w.hi).toBeGreaterThan(4);
  });

  it('clamps at the first round', () => {
    const w = computeWindowForViewport(messages, prefix, 0, batch);
    expect(w.lo).toBe(0);
    expect(w.hi).toBeLessThanOrEqual(batch);
  });

  it('attaches to the tail near the bottom', () => {
    const w = computeWindowForViewport(messages, prefix, prefix[messages.length] - 10, batch);
    expect(w).toEqual({ lo: 7, hi: 10 });
  });

  it('returns an empty window when there are no rounds', () => {
    const msgs = [msg('assistant', 'a')];
    const p = [0, estimateMessageHeight(msgs[0])];
    expect(computeWindowForViewport(msgs, p, 0, batch)).toEqual({ lo: 0, hi: 0 });
  });
});

describe('estimateMessageHeight', () => {
  it('grows with content length and tool invocations', () => {
    const short = estimateMessageHeight(msg('assistant', 'hi'));
    const long = estimateMessageHeight(msg('assistant', 'x'.repeat(800)));
    const withTools = estimateMessageHeight(
      msg('assistant', 'hi', {
        toolInvocations: [
          { id: 't1', name: 'workspace_run_command', arguments: {}, status: 'success' },
          { id: 't2', name: 'workspace_run_command', arguments: {}, status: 'success' },
        ],
      })
    );
    expect(long).toBeGreaterThan(short);
    expect(withTools).toBeGreaterThan(short);
  });

  it('is capped', () => {
    expect(estimateMessageHeight(msg('assistant', 'x'.repeat(100_000)))).toBeLessThanOrEqual(800);
  });
});
