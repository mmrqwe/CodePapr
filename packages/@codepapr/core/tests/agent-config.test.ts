import { describe, expect, it } from 'vitest';
import {
  parseAgentMarkdown,
  filterToolsForAgent,
  BUILTIN_AGENTS,
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

describe('agentConfig - BUILTIN_AGENTS', () => {
  it('explore 拥有只读工具集', () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === 'explore')!;
    expect(explore).toBeDefined();
    expect(explore.tools).toEqual({
      read: true,
      graph: true,
      lsp: true,
      diagnostics: true,
      grep: true,
    });
  });

  it('scout 拥有 web 工具集', () => {
    const scout = BUILTIN_AGENTS.find((a) => a.name === 'scout')!;
    expect(scout).toBeDefined();
    expect(scout.tools).toEqual({
      web_search: true,
      web_fetch: true,
      web_download: true,
      browser: true,
    });
  });

  it('mentor 无工具', () => {
    const mentor = BUILTIN_AGENTS.find((a) => a.name === 'mentor')!;
    expect(mentor).toBeDefined();
    expect(mentor.tools).toEqual({});
  });
});
