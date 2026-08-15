import { describe, expect, it } from 'vitest';
import { normalizeSettings } from './settingsNormalizer';
import { CORE_TOKEN_KEYS } from '../../theme/themeEngine';
import type { CustomThemeRecord } from '../../theme/types';
import type { Settings } from './types';

describe('normalizeSettings mentor 字段防御', () => {
  // 回归 #22：mentor 三字段此前用 `?? default` + .trim()，非字符串的损坏
  // 持久化值（数字/对象/null 以外的类型）会让 .trim() 抛 TypeError，
  // 而 normalizeSettings 在每次 sendMessage 时都会执行。
  it('corrupted non-string mentor fields fall back to defaults instead of throwing', () => {
    const result = normalizeSettings({
      mentorModel: 123 as unknown as string,
      mentorBaseURL: { evil: true } as unknown as string,
      mentorApiKey: 42 as unknown as string,
    });
    expect(result.mentorModel).toBe('');
    expect(result.mentorBaseURL).toBe('');
    expect(result.mentorApiKey).toBe('');
  });

  it('string mentor fields are trimmed', () => {
    const result = normalizeSettings({
      mentorModel: '  gpt-4o  ',
      mentorBaseURL: '  https://api.example.com/  ',
      mentorApiKey: '  sk-test  ',
    });
    expect(result.mentorModel).toBe('gpt-4o');
    expect(result.mentorBaseURL).toBe('https://api.example.com/');
    expect(result.mentorApiKey).toBe('sk-test');
  });

  it('prompt fields also survive non-string corruption', () => {
    const result = normalizeSettings({
      explorePrompt: 123 as unknown as string,
      scoutPrompt: null as unknown as string,
      mentorPrompt: { x: 1 } as unknown as string,
    });
    expect(result.explorePrompt).toBe('');
    expect(result.scoutPrompt).toBe('');
    expect(result.mentorPrompt).toBe('');
  });
});

describe('normalizeSettings thinking 强度字段', () => {
  it('任意非空字符串 effort 原样保留（第三方端点取值各异）', () => {
    const result = normalizeSettings({ thinkingEffort: 'xhigh' });
    expect(result.thinkingEffort).toBe('xhigh');
  });

  it('旧持久化值 high/max 依然有效', () => {
    expect(normalizeSettings({ thinkingEffort: 'high' }).thinkingEffort).toBe('high');
    expect(normalizeSettings({ thinkingEffort: 'max' }).thinkingEffort).toBe('max');
  });

  it('空/损坏的 effort 回退默认值', () => {
    expect(normalizeSettings({ thinkingEffort: '' }).thinkingEffort).toBe('max');
    expect(normalizeSettings({ thinkingEffort: 42 as unknown as string }).thinkingEffort).toBe('max');
  });

  it('budget 非法值回退默认，合法值取整', () => {
    expect(normalizeSettings({ thinkingBudgetTokens: 8000 }).thinkingBudgetTokens).toBe(8000);
    expect(normalizeSettings({ thinkingBudgetTokens: 8123.7 }).thinkingBudgetTokens).toBe(8123);
    expect(
      normalizeSettings({ thinkingBudgetTokens: 'x' as unknown as number }).thinkingBudgetTokens
    ).toBe(4096);
  });

  it('mentor 强度字段独立归一化', () => {
    const result = normalizeSettings({
      mentorThinkingEffort: '  medium  ',
      mentorThinkingBudgetTokens: 6000,
    });
    expect(result.mentorThinkingEffort).toBe('medium');
    expect(result.mentorThinkingBudgetTokens).toBe(6000);
    expect(normalizeSettings({ mentorThinkingEffort: '' }).mentorThinkingEffort).toBe('');
  });
});

describe('normalizeSettings 主题字段防御', () => {
  it('内置主题 id 保留，未知 id 回退 null（跟随系统）', () => {
    expect(normalizeSettings({ theme: 'nord' } as Partial<Settings>).theme).toBe('nord');
    expect(normalizeSettings({ theme: 'bogus' } as Partial<Settings>).theme).toBeNull();
    expect(normalizeSettings({ theme: '' } as Partial<Settings>).theme).toBeNull();
    expect(normalizeSettings({} as Partial<Settings>).theme).toBeNull();
  });

  it('自定义主题 id 仅在记录通过校验时保留', () => {
    const valid: CustomThemeRecord = {
      name: 'M',
      mode: 'dark',
      tokens: Object.fromEntries(CORE_TOKEN_KEYS.map((k) => [k, '#111'])),
    };
    expect(
      normalizeSettings({
        theme: 'custom-1',
        customThemes: { 'custom-1': valid },
      } as Partial<Settings>).theme,
    ).toBe('custom-1');
    expect(
      normalizeSettings({
        theme: 'custom-1',
        customThemes: {},
      } as Partial<Settings>).theme,
    ).toBeNull();
  });

  it('非法自定义主题记录被丢弃，不阻塞设置加载', () => {
    const settings = normalizeSettings({
      customThemes: {
        'ok-theme': {
          name: 'OK',
          mode: 'dark',
          tokens: Object.fromEntries(CORE_TOKEN_KEYS.map((k) => [k, '#111'])),
        },
        'bad-theme': { name: 'Bad', mode: 'blue' as unknown as 'light', tokens: {} },
      },
    } as unknown as Partial<Settings>);
    expect(Object.keys(settings.customThemes)).toEqual(['ok-theme']);
  });

  it('accent 仅接受 #rgb / #rrggbb', () => {
    expect(normalizeSettings({ accent: '#ff0000' } as Partial<Settings>).accent).toBe('#ff0000');
    expect(normalizeSettings({ accent: '#f00' } as Partial<Settings>).accent).toBe('#f00');
    expect(normalizeSettings({ accent: 'red' } as Partial<Settings>).accent).toBeNull();
    expect(normalizeSettings({ accent: 123 as unknown as string } as Partial<Settings>).accent).toBeNull();
    expect(normalizeSettings({} as Partial<Settings>).accent).toBeNull();
  });
});
