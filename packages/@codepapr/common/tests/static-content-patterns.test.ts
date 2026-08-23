import { describe, expect, it } from 'vitest';
import { STATIC_CONTENT_FORBIDDEN_PATTERNS } from '../src/staticContentPatterns';

describe('STATIC_CONTENT_FORBIDDEN_PATTERNS — 缓存一致性统一模式表', () => {
  it('表非空，且每项都有可测试的正则与名称', () => {
    expect(STATIC_CONTENT_FORBIDDEN_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of STATIC_CONTENT_FORBIDDEN_PATTERNS) {
      expect(entry.re).toBeInstanceOf(RegExp);
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it('所有正则不带 g 标志（.test() 重复调用无 lastIndex 漂移）', () => {
    for (const { re } of STATIC_CONTENT_FORBIDDEN_PATTERNS) {
      expect(re.global).toBe(false);
    }
  });

  it('覆盖历史上出现过的动态内容形态', () => {
    const cases: Array<[string, boolean]> = [
      ['填充 ${name} 变量', true],
      ['使用 {{var}} 占位', true],
      ['时间格式示例：2024-01-01T12:00', true],
      ['now is [TIMESTAMP]', true],
      ['session [SESSION_ID]', true],
      ['[TIME_NOW]', true],
      ['today is [DATE]', true],
      ['rand [RANDOM_HEX]', true],
      // 静态文本不得误报
      ['You are a helpful coding agent.', false],
      ['JSON 对象写成 { "key": "value" }', false],
      ['数组索引 arr[0]', false],
      ['2024-01-01（无 T 无时间部分）', false],
    ];
    for (const [text, shouldMatch] of cases) {
      const matched = STATIC_CONTENT_FORBIDDEN_PATTERNS.some(({ re }) => re.test(text));
      expect(matched, `文本「${text}」期望 ${shouldMatch ? '命中' : '不命中'}`).toBe(
        shouldMatch
      );
    }
  });
});
