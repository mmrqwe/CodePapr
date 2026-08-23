import { describe, expect, it } from 'vitest';
import {
  buildProjectRulesSection,
  resolveProjectRulesSection,
  PROJECT_AGENTS_FILE,
  PROJECT_RULE_FILES,
  getDefaultAgentsTemplate,
  stripEmptyRulePlaceholders,
} from '../src/agent/projectRules';

describe('projectRules - buildProjectRulesSection', () => {
  it('多个非空规则文件按来源拼装为单个片段', () => {
    const section = buildProjectRulesSection([
      { path: '.CodePapr/AGENTS.md', content: '使用中文注释' },
      { path: 'CLAUDE.md', content: '禁止删除测试' },
    ]);
    expect(section).toContain('## 项目规则');
    expect(section).toContain('### 规则来源：.CodePapr/AGENTS.md');
    expect(section).toContain('使用中文注释');
    expect(section).toContain('### 规则来源：CLAUDE.md');
    expect(section).toContain('禁止删除测试');
  });

  it('跳过空白文件', () => {
    const section = buildProjectRulesSection([
      { path: '.CodePapr/AGENTS.md', content: '   \n  ' },
      { path: 'CLAUDE.md', content: '保持零警告' },
    ]);
    expect(section).not.toContain('AGENTS.md');
    expect(section).toContain('保持零警告');
  });

  it('全部为空时返回空字符串', () => {
    expect(buildProjectRulesSection([])).toBe('');
    expect(buildProjectRulesSection([{ path: '.CodePapr/AGENTS.md', content: '' }])).toBe('');
  });

  it('无规则文件时回退到默认约定；已有空白文件不回退', () => {
    const fallback = resolveProjectRulesSection([]);
    expect(fallback).toContain('### 规则来源：.CodePapr/AGENTS.md');
    expect(fallback).toContain('先读再改');
    expect(resolveProjectRulesSection([], 'en')).toContain('Read existing code first');
    expect(resolveProjectRulesSection([{ path: PROJECT_AGENTS_FILE, content: '  \n' }])).toBe('');
  });

  it('默认查找文件与模板可用', () => {
    expect(PROJECT_AGENTS_FILE).toBe('.CodePapr/AGENTS.md');
    expect(PROJECT_RULE_FILES).toEqual([PROJECT_AGENTS_FILE]);
    const cn = getDefaultAgentsTemplate();
    const en = getDefaultAgentsTemplate('en');
    const tw = getDefaultAgentsTemplate('zh-TW');
    expect(cn).toContain('先读再改');
    expect(cn).toContain('验证');
    expect(cn).toContain('不要动');
    expect(en).toContain('Read existing code first');
    expect(en).toContain('Verify');
    expect(tw).toContain('先讀再改');
    expect(tw).toContain('驗證');
  });

  it('注入前去掉未填的标签占位和空小节，模板原文仍保留空行', () => {
    const template = getDefaultAgentsTemplate();
    expect(template).toMatch(/^\s*-\s*技术栈：\s*$/m);
    const stripped = stripEmptyRulePlaceholders(template);
    expect(stripped).toContain('先读再改');
    expect(stripped).not.toMatch(/^\s*-\s*技术栈：\s*$/m);
    expect(stripped).not.toMatch(/^\s*-\s*测试：\s*$/m);
    expect(stripped).not.toContain('## 本项目');
    expect(stripped).not.toContain('## 验证');
    const injected = resolveProjectRulesSection([]);
    expect(injected).toContain('先读再改');
    expect(injected).not.toMatch(/^\s*-\s*测试：\s*$/m);
  });
});
