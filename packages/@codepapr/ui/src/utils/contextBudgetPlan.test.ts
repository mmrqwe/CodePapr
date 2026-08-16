import { describe, expect, it } from 'vitest';
import { planContextCompaction } from './contextCompaction';
import type { ContextMessageLike } from './contextCompaction';

function user(id: string, content: string): ContextMessageLike {
  return { id, role: 'user', content, timestamp: 1 };
}

function assistant(id: string, content: string): ContextMessageLike {
  return { id, role: 'assistant', content, timestamp: 2 };
}

/** bytes/4 启发式：4 字符 ≈ 1 token。 */
function sized(contentChars: number): string {
  return 'x'.repeat(contentChars);
}

describe('planContextCompaction soft/hard budget actions (PR3)', () => {
  const hard = 1_000;
  const soft = 700;

  it('below soft budget → none', () => {
    const messages = [user('u1', sized(200)), assistant('a1', sized(200))];
    const plan = planContextCompaction(messages, { maxTokens: hard, softMaxTokens: soft });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.shouldPrune).toBeUndefined();
    expect(plan.budgetAction).toBe('none');
  });

  it('soft ~ hard → prune-tool-results without a checkpoint', () => {
    const messages = [user('u1', sized(1_800)), assistant('a1', sized(1_800))];
    const plan = planContextCompaction(messages, { maxTokens: hard, softMaxTokens: soft });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.shouldPrune).toBe(true);
    expect(plan.budgetAction).toBe('prune-tool-results');
  });

  it('over hard budget → compact with token-limit trigger', () => {
    const messages = [user('u1', sized(4_000)), assistant('a1', sized(4_000))];
    const plan = planContextCompaction(messages, { maxTokens: hard, softMaxTokens: soft });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.trigger).toBe('token-limit');
  });

  it('rounds exceeded below soft → compact with round-limit trigger', () => {
    const messages: ContextMessageLike[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(user(`u${i}`, 'hi'));
      messages.push(assistant(`a${i}`, 'ok'));
    }
    const plan = planContextCompaction(messages, {
      maxTokens: hard,
      softMaxTokens: soft,
      maxRounds: 10,
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.trigger).toBe('round-limit');
  });

  it('force → manual trigger regardless of budget', () => {
    const messages = [user('u1', 'hi')];
    const plan = planContextCompaction(messages, { maxTokens: hard, softMaxTokens: soft, force: true });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.trigger).toBe('manual');
  });

  it('soft defaults to hard when not provided (legacy behavior)', () => {
    const messages = [user('u1', sized(800)), assistant('a1', sized(800))];
    const plan = planContextCompaction(messages, { maxTokens: hard });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.budgetAction).toBe('none');
  });
});
