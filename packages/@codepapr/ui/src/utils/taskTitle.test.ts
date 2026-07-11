import { describe, expect, it } from 'vitest';
import { buildTaskTitle } from './taskTitle';

describe('buildTaskTitle', () => {
  it('builds a concise Chinese task title from user intent', () => {
    expect(buildTaskTitle('请帮我修复 Rust 后端死锁')).toBe('修复 Rust 后端死锁');
  });

  it('strips filler phrases from English prompts', () => {
    expect(buildTaskTitle('Please fix the task naming logic and remove timestamp titles')).toBe(
      'fix the task naming logic and remove timestamp t...'
    );
  });

  it('falls back to a default title for empty input', () => {
    expect(buildTaskTitle('   ')).toBe('新任务');
  });
});
