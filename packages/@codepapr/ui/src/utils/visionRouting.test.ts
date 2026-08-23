import { describe, expect, it } from 'vitest';
import type { ModelProfile, Settings } from '../store/internals/types';
import {
  fastSlotSupportsVision,
  isKnownTextOnlyModel,
  modelSupportsVision,
  resolveVisionInputAction,
  shouldExposeReadImage,
  shouldOffloadVision,
} from './visionRouting';

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
  const primary = profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false });
  const fast = profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: true });
  return {
    model: 'primary-model',
    fastModel: 'fast-model',
    fastModelEnabled: true,
    mentorEnabled: false,
    mentorModel: '',
    mentorProfileId: '',
    multimodalEnabled: false,
    multimodalModelTier: 'all',
    modelProfiles: [primary, fast],
    primaryProfileId: 'p-primary',
    fastProfileId: 'p-fast',
    ...overrides,
  } as Settings;
}

describe('visionRouting', () => {
  it('offloads to fast when primary cannot see and fast multimodal is on', () => {
    const s = settings();
    expect(modelSupportsVision(s, 'primary-model')).toBe(false);
    expect(fastSlotSupportsVision(s)).toBe(true);
    expect(shouldOffloadVision(s, 'primary-model')).toBe(true);
    expect(shouldExposeReadImage(s, 'primary-model')).toBe(true);
    expect(resolveVisionInputAction(s, 'primary-model')).toBe('offload');
  });

  it('uses native vision when the primary slot can see', () => {
    const s = settings({
      modelProfiles: [
        profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: true }),
        profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: true }),
      ],
    });
    expect(resolveVisionInputAction(s, 'primary-model')).toBe('native');
    expect(shouldOffloadVision(s, 'primary-model')).toBe(false);
  });

  it('does not offload when fast multimodal is off', () => {
    const s = settings({
      modelProfiles: [
        profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false }),
        profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: false }),
      ],
    });
    expect(fastSlotSupportsVision(s)).toBe(false);
    expect(shouldOffloadVision(s, 'primary-model')).toBe(false);
    expect(shouldExposeReadImage(s, 'primary-model')).toBe(false);
    expect(resolveVisionInputAction(s, 'primary-model')).toBe('drop');
  });

  it('does not offload when the fast slot is disabled', () => {
    const s = settings({ fastModelEnabled: false });
    expect(fastSlotSupportsVision(s)).toBe(false);
    expect(shouldOffloadVision(s, 'primary-model')).toBe(false);
    expect(resolveVisionInputAction(s, 'primary-model')).toBe('drop');
  });

  it('does not treat the primary profile as a fast vision fallback', () => {
    const s = settings({
      fastProfileId: 'missing',
      modelProfiles: [
        profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: true }),
      ],
    });
    expect(fastSlotSupportsVision(s)).toBe(false);
  });

  it('lets a fast-routed turn see images only if fast multimodal is on', () => {
    const s = settings();
    expect(modelSupportsVision(s, 'fast-model')).toBe(true);
    expect(shouldOffloadVision(s, 'fast-model')).toBe(false);
    expect(resolveVisionInputAction(s, 'fast-model')).toBe('native');

    const noFastVision = settings({
      modelProfiles: [
        profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false }),
        profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: false }),
      ],
    });
    expect(modelSupportsVision(noFastVision, 'fast-model')).toBe(false);
    expect(shouldExposeReadImage(noFastVision, 'fast-model')).toBe(false);
    expect(resolveVisionInputAction(noFastVision, 'fast-model')).toBe('drop');
  });

  it('never uses mentor as a vision fallback', () => {
    const s = settings({
      mentorEnabled: true,
      mentorModel: 'mentor-model',
      mentorProfileId: 'p-mentor',
      modelProfiles: [
        profile({ id: 'p-primary', model: 'primary-model', multimodalEnabled: false }),
        profile({ id: 'p-fast', model: 'fast-model', multimodalEnabled: false }),
        profile({ id: 'p-mentor', model: 'mentor-model', multimodalEnabled: true }),
      ],
    });
    expect(shouldOffloadVision(s, 'primary-model')).toBe(false);
    expect(resolveVisionInputAction(s, 'primary-model')).toBe('drop');
  });

  it('honors legacy multimodalModelTier when no profiles exist', () => {
    const s = settings({
      modelProfiles: [],
      multimodalEnabled: true,
      multimodalModelTier: 'primary',
      fastModelEnabled: true,
      fastModel: 'fast-model',
    });
    expect(modelSupportsVision(s, 'primary-model')).toBe(true);
    expect(modelSupportsVision(s, 'fast-model')).toBe(false);
    expect(fastSlotSupportsVision(s)).toBe(false);
    expect(shouldExposeReadImage(s, 'fast-model')).toBe(false);
  });

  it('correctly identifies known text-only models and prevents raw vision payload', () => {
    expect(isKnownTextOnlyModel('deepseek-v4-pro')).toBe(true);
    expect(isKnownTextOnlyModel('deepseek-chat')).toBe(true);
    expect(isKnownTextOnlyModel('deepseek-reasoner')).toBe(true);
    expect(isKnownTextOnlyModel('o1-mini')).toBe(true);
    expect(isKnownTextOnlyModel('o3-mini')).toBe(true);
    expect(isKnownTextOnlyModel('gpt-3.5-turbo')).toBe(true);
    expect(isKnownTextOnlyModel('qwen-2.5-coder-32b')).toBe(true);
    expect(isKnownTextOnlyModel('qwen-2.5-vl-72b')).toBe(false);
    expect(isKnownTextOnlyModel('claude-3-7-sonnet')).toBe(false);
    expect(isKnownTextOnlyModel('gpt-4o')).toBe(false);

    const s = settings({
      model: 'deepseek-v4-pro',
      fastModel: 'claude-3-7-sonnet',
      modelProfiles: [
        profile({ id: 'p-primary', model: 'deepseek-v4-pro', multimodalEnabled: true }),
        profile({ id: 'p-fast', model: 'claude-3-7-sonnet', multimodalEnabled: true }),
      ],
    });
    // Even if multimodalEnabled was true in profile, DeepSeek is recognized as text-only
    expect(modelSupportsVision(s, 'deepseek-v4-pro')).toBe(false);
    // Fast vision is available via Claude
    expect(fastSlotSupportsVision(s)).toBe(true);
    // Should offload to fast model rather than sending raw image to DeepSeek
    expect(shouldOffloadVision(s, 'deepseek-v4-pro')).toBe(true);
    expect(resolveVisionInputAction(s, 'deepseek-v4-pro')).toBe('offload');
  });
});
