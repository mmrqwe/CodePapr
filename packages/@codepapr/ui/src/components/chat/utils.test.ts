import { describe, expect, it } from 'vitest';
import { slashCommandNameFilter } from './utils';

describe('slashCommandNameFilter', () => {
  it('输入命令名时返回过滤串', () => {
    expect(slashCommandNameFilter('/')).toBe('');
    expect(slashCommandNameFilter('/rev')).toBe('rev');
    expect(slashCommandNameFilter('/review')).toBe('review');
    expect(slashCommandNameFilter('--goal')).toBe('goal');
  });

  it('开始写参数或换行后关闭过滤（Enter 应发送）', () => {
    expect(slashCommandNameFilter('/review src/')).toBeNull();
    expect(slashCommandNameFilter('/goal exec:npm test')).toBeNull();
    expect(slashCommandNameFilter('/help ')).toBeNull();
    expect(slashCommandNameFilter('/review\nfoo')).toBeNull();
    expect(slashCommandNameFilter('hello')).toBeNull();
  });
});
