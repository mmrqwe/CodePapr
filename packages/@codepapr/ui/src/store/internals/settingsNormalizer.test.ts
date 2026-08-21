import { describe, expect, it } from 'vitest';
import {
  createDefaultProfile,
  findProfileById,
  normalizeSettings,
  resolveFastProfile,
  resolveMentorProfile,
  resolvePrimaryProfile,
  resolveThinkingPayload,
} from './settingsNormalizer';
import { CORE_TOKEN_KEYS } from '../../theme/themeEngine';
import type { CustomThemeRecord } from '../../theme/types';
import type { ModelProfile, Settings } from './types';

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

describe('normalizeSettings 实验性功能', () => {
  it('角色和语音默认关闭，仅接受布尔值', () => {
    const defaults = normalizeSettings({});
    expect(defaults.experimentalCharacters).toBe(false);
    expect(defaults.experimentalVoice).toBe(false);

    expect(normalizeSettings({ experimentalCharacters: true }).experimentalCharacters).toBe(true);
    expect(normalizeSettings({ experimentalVoice: true }).experimentalVoice).toBe(true);
    expect(
      normalizeSettings({ experimentalCharacters: 'yes' as unknown as boolean }).experimentalCharacters
    ).toBe(false);
  });
});

describe('normalizeSettings LSP families', () => {
  it('defaults to all families enabled', () => {
    expect(normalizeSettings({}).lspDisabledFamilies).toEqual([]);
  });

  it('keeps known disabled families and drops unknown ids', () => {
    expect(normalizeSettings({ lspDisabledFamilies: ['rust', 'nope', 'java'] }).lspDisabledFamilies).toEqual([
      'rust',
      'java',
    ]);
  });
});

describe('ModelProfile 与 Slot 角色分配机制', () => {
  it('createDefaultProfile 创建具有合理默认值的配置对象', () => {
    const deepseekProf = createDefaultProfile('My DeepSeek', 'deepseek');
    expect(deepseekProf.name).toBe('My DeepSeek');
    expect(deepseekProf.apiMode).toBe('deepseek');
    expect(deepseekProf.apiFormat).toBe('openai');
    expect(deepseekProf.model).toBe('deepseek-v4-pro');
    expect(deepseekProf.thinkingEnabled).toBe(true);
    expect(deepseekProf.thinkingPayload).toBe('thinking');
    expect(deepseekProf.id).toMatch(/^profile-/);

    const customProf = createDefaultProfile('My Custom', 'custom');
    expect(customProf.apiMode).toBe('custom');
    expect(customProf.model).toBe('gpt-4o');
    expect(customProf.thinkingPayload).toBe('reasoning');

    const localProf = createDefaultProfile('My Local', 'local');
    expect(localProf.apiMode).toBe('local');
    expect(localProf.baseURL).toBe('http://127.0.0.1:8080/v1');
    expect(localProf.thinkingPayload).toBe('reasoning');
  });

  it('空设置默认生成预设模型配置池，并正确绑定 primary, fast, mentor 插槽', () => {
    const settings = normalizeSettings({});
    expect(settings.modelProfiles.length).toBeGreaterThanOrEqual(4);
    expect(settings.primaryProfileId).toBe('profile-deepseek');
    expect(settings.fastProfileId).toBe('profile-deepseek-fast');
    expect(settings.mentorProfileId).toBe('profile-custom');

    const primary = resolvePrimaryProfile(settings);
    const fast = resolveFastProfile(settings);
    const mentor = resolveMentorProfile(settings);

    expect(primary.id).toBe('profile-deepseek');
    expect(fast.id).toBe('profile-deepseek-fast');
    expect(mentor.id).toBe('profile-custom');
    expect(settings.thinkingPayload).toBe('thinking');
    expect(settings.mentorThinkingPayload).toBe('reasoning');
  });

  it('thinkingPayload 缺省按 apiMode 回填，显式值保留', () => {
    expect(resolveThinkingPayload(undefined, 'deepseek')).toBe('thinking');
    expect(resolveThinkingPayload(undefined, 'custom')).toBe('reasoning');
    expect(resolveThinkingPayload('both', 'deepseek')).toBe('both');

    const settings = normalizeSettings({
      modelProfiles: [
        {
          id: 'prof-ark',
          name: 'Ark',
          apiMode: 'custom',
          apiFormat: 'response',
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
          apiKey: 'sk-ark',
          model: 'doubao-1.5-pro-32k',
          maxTokens: 32000,
          thinkingEnabled: true,
          thinkingPayload: 'both',
        },
      ],
      primaryProfileId: 'prof-ark',
    });
    expect(settings.thinkingPayload).toBe('both');
    expect(settings.modelProfiles[0]?.thinkingPayload).toBe('both');

    const legacy = normalizeSettings({
      modelProfiles: [
        {
          id: 'prof-legacy',
          name: 'Legacy Custom',
          apiMode: 'custom',
          apiFormat: 'openai',
          baseURL: 'https://relay.example.com/v1',
          apiKey: 'sk',
          model: 'gpt-4o',
          maxTokens: 8000,
        },
      ],
      primaryProfileId: 'prof-legacy',
    });
    expect(legacy.thinkingPayload).toBe('reasoning');
    expect(legacy.modelProfiles[0]?.thinkingPayload).toBe('reasoning');
  });

  it('从 legacy 平铺设置合成配置池并保留 API 密钥与端点', () => {
    const settings = normalizeSettings({
      apiMode: 'custom',
      apiFormat: 'claude',
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-123',
      model: 'claude-3-7-sonnet',
      fastModel: 'claude-3-5-haiku',
      mentorModel: 'claude-opus',
      mentorApiKey: 'sk-mentor-key',
      mentorBaseURL: 'https://api.mentor.com/v1',
      mentorApiFormat: 'openai',
    });

    expect(settings.model).toBe('claude-3-7-sonnet');
    expect(settings.apiKey).toBe('sk-ant-123');
    expect(settings.baseURL).toBe('https://api.anthropic.com/v1');
    expect(settings.apiFormat).toBe('claude');

    // 检查是否有生成的 profile-mentor
    const mentorProf = findProfileById(settings, 'profile-mentor');
    expect(mentorProf).toBeDefined();
    expect(mentorProf?.model).toBe('claude-opus');
    expect(mentorProf?.apiKey).toBe('sk-mentor-key');
    expect(mentorProf?.baseURL).toBe('https://api.mentor.com/v1');
  });

  it('用户自定义配置池生效，且切换 primaryProfileId 时自动同步平铺字段', () => {
    const customProfiles: ModelProfile[] = [
      {
        id: 'prof-openai-o3',
        name: 'OpenAI o3-mini',
        apiMode: 'custom',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-proj-o3',
        model: 'o3-mini',
        maxTokens: 32000,
        thinkingEnabled: true,
        thinkingEffort: 'medium',
      },
      {
        id: 'prof-qwen-turbo',
        name: 'Qwen Turbo',
        apiMode: 'custom',
        apiFormat: 'openai',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-dash-xxx',
        model: 'qwen-turbo-latest',
        maxTokens: 16000,
      },
      {
        id: 'prof-claude-mentor',
        name: 'Claude Mentor',
        apiMode: 'custom',
        apiFormat: 'claude',
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-mentor',
        model: 'claude-3-7-sonnet-20250219',
        maxTokens: 64000,
        thinkingEnabled: true,
        thinkingBudgetTokens: 8192,
      },
    ];

    const settings = normalizeSettings({
      modelProfiles: customProfiles,
      primaryProfileId: 'prof-openai-o3',
      fastProfileId: 'prof-qwen-turbo',
      mentorProfileId: 'prof-claude-mentor',
    });

    expect(settings.modelProfiles.length).toBe(3);
    expect(settings.model).toBe('o3-mini');
    expect(settings.apiKey).toBe('sk-proj-o3');
    expect(settings.baseURL).toBe('https://api.openai.com/v1');
    expect(settings.thinkingEnabled).toBe(true);
    expect(settings.thinkingEffort).toBe('medium');
    expect(settings.thinkingPayload).toBe('reasoning');

    expect(settings.fastModel).toBe('qwen-turbo-latest');

    expect(settings.mentorModel).toBe('claude-3-7-sonnet-20250219');
    expect(settings.mentorApiKey).toBe('sk-ant-mentor');
    expect(settings.mentorBaseURL).toBe('https://api.anthropic.com/v1');
    expect(settings.mentorApiFormat).toBe('claude');
    expect(settings.mentorThinkingEnabled).toBe(true);
    expect(settings.mentorThinkingBudgetTokens).toBe(8192);
  });

  it('当指定的插槽 profileId 不存在时，自动优雅回退', () => {
    const customProfiles: ModelProfile[] = [
      {
        id: 'prof-1',
        name: 'Profile 1',
        apiMode: 'custom',
        apiFormat: 'openai',
        baseURL: '',
        apiKey: '',
        model: 'model-1',
        maxTokens: 4000,
      },
    ];

    const settings = normalizeSettings({
      modelProfiles: customProfiles,
      primaryProfileId: 'non-existent-id',
      fastProfileId: 'non-existent-fast',
      mentorProfileId: 'non-existent-mentor',
    });

    expect(settings.primaryProfileId).toBe('prof-1');
    expect(settings.fastProfileId).toBe('prof-1');
    expect(settings.mentorProfileId).toBe('prof-1');
    expect(settings.model).toBe('model-1');
  });

  it('正确支持并归一化 response API 格式（Responses API）', () => {
    const responseProfile: ModelProfile = {
      id: 'prof-ark-resp',
      name: '火山 Responses API',
      apiMode: 'custom',
      apiFormat: 'response',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark-secret',
      model: 'doubao-1.5-pro-32k',
      maxTokens: 32000,
    };

    const settings = normalizeSettings({
      modelProfiles: [responseProfile],
      primaryProfileId: 'prof-ark-resp',
      mentorApiFormat: 'response',
    });

    expect(settings.apiFormat).toBe('response');
    expect(settings.provider).toBe('response');
    expect(settings.model).toBe('doubao-1.5-pro-32k');
    expect(settings.baseURL).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(settings.mentorApiFormat).toBe('response');
  });
});
