/**
 * CacheValidator: 验证 API 响应的缓存一致性
 */

import {
  IChatRequest,
  IChatResponse,
  ICacheValidation,
  CacheConsistencyError,
} from '@codepapr/types';
import { Logger } from '@codepapr/common';
import { Serializer } from '@codepapr/core';
import { sha256 } from '@codepapr/common';

const log = new Logger('CacheValidator');

export class CacheValidator {
  /**
   * 验证响应并计算缓存命中率
   */
  validate(
    request: IChatRequest,
    response: IChatResponse,
    localPrefixHash: string,
    localLogHash: string
  ): ICacheValidation {
    const usage = response.usage ?? {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    };

    const hasOfficialPromptCacheStats =
      typeof usage.prompt_cache_hit_tokens === 'number' ||
      typeof usage.prompt_cache_miss_tokens === 'number';
    const promptCacheHitTokens = hasOfficialPromptCacheStats
      ? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0
      : undefined;
    const promptCacheMissTokens = hasOfficialPromptCacheStats
      ? usage.prompt_cache_miss_tokens ?? usage.input_tokens ?? 0
      : undefined;

    const cacheReadTokens = promptCacheHitTokens ?? usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    const newInputTokens = promptCacheMissTokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;

    if (request.metadata?.requestShapeHash) {
      const actualRequestShapeHash = sha256(
        Serializer.stringify({
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.reasoningContent
              ? { reasoningContent: message.reasoningContent }
              : {}),
            ...(message.toolCalls
              ? {
                  toolCalls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    name: toolCall.name,
                    arguments: Serializer.canonical(toolCall.arguments),
                  })),
                }
              : {}),
            ...(message.toolResult
              ? { toolCallId: message.toolResult.toolCallId }
              : {}),
          })),
          tools: request.tools
            ? [...request.tools]
                .map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: Serializer.canonical(tool.parameters),
                }))
                .sort((left, right) => left.name.localeCompare(right.name))
            : [],
        })
      );

      if (actualRequestShapeHash !== request.metadata.requestShapeHash) {
        throw new CacheConsistencyError(
          'Request shape changed between request build and response validation!'
        );
      }
    }

    // 验证哈希一致性
    if (request.metadata?.prefixHash && request.metadata.prefixHash !== localPrefixHash) {
      log.warn('Prefix hash mismatch in metadata vs local', {
        metadata: request.metadata.prefixHash.slice(0, 8),
        local: localPrefixHash.slice(0, 8),
      });
    }

    if (request.metadata?.logHash && request.metadata.logHash !== localLogHash) {
      throw new CacheConsistencyError(
        'Log hash changed between request build and response validation!'
      );
    }

    // 计算缓存命中率
    const totalInputTokens =
      cacheReadTokens + cacheCreationTokens + newInputTokens;
    const cacheHitRate =
      totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0;

    const result: ICacheValidation = {
      prefixCached: cacheReadTokens > 0,
      prefixCreated: cacheCreationTokens > 0,
      cacheReadTokens,
      cacheCreationTokens,
      newInputTokens,
      outputTokens,
      cacheHitRate,
      promptCacheHitTokens,
      promptCacheMissTokens,
    };

    log.info('Cache validation result', {
      hitRate: `${(cacheHitRate * 100).toFixed(2)}%`,
      cacheRead: cacheReadTokens,
      newInput: newInputTokens,
      output: outputTokens,
    });

    return result;
  }

  /**
   * 估算节省的成本（DeepSeek 缓存命中按 10% 计费）
   */
  estimateCostSavings(validation: ICacheValidation): {
    actualCost: number;
    estimatedFullCost: number;
    savings: number;
    savingsRate: number;
  } {
    // DeepSeek 价格（每百万 token，单位 USD）
    const PRICE_INPUT = 0.27;
    const PRICE_CACHE_HIT = 0.027; // 10% of input
    const PRICE_OUTPUT = 1.1;

    const actualCost =
      (validation.cacheReadTokens / 1_000_000) * PRICE_CACHE_HIT +
      (validation.newInputTokens / 1_000_000) * PRICE_INPUT +
      (validation.outputTokens / 1_000_000) * PRICE_OUTPUT;

    const estimatedFullCost =
      ((validation.cacheReadTokens + validation.newInputTokens) / 1_000_000) *
        PRICE_INPUT +
      (validation.outputTokens / 1_000_000) * PRICE_OUTPUT;

    const savings = estimatedFullCost - actualCost;
    const savingsRate = estimatedFullCost > 0 ? savings / estimatedFullCost : 0;

    return {
      actualCost,
      estimatedFullCost,
      savings,
      savingsRate,
    };
  }
}
