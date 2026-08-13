import { buildThinking } from '@codepapr/core';
import type { ILLMProvider } from '@codepapr/api';
import type { ProviderName } from '../../store/agentStore';

export interface ConnectionTestOptions {
  model: string;
  providerName: ProviderName;
  thinkingEnabled: boolean;
  reasoningEffort: string;
  thinkingBudgetTokens: number;
  signal?: AbortSignal;
}

/** 连接测试的最低 maxTokens：必须 >1024，否则 Claude 格式的 thinking 预算
 *  无法满足「budget ≥1024 且 < max_tokens」硬约束而被降级省略，
 *  测试就验证不到思考强度了。 */
export const CONNECTION_TEST_MAX_TOKENS = 4096;

/**
 * 以与主代理一致的参数语义（buildThinking）发一条极简聊天请求，
 * 验证 key/URL/模型/思考强度整条链路。失败时抛出带可读信息的错误。
 */
export async function runConnectionTest(
  provider: ILLMProvider,
  options: ConnectionTestOptions,
): Promise<void> {
  const thinking = buildThinking(
    {
      thinkingEnabled: options.thinkingEnabled,
      reasoningEffort: options.reasoningEffort,
      thinkingBudgetTokens: options.thinkingBudgetTokens,
    },
    options.providerName,
  );

  await provider.chat(
    {
      model: options.model,
      messages: [
        { id: 'connection-test', role: 'user', content: 'Hi', timestamp: Date.now() },
      ],
      maxTokens: CONNECTION_TEST_MAX_TOKENS,
      temperature: 0.3,
      topP: 0.9,
      ...(thinking ? { thinking } : {}),
    },
    options.signal,
  );
}
