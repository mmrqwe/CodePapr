import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IImageContent } from '@codepapr/types';
import type { ModelProfile, Settings } from '../store/internals/types';
import { formatVisionOffloadBlock, replaceImagesInToolResult } from './visionOffload';

const chatMock = vi.fn();

vi.mock('../store/internals/providerFactory', () => ({
  buildProviderForProfile: () => ({ chat: chatMock }),
  buildProviderInstance: () => ({ chat: chatMock }),
}));

function profile(overrides: Partial<ModelProfile> & Pick<ModelProfile, 'id' | 'model'>): ModelProfile {
  return {
    name: overrides.id,
    apiMode: 'custom',
    apiFormat: 'openai',
    baseURL: 'https://example.invalid',
    apiKey: 'sk-test',
    maxTokens: 8000,
    multimodalEnabled: false,
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    lang: 'zh-CN',
    model: 'primary-model',
    fastModel: 'fast-model',
    fastModelEnabled: true,
    mentorEnabled: false,
    mentorModel: '',
    mentorProfileId: '',
    multimodalEnabled: false,
    multimodalModelTier: 'all',
    streamIdleTimeoutMs: 30000,
    modelProfiles: [
      profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false }),
      profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: true }),
    ],
    primaryProfileId: 'p-primary',
    fastProfileId: 'p-fast',
    ...overrides,
  } as Settings;
}

const sampleImage: IImageContent = { mediaType: 'image/png', data: 'abc' };

describe('replaceImagesInToolResult', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });
  it('keeps __images when the current model can see', async () => {
    const result = { path: 'a.png', __images: [sampleImage] };
    const next = await replaceImagesInToolResult(
      result,
      settings({
        modelProfiles: [
          profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: true }),
          profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: true }),
        ],
      }),
      'primary-model',
    );
    expect(next).toEqual(result);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('replaces __images with a fast-model description when offloading', async () => {
    chatMock.mockResolvedValueOnce({
      choices: [{ message: { content: '  a red login form  ' } }],
    });
    const next = await replaceImagesInToolResult(
      { path: 'shot.png', bytes: 12, __images: [sampleImage] },
      settings(),
      'primary-model',
    );
    expect(next).toMatchObject({
      path: 'shot.png',
      bytes: 12,
      describedByFastModel: true,
      description: 'a red login form',
    });
    expect(next).not.toHaveProperty('__images');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('drops __images without calling fast when fast vision is unavailable', async () => {
    const next = await replaceImagesInToolResult(
      { path: 'shot.png', __images: [sampleImage] },
      settings({
        modelProfiles: [
          profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false }),
          profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: false }),
        ],
      }),
      'primary-model',
    );
    expect(next).not.toHaveProperty('__images');
    expect((next as { description: string }).description).toContain('未启用');
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('formatVisionOffloadBlock', () => {
  it('wraps the description with a stable header', () => {
    expect(formatVisionOffloadBlock('zh-CN', '按钮是红色的')).toContain('【快速模型识图结果】');
    expect(formatVisionOffloadBlock('en', 'red button')).toContain('[Fast-model vision description]');
  });
});
