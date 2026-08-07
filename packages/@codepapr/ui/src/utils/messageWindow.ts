import type { UIMessage } from '../store/agentStore';

/** Indices into `messages` where each conversation round starts. A round begins
 *  at a user message with content — the same definition ConversationRoundsIndicator
 *  uses, so window boundaries align with the round ticks. */
export function computeRoundStartIndices(messages: readonly UIMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && !m.hidden && m.content) {
      starts.push(i);
    }
  }
  return starts;
}

/** Window start that shows only the last `batchRounds` rounds (all messages when
 *  the conversation is shorter). */
export function computeInitialWindowStart(
  messages: readonly UIMessage[],
  batchRounds: number
): number {
  const starts = computeRoundStartIndices(messages);
  if (starts.length <= batchRounds) return 0;
  return starts[starts.length - batchRounds];
}

/** Window start after loading `batchRounds` more rounds earlier than the current
 *  window. Returns 0 once the beginning of the conversation is reached. */
export function computePreviousWindowStart(
  messages: readonly UIMessage[],
  windowStart: number,
  batchRounds: number
): number {
  if (windowStart <= 0) return 0;
  const starts = computeRoundStartIndices(messages);
  let before = 0;
  for (const index of starts) {
    if (index < windowStart) before++;
    else break;
  }
  if (before === 0) return 0;
  const target = before - batchRounds;
  return target <= 0 ? 0 : starts[target];
}

/** Window start that includes the message at `messageIndex` (jump-to-message):
 *  aligns to the round containing the target so it lands at the window top. */
export function computeWindowStartForIndex(
  messages: readonly UIMessage[],
  messageIndex: number
): number {
  const starts = computeRoundStartIndices(messages);
  let start = 0;
  for (const index of starts) {
    if (index <= messageIndex) start = index;
    else break;
  }
  return start;
}

/** Number of rounds entirely before `windowStart` — used to label the
 *  "load earlier" sentinel. */
export function countRoundsBefore(messages: readonly UIMessage[], windowStart: number): number {
  if (windowStart <= 0) return 0;
  let count = 0;
  for (const m of messages.slice(0, windowStart)) {
    if (m.role === 'user' && !m.hidden && m.content) count++;
  }
  return count;
}
