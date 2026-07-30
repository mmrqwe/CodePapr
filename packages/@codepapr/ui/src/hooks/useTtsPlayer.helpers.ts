const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/g;
const SENTENCE_BOUNDARY_CJK = /[。！？\n\r!?;]+/g;
const SENTENCE_BOUNDARY_EN = /[.!?;\n\r]+/g;
/**
 * Clause-level boundary for fine-grained secondary splitting.
 * Splits on Chinese commas / enumeration commas / semicolons / colons /
 * em-dashes to keep GPT input short (benchmark: 56→9 char avg = 6x GPT speedup).
 */
const CLAUSE_BOUNDARY = /[，、；：——]+/g;

export function sentenceBoundaryFor(text: string): RegExp {
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  if (text.length > 0 && cjkCount / text.length > 0.5) {
    return SENTENCE_BOUNDARY_CJK;
  }
  return SENTENCE_BOUNDARY_EN;
}

/**
 * Strip markdown, code blocks, URLs, and other non-speakable text
 * from assistant content before sending to TTS.
 *
 * Roleplay-aware: action descriptors (italics like `*嘴角微扬*`, `*Johnny laughs*`,
 * or parenthetical asides like `（叹气）` `(sighs)`) are STRIPPED ENTIRELY,
 * not just unwrapped. The bold variants (`**word**`, `__word__`) are still
 * unwrapped because those are emphasis, not actions.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*[^*]+?\*/g, ' ')
    // Underscore italics only when the underscores sit on word boundaries —
    // otherwise identifiers like `snake_case` (underscores between word
    // chars) get their middle stripped out.
    .replace(/(^|[^\w])_[^_]+?_(?=[^\w]|$)/g, '$1 ')
    .replace(/（[^（）]*）/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/…+/g, '。')
    .replace(/([。！？])。+/g, '$1')
    .replace(/(^|\n)\s*。+/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitSentences(text: string): { sentences: string[]; lastEnd: number } {
  const coarse: string[] = [];
  let lastEnd = 0;

  try {
    const Segmenter = (Intl as unknown as { Segmenter?: new (
      locales?: string[],
      options?: { granularity: string }
    ) => { segment(input: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
    if (typeof Segmenter !== 'undefined') {
      const segmenter = new Segmenter(['zh', 'en', 'ja', 'ko'], { granularity: 'sentence' });
      for (const s of segmenter.segment(text)) {
        const sentence = text.slice(lastEnd, s.index + s.segment.length).trim();
        if (sentence) coarse.push(sentence);
        lastEnd = s.index + s.segment.length;
      }
    }
  } catch {
    // Fall through to regex fallback.
  }

  if (coarse.length === 0) {
    const boundary = sentenceBoundaryFor(text);
    const matches = [...text.matchAll(boundary)];
    for (const m of matches) {
      const end = m.index! + m[0].length;
      const sentence = text.slice(lastEnd, end).trim();
      if (sentence) coarse.push(sentence);
      lastEnd = end;
    }
  }

  // Fine-grained secondary split: break each coarse sentence on clause
  // boundaries (commas, semicolons, etc.) for dramatically faster GPT
  // inference. GPT autoregressive time grows super-linearly with text
  // length; 56-char avg → 9-char avg yields ~6x GPT speedup.
  const fine: string[] = [];
  for (const s of coarse) {
    const clauses = s.split(CLAUSE_BOUNDARY).map(c => c.trim()).filter(c => c.length > 0);
    if (clauses.length > 0) fine.push(...clauses);
  }

  return { sentences: fine, lastEnd };
}

/**
 * Pick the optimal GPT-SoVITS diffusion step count for a sentence.
 * Short sentences don't need many steps — the quality loss is imperceptible.
 */
export function pickSteps(text: string, userDefault: number): number {
  const len = text.trim().length;
  if (len <= 6) return 4;
  return userDefault;
}

/**
 * Merge consecutive short sentences into synthesis units just long enough
 * to amortise per-call overhead (~1-1.5s HTTP RTT + model setup) without
 * triggering GPT's super-linear time penalty on long inputs.
 *
 * Benchmark on Apple Silicon MPS (GPT-SoVITS v4, sample_steps=4):
 *   9-char avg  →  gpt ~0.5s/call,  total ~2.5s/call
 *   56-char avg →  gpt ~20s/call,   total ~30s/call
 *
 * Threshold 12 merges 2-3 tiny fragments (saves 2-3 RTTs) while keeping
 * GPT input well below the super-linear knee (~25+ chars).
 */
export function mergeShortSentences(sentences: string[]): string[] {
  if (sentences.length === 0) return [];
  const result: string[] = [];
  let buf = '';
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    const hasNewline = s.includes('\n');
    if (hasNewline && buf) {
      result.push(buf + s);
      buf = '';
      continue;
    }
    if (buf.length + s.length >= 12 || hasNewline) {
      result.push(buf + s);
      buf = '';
    } else {
      buf += s;
    }
  }
  if (buf) {
    result.push(buf);
  }
  return result;
}

/**
 * Walk raw streaming text and return the index up to which it is "safe to
 * sanitize and speak":
 *  - All inline markers (`*`, `**`, code backticks, `（）`, `()`, `[]`,
 *    `「」`, `『』`, `【】`, ```` ``` ````) are balanced.
 *  - The last character is sentence-end punctuation.
 *
 * Returns 0 when no safe split exists yet (caller should keep buffering).
 */export function findSafeSplitPoint(text: string): number {
  let star = 0;
  let backtick = 0;
  let cnParen = 0;
  let enParen = 0;
  let bracket = 0;
  let cnQuote = 0;
  let cnQuote2 = 0;
  let cnBracket = 0;
  let lastSafe = 0;
  let firstUnbalancedAt = 0;
  let i = 0;

  const allBalanced = () =>
    star === 0 && backtick === 0 && cnParen === 0 && enParen === 0 &&
    bracket === 0 && cnQuote === 0 && cnQuote2 === 0 && cnBracket === 0;

  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end < 0) {
        if (firstUnbalancedAt === 0 && i > lastSafe) firstUnbalancedAt = i;
        return Math.max(lastSafe, firstUnbalancedAt);
      }
      i = end + 3;
      continue;
    }
    const ch = text[i]!;
    const next = text[i + 1];

    if (ch === '*' && next === '*') {
      const close = text.indexOf('**', i + 2);
      if (close < 0) {
        if (firstUnbalancedAt === 0 && i > lastSafe) firstUnbalancedAt = i;
        return Math.max(lastSafe, firstUnbalancedAt);
      }
      i = close + 2;
      continue;
    }

    switch (ch) {
      case '*': {
        const wasBalanced = allBalanced();
        star ^= 1;
        if (wasBalanced && !allBalanced() && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      }
      case '`': {
        const wasBalanced = allBalanced();
        backtick ^= 1;
        if (wasBalanced && !allBalanced() && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      }
      case '（':
        cnParen++;
        if (cnParen === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case '）':
        if (cnParen > 0) cnParen--;
        break;
      case '(':
        enParen++;
        if (enParen === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case ')':
        if (enParen > 0) enParen--;
        break;
      case '[':
        bracket++;
        if (bracket === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case ']':
        if (bracket > 0) bracket--;
        break;
      case '「':
        cnQuote++;
        if (cnQuote === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case '」':
        if (cnQuote > 0) cnQuote--;
        break;
      case '『':
        cnQuote2++;
        if (cnQuote2 === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case '』':
        if (cnQuote2 > 0) cnQuote2--;
        break;
      case '【':
        cnBracket++;
        if (cnBracket === 1 && firstUnbalancedAt === 0 && i > lastSafe) {
          firstUnbalancedAt = i;
        }
        break;
      case '】':
        if (cnBracket > 0) cnBracket--;
        break;
      case '。':
      case '！':
      case '？':
      case '!':
      case '?':
      case ';':
      case '，':
      case '、':
      case '；':
      case '：':
      case '…':
      case '\n':
      case '\r':
        if (allBalanced()) {
          lastSafe = i + 1;
          firstUnbalancedAt = 0;
        }
        break;
    }
    i++;
  }
  return Math.max(lastSafe, firstUnbalancedAt);
}

/**
 * State carried across consecutive `feedStream` invocations.
 *
 * This is intentionally a plain object — kept on a `ref` in the hook —
 * so the decision logic can live in a pure function that is trivial to
 * unit-test in isolation. Every field is updated by `planFeed` below.
 */
export interface FeedState {
  /** Index into the most recent `fullText` we've already committed to TTS. */
  cursor: number;
  /** Last `fullText` we've seen, used to detect divergence / new messages. */
  lastFullText: string;
  /** Last `messageId` we've seen. `undefined` means the caller did not pass one. */
  lastMessageId: string | undefined;
  /** Last `messageId` we have already FINALIZED (forceComplete). Used as the idempotence key. */
  lastFinalizedId: string | undefined;
  /** Last raw chunk we enqueued, used to skip a consecutive byte-identical chunk. */
  lastEnqueued: string;
}

export function createFeedState(): FeedState {
  return {
    cursor: 0,
    lastFullText: '',
    lastMessageId: undefined,
    lastFinalizedId: undefined,
    lastEnqueued: '',
  };
}

export type FeedAction =
  /** No-op: the caller should not touch the queue. */
  | { type: 'noop' }
  /**
   * Emit `chunkToSpeak` as the *raw* (post-cursor, pre-sanitize) text that
   * should be sent through `sanitizeForSpeech` → `splitSentences` →
   * `mergeShortSentences` → `enqueue` by the caller. The state has already
   * been updated to reflect what is being emitted.
   */
  | { type: 'emit'; chunkToSpeak: string; isWholeMode?: boolean };

/**
 * Pure-function core of the streaming feed:
 *
 *  1. If a `forceComplete` for the same `messageId` has already been
 *     finalized, return `noop` — finalize is idempotent per message.
 *  2. Detect whether the incoming text is a *new* message (by id change
 *     OR by content divergence — the message store may rewrite content
 *     on finalize, breaking the prefix invariant on which `cursor` rests).
 *  3. For `whole` mode: only emit on `forceComplete`, emit the entire
 *     `fullText`.
 *  4. Otherwise: emit the slice `[cursor, cursor+safeEnd)` where
 *     `safeEnd = forceComplete ? remaining.length : findSafeSplitPoint(remaining)`.
 *
 * The caller is responsible for actually running the sanitizer and pushing
 * the result to the playback queue.
 *
 * Returns the updated `FeedState` plus the `FeedAction` describing what the
 * caller should do. We return a *new* state object so callers can `Object.assign`
 * it back into their ref — making the function trivially testable.
 */
export function planFeed(
  state: FeedState,
  fullText: string,
  forceComplete: boolean,
  messageId: string | undefined,
  playbackMode: 'whole' | 'streaming',
): { state: FeedState; action: FeedAction } {
  if (!fullText) {
    return { state, action: { type: 'noop' } };
  }

  // Idempotent finalize: a message is finalized AT MOST ONCE.
  if (forceComplete && messageId !== undefined && state.lastFinalizedId === messageId) {
    return { state, action: { type: 'noop' } };
  }

  // New-message detection.
  const idChanged =
    messageId !== undefined
    && state.lastMessageId !== undefined
    && state.lastMessageId !== messageId;
  const contentDiverged =
    !idChanged
    && state.lastFullText.length > 0
    && state.lastFullText !== fullText
    && !fullText.startsWith(state.lastFullText);
  const isNewMessage =
    messageId !== undefined
      ? idChanged || contentDiverged
      : state.lastFullText.length > 0 && !fullText.startsWith(state.lastFullText);

  const next: FeedState = {
    cursor: state.cursor,
    lastFullText: fullText,
    lastMessageId: messageId,
    lastFinalizedId: state.lastFinalizedId,
    lastEnqueued: state.lastEnqueued,
  };

  if (isNewMessage) {
    next.cursor = 0;
    next.lastEnqueued = '';
    // A new message also clears any stale finalize lock — unless the new
    // message is *itself* the one we already finalized (paranoid guard).
    if (messageId !== undefined && state.lastFinalizedId !== messageId) {
      next.lastFinalizedId = undefined;
    }
  }

  if (playbackMode === 'whole') {
    if (!forceComplete) {
      return { state: next, action: { type: 'noop' } };
    }
    next.cursor = fullText.length;
    if (messageId !== undefined) next.lastFinalizedId = messageId;
    return {
      state: next,
      action: { type: 'emit', chunkToSpeak: fullText, isWholeMode: true },
    };
  }

  const newRaw = fullText.slice(next.cursor);
  if (!newRaw && !forceComplete) {
    return { state: next, action: { type: 'noop' } };
  }

  const safeEnd = forceComplete ? newRaw.length : findSafeSplitPoint(newRaw);
  if (safeEnd === 0) {
    if (forceComplete && messageId !== undefined) next.lastFinalizedId = messageId;
    return { state: next, action: { type: 'noop' } };
  }

  const safeChunk = newRaw.slice(0, safeEnd);
  next.cursor += safeEnd;
  if (forceComplete && messageId !== undefined) next.lastFinalizedId = messageId;
  return { state: next, action: { type: 'emit', chunkToSpeak: safeChunk } };
}

/**
 * Pure-function dedup for the enqueue path. Returns the parts that should
 * actually be pushed (omitting any that match `state.lastEnqueued`), plus
 * the new `lastEnqueued` value.
 *
 * The dedup is intentionally strict on byte-equality — we only filter
 * consecutive identical chunks, not "similar" ones. This catches the
 * pathological "speak the same sentence over and over" failure mode
 * without risking false positives.
 */
export function dedupParts(
  parts: string[],
  lastEnqueued: string,
): { kept: string[]; lastEnqueued: string } {
  const trimmed = parts.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.length === 0) {
    return { kept: [], lastEnqueued };
  }
  const kept: string[] = [];
  let prev = lastEnqueued;
  for (const part of trimmed) {
    if (part === prev) continue;
    kept.push(part);
    prev = part;
  }
  return { kept, lastEnqueued: prev };
}
