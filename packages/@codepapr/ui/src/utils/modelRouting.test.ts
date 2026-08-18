import { describe, expect, it } from 'vitest';
import {
  isExecutionHeavyTask,
  selectContextCompactionModelRoute,
  selectTaskModelRoute,
} from './modelRouting';

const settings = {
  model: 'deepseek-v4-pro',
  fastModelEnabled: true,
  fastModel: 'deepseek-v4-flash',
  temperature: 0.7,
  maxTokens: 393_216,
  thinkingEnabled: true,
};

describe('modelRouting', () => {
  it('marks fix/build tasks as execution-heavy', () => {
    expect(isExecutionHeavyTask('修复这个 bug 并运行测试')).toBe(true);
    expect(isExecutionHeavyTask('Build the project and fix lint issues')).toBe(true);
  });

  it('keeps summary-like ask tasks on the primary model', () => {
    const route = selectTaskModelRoute(settings, 'ask', '帮我摘要这篇文章');

    expect(route.tier).toBe('primary');
    expect(route.reason).toBe('default');
  });

  it('keeps plan mode on the primary model', () => {
    const route = selectTaskModelRoute(settings, 'plan', '帮我总结这个模块');

    expect(route.tier).toBe('primary');
    expect(route.reason).toBe('plan-mode');
  });

  it('keeps execution-heavy work on the primary model', () => {
    const route = selectTaskModelRoute(settings, 'agent', '修复这个问题并修改文件');

    expect(route.tier).toBe('primary');
    expect(route.reason).toBe('execution-heavy');
  });

  it('honors an explicit primary model hint', () => {
    const route = selectTaskModelRoute(settings, 'ask', '帮我摘要这篇文章', 'primary');
    expect(route.tier).toBe('primary');
    expect(route.model).toBe('deepseek-v4-pro');
  });

  it('honors an explicit fast model hint', () => {
    const route = selectTaskModelRoute(settings, 'agent', '帮我摘要这篇文章', 'fast');
    expect(route.tier).toBe('fast');
    expect(route.model).toBe('deepseek-v4-flash');
  });

  it('routes context compaction to the fast model when available', () => {
    const route = selectContextCompactionModelRoute(settings);

    expect(route?.tier).toBe('fast');
    expect(route?.model).toBe('deepseek-v4-flash');
    expect(route?.reason).toBe('context-compaction');
    expect(route?.thinkingEnabled).toBe(false);
    expect(route?.maxTokens).toBe(393_216);
  });

  it('routes context compaction to the primary model when preferred', () => {
    const route = selectContextCompactionModelRoute(settings, 'primary');

    expect(route?.tier).toBe('primary');
    expect(route?.model).toBe('deepseek-v4-pro');
    expect(route?.reason).toBe('context-compaction');
  });
});
