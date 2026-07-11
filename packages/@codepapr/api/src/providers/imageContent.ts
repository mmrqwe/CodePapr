/**
 * imageContent: 将 IMessage.images 映射为各 Provider 的多模态内容（纯逻辑）
 *
 * 抽出公共逻辑以便 OpenAI / Claude 复用并独立测试。
 */

import type { IImageContent } from '@codepapr/types';

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

/**
 * 构造 OpenAI 多模态 content 数组（文本 + image_url data URI）。
 * 当没有图片时返回 null，调用方应回退到纯字符串 content。
 */
export function buildOpenAIImageContent(
  text: string,
  images: IImageContent[] | undefined
): OpenAIContentPart[] | null {
  if (!images || images.length === 0) {
    return null;
  }

  const parts: OpenAIContentPart[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const image of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  return parts;
}

export interface ClaudeTextPart {
  type: 'text';
  text: string;
}

export interface ClaudeImagePart {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ClaudeContentPart = ClaudeTextPart | ClaudeImagePart;

/**
 * 构造 Claude 多模态 content 数组（文本 + base64 image）。
 * 当没有图片时返回 null，调用方应回退到原有内容映射。
 */
export function buildClaudeImageContent(
  text: string,
  images: IImageContent[] | undefined
): ClaudeContentPart[] | null {
  if (!images || images.length === 0) {
    return null;
  }

  const parts: ClaudeContentPart[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const image of images) {
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  return parts;
}
