import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runCachedModelRequest: vi.fn(),
  buildProviderInstance: vi.fn(),
  selectRoute: vi.fn(),
  resolveProviderName: vi.fn(),
}));

vi.mock('./cachedModelRequest', () => ({
  runCachedModelRequest: mocks.runCachedModelRequest,
}));
vi.mock('../store/internals/providerFactory', () => ({
  buildProviderInstance: mocks.buildProviderInstance,
}));
vi.mock('./modelRouting', () => ({
  selectContextCompactionModelRoute: mocks.selectRoute,
}));
vi.mock('../store/internals/settingsNormalizer', () => ({
  resolveProviderName: mocks.resolveProviderName,
}));

import {
  bootstrapMemoryContent,
  MEMORY_CONSOLIDATION_MAX_LINES,
  planMemoryConsolidation,
} from './memoryConsolidation';
import type { Settings } from '../store/internals/types';

const fakeSettings = {} as Settings;

function lines(n: number): string {
  return Array.from({ length: n }, () => 'x').join('\n');
}

describe('memoryConsolidation', () => {
  beforeEach(() => {
    mocks.runCachedModelRequest.mockReset();
    mocks.buildProviderInstance.mockReset();
    mocks.selectRoute.mockReset();
    mocks.resolveProviderName.mockReset();
  });

  describe('MEMORY_CONSOLIDATION_MAX_LINES', () => {
    it('is 200 (aligned with docs)', () => {
      expect(MEMORY_CONSOLIDATION_MAX_LINES).toBe(200);
    });
  });

  describe('planMemoryConsolidation', () => {
    it('returns false for empty/undefined content', () => {
      expect(planMemoryConsolidation(undefined)).toBe(false);
      expect(planMemoryConsolidation('')).toBe(false);
    });

    it('returns false when under the threshold', () => {
      expect(planMemoryConsolidation(lines(199))).toBe(false);
    });

    it('returns false at exactly the threshold (200 lines, not greater-than)', () => {
      expect(planMemoryConsolidation(lines(200))).toBe(false);
    });

    it('returns true when over the threshold (201 lines)', () => {
      expect(planMemoryConsolidation(lines(201))).toBe(true);
    });

    it('respects an explicit maxLines override', () => {
      expect(planMemoryConsolidation(lines(11), 10)).toBe(true);
      expect(planMemoryConsolidation(lines(10), 10)).toBe(false);
    });
  });

  describe('bootstrapMemoryContent', () => {
    it('returns null when all inputs are empty', async () => {
      const result = await bootstrapMemoryContent({}, fakeSettings);
      expect(result).toBeNull();
      expect(mocks.runCachedModelRequest).not.toHaveBeenCalled();
    });

    it('returns null when inputs are only whitespace', async () => {
      const result = await bootstrapMemoryContent(
        { projectGraphSummary: '   ', rulesSection: '', firstUserMessage: undefined },
        fakeSettings,
      );
      expect(result).toBeNull();
      expect(mocks.runCachedModelRequest).not.toHaveBeenCalled();
    });

    it('returns null when no model route is available', async () => {
      mocks.selectRoute.mockReturnValue(null);
      const result = await bootstrapMemoryContent(
        { projectGraphSummary: 'packages/*' },
        fakeSettings,
      );
      expect(result).toBeNull();
      expect(mocks.buildProviderInstance).not.toHaveBeenCalled();
    });

    it('returns null when no provider can be built', async () => {
      mocks.selectRoute.mockReturnValue({
        model: 'm', temperature: 0.1, maxTokens: 512, thinkingEnabled: false, modelTier: 'fast',
      });
      mocks.buildProviderInstance.mockReturnValue(null);
      const result = await bootstrapMemoryContent(
        { projectGraphSummary: 'packages/*' },
        fakeSettings,
      );
      expect(result).toBeNull();
      expect(mocks.runCachedModelRequest).not.toHaveBeenCalled();
    });

    it('wraps generated body with a dated 项目初始化记忆 heading', async () => {
      mocks.selectRoute.mockReturnValue({
        model: 'm', temperature: 0.1, maxTokens: 512, thinkingEnabled: false, modelTier: 'fast',
      });
      mocks.buildProviderInstance.mockReturnValue({ name: 'mock' });
      mocks.resolveProviderName.mockReturnValue('deepseek');
      mocks.runCachedModelRequest.mockResolvedValue({
        response: {
          choices: [
            { message: { role: 'assistant', content: '### 技术栈\n- TypeScript 5.9\n- Tauri 桌面框架\n- React + Zustand' }, finishReason: 'stop' },
          ],
        },
        cacheStats: null,
      });

      const result = await bootstrapMemoryContent(
        { projectGraphSummary: 'packages/@codepapr/*' },
        fakeSettings,
      );

      expect(result).not.toBeNull();
      expect(result).toMatch(/^## \d{4}-\d{2}-\d{2} 项目初始化记忆\n\n/);
      expect(result).toContain('### 技术栈');
      expect(mocks.runCachedModelRequest).toHaveBeenCalledTimes(1);
      const callArgs = mocks.runCachedModelRequest.mock.calls[0]?.[0] as {
        systemPrompt: string;
        userPrompt: string;
      };
      expect(callArgs.userPrompt).toContain('packages/@codepapr/*');
    });

    it('forwards rulesSection and firstUserMessage into the user prompt', async () => {
      mocks.selectRoute.mockReturnValue({
        model: 'm', temperature: 0.1, maxTokens: 512, thinkingEnabled: false, modelTier: 'fast',
      });
      mocks.buildProviderInstance.mockReturnValue({ name: 'mock' });
      mocks.resolveProviderName.mockReturnValue('deepseek');
      mocks.runCachedModelRequest.mockResolvedValue({
        response: {
          choices: [
            { message: { role: 'assistant', content: '### 构建\n- npm test' }, finishReason: 'stop' },
          ],
        },
        cacheStats: null,
      });

      await bootstrapMemoryContent(
        {
          projectGraphSummary: 'graph-summary',
          rulesSection: '## 项目规则\n- 先跑测试',
          firstUserMessage: '帮我修复 bug',
        },
        fakeSettings,
      );

      const callArgs = mocks.runCachedModelRequest.mock.calls[0]?.[0] as {
        userPrompt: string;
      };
      expect(callArgs.userPrompt).toContain('graph-summary');
      expect(callArgs.userPrompt).toContain('项目规则');
      expect(callArgs.userPrompt).toContain('帮我修复 bug');
    });

    it('returns null when the LLM returns empty content', async () => {
      mocks.selectRoute.mockReturnValue({
        model: 'm', temperature: 0.1, maxTokens: 512, thinkingEnabled: false, modelTier: 'fast',
      });
      mocks.buildProviderInstance.mockReturnValue({ name: 'mock' });
      mocks.resolveProviderName.mockReturnValue('deepseek');
      mocks.runCachedModelRequest.mockResolvedValue({
        response: {
          choices: [{ message: { role: 'assistant', content: '' }, finishReason: 'stop' }],
        },
        cacheStats: null,
      });

      const result = await bootstrapMemoryContent(
        { projectGraphSummary: 'some structure' },
        fakeSettings,
      );
      expect(result).toBeNull();
    });

    it('returns null when the LLM call throws', async () => {
      mocks.selectRoute.mockReturnValue({
        model: 'm', temperature: 0.1, maxTokens: 512, thinkingEnabled: false, modelTier: 'fast',
      });
      mocks.buildProviderInstance.mockReturnValue({ name: 'mock' });
      mocks.resolveProviderName.mockReturnValue('deepseek');
      mocks.runCachedModelRequest.mockRejectedValue(new Error('network down'));

      const result = await bootstrapMemoryContent(
        { projectGraphSummary: 'some structure' },
        fakeSettings,
      );
      expect(result).toBeNull();
    });
  });
});
