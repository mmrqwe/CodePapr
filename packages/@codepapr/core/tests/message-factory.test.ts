import { describe, expect, it } from 'vitest';
import { MessageFactory, stripInternalFields } from '../src';

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
