import { describe, expect, it, vi } from 'vitest';
import {
  parseAgentMarkdown,
  filterToolsForAgent,
  filterToolsForMode,
  filterToolsForProfile,
  MINIMAL_AGENT_TOOLS,
  applyMinimalToolProfile,
  allowToolForReadOnlyMode,
  readOnlyModeBlockMessage,
  buildTaskToolDefinition,
  BUILTIN_AGENTS,
  VERIFIER_PROMPT_OBJECTIVE,
  VERIFIER_PROMPT_SUBJECTIVE,
  type AgentDefinition,
} from '../src/agent/agentConfig';
import { ToolRegistry } from '../src/tool/ToolRegistry';
import { NEW_TOOL_DEFINITIONS } from '../src/tool/workspace/mergeToolDefs';
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

  it('有 frontmatter 但未声明 tools 时继承全部工具', () => {
    const raw = [
      '---',
      'description: 代码审查',
      'mode: subagent',
      '---',
      '你是 reviewer。',
    ].join('\n');
    const def = parseAgentMarkdown('reviewer', raw);
    expect(def.tools).toBeUndefined();
    expect(def.mode).toBe('subagent');
  });

  it('内联 tools: read, grep 解析为白名单', () => {
    const raw = [
      '---',
      'description: 搜索员',
      'tools: read, grep',
      '---',
      '只读搜索。',
    ].join('\n');
    const def = parseAgentMarkdown('searcher', raw);
    expect(def.tools).toEqual({ read: true, grep: true });
  });

  it('内联 tools: read grep 空格分隔同样解析为白名单', () => {
    const raw = [
      '---',
      'description: 搜索员',
      'tools: read grep glob',
      '---',
      '只读搜索。',
    ].join('\n');
    const def = parseAgentMarkdown('searcher', raw);
    expect(def.tools).toEqual({ read: true, grep: true, glob: true });
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
    tool('app_publish'),
    tool('question'),
    tool('task'),
  ];

  it('ask 模式：移除变更类工具、写类 app 工具与 question，保留只读工具 + task + 只读 git + 只读 app_list', () => {
    expect(filterToolsForMode(all, 'ask').map((t) => t.name)).toEqual([
      'read',
      'git',
      'app_list',
      'task',
    ]);
  });

  it('ask 模式：app_publish（写 app db）被屏蔽', () => {
    expect(filterToolsForMode(all, 'ask').map((t) => t.name)).not.toContain('app_publish');
  });

  it('app_publish 在所有可写模式可用（不限于 app 模式）', () => {
    for (const mode of ['agent', 'plan', 'app'] as const) {
      expect(filterToolsForMode(all, mode).map((t) => t.name)).toContain('app_publish');
    }
  });

  it('plan 模式：有变更工具 + question + 只读 app_list，无 app 渲染/生命周期工具', () => {
    const names = filterToolsForMode(all, 'plan').map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('git');
    expect(names).toContain('question');
    expect(names).toContain('task');
    expect(names).toContain('app_list');
    expect(names).not.toContain('app_render');
  });

  it('agent 模式：有变更工具 + task + 只读 app_list，无 app 渲染/生命周期工具和 question', () => {
    const names = filterToolsForMode(all, 'agent').map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('git');
    expect(names).toContain('task');
    expect(names).toContain('app_list');
    expect(names).not.toContain('app_render');
    expect(names).not.toContain('app_start');
    expect(names).not.toContain('question');
  });

  it('只读放行谓词：git 注册期可见，执行期仅 status/diff/log（T4）', () => {
    const gitTool = tool('git');
    expect(allowToolForReadOnlyMode(gitTool)).toBe(true);
    expect(allowToolForReadOnlyMode(gitTool, { action: 'status' })).toBe(true);
    expect(allowToolForReadOnlyMode(gitTool, { action: 'diff' })).toBe(true);
    expect(allowToolForReadOnlyMode(gitTool, { action: 'log' })).toBe(true);
    expect(allowToolForReadOnlyMode(gitTool, { action: 'commit' })).toBe(false);
    expect(allowToolForReadOnlyMode(gitTool, { action: 'reset' })).toBe(false);
    expect(allowToolForReadOnlyMode(gitTool, {})).toBe(false);
    expect(readOnlyModeBlockMessage(gitTool, { action: 'commit' })).toContain('git(action: commit)');
    expect(allowToolForReadOnlyMode(tool('write'))).toBe(false);
    expect(allowToolForReadOnlyMode(tool('read'))).toBe(true);
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

describe('agentConfig - filterToolsForProfile', () => {
  const registry = [
    tool('read'),
    tool('edit'),
    tool('write'),
    tool('grep'),
    tool('bash'),
    tool('websearch'),
    tool('webfetch'),
    tool('glob'),
    tool('list'),
    tool('patch'),
    tool('graph'),
    tool('lsp'),
    tool('lsp_edit'),
    tool('diagnostics'),
    tool('git'),
    tool('browser'),
    tool('skill'),
    tool('read_image'),
    tool('question'),
    tool('task'),
    tool('todo'),
    tool('memory_write'),
    tool('memory_search'),
    tool('memory_forget'),
    tool('memory_list'),
    tool('app_render'),
    tool('app_publish'),
    tool('app_list'),
    tool('mcp__search__web'),
  ];

  it('default / undefined：noop，与全量一致', () => {
    expect(filterToolsForProfile(registry, 'default')).toBe(registry);
    expect(filterToolsForProfile(registry, undefined)).toBe(registry);
  });

  it('minimal：仅 7 项 allowlist，无 memory/skill/git/lsp/app/mcp/todo/task', () => {
    expect(filterToolsForProfile(registry, 'minimal').map((t) => t.name)).toEqual([
      'read',
      'edit',
      'write',
      'grep',
      'bash',
      'websearch',
      'webfetch',
    ]);
  });

  it('mode ∩ profile：极简+Ask 无 write/edit/bash（mode 先砍），只剩读与网页', () => {
    const names = filterToolsForProfile(filterToolsForMode(registry, 'ask'), 'minimal').map((t) => t.name);
    expect(names).toEqual(['read', 'grep', 'websearch', 'webfetch']);
  });

  it('mode ∩ profile：极简+Plan 无 question（不在 allowlist）', () => {
    const names = filterToolsForProfile(filterToolsForMode(registry, 'plan'), 'minimal').map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).not.toContain('question');
  });

  it('mode ∩ profile：极简+App 无 app_* 工具（等同弱化 App）', () => {
    const names = filterToolsForProfile(filterToolsForMode(registry, 'app'), 'minimal').map((t) => t.name);
    expect(names).not.toContain('app_render');
    expect(names).not.toContain('app_publish');
    expect(names).not.toContain('app_list');
  });

  it('allowlist 与 core 注册表真实 name 一致（改名漏映射则此测试红；websearch 定义在 ui，由 parity 测试覆盖）', () => {
    const coreNames = new Set(NEW_TOOL_DEFINITIONS.map((t) => t.name));
    const uiOnlyNames: readonly string[] = ['websearch'];
    for (const name of MINIMAL_AGENT_TOOLS) {
      expect(coreNames.has(name) || uiOnlyNames.includes(name), `MINIMAL_AGENT_TOOLS 条目 "${name}" 不在注册表`).toBe(true);
    }
  });

  it('极简结果为空时告警（防改名后静默空集）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(filterToolsForProfile([tool('renamed_search'), tool('renamed_shell')], 'minimal')).toEqual([]);
      expect(warn).toHaveBeenCalled();
      // 入参本来就空：无需告警（无改名迹象）。
      warn.mockClear();
      expect(filterToolsForProfile([], 'minimal')).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('applyMinimalToolProfile：顶层非 allowlist 工具物理移除（定义+handler），内部隐藏工具保留', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('read'), async () => 'ok');
    registry.register(tool('edit'), async () => 'ok');
    registry.register(tool('write'), async () => 'ok');
    registry.register(tool('grep'), async () => 'ok');
    registry.register(tool('bash'), async () => 'ok');
    registry.register(tool('git'), async () => 'ok');
    registry.register(tool('task'), async () => 'ok');
    registry.register(tool('memory_write'), async () => 'ok');
    registry.register(tool('mcp__a__b'), async () => 'ok');
    registry.register(tool('workspace_edit_file'), async () => 'ok');
    registry.hideFromLlm('workspace_edit_file');
    registry.register(tool('graph'), async () => 'ok');
    registry.softHideFromLlm('graph');

    applyMinimalToolProfile(registry, 'default');
    expect(registry.getLlmTools().map((t) => t.name)).toContain('git');

    applyMinimalToolProfile(registry, 'minimal');
    expect(registry.getLlmTools().map((t) => t.name)).toEqual(['read', 'edit', 'write', 'grep', 'bash']);
    // 幻觉调用被裁掉的顶层工具：unknown tool（No handler）。
    await expect(registry.execute('git', { action: 'status' })).rejects.toThrow('No handler for tool: git');
    await expect(registry.execute('task', {})).rejects.toThrow('No handler for tool: task');
    // 内部（hideFromLlm）工具保留 handler——合并工具 dispatcher 依赖它。
    await expect(registry.execute('workspace_edit_file', {})).resolves.toBe('ok');
    // 软隐藏工具保留 handler、不进 LLM 集。
    expect(registry.getLlmTools().map((t) => t.name)).not.toContain('graph');
    await expect(registry.execute('graph', {})).resolves.toBe('ok');
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

  it('description 说明同一回合并行委派', () => {
    const def = buildTaskToolDefinition([agent('helper', 'subagent')], 'zh-CN');
    expect(def!.description).toContain('并行');
    const en = buildTaskToolDefinition([agent('helper', 'subagent')], 'en');
    expect(en!.description).toMatch(/parallel/i);
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

  it('compactor 是零工具内部代理（不暴露给 task 工具）', () => {
    const compactor = BUILTIN_AGENTS.find((a) => a.name === 'compactor')!;
    expect(compactor).toBeDefined();
    expect(compactor.internal).toBe(true);
    expect(compactor.mode).toBe('subagent');
    expect(compactor.tools).toEqual({});
    // internal 代理不出现在主 Agent 的 task 工具可见列表
    const visible = buildTaskToolDefinition([compactor], 'zh-CN');
    expect(visible).toBeNull();
  });

  it('compactor 内置定义不携带静态提示词（v3 状态合并提示词由压缩管线运行时注入）', () => {
    const compactor = BUILTIN_AGENTS.find((a) => a.name === 'compactor')!;
    expect(compactor.prompt).toBe('');
  });
});
