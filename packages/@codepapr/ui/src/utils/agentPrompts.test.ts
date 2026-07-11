import { describe, expect, it } from 'vitest';
import { MODE_PROMPTS, buildModePrompt, buildModeSystemPrompt } from './agentPrompts';

describe('agentPrompts', () => {
  it('keeps mode-level system prompts separate from per-turn task text', () => {
    expect(MODE_PROMPTS.ask).toContain('你处于 Ask 模式');
    expect(MODE_PROMPTS.ask).toContain('## 核心约束');
    expect(MODE_PROMPTS.ask).toContain('直接回答问题');
    expect(MODE_PROMPTS.plan).toContain('你处于 Plan 模式');
    expect(MODE_PROMPTS.agent).toContain('你处于 Agent 模式');
    expect(MODE_PROMPTS.agent).toContain('edit');
  });

  it('builds a runtime system prompt without embedding the current task text', () => {
    const prompt = buildModeSystemPrompt('agent', '/tmp/project', 'zh-CN', {
      available: true,
      packageManager: 'npm',
      packageJsonPath: 'package.json',
      ranAt: 1,
      overallStatus: 'failed',
      stages: [
        {
          id: 'typecheck',
          scriptName: 'build',
          label: 'typecheck(build fallback)',
          command: 'npm',
          args: ['run', 'build'],
          fallback: true,
          success: false,
          status: 1,
          timedOut: false,
          stdout: '',
          stderr: 'src/App.tsx:3:14 error Cannot find name foo',
          excerpt: 'src/App.tsx:3:14 error Cannot find name foo',
        },
      ],
    });

    expect(prompt).toContain('你处于 Agent 模式');
    expect(prompt).toContain('/tmp/project');
    expect(prompt).toContain('## 项目诊断');
    expect(prompt).not.toContain('修复 ESLint');
  });

  it('builds a per-turn prompt with diagnostics and task text only', () => {
    const prompt = buildModePrompt('agent', '/tmp/project', '修复当前静态错误', 'zh-CN', {
      available: true,
      packageManager: 'npm',
      packageJsonPath: 'package.json',
      ranAt: 1,
      overallStatus: 'failed',
      stages: [
        {
          id: 'typecheck',
          scriptName: 'build',
          label: 'typecheck(build fallback)',
          command: 'npm',
          args: ['run', 'build'],
          fallback: true,
          success: false,
          status: 1,
          timedOut: false,
          stdout: '',
          stderr: 'src/App.tsx:3:14 error Cannot find name foo',
          excerpt: 'src/App.tsx:3:14 error Cannot find name foo',
        },
      ],
    });

    expect(prompt).toContain('# CodePapr AGENT 模式');
    expect(prompt).toContain('## 项目诊断');
    expect(prompt).toContain('最新项目诊断：失败');
    expect(prompt).toContain('src/App.tsx:3:14');
    expect(prompt).toContain('## 目标');
    expect(prompt).toContain('修复当前静态错误');
    expect(prompt).not.toContain('## 长期附加指导');
    expect(prompt).not.toContain('## 项目文件夹');
    expect(prompt).not.toContain('/tmp/project');
    expect(prompt).not.toContain('## 核心约束');
  });

  it('keeps the workspace fallback in the stable ask system prompt', () => {
    const systemPrompt = buildModeSystemPrompt('ask', '', 'zh-CN');
    const prompt = buildModePrompt('ask', '', '解释当前行为', 'zh-CN');

    expect(systemPrompt).toContain('未选择项目文件夹');
    expect(systemPrompt).toContain('Ask 模式可基于已提供内容回答');
    expect(systemPrompt).toContain('## 项目文件夹');
    expect(prompt).not.toContain('未选择项目文件夹');
    expect(prompt).not.toContain('Ask 模式可基于已提供内容回答');
    expect(prompt).toContain('## 问题');
    expect(prompt).toContain('解释当前行为');
  });

  it('localizes system and per-turn prompt content in English', () => {
    const systemPrompt = buildModeSystemPrompt('plan', '/tmp/project', 'en');
    const prompt = buildModePrompt('plan', '/tmp/project', 'Open the project website', 'en');

    expect(systemPrompt).toContain('## Workspace');
    expect(systemPrompt).toContain('/tmp/project');
    expect(prompt).toContain('# CodePapr PLAN Mode');
    expect(prompt).toContain('## Objective');
    expect(prompt).toContain('Open the project website');
    expect(prompt).not.toContain('## Workspace');
  });
});
