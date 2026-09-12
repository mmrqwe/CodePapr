import { describe, expect, it } from 'vitest';
import { resolveSubagentExecution } from '../src/agent/subagentConfig';
import { FilteringToolRegistry } from '../src/tool/ToolRegistry';
import type { AgentDefinition, SubagentExecutionInput } from '../src/agent/agentConfig';
import type { IToolDefinition } from '@codepapr/types';

const tool = (name: string): IToolDefinition => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
});

function makeInput(overrides: Partial<SubagentExecutionInput> = {}): SubagentExecutionInput {
  return {
    definition: { name: 'custom', description: 'custom', mode: 'subagent', prompt: 'p' },
    currentDepth: 0,
    taskPrompt: 'do something',
    baseModel: 'base-model',
    fastModel: 'fast-model',
    fastModelEnabled: true,
    defaultMaxTokens: 200000,
    globalMaxToolRounds: 500,
    thinkingFallback: true,
    fallbackApiKey: 'main-key',
    fallbackBaseURL: 'https://main.example.com',
    ...overrides,
  };
}

describe('resolveSubagentExecution - 深度', () => {
  it('达到默认深度上限抛错', () => {
    expect(() => resolveSubagentExecution(makeInput({ currentDepth: 2 }))).toThrow(/深度/);
  });

  it('explore 使用 per-agent 深度上限', () => {
    const definition: AgentDefinition = { name: 'explore', description: 'e', mode: 'subagent', prompt: 'p' };
    expect(() =>
      resolveSubagentExecution(makeInput({ definition, currentDepth: 3, explore: { maxDepth: 3 } }))
    ).toThrow(/深度/);
    expect(() =>
      resolveSubagentExecution(makeInput({ definition, currentDepth: 2, explore: { maxDepth: 3 } }))
    ).not.toThrow();
  });
});

describe('resolveSubagentExecution - 模型路由', () => {
  it('model: fast 解析为 fastModel 且 tier 为 fast', () => {
    const definition: AgentDefinition = { name: 'x', description: 'x', mode: 'subagent', model: 'fast', prompt: 'p' };
    const exec = resolveSubagentExecution(makeInput({ definition }));
    expect(exec.route.model).toBe('fast-model');
    expect(exec.tier).toBe('fast');
    expect(exec.usingMentor).toBe(false);
  });

  it('mentor 已配置时使用 mentor provider 与 tier', () => {
    const definition: AgentDefinition = { name: 'mentor', description: 'm', mode: 'subagent', model: 'mentor', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({
        definition,
        mentor: {
          enabled: true,
          model: 'mentor-model',
          apiKey: 'mentor-key',
          baseURL: 'https://mentor.example.com/',
          apiFormat: 'claude',
          apiMode: 'custom',
          extraHeaders: { 'X-Tenant-Id': 'acme' },
          maxTokens: 10000,
          thinkingEnabled: true,
        },
      })
    );
    expect(exec.usingMentor).toBe(true);
    expect(exec.tier).toBe('mentor');
    expect(exec.mentor?.model).toBe('mentor-model');
    expect(exec.mentor?.apiKey).toBe('mentor-key');
    expect(exec.mentor?.baseURL).toBe('https://mentor.example.com');
    expect(exec.mentor?.apiFormat).toBe('claude');
    expect(exec.mentor?.apiMode).toBe('custom');
    expect(exec.mentor?.extraHeaders).toEqual({ 'X-Tenant-Id': 'acme' });
    expect(exec.parameters.maxTokens).toBe(10000);
    expect(exec.parameters.thinkingEnabled).toBe(true);
  });

  it('mentor apiMode 透传（deepseek 档不再被压成 apiFormat）', () => {
    const definition: AgentDefinition = { name: 'mentor', description: 'm', mode: 'subagent', model: 'mentor', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({
        definition,
        mentor: {
          enabled: true,
          model: 'deepseek-v4-pro',
          apiKey: 'sk-deepseek',
          baseURL: '',
          apiFormat: 'openai',
          apiMode: 'deepseek',
          maxTokens: 10000,
          thinkingEnabled: false,
        },
      })
    );
    expect(exec.mentor?.apiMode).toBe('deepseek');
    expect(exec.mentor?.apiFormat).toBe('openai');
  });

  it('mentor apiKey 为空时回退到主 apiKey', () => {
    const definition: AgentDefinition = { name: 'mentor', description: 'm', mode: 'subagent', model: 'mentor', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({
        definition,
        mentor: {
          enabled: true,
          model: 'mentor-model',
          apiKey: '',
          baseURL: '',
          apiFormat: 'openai',
          maxTokens: 10000,
          thinkingEnabled: false,
        },
      })
    );
    expect(exec.mentor?.apiKey).toBe('main-key');
    expect(exec.mentor?.baseURL).toBe('https://main.example.com');
    expect(exec.mentor?.apiMode).toBe('custom');
  });

  it('mentor 未配置 model 时回退到主模型', () => {
    const definition: AgentDefinition = { name: 'mentor', description: 'm', mode: 'subagent', model: 'mentor', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({
        definition,
        mentor: {
          enabled: true,
          model: '   ',
          apiKey: 'mentor-key',
          baseURL: '',
          apiFormat: 'openai',
          maxTokens: 10000,
          thinkingEnabled: false,
        },
      })
    );
    expect(exec.usingMentor).toBe(false);
    expect(exec.mentor).toBeNull();
    expect(exec.route.model).toBe('base-model');
    expect(exec.tier).toBe('primary');
  });
});

describe('resolveSubagentExecution - 温度', () => {
  it('自定义 agent 使用 definition.temperature（修复死代码）', () => {
    const definition: AgentDefinition = { name: 'custom', description: 'c', mode: 'subagent', temperature: 0.2, prompt: 'p' };
    const exec = resolveSubagentExecution(makeInput({ definition }));
    expect(exec.parameters.temperature).toBe(0.2);
  });

  it('无 definition.temperature 时使用路由默认 0.7', () => {
    const exec = resolveSubagentExecution(makeInput());
    expect(exec.parameters.temperature).toBe(0.7);
  });

  it('explore 默认温度 0.5 优先于路由温度', () => {
    const definition: AgentDefinition = { name: 'explore', description: 'e', mode: 'subagent', prompt: 'p' };
    const exec = resolveSubagentExecution(makeInput({ definition }));
    expect(exec.parameters.temperature).toBe(0.5);
  });
});

describe('resolveSubagentExecution - 工具轮数', () => {
  it('maxToolRounds 受全局上限封顶', () => {
    const exec = resolveSubagentExecution(makeInput({ globalMaxToolRounds: 30 }));
    expect(exec.maxToolRounds).toBe(30);
  });

  it('per-agent 轮数与全局取较小值', () => {
    const definition: AgentDefinition = { name: 'explore', description: 'e', mode: 'subagent', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({ definition, globalMaxToolRounds: 500, explore: { maxToolRounds: 20 } })
    );
    expect(exec.maxToolRounds).toBe(20);
  });
});

describe('resolveSubagentExecution - 思考强度继承', () => {
  it('explore/scout 继承主设置的 effort 与 budget', () => {
    const definition: AgentDefinition = { name: 'explore', description: 'e', mode: 'subagent', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({ definition, reasoningEffort: 'xhigh', thinkingBudgetTokens: 8000, thinkingPayload: 'both' })
    );
    expect(exec.parameters.reasoningEffort).toBe('xhigh');
    expect(exec.parameters.thinkingBudgetTokens).toBe(8000);
    expect(exec.parameters.thinkingPayload).toBe('both');
  });

  it('mentor 使用自己的强度设置（不继承主设置）', () => {
    const definition: AgentDefinition = { name: 'mentor', description: 'm', mode: 'subagent', model: 'mentor', prompt: 'p' };
    const exec = resolveSubagentExecution(
      makeInput({
        definition,
        reasoningEffort: 'max',
        thinkingBudgetTokens: 4096,
        mentor: {
          enabled: true,
          model: 'mentor-model',
          apiKey: 'k',
          baseURL: 'https://m.example.com',
          apiFormat: 'openai',
          maxTokens: 10000,
          thinkingEnabled: true,
          thinkingEffort: 'medium',
          thinkingBudgetTokens: 6000,
          thinkingPayload: 'both',
        },
      })
    );
    expect(exec.parameters.reasoningEffort).toBe('medium');
    expect(exec.parameters.thinkingBudgetTokens).toBe(6000);
    expect(exec.parameters.thinkingPayload).toBe('both');
  });

  it('强度为空时不注入参数（交给 API 默认）', () => {
    const exec = resolveSubagentExecution(makeInput({ reasoningEffort: '', thinkingBudgetTokens: 0 }));
    expect(exec.parameters.reasoningEffort).toBeUndefined();
    expect(exec.parameters.thinkingBudgetTokens).toBeUndefined();
  });
});

describe('FilteringToolRegistry', () => {
  it('按谓词跳过被禁工具（不注册 handler）', async () => {
    const registry = new FilteringToolRegistry((t) => t.name !== 'write');
    registry.register(tool('read'), () => 'read-ok');
    registry.register(tool('write'), () => 'write-ok');
    expect(registry.getAll().map((t) => t.name)).toEqual(['read']);
    expect(registry.has('write')).toBe(false);
    await expect(registry.execute('write', {})).rejects.toThrow();
    expect(await registry.execute('read', {})).toBe('read-ok');
  });
});
