import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../store/internals/defaults';
import type { CompactionSettings } from '../store/internals/types';

vi.mock('@codepapr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codepapr/core')>();
  return {
    ...actual,
    resolveSubagentExecution: vi.fn(),
    runSubagentSession: vi.fn(),
  };
});

vi.mock('../store/internals/providerFactory', () => ({
  buildProviderInstance: vi.fn(() => ({ fake: 'provider' })),
  buildFastProviderInstance: vi.fn(() => ({ fake: 'fast-provider' })),
}));

vi.mock('../store/internals/settingsNormalizer', () => ({
  resolveProviderName: vi.fn(() => 'deepseek'),
}));

import {
  resolveSubagentExecution,
  runSubagentSession,
  type ResolvedSubagentExecution,
} from '@codepapr/core';
import { buildFastProviderInstance, buildProviderInstance } from '../store/internals/providerFactory';
import { resolveProviderName } from '../store/internals/settingsNormalizer';
import {
  resolveEffectiveCompactorTier,
  buildCompactorDefinition,
  runCompactorSession,
} from './compactorRunner';

function makeSettings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
  return { ...DEFAULT_SETTINGS, ...overrides } as unknown as CompactionSettings;
}

function makeExec(tier: 'fast' | 'primary' = 'fast'): ResolvedSubagentExecution {
  return {
    route: {
      tier,
      model: tier === 'fast' ? 'fast-model' : 'primary-model',
      temperature: 0.3,
      reason: tier === 'fast' ? 'fast-subtask' : 'default',
    },
    parameters: { temperature: 0.3, topP: 0.9, maxTokens: 2000, thinkingEnabled: false },
    maxToolRounds: 50,
    mentor: null,
    usingMentor: false,
    tier,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSubagentExecution).mockReturnValue(makeExec('fast'));
  vi.mocked(runSubagentSession).mockResolvedValue({
    content: '{"userGoal":["x"],"pendingWork":[]}',
    steps: [],
    toolInvocations: [],
    cacheStats: undefined,
    tier: 'fast',
  });
});

describe('resolveEffectiveCompactorTier', () => {
  it('fast 档且 fastModel 已启用 → fast', () => {
    expect(
      resolveEffectiveCompactorTier(
        makeSettings({ compactionModel: 'fast', fastModelEnabled: true, fastModel: 'f' })
      )
    ).toBe('fast');
  });

  it('fast 档但 fastModel 未启用 → 静默降级 primary', () => {
    expect(
      resolveEffectiveCompactorTier(
        makeSettings({ compactionModel: 'fast', fastModelEnabled: false, fastModel: '' })
      )
    ).toBe('primary');
  });

  it('primary 档保持不变', () => {
    expect(resolveEffectiveCompactorTier(makeSettings({ compactionModel: 'primary' }))).toBe('primary');
  });
});

describe('buildCompactorDefinition', () => {
  const base = { lang: 'zh-CN' as const, baseModel: 'primary-model' };

  it('fast 档使用 fast 模型标记（已启用时）', () => {
    const def = buildCompactorDefinition({
      settings: makeSettings({ compactionModel: 'fast', fastModelEnabled: true, fastModel: 'fast-model' }),
      ...base,
    });
    expect(def.model).toBe('fast');
  });

  it('fast 档但 fastModel 未启用时降为 primary 模型字符串', () => {
    const def = buildCompactorDefinition({
      settings: makeSettings({ compactionModel: 'fast', fastModelEnabled: false }),
      ...base,
    });
    expect(def.model).toBe('primary-model');
  });

  it('primary 档使用主模型字符串', () => {
    const def = buildCompactorDefinition({
      settings: makeSettings({ compactionModel: 'primary' }),
      ...base,
    });
    expect(def.model).toBe('primary-model');
  });

  it('温度取 compactionTemperature，thinking 关闭', () => {
    const def = buildCompactorDefinition({
      settings: makeSettings({ compactionTemperature: 0.2 }),
      ...base,
    });
    expect(def.temperature).toBe(0.2);
  });

  it('始终是 internal 零工具代理：不暴露给主 Agent，tools 为空', () => {
    const def = buildCompactorDefinition({ settings: makeSettings(), ...base });
    expect(def.internal).toBe(true);
    expect(def.mode).toBe('subagent');
    expect(def.tools).toEqual({});
  });

  it('prompt 为空占位：v3 状态合并提示词由 contextCheckpoint 运行时覆盖', () => {
    const def = buildCompactorDefinition({ settings: makeSettings(), ...base });
    expect(def.prompt).toBe('');
  });
});

describe('runCompactorSession', () => {
  const settings = makeSettings({
    compactionModel: 'fast',
    fastModelEnabled: true,
    fastModel: 'fast-model',
    compactionMaxTokens: 2000,
    compactionTemperature: 0.3,
  });
  const definition = buildCompactorDefinition({
    settings,
    lang: 'zh-CN',
    baseModel: 'primary-model',
  });

  it('走 core 单一逻辑源：空工具列表 + 零工具注册表', async () => {
    await runCompactorSession({ definition, prompt: '压缩这段对话', settings, baseModel: 'primary-model', lang: 'zh-CN' });
    const deps = vi.mocked(runSubagentSession).mock.calls[0]![0];
    expect(deps.tools).toEqual([]);
    expect(deps.definition.name).toBe('compactor');
    expect(deps.prompt).toBe('压缩这段对话');
    expect(deps.lang).toBe('zh-CN');
  });

  it('maxTokens 取 compactionMaxTokens，thinking 关闭', async () => {
    await runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' });
    const input = vi.mocked(resolveSubagentExecution).mock.calls[0]![0];
    expect(input.defaultMaxTokens).toBe(2000);
    expect(input.thinkingFallback).toBe(false);
  });

  it('不传 maxWallClockMs：保持默认 20 分钟墙钟预算', async () => {
    await runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' });
    const deps = vi.mocked(runSubagentSession).mock.calls[0]![0];
    expect(deps).not.toHaveProperty('maxWallClockMs');
  });

  it('不注入 skills/memory/projectGraph bootstrap 节', async () => {
    await runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' });
    const deps = vi.mocked(runSubagentSession).mock.calls[0]![0];
    expect(deps.skillsSection).toBeUndefined();
    expect(deps.memorySection).toBeUndefined();
    expect(deps.projectGraphSummary).toBeUndefined();
  });

  it('abortSignal 透传给子代理会话', async () => {
    const controller = new AbortController();
    await runCompactorSession({
      definition,
      prompt: 'p',
      settings,
      baseModel: 'primary-model',
      lang: 'zh-CN',
      abortSignal: controller.signal,
    });
    const deps = vi.mocked(runSubagentSession).mock.calls[0]![0];
    expect(deps.abortSignal).toBe(controller.signal);
  });

  it('AbortError 原样上抛（全仓取消约定）', async () => {
    vi.mocked(runSubagentSession).mockRejectedValue(new DOMException('已取消', 'AbortError'));
    await expect(
      runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' })
    ).rejects.toThrow(DOMException);
    await expect(
      runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('返回子代理会话结果（content/cacheStats/tier 透传）', async () => {
    vi.mocked(runSubagentSession).mockResolvedValue({
      content: '{"userGoal":["a"]}',
      steps: [],
      toolInvocations: [],
      cacheStats: { promptCacheHitTokens: 10, promptCacheMissTokens: 5, completionTokens: 3 } as never,
      tier: 'fast',
    });
    const result = await runCompactorSession({
      definition,
      prompt: 'p',
      settings,
      baseModel: 'primary-model',
      lang: 'zh-CN',
    });
    expect(result.content).toBe('{"userGoal":["a"]}');
    expect(result.tier).toBe('fast');
    expect(result.cacheStats).toBeDefined();
  });

  it('fast 档：provider 取 fast profile 凭据，providerName 按 fast 档解析', async () => {
    await runCompactorSession({ definition, prompt: 'p', settings, baseModel: 'primary-model', lang: 'zh-CN' });
    expect(buildFastProviderInstance).toHaveBeenCalledWith(settings);
    expect(buildProviderInstance).not.toHaveBeenCalled();
    expect(resolveProviderName).toHaveBeenCalledWith({
      apiMode: settings.fastApiMode,
      apiFormat: settings.fastApiFormat,
    });
  });

  it('primary 档：provider 用主档凭据', async () => {
    const primarySettings = makeSettings({
      compactionModel: 'primary',
      fastModelEnabled: true,
      fastModel: 'fast-model',
    });
    const primaryDefinition = buildCompactorDefinition({
      settings: primarySettings,
      lang: 'zh-CN',
      baseModel: 'primary-model',
    });
    await runCompactorSession({
      definition: primaryDefinition,
      prompt: 'p',
      settings: primarySettings,
      baseModel: 'primary-model',
      lang: 'zh-CN',
    });
    expect(buildProviderInstance).toHaveBeenCalledWith(primarySettings);
    expect(buildFastProviderInstance).not.toHaveBeenCalled();
  });
});
