import { describe, expect, it } from 'vitest';
import { normalizeSettings } from './settingsNormalizer';
import { toWorkerAgentSettings } from './workerSettings';

describe('toWorkerAgentSettings: fast profile 凭据映射', () => {
  it('默认档：fast 凭据来自默认 fast profile（deepseek，空 key 回退运行时的主 key）', () => {
    const worker = toWorkerAgentSettings(normalizeSettings({}));
    expect(worker.fastModel).toBe('deepseek-flash');
    expect(worker.fastApiMode).toBe('deepseek');
    expect(worker.fastApiFormat).toBe('openai');
    expect(worker.fastApiKey).toBe('');
    expect(worker.fastBaseURL).toBe('');
  });

  it('fast 槽位换成自定义 profile 后，端点/密钥随槽位一起下发给 worker', () => {
    const base = normalizeSettings({});
    const custom = base.modelProfiles.find((p) => p.id === 'profile-custom')!;
    const settings = normalizeSettings({
      ...base,
      fastProfileId: custom.id,
      modelProfiles: base.modelProfiles.map((p) =>
        p.id === custom.id
          ? { ...p, apiKey: 'sk-fast', baseURL: 'https://fast.example.com/v1' }
          : p
      ),
    });

    const worker = toWorkerAgentSettings(settings);
    expect(worker.fastApiMode).toBe('custom');
    expect(worker.fastApiFormat).toBe('openai');
    expect(worker.fastApiKey).toBe('sk-fast');
    expect(worker.fastBaseURL).toBe('https://fast.example.com/v1');
  });
});

describe('toWorkerAgentSettings: mentor profile 凭据映射', () => {
  it('导师槽位为 deepseek profile 时，apiMode/端点/密钥/附加头随槽位下发', () => {
    const base = normalizeSettings({});
    const mentor = base.modelProfiles.find((p) => p.id === 'profile-custom')!;
    const settings = normalizeSettings({
      ...base,
      mentorProfileId: mentor.id,
      modelProfiles: base.modelProfiles.map((p) =>
        p.id === mentor.id
          ? {
              ...p,
              apiMode: 'deepseek',
              apiFormat: 'openai',
              baseURL: '',
              apiKey: 'sk-mentor',
              extraHeaders: { 'X-Mentor': '1' },
            }
          : p
      ),
    });

    const worker = toWorkerAgentSettings(settings);
    expect(worker.mentorEnabled).toBe(base.mentorEnabled);
    expect(worker.mentorApiMode).toBe('deepseek');
    expect(worker.mentorApiFormat).toBe('openai');
    expect(worker.mentorApiKey).toBe('sk-mentor');
    expect(worker.mentorBaseURL).toBe('');
    expect(worker.mentorExtraHeaders).toEqual({ 'X-Mentor': '1' });
  });
});
