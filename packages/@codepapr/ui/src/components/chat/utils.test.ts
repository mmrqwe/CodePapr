import { describe, expect, it } from 'vitest';
import { slashCommandNameFilter, findAtTriggerIndex, resolveComposerFilters } from './utils';

describe('slashCommandNameFilter', () => {
  it('输入命令名时返回过滤串', () => {
    expect(slashCommandNameFilter('/')).toBe('');
    expect(slashCommandNameFilter('/rev')).toBe('rev');
    expect(slashCommandNameFilter('/review')).toBe('review');
    expect(slashCommandNameFilter('--goal')).toBeNull();
  });

  it('开始写参数或换行后关闭过滤（Enter 应发送）', () => {
    expect(slashCommandNameFilter('/review src/')).toBeNull();
    expect(slashCommandNameFilter('/goal exec:npm test')).toBeNull();
    expect(slashCommandNameFilter('/help ')).toBeNull();
    expect(slashCommandNameFilter('/review\nfoo')).toBeNull();
    expect(slashCommandNameFilter('hello')).toBeNull();
  });
});

describe('resolveComposerFilters', () => {
  it('finds a leading or space-delimited @ mention', () => {
    expect(findAtTriggerIndex('@ex')).toBe(0);
    expect(findAtTriggerIndex('hello @ex')).toBe(6);
    expect(findAtTriggerIndex('email@ex')).toBe(-1);
  });

  it('opens the @ dropdown and suppresses slash while mentioning', () => {
    expect(resolveComposerFilters('@exp', 4)).toEqual({
      atFilter: 'exp',
      atTriggerIndex: 0,
      slashFilter: null,
    });
  });

  it('opens slash filter when not in an @ mention', () => {
    expect(resolveComposerFilters('/rev', 4)).toEqual({
      atFilter: null,
      atTriggerIndex: -1,
      slashFilter: 'rev',
    });
  });
});
