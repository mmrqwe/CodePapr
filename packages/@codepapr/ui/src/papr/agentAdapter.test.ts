import { describe, it, expect } from 'vitest';
import { paprAgentToCore } from './agentAdapter';

describe('paprAgentToCore', () => {
  it('converts basic agent definition', () => {
    const result = paprAgentToCore({
      name: 'assistant',
      model: 'deepseek',
      systemPrompt: 'You are helpful.',
    }, 'my-app');

    expect(result.name).toBe('app-my-app-assistant');
    expect(result.mode).toBe('subagent');
    expect(result.model).toBe('deepseek');
    expect(result.prompt).toBe('You are helpful.');
    expect(result.tools).toEqual({});
  });

  it('uses default model when not specified', () => {
    const result = paprAgentToCore({
      name: 'helper',
    }, 'test-app');

    expect(result.model).toBe('deepseek');
  });

  it('maps tools array to boolean map', () => {
    const result = paprAgentToCore({
      name: 'analyst',
      tools: ['read', 'grep', 'web_search'],
    }, 'data-app');

    expect(result.tools).toEqual({
      read: true,
      grep: true,
      web_search: true,
    });
  });

  it('handles empty tools array', () => {
    const result = paprAgentToCore({
      name: 'empty',
      tools: [],
    }, 'app');

    expect(result.tools).toEqual({});
  });

  it('handles undefined tools', () => {
    const result = paprAgentToCore({
      name: 'notools',
    }, 'app');

    expect(result.tools).toEqual({});
  });

  it('uses default system prompt when not specified', () => {
    const result = paprAgentToCore({
      name: 'default',
    }, 'app');

    expect(result.prompt).toBe('You are a helpful assistant.');
  });

  it('uses fast model tier', () => {
    const result = paprAgentToCore({
      name: 'fast-agent',
      model: 'fast',
    }, 'app');

    expect(result.model).toBe('fast');
  });
});
