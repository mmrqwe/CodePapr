import { describe, expect, it } from 'vitest';
import { MessageFactory, stripInternalFields, redactImagePayloadsForTranscript, redactTranscriptOutputString } from '../src';

describe('MessageFactory.tool', () => {
  it('strips __images from toolResult.result', () => {
    const result = {
      path: 'screenshot.png',
      bytes: 12345,
      __images: [{ mediaType: 'image/png', data: 'base64data' }],
    };
    const msg = MessageFactory.tool('call-1', result, true);

    expect(msg.role).toBe('tool');
    expect(msg.toolResult?.result).toBeDefined();
    const stored = msg.toolResult!.result as Record<string, unknown>;
    expect(stored.__images).toBeUndefined();
    expect(stored.path).toBe('screenshot.png');
    expect(stored.bytes).toBe(12345);
  });

  it('strips __images from content string', () => {
    const result = {
      path: 'img.png',
      __images: [{ mediaType: 'image/png', data: 'hugebase64' }],
    };
    const msg = MessageFactory.tool('call-1', result, true);

    expect(msg.content).not.toContain('hugebase64');
    expect(msg.content).not.toContain('__images');
    expect(msg.content).toContain('img.png');
  });

  it('strips __question from toolResult.result', () => {
    const result = {
      __question: true,
      question: 'Which option?',
      header: 'Choice',
    };
    const msg = MessageFactory.tool('call-1', result, true);

    const stored = msg.toolResult!.result as Record<string, unknown>;
    expect(stored.__question).toBeUndefined();
    expect(stored.question).toBe('Which option?');
  });

  it('handles string results unchanged', () => {
    const msg = MessageFactory.tool('call-1', 'plain text result', true);
    expect(msg.content).toBe('plain text result');
    expect(msg.toolResult!.result).toBe('plain text result');
  });

  it('strips reRecallInsertion from tool result (ADR-009 rule 13)', () => {
    const result = {
      query: 'oauth',
      results: '- [verified] oauth 回调需注册',
      reRecallInsertion: {
        anchorMessageId: 'user-1',
        renderedMessages: [{ role: 'user', content: 'RECALL BLOCK SECRET' }],
      },
    };
    const msg = MessageFactory.tool('call-1', result, true);

    const stored = msg.toolResult!.result as Record<string, unknown>;
    expect(stored.reRecallInsertion).toBeUndefined();
    expect(stored.query).toBe('oauth');
    expect(msg.content).not.toContain('RECALL BLOCK SECRET');
    expect(msg.content).not.toContain('reRecallInsertion');
  });

  it('handles nested __images in arrays', () => {
    const result = {
      items: [
        { name: 'a', __images: [{ mediaType: 'image/png', data: 'x' }] },
        { name: 'b' },
      ],
    };
    const cleaned = stripInternalFields(result) as Record<string, unknown>;
    const items = cleaned.items as Array<Record<string, unknown>>;
    expect(items[0].__images).toBeUndefined();
    expect(items[0].name).toBe('a');
    expect(items[1].name).toBe('b');
  });
});

describe('stripInternalFields', () => {
  it('returns primitives unchanged', () => {
    expect(stripInternalFields(42)).toBe(42);
    expect(stripInternalFields('hello')).toBe('hello');
    expect(stripInternalFields(null)).toBe(null);
    expect(stripInternalFields(undefined)).toBe(undefined);
  });

  it('returns arrays with stripped elements', () => {
    const input = [{ __images: 'x', keep: 1 }, { __question: true, keep: 2 }];
    const result = stripInternalFields(input) as Array<Record<string, unknown>>;
    expect(result[0].__images).toBeUndefined();
    expect(result[0].keep).toBe(1);
    expect(result[1].__question).toBeUndefined();
    expect(result[1].keep).toBe(2);
  });
});

describe('redactImagePayloadsForTranscript / redactTranscriptOutputString（工具图片转录投影）', () => {
  it('保留 __images 骨架与 path/mediaType，仅置空 data', () => {
    const input = {
      path: 'assets/a.png',
      nested: { deep: [{ __images: [{ mediaType: 'image/png', data: 'iVBORw0kggo', path: '.CodePapr/chat-images/1.png' }] }] },
    };
    const out = redactImagePayloadsForTranscript(input) as typeof input & {
      nested: { deep: Array<{ __images: Array<{ data: string; path?: string }> }> };
    };
    expect(out.path).toBe('assets/a.png');
    const img = out.nested.deep[0]!.__images[0]!;
    expect(img.data).toBe('');
    expect(img.path).toBe('.CodePapr/chat-images/1.png');
    expect((img as Record<string, unknown>).mediaType).toBe('image/png');
  });

  it('非 __images 字段原样；无 data 键的图片条目不动', () => {
    expect(redactImagePayloadsForTranscript('plain')).toBe('plain');
    const out = redactImagePayloadsForTranscript({
      __images: [{ mediaType: 'image/png' }, null, 'weird'],
    }) as { __images: unknown[] };
    expect(out.__images).toEqual([{ mediaType: 'image/png' }, null, 'weird']);
  });

  it('字符串 output：含 base64 才重写，纯文本/非 JSON/不含图片原样返回', () => {
    const big = JSON.stringify({ ok: true, __images: [{ mediaType: 'image/png', data: 'A'.repeat(5000) }] });
    expect(redactTranscriptOutputString(big)).toContain('"data":""');
    expect(redactTranscriptOutputString('plain text')).toBe('plain text');
    expect(redactTranscriptOutputString('{"note":"no images"}')).toBe('{"note":"no images"}');
    expect(redactTranscriptOutputString('{"broken": ')).toBe('{"broken": ');
    // 字符串里偶然出现标记但整体非 JSON 对象：不炸
    expect(redactTranscriptOutputString('"__images"')).toBe('"__images"');
  });
});
