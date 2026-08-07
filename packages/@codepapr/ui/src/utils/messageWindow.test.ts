import { describe, expect, it } from 'vitest';
import {
  computeInitialWindowStart,
  computePreviousWindowStart,
  computeRoundStartIndices,
  computeWindowStartForIndex,
  countRoundsBefore,
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
      msg('user', '', {}),
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

describe('computeInitialWindowStart', () => {
  it('returns 0 when the conversation fits within the batch', () => {
    const messages = buildConversation(6);
    expect(computeInitialWindowStart(messages, 6)).toBe(0);
    expect(computeInitialWindowStart(messages, 10)).toBe(0);
  });

  it('keeps only the last N rounds for longer conversations', () => {
    const messages = buildConversation(10); // each round = 2 messages
    // round starts: 0,2,4,...,18; last 6 rounds start at index 8 (round 5)
    expect(computeInitialWindowStart(messages, 6)).toBe(8);
  });

  it('returns 0 when there are no user rounds', () => {
    const messages = [msg('assistant', 'a1'), msg('assistant', 'a2')];
    expect(computeInitialWindowStart(messages, 6)).toBe(0);
  });
});

describe('computePreviousWindowStart', () => {
  const messages = buildConversation(10); // starts at 0,2,...,18

  it('moves the window back by one batch', () => {
    // initial window for batch 6 starts at 8; loading 6 more reaches the start
    expect(computePreviousWindowStart(messages, 8, 6)).toBe(0);
  });

  it('moves back a full batch when enough history remains', () => {
    const long = buildConversation(20); // starts 0,2,...,38; initial batch-6 start = 28
    expect(computeInitialWindowStart(long, 6)).toBe(28);
    expect(computePreviousWindowStart(long, 28, 6)).toBe(16);
    expect(computePreviousWindowStart(long, 16, 6)).toBe(4);
    expect(computePreviousWindowStart(long, 4, 6)).toBe(0);
  });

  it('returns 0 when already at the beginning', () => {
    expect(computePreviousWindowStart(messages, 0, 6)).toBe(0);
  });
});

describe('computeWindowStartForIndex', () => {
  it('aligns to the round containing the target message', () => {
    const messages = buildConversation(10); // starts 0,2,...,18
    // assistant of round 4 sits at index 7; its round starts at 6
    expect(computeWindowStartForIndex(messages, 7)).toBe(6);
    // targeting the user message itself
    expect(computeWindowStartForIndex(messages, 6)).toBe(6);
  });

  it('returns 0 for targets before the first round', () => {
    const messages = [msg('assistant', 'boot'), ...buildConversation(3)];
    expect(computeWindowStartForIndex(messages, 0)).toBe(0);
  });
});

describe('countRoundsBefore', () => {
  it('counts user rounds strictly before the window start', () => {
    const messages = buildConversation(10);
    expect(countRoundsBefore(messages, 8)).toBe(4);
    expect(countRoundsBefore(messages, 0)).toBe(0);
    expect(countRoundsBefore(messages, 20)).toBe(10);
  });
});
