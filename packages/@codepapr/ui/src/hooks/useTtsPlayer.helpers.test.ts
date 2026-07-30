import { describe, expect, it } from 'vitest';
import {
  sanitizeForSpeech,
  splitSentences,
  pickSteps,
  mergeShortSentences,
  findSafeSplitPoint,
  createFeedState,
  planFeed,
  dedupParts,
} from './useTtsPlayer.helpers';

describe('sanitizeForSpeech', () => {
  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeForSpeech('   \n  \t  ')).toBe('');
  });

  it('strips triple-backtick code fences', () => {
    const input = 'Here is code:\n```js\nconst x = 1;\n```\nDone.';
    const out = sanitizeForSpeech(input);
    expect(out).not.toContain('const x = 1');
    expect(out).toContain('Here is code');
    expect(out).toContain('Done.');
  });

  it('strips inline code', () => {
    const out = sanitizeForSpeech('Use the `git status` command.');
    expect(out).not.toContain('git status');
    expect(out).toContain('Use the');
    expect(out).toContain('command');
  });

  it('keeps link label, drops URL', () => {
    const out = sanitizeForSpeech('See [docs](https://example.com/x) for details.');
    expect(out).toContain('docs');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('https');
  });

  it('strips bare URLs', () => {
    const out = sanitizeForSpeech('Visit https://example.com/page now.');
    expect(out).not.toContain('example.com');
    expect(out).toContain('Visit');
    expect(out).toContain('now');
  });

  it('unwraps **bold** but preserves the content', () => {
    expect(sanitizeForSpeech('This is **important** text.')).toContain('important');
    expect(sanitizeForSpeech('This is **important** text.')).not.toContain('**');
  });

  it('unwraps __bold__ as emphasis', () => {
    expect(sanitizeForSpeech('Word __strong__ end.')).toContain('strong');
  });

  it('preserves snake_case identifiers (underscores between word chars)', () => {
    const out = sanitizeForSpeech('Call the get_user_name function now.');
    expect(out).toContain('get_user_name');
  });

  it('preserves a single trailing underscore identifier', () => {
    expect(sanitizeForSpeech('Use my_var and other_var_2 here.')).toContain('my_var');
    expect(sanitizeForSpeech('Use my_var and other_var_2 here.')).toContain('other_var_2');
  });

  it('DELETES underscore italics at word boundaries', () => {
    const out = sanitizeForSpeech('He said _quietly_ hello.');
    expect(out).not.toContain('quietly');
    expect(out).toContain('hello');
  });

  it('DELETES italic action descriptors entirely (single line, English)', () => {
    const out = sanitizeForSpeech('She said *whispering* hello.');
    expect(out).not.toContain('whispering');
    expect(out).toContain('hello');
  });

  it('DELETES italic action descriptors (single line, Chinese)', () => {
    const out = sanitizeForSpeech('他说*嘴角微扬*你好。');
    expect(out).not.toContain('嘴角微扬');
    expect(out).toContain('你好');
  });

  it('DELETES full-width parenthetical actions', () => {
    const out = sanitizeForSpeech('他点点头（叹气）说没事。');
    expect(out).not.toContain('叹气');
    expect(out).toContain('没事');
  });

  it('DELETES half-width parenthetical actions', () => {
    const out = sanitizeForSpeech('She nodded (sighs) and left.');
    expect(out).not.toContain('sighs');
    expect(out).toContain('nodded');
    expect(out).toContain('left');
  });

  it('processes bold before italic (regression: **bold** survives)', () => {
    const out = sanitizeForSpeech('This **really matters** to me.');
    expect(out).toContain('really matters');
  });

  it('strips heading markers', () => {
    expect(sanitizeForSpeech('# Title\nBody.')).toBe('Title\nBody.');
    expect(sanitizeForSpeech('### Subtitle')).toBe('Subtitle');
  });

  it('strips list markers', () => {
    const out = sanitizeForSpeech('- item one\n- item two');
    expect(out).toContain('item one');
    expect(out).toContain('item two');
    expect(out).not.toMatch(/^- /m);
  });

  it('strips numbered list markers', () => {
    const out = sanitizeForSpeech('1. first\n2. second');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).not.toMatch(/^\d+\. /m);
  });

  it('strips blockquote markers', () => {
    expect(sanitizeForSpeech('> quoted')).toBe('quoted');
  });

  it('strips horizontal rules', () => {
    const out = sanitizeForSpeech('Before\n---\nAfter');
    expect(out).toContain('Before');
    expect(out).toContain('After');
    expect(out).not.toContain('---');
  });

  it('strips HTML tags', () => {
    const out = sanitizeForSpeech('<b>bold</b> and <i>italic</i>');
    expect(out).toContain('bold');
    expect(out).toContain('italic');
    expect(out).not.toContain('<b>');
  });

  it('strips HTML entities', () => {
    const out = sanitizeForSpeech('A&nbsp;B&amp;C');
    expect(out).not.toContain('&nbsp;');
    expect(out).not.toContain('&amp;');
  });

  it('collapses multiple spaces created by substitutions', () => {
    const out = sanitizeForSpeech('a    b\t\t\tc');
    expect(out).not.toMatch(/[ \t]{2,}/);
  });

  it('handles multi-line italic action descriptors', () => {
    const input = '*Johnny walks to the window,\nlights a cigarette*\nThen he turns.';
    const out = sanitizeForSpeech(input);
    expect(out).not.toContain('Johnny walks');
    expect(out).not.toContain('cigarette');
    expect(out).toContain('Then he turns');
  });

  it('handles realistic mixed roleplay output', () => {
    const input = `**Johnny**: *leans in* "Hello there." (smirks)\n\nWelcome to the show.`;
    const out = sanitizeForSpeech(input);
    expect(out).toContain('Johnny');
    expect(out).toContain('Hello there');
    expect(out).toContain('Welcome to the show');
    expect(out).not.toContain('leans in');
    expect(out).not.toContain('smirks');
  });

  it('replaces ellipsis (…) with 。 to prevent GPT explosion', () => {
    const out = sanitizeForSpeech('歩いて…ドアを開けて…戻ってきた');
    expect(out).not.toContain('…');
    expect(out).toContain('。');
  });

  it('replaces consecutive ellipsis as a group', () => {
    const out = sanitizeForSpeech('あの……えっと');
    expect(out).not.toContain('…');
  });

  it('cleans up 。 artifacts after ！ or ？ (from …→。 replacement)', () => {
    const out = sanitizeForSpeech('やるんだから！。あんたは？。');
    expect(out).not.toMatch(/[！？]。/);
  });

  it('removes leading 。 on a line (from …→。 at sentence start)', () => {
    const out = sanitizeForSpeech('…そして。いつか');
    // The … becomes 。, then leading 。 is stripped
    expect(out).not.toMatch(/(^|\n)\s*。/);
  });
});

describe('splitSentences', () => {
  it('splits English text on terminal punctuation', () => {
    const { sentences } = splitSentences('Hello world. How are you? Fine!');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.join(' ')).toContain('Hello world');
    expect(sentences.join(' ')).toContain('Fine');
  });

  it('splits Chinese text on 。！？', () => {
    const { sentences } = splitSentences('你好。今天天气好！是吗？');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.join('')).toContain('你好');
    expect(sentences.join('')).toContain('是吗');
  });

  it('produces non-empty sentences only', () => {
    const { sentences } = splitSentences('...!!??.');
    for (const s of sentences) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns lastEnd at or beyond final boundary', () => {
    const text = 'A. B. C.';
    const { lastEnd } = splitSentences(text);
    expect(lastEnd).toBeGreaterThan(0);
    expect(lastEnd).toBeLessThanOrEqual(text.length);
  });

  it('handles empty input', () => {
    const { sentences, lastEnd } = splitSentences('');
    expect(sentences).toEqual([]);
    expect(lastEnd).toBe(0);
  });

  it('handles input with no terminal punctuation', () => {
    const { sentences } = splitSentences('no terminator');
    // Behaviour varies (regex returns [], Intl.Segmenter returns 1) — both are OK.
    expect(sentences.length).toBeLessThanOrEqual(1);
  });

  it('splits CJK/EN mixed text reasonably', () => {
    const text = '今天去 store 买东西。Then we went home.';
    const { sentences } = splitSentences(text);
    expect(sentences.length).toBeGreaterThanOrEqual(1);
  });

  it('fine-splits on Chinese commas for faster GPT inference', () => {
    const text = '你好，世界，今天天气不错。';
    const { sentences } = splitSentences(text);
    // Should split on commas AND period → at least 3 clauses
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.join('')).toContain('你好');
    expect(sentences.join('')).toContain('世界');
    expect(sentences.join('')).toContain('今天天气不错');
  });

  it('fine-splits on 、 (enumeration comma)', () => {
    const text = '苹果、香蕉、橙子。';
    const { sentences } = splitSentences(text);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
  });

  it('fine-splits on ；and ：', () => {
    const text = '第一点：开始；第二点：结束。';
    const { sentences } = splitSentences(text);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
  });

  it('does not produce empty sentences from consecutive commas', () => {
    const text = '你好，，世界';
    const { sentences } = splitSentences(text);
    for (const s of sentences) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('pickSteps', () => {
  it('returns 4 for short sentences (<=6 chars)', () => {
    expect(pickSteps('hi.', 16)).toBe(4);
    expect(pickSteps('你好', 16)).toBe(4);
    expect(pickSteps('123456', 16)).toBe(4);
  });

  it('returns user default for longer sentences', () => {
    expect(pickSteps('This is a longer sentence.', 16)).toBe(16);
    expect(pickSteps('这是一段比较长的句子', 8)).toBe(8);
  });

  it('trims whitespace before measuring length', () => {
    expect(pickSteps('   hi   ', 32)).toBe(4);
  });

  it('respects different userDefault values', () => {
    expect(pickSteps('long enough sentence here', 4)).toBe(4);
    expect(pickSteps('long enough sentence here', 32)).toBe(32);
  });
});

describe('mergeShortSentences', () => {
  it('returns empty array for empty input', () => {
    expect(mergeShortSentences([])).toEqual([]);
  });

  it('passes through a single short sentence (will be re-evaluated later)', () => {
    expect(mergeShortSentences(['hi'])).toEqual(['hi']);
  });

  it('merges consecutive short sentences until >= 12 chars', () => {
    const out = mergeShortSentences(['ab.', 'cd.', 'ef.', 'gh.', 'ij.']);
    // With threshold 12: 3+3+3+3=12 → emit after 4th. Then 'ij.' remains.
    expect(out.join('')).toBe('ab.cd.ef.gh.ij.');
    // Should have merged some — not all in one (threshold 12, not 40)
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('emits buffer + newline-containing sentence as one unit', () => {
    const out = mergeShortSentences(['hi.', 'bye\n', 'next']);
    expect(out[0]).toBe('hi.bye\n');
  });

  it('preserves total content across merges (lossless)', () => {
    const input = ['你好', '世界', '今天', '不错', '天气'];
    const out = mergeShortSentences(input);
    expect(out.join('')).toBe(input.join(''));
  });

  it('keeps a long-enough single sentence as a single output', () => {
    const long = 'this sentence is long enough by itself.';
    expect(mergeShortSentences([long])).toEqual([long]);
  });
});

describe('findSafeSplitPoint', () => {
  it('returns 0 for empty text', () => {
    expect(findSafeSplitPoint('')).toBe(0);
  });

  it('returns 0 when no terminator exists', () => {
    expect(findSafeSplitPoint('hello')).toBe(0);
  });

  it('does NOT treat "." as a terminator (Chinese-oriented set)', () => {
    // The current terminator set is 。！？!?;,，\n\r — "." is intentionally excluded.
    expect(findSafeSplitPoint('Hello world.')).toBe(0);
  });

  it('treats "!" as a terminator', () => {
    const text = 'Hello world!';
    expect(findSafeSplitPoint(text)).toBe(text.length);
  });

  it('treats "?" as a terminator', () => {
    const text = 'Hello?';
    expect(findSafeSplitPoint(text)).toBe(text.length);
  });

  it('treats 。 as a terminator', () => {
    const text = '你好。';
    expect(findSafeSplitPoint(text)).toBe(text.length);
  });

  it('returns 0 for an unclosed single asterisk action descriptor', () => {
    expect(findSafeSplitPoint('*action')).toBe(0);
  });

  it('returns position before unbalanced marker (streaming-safe)', () => {
    // When there is no prior safe split, the function returns the index of
    // the first unbalanced marker so we can still speak the safe prefix.
    expect(findSafeSplitPoint('hi *open')).toBe(3);
  });

  it('returns position after ! inside a closed *...*', () => {
    const text = '*action*! tail';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('!');
  });

  it('returns the unbalanced position when inside unclosed full-width parens', () => {
    // No earlier terminator → returns index of `（` so caller speaks "开头".
    const text = '开头（动作';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBe(text.indexOf('（'));
  });

  it('treats balanced full-width parens + 。 as fully safe', () => {
    const text = '开头（动作）。后面';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('。');
  });

  it('treats balanced half-width parens + ! correctly', () => {
    const text = 'start (note)! next';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('!');
  });

  it('returns the unbalanced position when inside unclosed half-width parens', () => {
    const text = 'start (open';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBe(text.indexOf('('));
  });

  it('handles **bold** pair (skips internal terminators)', () => {
    // The `**...**` block is treated as inert and skipped over.
    // After it, "! tail" arrives. The `!` terminates → safe split.
    const text = '**bold word**! tail';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('!');
  });

  it('returns 0 for unclosed **', () => {
    expect(findSafeSplitPoint('**open here')).toBe(0);
  });

  it('returns 0 for unclosed ``` code fence', () => {
    expect(findSafeSplitPoint('```js\nlet x = 1;')).toBe(0);
  });

  it('handles closed ``` code fence as inert region (treats \\n as terminator)', () => {
    const text = '```js\nlet x = 1;\n```\n';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
  });

  it('returns first-unbalanced position when inside 「」 with no prior safe split', () => {
    const text = '他说「未结束';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBe(text.indexOf('「'));
  });

  it('splits after 。 when 「」 is closed', () => {
    const text = '他说「你好」。';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBe(text.length);
  });

  it('flags 『 as unbalanced (no terminator yet)', () => {
    const pos = findSafeSplitPoint('A『B');
    expect(pos).toBe('A'.length);
  });

  it('flags 【 as unbalanced (no terminator yet)', () => {
    const pos = findSafeSplitPoint('【tag');
    expect(pos).toBe(0);
  });

  it('flags [ as unbalanced (no terminator yet)', () => {
    const pos = findSafeSplitPoint('[link');
    expect(pos).toBe(0);
  });

  it('preserves the LAST safe split point when later content is unbalanced', () => {
    // First clean sentence ends, then an unclosed marker starts.
    const text = 'Done! *opened';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(text.length);
    expect(text.slice(0, pos)).toContain('Done!');
    expect(text.slice(0, pos)).not.toContain('*');
  });

  it('handles realistic streaming snapshot mid-action', () => {
    // Streaming text where action descriptor hasn't closed yet.
    const text = 'Hello there! *Johnny looks';
    const pos = findSafeSplitPoint(text);
    // pos is at the index of `*` — everything before is safe to speak.
    expect(pos).toBe(text.indexOf('*'));
    expect(text.slice(0, pos)).toBe('Hello there! ');
  });

  it('DOES split on full-width comma (fine-grained for GPT speed)', () => {
    // `，` IS now a split point — fine-grained splitting keeps GPT input
    // short for dramatically faster inference (6x GPT speedup benchmarked).
    const text = '你好，世界';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('你好');
  });

  it('treats … (ellipsis) as a safe split point', () => {
    // Multiple … cause GPT-SoVITS to generate extremely long silent token
    // sequences (benchmark: 10 chars with 3×… → gpt=21s vs 0.4s without).
    // sanitizeForSpeech replaces … with 。 so this is a belt-and-suspenders
    // guard for any … that survive sanitization.
    const text = '歩いて…ドアを開けて';
    const pos = findSafeSplitPoint(text);
    expect(pos).toBeGreaterThan(0);
    expect(text.slice(0, pos)).toContain('歩いて');
  });
});

describe('dedupParts', () => {
  it('returns nothing for empty input', () => {
    const out = dedupParts([], 'prev');
    expect(out.kept).toEqual([]);
    expect(out.lastEnqueued).toBe('prev');
  });

  it('drops whitespace-only entries', () => {
    const out = dedupParts(['  ', 'hello', '\t\n'], '');
    expect(out.kept).toEqual(['hello']);
    expect(out.lastEnqueued).toBe('hello');
  });

  it('skips a chunk equal to lastEnqueued (consecutive identical)', () => {
    const out = dedupParts(['hello', 'hello', 'world'], 'hello');
    expect(out.kept).toEqual(['world']);
    expect(out.lastEnqueued).toBe('world');
  });

  it('skips consecutive duplicates within the same batch', () => {
    const out = dedupParts(['a', 'a', 'b', 'b', 'a'], '');
    expect(out.kept).toEqual(['a', 'b', 'a']);
    expect(out.lastEnqueued).toBe('a');
  });

  it('keeps non-consecutive duplicates (only filters CONSECUTIVE same chunks)', () => {
    const out = dedupParts(['a', 'b', 'a'], '');
    expect(out.kept).toEqual(['a', 'b', 'a']);
  });

  it('trims before comparing', () => {
    const out = dedupParts(['hello', '  hello  ', 'world'], '');
    // After trim, both become "hello"; the 2nd is dropped.
    expect(out.kept).toEqual(['hello', 'world']);
  });
});

describe('planFeed', () => {
  it('returns noop on empty fullText', () => {
    const s = createFeedState();
    const { action } = planFeed(s, '', false, undefined, 'streaming');
    expect(action.type).toBe('noop');
  });

  it('emits a safe chunk in streaming mode and advances cursor', () => {
    const s = createFeedState();
    const r = planFeed(s, 'Hello world! tail', false, 'm1', 'streaming');
    expect(r.action.type).toBe('emit');
    if (r.action.type === 'emit') {
      // "Hello world!" is the safe prefix — `findSafeSplitPoint` returns the
      // index right after the terminator, BEFORE any trailing whitespace.
      expect(r.action.chunkToSpeak).toBe('Hello world!');
    }
    expect(r.state.cursor).toBe('Hello world!'.length);
  });

  it('NEVER speaks unbalanced markers (italic descriptor not yet closed)', () => {
    const s = createFeedState();
    const r = planFeed(s, '*opening', false, 'm1', 'streaming');
    expect(r.action.type).toBe('noop');
    expect(r.state.cursor).toBe(0);
  });

  it('keeps cursor stable across redundant feeds of the same fullText', () => {
    let st = createFeedState();
    const text = 'Hello! ';
    const r1 = planFeed(st, text, false, 'm1', 'streaming');
    st = r1.state;
    expect(r1.action.type).toBe('emit');

    // Second call with identical text: nothing new to speak.
    const r2 = planFeed(st, text, false, 'm1', 'streaming');
    expect(r2.action.type).toBe('noop');
    expect(r2.state.cursor).toBe(st.cursor);
  });

  it('appends only the new tail across two streaming frames', () => {
    let st = createFeedState();
    const r1 = planFeed(st, 'Hi! ', false, 'm1', 'streaming');
    st = r1.state;
    const r2 = planFeed(st, 'Hi! There! ', false, 'm1', 'streaming');
    expect(r2.action.type).toBe('emit');
    if (r2.action.type === 'emit') {
      // The leading space after "Hi!" is part of the tail; `findSafeSplitPoint`
      // returns the index just past `!`, dropping the space before "There".
      expect(r2.action.chunkToSpeak).toBe(' There!');
    }
  });

  it('detects a new message by id change and resets the cursor', () => {
    let st = createFeedState();
    const r1 = planFeed(st, 'Old message text! ', false, 'm1', 'streaming');
    st = r1.state;
    const r2 = planFeed(st, 'Brand new message! ', false, 'm2', 'streaming');
    expect(r2.action.type).toBe('emit');
    if (r2.action.type === 'emit') {
      // Cursor reset → the whole new message (up to the terminator) is emitted.
      expect(r2.action.chunkToSpeak).toBe('Brand new message!');
    }
    expect(r2.state.cursor).toBe('Brand new message!'.length);
  });

  it('detects content divergence (store rewrote content) and resets cursor', () => {
    let st = createFeedState();
    const r1 = planFeed(st, 'streaming partial! ', false, 'm1', 'streaming');
    st = r1.state;
    // Same messageId, but content was REWRITTEN (no longer extends the original).
    const r2 = planFeed(st, 'totally different finalized! ', false, 'm1', 'streaming');
    expect(r2.action.type).toBe('emit');
    if (r2.action.type === 'emit') {
      expect(r2.action.chunkToSpeak).toBe('totally different finalized!');
    }
  });

  // ============================================================
  // The regressions that drove this entire change: the user reported
  // the character keeps repeating one sentence. These tests pin that
  // behavior down.
  // ============================================================

  it('REGRESSION: finalize for the same messageId is idempotent (StrictMode safe)', () => {
    let st = createFeedState();
    // Stream a sentence to completion.
    const r1 = planFeed(st, 'Hello there! ', false, 'm1', 'streaming');
    st = r1.state;
    expect(r1.action.type).toBe('emit');

    // Now finalize the message.
    const r2 = planFeed(st, 'Hello there!', true, 'm1', 'streaming');
    st = r2.state;
    // The cursor is already past the content; finalize emits nothing
    // but locks the finalize key.
    expect(st.lastFinalizedId).toBe('m1');

    // React StrictMode / a stray re-render fires finalize a SECOND time
    // for the same messageId. THIS must be a noop — otherwise the user
    // hears the message twice.
    const r3 = planFeed(st, 'Hello there!', true, 'm1', 'streaming');
    expect(r3.action.type).toBe('noop');
  });

  it('REGRESSION: streaming + finalize on same message does NOT double-speak', () => {
    let st = createFeedState();
    // 3 streaming frames, then finalize.
    const text = 'Hello world! Welcome aboard! Enjoy your stay! ';
    const r1 = planFeed(st, text, false, 'm1', 'streaming');
    st = r1.state;
    expect(r1.action.type).toBe('emit');
    if (r1.action.type === 'emit') {
      // The whole text up to the last terminator is emitted (the trailing
      // space is NOT included by findSafeSplitPoint).
      expect(r1.action.chunkToSpeak).toBe('Hello world! Welcome aboard! Enjoy your stay!');
    }

    // Same text, no new bytes — streaming effect re-fires due to unrelated
    // re-render.
    const r2 = planFeed(st, text, false, 'm1', 'streaming');
    // The cursor is at 45, the trailing whitespace remains; findSafeSplitPoint
    // on " " returns 0 (no terminator) → noop.
    expect(r2.action.type).toBe('noop');
    st = r2.state;

    // Finalize: cursor is at 45, forceComplete pulls the remaining " " — but
    // sanitize would strip it. We DO emit (chunkToSpeak === " ") and lock
    // the finalize key.
    const r3 = planFeed(st, text, true, 'm1', 'streaming');
    st = r3.state;
    expect(st.lastFinalizedId).toBe('m1');

    // Another finalize from StrictMode — MUST be a noop.
    const r4 = planFeed(st, text, true, 'm1', 'streaming');
    expect(r4.action.type).toBe('noop');
  });

  it('REGRESSION: whole mode finalize is idempotent', () => {
    let st = createFeedState();
    // In whole mode, streaming frames are no-ops; only finalize emits.
    const r1 = planFeed(st, 'One whole passage.', false, 'm1', 'whole');
    expect(r1.action.type).toBe('noop');
    st = r1.state;

    const r2 = planFeed(st, 'One whole passage.', true, 'm1', 'whole');
    expect(r2.action.type).toBe('emit');
    if (r2.action.type === 'emit') {
      expect(r2.action.isWholeMode).toBe(true);
      expect(r2.action.chunkToSpeak).toBe('One whole passage.');
    }
    st = r2.state;

    // Second finalize for the same message must be a noop.
    const r3 = planFeed(st, 'One whole passage.', true, 'm1', 'whole');
    expect(r3.action.type).toBe('noop');
  });

  it('REGRESSION: whole mode does NOT emit anything until forceComplete', () => {
    let st = createFeedState();
    for (const partial of ['One', 'One whole', 'One whole passage', 'One whole passage.']) {
      const r = planFeed(st, partial, false, 'm1', 'whole');
      expect(r.action.type).toBe('noop');
      st = r.state;
    }
    const r = planFeed(st, 'One whole passage.', true, 'm1', 'whole');
    expect(r.action.type).toBe('emit');
  });

  it('REGRESSION: a new message AFTER finalize clears the finalize lock', () => {
    let st = createFeedState();
    const r1 = planFeed(st, 'Msg one! ', true, 'm1', 'streaming');
    expect(r1.action.type).toBe('emit');
    st = r1.state;
    expect(st.lastFinalizedId).toBe('m1');

    // New message arrives.
    const r2 = planFeed(st, 'Msg two! ', false, 'm2', 'streaming');
    expect(r2.action.type).toBe('emit');
    st = r2.state;
    expect(st.lastFinalizedId).toBeUndefined();

    // Finalize the second one.
    const r3 = planFeed(st, 'Msg two!', true, 'm2', 'streaming');
    st = r3.state;
    expect(st.lastFinalizedId).toBe('m2');

    // A duplicate finalize of m2 is still suppressed.
    const r4 = planFeed(st, 'Msg two!', true, 'm2', 'streaming');
    expect(r4.action.type).toBe('noop');
  });

  it('REGRESSION: forceComplete flushes through unclosed markers', () => {
    let st = createFeedState();
    // Streaming frame ends mid-italic: must NOT speak yet.
    const r1 = planFeed(st, 'Hi *Johnny looks ', false, 'm1', 'streaming');
    // Either emits "Hi " or buffers — the IMPORTANT thing is that the
    // italic content is not in the emitted chunk.
    if (r1.action.type === 'emit') {
      expect(r1.action.chunkToSpeak).not.toContain('Johnny');
    }
    st = r1.state;

    // Now finalize: the AI is done, no closing `*` will ever arrive.
    // forceComplete must flush the entire remainder.
    const r2 = planFeed(st, 'Hi *Johnny looks ', true, 'm1', 'streaming');
    // Combined emitted content across both frames must cover the full text.
    const emitted1 = r1.action.type === 'emit' ? r1.action.chunkToSpeak : '';
    const emitted2 = r2.action.type === 'emit' ? r2.action.chunkToSpeak : '';
    expect(emitted1 + emitted2).toBe('Hi *Johnny looks ');
  });

  it('REGRESSION: missing messageId still works (fallback prefix heuristic)', () => {
    let st = createFeedState();
    const r1 = planFeed(st, 'Hello! ', false, undefined, 'streaming');
    expect(r1.action.type).toBe('emit');
    st = r1.state;

    // Same text again → no advance.
    const r2 = planFeed(st, 'Hello! ', false, undefined, 'streaming');
    expect(r2.action.type).toBe('noop');
    st = r2.state;

    // Diverged text without an id → treated as new message, cursor resets.
    const r3 = planFeed(st, 'Different! ', false, undefined, 'streaming');
    expect(r3.action.type).toBe('emit');
    if (r3.action.type === 'emit') {
      expect(r3.action.chunkToSpeak).toBe('Different!');
    }
  });

  it('REGRESSION: dedup state is preserved on streaming advance and reset on new message', () => {
    let st = createFeedState();
    st = { ...st, lastEnqueued: 'previously enqueued' };

    // Same-message streaming frame doesn't reset lastEnqueued.
    const r1 = planFeed(st, 'Hello! ', false, 'm1', 'streaming');
    expect(r1.state.lastEnqueued).toBe('previously enqueued');
    st = r1.state;

    // New message resets lastEnqueued (so the new message's first chunk
    // is not blocked by an unrelated leftover from the previous message).
    const r2 = planFeed(st, 'Brand new! ', false, 'm2', 'streaming');
    expect(r2.state.lastEnqueued).toBe('');
  });
});

