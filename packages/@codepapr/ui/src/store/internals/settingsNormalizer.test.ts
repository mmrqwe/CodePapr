import { describe, expect, it } from 'vitest';
import { normalizeSettings } from './settingsNormalizer';
import { CORE_TOKEN_KEYS } from '../../theme/themeEngine';
import type { CustomThemeRecord } from '../../theme/types';
import type { Settings } from './types';

/** 旧版本 Settings 输入（含已废弃的 theme 字段）。 */
type LegacySettingsInput = Partial<Settings> & { theme?: string | null };

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
  it('lightTheme/darkTheme 只接受内置或已校验的自定义主题', () => {
    const base = normalizeSettings({} as Partial<Settings>);
    expect(base.lightTheme).toBe('paper-light');
    expect(base.darkTheme).toBe('paper-dark');
    expect(base.followSystem).toBe(true);

    const withThemes = normalizeSettings({
      lightTheme: 'solarized-light',
      darkTheme: 'nord',
    } as Partial<Settings>);
    expect(withThemes.lightTheme).toBe('solarized-light');
    expect(withThemes.darkTheme).toBe('nord');

    const invalid = normalizeSettings({
      lightTheme: 'bogus',
      darkTheme: 'bogus',
    } as Partial<Settings>);
    expect(invalid.lightTheme).toBe('paper-light');
    expect(invalid.darkTheme).toBe('paper-dark');
  });

  it('自定义主题 id 仅在记录通过校验时可用于槽位', () => {
    const valid: CustomThemeRecord = {
      name: 'M',
      mode: 'dark',
      tokens: Object.fromEntries(CORE_TOKEN_KEYS.map((k) => [k, '#111'])),
    };
    const settings = normalizeSettings({
      darkTheme: 'custom-1',
      customThemes: { 'custom-1': valid },
    } as Partial<Settings>);
    expect(settings.darkTheme).toBe('custom-1');

    const missing = normalizeSettings({
      darkTheme: 'custom-1',
      customThemes: {},
    } as Partial<Settings>);
    expect(missing.darkTheme).toBe('paper-dark');
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

  it('旧版单一 theme 字段迁移到浅/深槽位', () => {
    // 旧字段 = 深色主题 → 落入 darkTheme，转手动模式
    const dark = normalizeSettings({ theme: 'nord' } as LegacySettingsInput);
    expect(dark.darkTheme).toBe('nord');
    expect(dark.lightTheme).toBe('paper-light');
    expect(dark.followSystem).toBe(false);
    expect(dark.themeMode).toBe('dark');

    // 旧字段 = 浅色主题
    const light = normalizeSettings({ theme: 'solarized-light' } as LegacySettingsInput);
    expect(light.lightTheme).toBe('solarized-light');
    expect(light.darkTheme).toBe('paper-dark');
    expect(light.followSystem).toBe(false);
    expect(light.themeMode).toBe('light');

    // 旧字段 = null → 跟随系统
    const follow = normalizeSettings({ theme: null } as LegacySettingsInput);
    expect(follow.followSystem).toBe(true);
    expect(follow.lightTheme).toBe('paper-light');
    expect(follow.darkTheme).toBe('paper-dark');
  });

  it('themeMode/followSystem 非法值回退默认', () => {
    const settings = normalizeSettings({
      followSystem: 'yes' as unknown as boolean,
      themeMode: 'blue' as unknown as 'light',
    } as Partial<Settings>);
    expect(settings.followSystem).toBe(true);
    expect(settings.themeMode).toBe('light');
    expect(normalizeSettings({ themeMode: 'dark' } as Partial<Settings>).themeMode).toBe('dark');
  });

  it('accent 仅接受 #rgb / #rrggbb', () => {
    expect(normalizeSettings({ accent: '#ff0000' } as Partial<Settings>).accent).toBe('#ff0000');
    expect(normalizeSettings({ accent: '#f00' } as Partial<Settings>).accent).toBe('#f00');
    expect(normalizeSettings({ accent: 'red' } as Partial<Settings>).accent).toBeNull();
    expect(normalizeSettings({ accent: 123 as unknown as string } as Partial<Settings>).accent).toBeNull();
    expect(normalizeSettings({} as Partial<Settings>).accent).toBeNull();
  });
});
