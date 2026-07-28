import { describe, expect, it } from 'vitest';
import {
  buildSkillsSection,
  buildSessionBootstrapPrompt,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  buildStructuredUserPrompt,
  createDefaultUserPromptSections,
  ImmutablePrefix,
  parseStructuredUserPrompt,
  validateUserPrompt,
  type SkillDefinition,
} from '../src';

describe('promptSystem', () => {
  const skills: SkillDefinition[] = [
    {
      name: 'search',
      description: '搜索资料',
      prompt: '优先查官方文档。',
    },
    {
      name: 'release',
      description: '发布检查',
      prompt: '先检查构建产物。',
    },
  ];

  it('builds a stable runtime system prompt without per-turn diagnostics or skills', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      rulesSection: '## 项目规则\n- 先跑测试',
      toolNames: ['edit', 'graph', 'exec'],
    });

    expect(prompt).toContain('你是一名资深软件工程师');
    expect(prompt).toContain('## 项目规则');
    expect(prompt).toContain('你处于 Agent 模式');
    expect(prompt).not.toContain('项目 Skills');
    expect(prompt).not.toContain('项目诊断');
  });

  it('includes graph tool constraint when graph is in toolNames', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph'],
    });
    expect(prompt).toContain('graph');
    expect(prompt).toContain('先拿地图再行动');
  });

  it('includes bash constraint when present', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['bash'],
    });
    expect(prompt).toContain('bash');
    expect(prompt).toContain('background');
    expect(prompt).toContain('workdir');
  });

  it('lsp constraint does not mention diagnostics as lsp action', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['lsp'],
    });
    expect(prompt).toContain('lsp');
    expect(prompt).not.toContain('`diagnostics`');
  });

  it('includes diagnostics standalone constraint', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['diagnostics'],
    });
    expect(prompt).toContain('diagnostics');
    expect(prompt).toContain('npm run lint');
  });

  it('includes write/edit/patch parameter guidance', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write', 'edit'],
    });
    expect(prompt).toContain('relativePath');
    expect(prompt).toContain('SEARCH/REPLACE');
    expect(prompt).toContain('项目记忆');
  });

  it('includes web_search constraint in ask mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'ask',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['web_search', 'web_fetch'],
    });
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('web_fetch');
  });

  it('includes write constraint with project memory in agent mode', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write'],
    });
    expect(prompt).toContain('项目记忆');
    expect(prompt).toContain('.CodePapr/memory.md');
    expect(prompt).toContain('项目结构');
    expect(prompt).not.toContain('常规发现');
  });

  it('does NOT include project memory in ask mode even with write tool', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'ask',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['write'],
    });
    expect(prompt).not.toContain('项目记忆');
  });

  it('includes question constraint only in plan mode', () => {
    const planPrompt = buildRuntimeSystemPrompt({
      mode: 'plan',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['question'],
    });
    expect(planPrompt).toContain('question');

    const agentPrompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['question'],
    });
    expect(agentPrompt).not.toContain('需求模糊时调用');
  });

  it('keeps the immutable prefix stable when only the custom guidance changes', () => {
    const systemPrompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      rulesSection: '## 项目规则\n- 先跑测试',
      toolNames: ['edit'],
    });
    const prefixA = new ImmutablePrefix({
      systemPrompt,
      tools: [],
      model: 'deepseek-v4-pro',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
    });
    const prefixB = new ImmutablePrefix({
      systemPrompt,
      tools: [],
      model: 'deepseek-v4-pro',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
    });

    const bootstrapA = buildSessionBootstrapPrompt({
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      skillsSection: buildSkillsSection(skills, 'zh-CN'),
      customPromptSection: '## 执行方式\n优先直接执行。',
    });
    const bootstrapB = buildSessionBootstrapPrompt({
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      skillsSection: buildSkillsSection(skills, 'zh-CN'),
      customPromptSection: '## 执行方式\n优先最小改动。',
    });
    const turnPrompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '修复当前报错',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
    });

    expect(prefixA.computeHash()).toBe(prefixB.computeHash());
    expect(bootstrapA).not.toBe(bootstrapB);
    expect(bootstrapA).toContain('## 项目 Skills');
    expect(bootstrapA).toContain('`search`: 搜索资料');
    expect(bootstrapA).toContain('## 长期附加指导');
    expect(turnPrompt).not.toContain('## 项目文件夹');
  });

  it('keeps full skill content out of per-turn runtime prompts', () => {
    const prompt = buildRuntimeUserPrompt({
      mode: 'agent',
      input: '请搜索最新官方 docs',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
    });

    expect(prompt).not.toContain('项目 Skills');
    expect(prompt).not.toContain('优先查官方文档。');
  });

  it('flags obviously dynamic user prompt content', () => {
    const result = validateUserPrompt('请在回答中加入 [TIMESTAMP] 和 ${env}');
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
  });

  it('builds and parses structured user prompt sections', () => {
    const sections = createDefaultUserPromptSections('zh-CN');
    sections.appendix = '回答中优先给出验证命令。';

    const prompt = buildStructuredUserPrompt(sections, 'zh-CN');
    const parsed = parseStructuredUserPrompt(prompt);

    expect(prompt).toContain('## 执行方式');
    expect(prompt).toContain('## 补充约束');
    expect(parsed).toEqual(sections);
  });

  it('includes architect references when mentorEnabled is true', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
      mentorEnabled: true,
    });
    expect(prompt).toContain('架构师');
    expect(prompt).toContain('必须先向架构师汇报');
    expect(prompt).toContain('如果架构师调用失败');
  });

  it('excludes architect references when mentorEnabled is false', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
      mentorEnabled: false,
    });
    expect(prompt).not.toContain('架构师');
    expect(prompt).not.toContain('必须先向架构师汇报');
    expect(prompt).not.toContain('如果架构师调用失败');
  });

  it('excludes architect references by default when mentorEnabled is not specified', () => {
    const prompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath: '/tmp/project',
      lang: 'zh-CN',
      toolNames: ['graph', 'lsp', 'task'],
    });
    expect(prompt).not.toContain('架构师');
  });
});
