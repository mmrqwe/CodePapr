import { describe, it, expect } from 'vitest';
import {
  resolveVerifierTier,
  resolveEffectiveVerifierTier,
  buildVerifierDefinition,
  buildVerifierUserPrompt,
  parseVerifierResponse,
  VERIFIER_MAX_TOOL_ROUNDS,
} from './verifierRunner';
import { DEFAULT_SETTINGS } from '../store/internals/defaults';
import type { Settings } from '../store/agentStore';
import type { ConditionResult } from '@codepapr/types';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides } as Settings;
}

const CONDITION_PASS: ConditionResult = {
  met: true,
  evidence: '子句 1 ✓ 通过\n命令: npm test\n退出码: 0',
  details: [],
};

describe('resolveVerifierTier', () => {
  it('主观目标在 fast 档自动升级为 mentor（已配置）', () => {
    expect(resolveVerifierTier('fast', true, true)).toBe('mentor');
  });

  it('主观目标升级 mentor 但未配置时静默降级 primary', () => {
    expect(resolveVerifierTier('fast', true, false)).toBe('primary');
  });

  it('客观目标保持 fast 档', () => {
    expect(resolveVerifierTier('fast', false, true)).toBe('fast');
  });

  it('显式选择 primary 时主观目标不升级', () => {
    expect(resolveVerifierTier('primary', true, true)).toBe('primary');
  });

  it('显式选择 mentor 且已配置时对客观目标也生效', () => {
    expect(resolveVerifierTier('mentor', false, true)).toBe('mentor');
  });

  it('显式选择 mentor 但未配置时静默降级 primary', () => {
    expect(resolveVerifierTier('mentor', false, false)).toBe('primary');
  });
});

describe('resolveEffectiveVerifierTier', () => {
  it('依据 settings 判定 mentor 是否已配置', () => {
    expect(resolveEffectiveVerifierTier(makeSettings({ mentorEnabled: false }), true)).toBe('primary');
    expect(resolveEffectiveVerifierTier(makeSettings({ mentorEnabled: true, mentorModel: 'gpt-4o' }), true)).toBe('mentor');
  });
});

describe('buildVerifierDefinition', () => {
  const base = { isSubjective: false, lang: 'zh-CN' as const, baseModel: 'primary-model' };

  it('fast 档使用 fast 模型（已启用时）', () => {
    const def = buildVerifierDefinition({
      settings: makeSettings({
        verifierModelTier: 'fast',
        fastModelEnabled: true,
        fastModel: 'fast-model',
      }),
      ...base,
    });
    expect(def.model).toBe('fast');
    expect(def.temperature).toBe(DEFAULT_SETTINGS.verifierTemperature);
  });

  it('fast 档但 fastModel 未启用时降为 primary 模型字符串', () => {
    const def = buildVerifierDefinition({
      settings: makeSettings({ verifierModelTier: 'fast', fastModelEnabled: false }),
      ...base,
    });
    expect(def.model).toBe('primary-model');
  });

  it('primary 档强制使用主模型字符串', () => {
    const def = buildVerifierDefinition({
      settings: makeSettings({ verifierModelTier: 'primary' }),
      ...base,
    });
    expect(def.model).toBe('primary-model');
  });

  it('mentor 档使用 mentor 模型标记', () => {
    const def = buildVerifierDefinition({
      settings: makeSettings({ verifierModelTier: 'mentor', mentorEnabled: true, mentorModel: 'gpt-4o' }),
      ...base,
    });
    expect(def.model).toBe('mentor');
  });

  it('始终是 internal 只读代理：不暴露给主 Agent，仅 read/grep/glob/list', () => {
    const def = buildVerifierDefinition({ settings: makeSettings(), ...base });
    expect(def.internal).toBe(true);
    expect(def.tools).toEqual({ read: true, grep: true, glob: true, list: true });
  });

  it('主观目标使用主观评分提示词，客观目标使用条件判定提示词', () => {
    const subj = buildVerifierDefinition({
      settings: makeSettings(),
      isSubjective: true,
      lang: 'en',
      baseModel: 'm',
    });
    const obj = buildVerifierDefinition({
      settings: makeSettings(),
      isSubjective: false,
      lang: 'en',
      baseModel: 'm',
    });
    expect((subj.prompt as Record<string, string>).en).toContain('Scoring Rubric');
    expect((obj.prompt as Record<string, string>).en).toContain('Judgment Rules');
  });
});

describe('buildVerifierUserPrompt', () => {
  const base = {
    transcript: '[Tool Calls] edit(file.ts)',
    workerContent: '已修复，测试通过。',
    conditionResult: CONDITION_PASS,
    goalText: '修复 auth 测试',
    isSubjective: false,
    strictness: 'normal' as const,
    lang: 'zh-CN' as const,
    iteration: 2,
    maxIterations: 20,
  };

  it('包含目标、transcript、Worker 自述与客观条件结果', () => {
    const prompt = buildVerifierUserPrompt(base);
    expect(prompt).toContain('修复 auth 测试');
    expect(prompt).toContain('[Tool Calls] edit(file.ts)');
    expect(prompt).toContain('已修复，测试通过。');
    expect(prompt).toContain('true');
    expect(prompt).toContain('第 2 轮');
  });

  it('Worker 自述为空时给出占位说明', () => {
    const prompt = buildVerifierUserPrompt({ ...base, workerContent: '  ' });
    expect(prompt).toContain('无文字回复');
  });

  it('主观模式不包含客观条件结果段，但包含评分阈值说明', () => {
    const prompt = buildVerifierUserPrompt({ ...base, isSubjective: true });
    expect(prompt).not.toContain('客观条件结果');
    expect(prompt).toContain('总分 ≥ 3 分');
    expect(prompt).toContain('progress ≥ 0.9');
  });

  it('客观模式包含严格度说明', () => {
    const prompt = buildVerifierUserPrompt({ ...base, strictness: 'strict' });
    expect(prompt).toContain('严格模式');
  });
});

describe('parseVerifierResponse', () => {
  it('解析裸 JSON', () => {
    const v = parseVerifierResponse('{"verdict":"SATISFIED","evidence":"done","progress":1.0}');
    expect(v.verdict).toBe('SATISFIED');
    expect(v.progress).toBe(1.0);
  });

  it('解析 markdown 代码块包裹的 JSON', () => {
    const v = parseVerifierResponse('```json\n{"verdict":"NOT_MET","evidence":"x","progress":0.3,"failureMode":"partial_fix"}\n```');
    expect(v.verdict).toBe('NOT_MET');
    expect(v.progress).toBe(0.3);
    expect(v.failureMode).toBe('partial_fix');
  });

  it('无法解析时从文本推断（否定优先）', () => {
    expect(parseVerifierResponse('The goal is NOT_MET because tests fail').verdict).toBe('NOT_MET');
    expect(parseVerifierResponse('Verdict: SATISFIED').verdict).toBe('SATISFIED');
  });

  it('完全无法解析时默认 NOT_MET', () => {
    expect(parseVerifierResponse('???').verdict).toBe('NOT_MET');
  });
});

describe('VERIFIER_MAX_TOOL_ROUNDS', () => {
  it('工具轮数上限为 6（只做抽查，不做全量审计）', () => {
    expect(VERIFIER_MAX_TOOL_ROUNDS).toBe(6);
  });
});
