import { describe, expect, it } from 'vitest';
import {
  buildOpenAIImageContent,
  buildClaudeImageContent,
} from '../src/providers/imageContent';

describe('imageContent - buildOpenAIImageContent', () => {
  it('无图片时返回 null', () => {
    expect(buildOpenAIImageContent('hi', undefined)).toBeNull();
    expect(buildOpenAIImageContent('hi', [])).toBeNull();
  });

  it('构造文本 + image_url data URI', () => {
    const parts = buildOpenAIImageContent('看这张图', [
      { mediaType: 'image/png', data: 'AAAA' },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('空文本时只含图片部分', () => {
    const parts = buildOpenAIImageContent('', [{ mediaType: 'image/jpeg', data: 'BBBB' }]);
    expect(parts).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
    ]);
  });
});

describe('imageContent - buildClaudeImageContent', () => {
  it('无图片时返回 null', () => {
    expect(buildClaudeImageContent('hi', undefined)).toBeNull();
  });

  it('构造文本 + base64 image source', () => {
    const parts = buildClaudeImageContent('描述', [
      { mediaType: 'image/webp', data: 'CCCC' },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: '描述' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } },
    ]);
  });
});
