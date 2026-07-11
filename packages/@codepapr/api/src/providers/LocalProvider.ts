/**
 * LocalProvider: 本地模型 Provider（OpenAI 兼容）
 *
 * 适配 llama.cpp server、Ollama（/v1）、LM Studio 等本地推理服务。
 * 复用 OpenAIProvider 的请求/响应逻辑，仅调整默认 baseURL 与鉴权语义：
 * - 默认指向 llama.cpp 的本地端点
 * - 本地服务通常不需要 API Key，validate() 始终通过
 */

import { OpenAIProvider } from './OpenAIProvider';
import { ProviderConfig } from './ILLMProvider';

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';

export class LocalProvider extends OpenAIProvider {
  name = 'local';
  models = ['local-model'];

  constructor(config: Partial<ProviderConfig> = {}) {
    super({
      baseURL: DEFAULT_LOCAL_BASE_URL,
      ...config,
      // 本地服务通常无需鉴权；保留占位以兼容 Authorization 头
      apiKey: config.apiKey && config.apiKey.trim() ? config.apiKey : 'local',
    });
  }

  /** 本地模型无需 API Key 即视为可用。 */
  validate(): boolean {
    return true;
  }
}
