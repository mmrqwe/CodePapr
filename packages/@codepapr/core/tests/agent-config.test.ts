import { describe, expect, it } from 'vitest';
import {
  parseAgentMarkdown,
  filterToolsForAgent,
  filterToolsForMode,
  buildTaskToolDefinition,
  BUILTIN_AGENTS,
  VERIFIER_PROMPT_OBJECTIVE,
  VERIFIER_PROMPT_SUBJECTIVE,
  type AgentDefinition,
} from '../src/agent/agentConfig';
import type { IToolDefinition } from '@codepapr/types';

const tool = (name: string): IToolDefinition => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
});

describe('agentConfig - parseAgentMarkdown', () => {
  it('解析 frontmatter 字段与正文提示词', () => {
    const raw = [
      '---',
      'description: 只读探索代理',
      'mode: subagent',
      'model: deepseek-v4-pro',
      'temperature: 0.2',
      'tools:',
      '  read: true',
      '  write: false',
      '  graph: true',
      '---',
      '你是只读探索子代理，只能读文件。',
    ].join('\n');

    const def = parseAgentMarkdown('explore', raw);
    expect(def.name).toBe('explore');
    expect(def.description).toBe('只读探索代理');
    expect(def.mode).toBe('subagent');
    expect(def.model).toBe('deepseek-v4-pro');
    expect(def.temperature).toBe(0.2);
    expect(def.tools).toEqual({ read: true, write: false, graph: true });
    expect(def.prompt).toBe('你是只读探索子代理，只能读文件。');
  });

  it('无 frontmatter 时全文作为提示词并使用默认值', () => {
    const def = parseAgentMarkdown('helper', '直接执行任务');
    expect(def.mode).toBe('subagent');
    expect(def.description).toContain('helper');
    expect(def.prompt).toBe('直接执行任务');
    expect(def.tools).toBeUndefined();
  });

  it('空名称抛出异常', () => {
    expect(() => parseAgentMarkdown('  ', 'x')).toThrow();
  });

  it('空 tools 块表示显式禁用所有工具', () => {
    const raw = [
      '---',
      'description: 无工具代理',
      'tools:',
      '---',
      '纯文本回答。',
    ].join('\n');
    const def = parseAgentMarkdown('notools', raw);
    expect(def.tools).toEqual({});
  });
});

describe('agentConfig - filterToolsForAgent', () => {
  const all = [tool('read'), tool('write'), tool('graph'), tool('task')];

  it('未声明 tools 时返回全部工具', () => {
    expect(filterToolsForAgent(all, undefined).map((t) => t.name)).toEqual([
      'read',
      'write',
      'graph',
      'task',
    ]);
  });

  it('声明 tools 时白名单过滤', () => {
    const filtered = filterToolsForAgent(all, {
      read: true,
      write: false,
      graph: true,
    });
    expect(filtered.map((t) => t.name)).toEqual(['read', 'graph']);
  });

  it('空对象 {} 返回空列表', () => {
    expect(filterToolsForAgent(all, {})).toEqual([]);
  });
});

describe('agentConfig - filterToolsForMode', () => {
  const all = [
    tool('read'),
    tool('write'),
    tool('edit'),
    tool('bash'),
    tool('git'),
    tool('app_render'),
    tool('app_list'),
    tool('app_start'),
    tool('app_stop'),
    tool('app_delete'),
    tool('question'),
    tool('task'),
  ];

  it('ask 模式：移除变更类工具和 app 工具和 question，保留只读工具 + task', () => {
    expect(filterToolsForMode(all, 'ask').map((t) => t.name)).toEqual(['read', 'task']);
  });

  it('plan 模式：有变更工具 + question，无 app 工具', () => {
    const names = filterToolsForMode(all, 'plan').map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('git');
    expect(names).toContain('question');
    expect(names).toContain('task');
    expect(names).not.toContain('app_render');
    expect(names).not.toContain('app_list');
  });

  it('agent 模式：有变更工具 + task，无 app 工具和 question', () => {
    const names = filterToolsForMode(all, 'agent').map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('git');
    expect(names).toContain('task');
    expect(names).not.toContain('app_render');
    expect(names).not.toContain('question');
  });

  it('app 模式：有变更工具 + app 工具 + task，无 question', () => {
    const names = filterToolsForMode(all, 'app').map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('app_render');
    expect(names).toContain('app_list');
    expect(names).toContain('task');
    expect(names).not.toContain('question');
  });
});

describe('agentConfig - buildTaskToolDefinition mode 过滤', () => {
  const agent = (name: string, mode: AgentDefinition['mode'], internal = false): AgentDefinition => ({
    name,
    description: name,
    mode,
    prompt: name,
    internal,
  });

  it('排除 mode: primary 的 agent', () => {
    const def = buildTaskToolDefinition([agent('mainish', 'primary'), agent('helper', 'subagent')], 'en');
    expect(def).not.toBeNull();
    expect(def!.description).toContain('helper');
    expect(def!.description).not.toContain('mainish');
  });

  it('保留 subagent 与 all 模式', () => {
    const def = buildTaskToolDefinition([agent('a', 'subagent'), agent('b', 'all')], 'en');
    expect(def!.description).toContain('a');
    expect(def!.description).toContain('b');
  });

  it('仅剩 primary 时返回 null', () => {
    expect(buildTaskToolDefinition([agent('mainish', 'primary')], 'en')).toBeNull();
  });

  it('排除 internal agent', () => {
    expect(buildTaskToolDefinition([agent('v', 'subagent', true)], 'en')).toBeNull();
  });
});

describe('agentConfig - BUILTIN_AGENTS', () => {
  it('explore 拥有只读工具集', () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === 'explore')!;
    expect(explore).toBeDefined();
    expect(explore.tools).toEqual({
      read: true,
      read_image: true,
      list: true,
      graph: true,
      glob: true,
      lsp: true,
      diagnostics: true,
      grep: true,
    });
  });

  it('scout 拥有 web 工具集', () => {
    const scout = BUILTIN_AGENTS.find((a) => a.name === 'scout')!;
    expect(scout).toBeDefined();
    expect(scout.tools).toEqual({
      websearch: true,
      webfetch: true,
      browser: true,
      read_image: true,
    });
  });

  it('mentor 无工具', () => {
    const mentor = BUILTIN_AGENTS.find((a) => a.name === 'mentor')!;
    expect(mentor).toBeDefined();
    expect(mentor.tools).toEqual({});
  });

  it('verifier 是只读内部代理（不暴露给 task 工具）', () => {
    const verifier = BUILTIN_AGENTS.find((a) => a.name === 'verifier')!;
    expect(verifier).toBeDefined();
    expect(verifier.internal).toBe(true);
    expect(verifier.mode).toBe('subagent');
    expect(verifier.tools).toEqual({
      read: true,
      grep: true,
      glob: true,
      list: true,
    });
    // internal 代理不出现在主 Agent 的 task 工具可见列表
    const visible = buildTaskToolDefinition([verifier], 'zh-CN');
    expect(visible).toBeNull();
  });

  it('verifier 提示词包含客观与主观两套三语 Record', () => {
    expect(typeof VERIFIER_PROMPT_OBJECTIVE['zh-CN']).toBe('string');
    expect(typeof VERIFIER_PROMPT_OBJECTIVE['zh-TW']).toBe('string');
    expect(typeof VERIFIER_PROMPT_OBJECTIVE.en).toBe('string');
    expect(typeof VERIFIER_PROMPT_SUBJECTIVE['zh-CN']).toBe('string');
    expect(typeof VERIFIER_PROMPT_SUBJECTIVE['zh-TW']).toBe('string');
    expect(typeof VERIFIER_PROMPT_SUBJECTIVE.en).toBe('string');
    expect(VERIFIER_PROMPT_OBJECTIVE['zh-CN']).toContain('SATISFIED');
    expect(VERIFIER_PROMPT_SUBJECTIVE.en).toContain('Scoring Rubric');
  });
});
