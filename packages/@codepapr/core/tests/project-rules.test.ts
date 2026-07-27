import { describe, expect, it } from 'vitest';
import {
  buildProjectRulesSection,
  PROJECT_AGENTS_FILE,
  PROJECT_RULE_FILES,
  getDefaultAgentsTemplate,
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

  it('默认查找文件与模板可用', () => {
    expect(PROJECT_AGENTS_FILE).toBe('.CodePapr/AGENTS.md');
    expect(PROJECT_RULE_FILES).toEqual([PROJECT_AGENTS_FILE]);
    const cn = getDefaultAgentsTemplate();
    const en = getDefaultAgentsTemplate('en');
    const tw = getDefaultAgentsTemplate('zh-TW');
    expect(cn).toContain('仅对主 Agent 生效');
    expect(cn).toContain('技术栈');
    expect(cn).toContain('构建与验证');
    expect(cn).toContain('项目约定');
    expect(cn).toContain('禁止事项');
    expect(en).toContain('main Agent only');
    expect(en).toContain('Tech Stack');
    expect(tw).toContain('僅對主 Agent 生效');
    expect(tw).toContain('技術棧');
  });
});
