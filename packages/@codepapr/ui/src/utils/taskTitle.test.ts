import { describe, expect, it } from 'vitest';
import { buildTaskTitle, buildUserMessageTitleSource } from './taskTitle';

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

describe('buildUserMessageTitleSource', () => {
  it('prefers the typed text', () => {
    expect(buildUserMessageTitleSource('修复这个 bug', [{ name: 'a.pdf' }], 2)).toBe('修复这个 bug');
  });

  it('falls back to attachment names when the text is blank', () => {
    expect(
      buildUserMessageTitleSource('   ', [{ name: 'report.pdf' }, { name: 'notes.ts' }], 1)
    ).toBe('report.pdf、notes.ts');
    expect(buildUserMessageTitleSource('', [{ name: 'report.pdf' }], 0, 'en')).toBe('report.pdf');
  });

  it('falls back to a localized image title when only images are attached', () => {
    expect(buildUserMessageTitleSource('', undefined, 3, 'zh-CN')).toBe('图片 × 3');
    expect(buildUserMessageTitleSource(undefined, [], 1, 'zh-TW')).toBe('圖片 × 1');
    expect(buildUserMessageTitleSource(undefined, undefined, 2, 'en')).toBe('Image × 2');
  });

  it('returns an empty string when there is nothing to name the task from', () => {
    expect(buildUserMessageTitleSource(undefined, undefined, 0)).toBe('');
  });
});
