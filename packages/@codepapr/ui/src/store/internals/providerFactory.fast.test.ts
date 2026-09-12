import { describe, expect, it } from 'vitest';
import { DeepSeekProvider, OpenAIProvider } from '@codepapr/api';
import { buildFastProviderInstance } from './providerFactory';

/** BaseLLMProvider.config 是 protected；单测经 cast 读取以断言构造参数。 */
function providerConfig(provider: object): Record<string, unknown> {
  return (provider as unknown as { config: Record<string, unknown> }).config;
}

const primary = {
  apiMode: 'custom' as const,
  apiFormat: 'openai' as const,
  apiKey: 'sk-primary',
  baseURL: 'https://relay.example.com/v1',
  streamIdleTimeoutMs: 30_000,
};

describe('buildFastProviderInstance', () => {
  it('同 provider 类型：缺 key/baseURL 时继承主档（key 与 baseURL 都回落）', () => {
    const provider = buildFastProviderInstance({
      ...primary,
      fastApiMode: 'custom',
      fastApiFormat: 'openai',
      fastApiKey: '',
      fastBaseURL: '',
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    const config = providerConfig(provider);
    expect(config.apiKey).toBe('sk-primary');
    expect(config.baseURL).toBe('https://relay.example.com/v1');
  });

  it('异类 fast（deepseek）：用 DeepSeekProvider，空 baseURL 不继承主档中转地址', () => {
    const provider = buildFastProviderInstance({
      ...primary,
      fastApiMode: 'deepseek',
      fastApiFormat: 'openai',
      fastApiKey: 'sk-fast',
      fastBaseURL: '',
    });
    expect(provider).toBeInstanceOf(DeepSeekProvider);
    const config = providerConfig(provider);
    expect(config.apiKey).toBe('sk-fast');
    expect(config.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('fast 自身 key/baseURL 优先于主档', () => {
    const provider = buildFastProviderInstance({
      ...primary,
      fastApiMode: 'custom',
      fastApiFormat: 'openai',
      fastApiKey: 'sk-fast',
      fastBaseURL: 'https://fast.example.com/v1',
    });
    const config = providerConfig(provider);
    expect(config.apiKey).toBe('sk-fast');
    expect(config.baseURL).toBe('https://fast.example.com/v1');
  });

  it('旧档缺 fast 字段：完全回退主档', () => {
    const provider = buildFastProviderInstance(primary);
    const config = providerConfig(provider);
    expect(config.apiKey).toBe('sk-primary');
    expect(config.baseURL).toBe('https://relay.example.com/v1');
  });
});
