import type { UIMessage } from '../store/agentStore';

/** Sliding render window expressed over conversation rounds: rounds [lo, hi)
 *  are rendered. `hi === totalRounds` means the window is attached to the tail
 *  (new messages flow into it automatically). */
export interface RoundWindow {
  lo: number;
  hi: number;
}

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

/** Initial window: the last `batchRounds` rounds, attached to the tail. */
export function computeInitialWindow(totalRounds: number, batchRounds: number): RoundWindow {
  if (totalRounds <= 0) return { lo: 0, hi: 0 };
  if (totalRounds <= batchRounds) return { lo: 0, hi: totalRounds };
  return { lo: totalRounds - batchRounds, hi: totalRounds };
}

/** Slide the window toward older rounds by `stepRounds`. The window keeps its
 *  size (≤ batchRounds), so newly loaded rounds at the top unload rounds at the
 *  bottom — the rendered DOM stays bounded. */
export function slideWindowUp(
  window: RoundWindow,
  totalRounds: number,
  batchRounds: number,
  stepRounds: number
): RoundWindow {
  if (window.lo <= 0 || totalRounds <= 0) return window;
  const lo = Math.max(0, window.lo - stepRounds);
  const hi = Math.min(totalRounds, lo + batchRounds);
  return { lo, hi };
}

/** Slide the window toward newer rounds by `stepRounds`. Reaching the last
 *  round re-attaches the window to the tail. */
export function slideWindowDown(
  window: RoundWindow,
  totalRounds: number,
  batchRounds: number,
  stepRounds: number
): RoundWindow {
  if (window.hi >= totalRounds || totalRounds <= 0) return window;
  const hi = Math.min(totalRounds, window.hi + stepRounds);
  const lo = Math.max(0, hi - batchRounds);
  return { lo, hi };
}

/** Window for jumping to the message at `messageIndex`: the round containing
 *  the target lands at the window top, unless the target sits within the last
 *  `batchRounds` rounds — then the window snaps to the tail. */
export function computeWindowForJump(
  messages: readonly UIMessage[],
  messageIndex: number,
  batchRounds: number
): RoundWindow {
  const starts = computeRoundStartIndices(messages);
  if (starts.length === 0) return { lo: 0, hi: 0 };
  let roundIndex = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= messageIndex) roundIndex = i;
    else break;
  }
  if (roundIndex < 0) roundIndex = 0;
  const total = starts.length;
  if (roundIndex >= total - batchRounds) {
    return computeInitialWindow(total, batchRounds);
  }
  return { lo: roundIndex, hi: roundIndex + batchRounds };
}

/** Converge a window after messages were truncated (reset-to-message). Windows
 *  attached to the tail stay attached. Idempotent for valid windows. */
export function clampWindow(
  window: RoundWindow,
  totalRounds: number,
  batchRounds: number
): RoundWindow {
  if (totalRounds <= 0) return { lo: 0, hi: 0 };
  if (window.lo >= 0 && window.lo <= window.hi && window.hi <= totalRounds) {
    return window;
  }
  if (window.hi >= totalRounds) {
    return computeInitialWindow(totalRounds, batchRounds);
  }
  const hi = Math.min(window.hi, totalRounds);
  const lo = Math.max(0, Math.min(window.lo, hi));
  return lo < hi ? { lo, hi } : computeInitialWindow(totalRounds, batchRounds);
}

/** Message-index slice [start, end) for a round window. `lo === 0` includes any
 *  messages before the first round; a tail-attached window runs to the end. */
export function windowMessageBounds(
  messages: readonly UIMessage[],
  window: RoundWindow
): { start: number; end: number } {
  const starts = computeRoundStartIndices(messages);
  if (starts.length === 0) return { start: 0, end: messages.length };
  const lo = Math.max(0, Math.min(window.lo, starts.length));
  const hi = Math.max(lo, Math.min(window.hi, starts.length));
  const start = lo === 0 ? 0 : starts[lo];
  const end = hi >= starts.length ? messages.length : starts[hi];
  return { start, end };
}

/** Rough pixel height for a message that is not currently rendered (and may
 *  never have been measured). Used for the spacer blocks that stand in for
 *  unloaded history; measured heights replace estimates once a message renders. */
export function estimateMessageHeight(message: UIMessage): number {
  const text = message.content || '';
  const lines = Math.max(1, Math.ceil(text.length / 40));
  const toolHeight = (message.toolInvocations?.length ?? 0) * 44;
  const reasoningHeight = message.reasoningContent ? 40 : 0;
  return Math.min(800, 56 + lines * 22 + toolHeight + reasoningHeight);
}
