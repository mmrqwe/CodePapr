import { describe, expect, it } from 'vitest';
import { DEFAULT_CODING_SYSTEM_PROMPT, buildModeSystemPrompt } from './prompts';

describe('CLI prompts', () => {
  it('keeps a stable shared system base plus mode constraints', () => {
    expect(DEFAULT_CODING_SYSTEM_PROMPT).toContain('准确率优先');
    expect(DEFAULT_CODING_SYSTEM_PROMPT).not.toContain('面向真实编程工作流');

    const prompt = buildModeSystemPrompt('agent', '/tmp/project');
    expect(prompt).toContain('你处于 Agent 模式');
    expect(prompt).toContain('面向真实编程工作流');
    expect(prompt).toContain('## 核心约束');
    expect(prompt).toContain('exec');
  });
});
