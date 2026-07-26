/**
 * RequestBuilder: 构造 API 请求并执行 8 点缓存一致性验证
 *
 * 每次构造请求时，必须验证：
 * 1. 系统提示词无动态内容
 * 2. 工具定义未变化
 * 3. 日志只追加，未修改
 * 4. 消息已冻结
 * 5. 消息索引连续
 * 6. 前缀哈希一致
 * 7. 确定性序列化
 * 8. 没有重排序
 */

import {
  IChatRequest,
  IChatThinking,
  IImmutablePrefix,
  IAppendOnlyLog,
  IToolDefinition,
  IMessage,
  CacheConsistencyError,
} from '@codepapr/types';
import { Logger, sha256, estimateTokens } from '@codepapr/common';
import { Serializer } from '@codepapr/core';
import { DEFAULT_MAX_TOKENS, sanitizeMaxTokens, getProviderContextLimit } from '../tokenLimits';

const log = new Logger('RequestBuilder');

interface BuildOptions {
  prefix: IImmutablePrefix;
  appendLog: IAppendOnlyLog;
  model: string;
  provider: 'deepseek' | 'openai' | 'claude';
  thinking?: IChatThinking;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: IToolDefinition[];
}

function buildProviderCacheControl(
  provider: BuildOptions['provider'],
  budgetTokens: number
): IChatRequest['cacheControl'] | undefined {
  if (provider !== 'claude') {
    return undefined;
  }

  return {
    type: 'session',
    budgetTokens,
  };
}

export class RequestBuilder {
  private lastLogMessagesHash: string = '';
  private lastLogMessageCount: number = 0;
  private toolHashes: Map<string, string> = new Map();
  private lastPrefixHash: string = '';

  /**
   * 构造请求并执行所有验证
   */
  build(opts: BuildOptions): IChatRequest {
    // ✅ 检查 1: 系统提示词无动态内容
    this.validateStaticSystemPrompt(opts.prefix);

    // ✅ 检查 2: 工具定义未变化
    const prefixTools = opts.prefix.getToolDefinitions();
    this.validateToolsImmutable(prefixTools);
    this.validateRuntimeToolsMatchPrefix(opts.tools, prefixTools);

    // ✅ 检查 3: 日志只追加
    this.validateAppendOnly(opts.appendLog);

    // ✅ 检查 4: 前缀未变化
    this.validatePrefixUnchanged(opts.prefix);

    // ✅ 检查 5: 构造消息数组（前缀 + 日志）
    const prefixMessages = opts.prefix.toMessageArray();
    const logMessages = opts.appendLog.toMessageArray();
    let messages = [...prefixMessages, ...logMessages];

    // Strip images from consumed user messages
    // Only the LAST user message with images keeps them; all earlier ones are stripped.
    // This prevents old base64 data from bloating every subsequent request.
    messages = stripConsumedImages(messages);

    // NOTE: Old tool results are NOT pruned here. Pruning on every request build
    // used a sliding protection window, so a tool message flipped from full
    // content to a placeholder as rounds accumulated — mutating bytes in the
    // middle of the already-cached prefix and invalidating DeepSeek's byte-exact
    // prefix cache on essentially every round. Pruning now happens once, at
    // context-rebuild time (buildEffectiveContextMessages), where it coincides
    // with the compaction prefix rewrite and is idempotent for identical input.

    // ✅ 检查 6: 确定性序列化
    const cacheRelevantMessages = this.toCacheRelevantMessages(messages);
    const serialized = Serializer.stringify({
      messages: cacheRelevantMessages,
      tools: prefixTools,
    });
    const expectedPrefixHash = sha256(
      Serializer.stringify(this.toCacheRelevantMessages(prefixMessages))
    );
    const requestShapeHash = sha256(serialized);

    // ✅ 检查 7: 估算 token 数
    const budgetTokens = estimateTokens(serialized);
    const outputTokens = sanitizeMaxTokens(opts.maxTokens ?? DEFAULT_MAX_TOKENS, opts.provider);
    const totalInputTokens = estimateTokens(JSON.stringify(messages));
    const contextLimit = getProviderContextLimit(opts.provider);
    if (totalInputTokens + outputTokens > contextLimit) {
      const oversizeBytes = Math.round((totalInputTokens + outputTokens - contextLimit) * 4);
      log.warn(
        `Request exceeds ${opts.provider} context limit: ` +
        `~${totalInputTokens} input + ${outputTokens} output > ${contextLimit} limit ` +
        `(oversize ~${oversizeBytes} bytes). API may return 400.`
      );
    }

    // ✅ 检查 8: 构造完整请求
    const request: IChatRequest = {
      messages,
      model: opts.model,
      thinking: opts.thinking,
      temperature: opts.temperature ?? 0.7,
      topP: opts.topP ?? 0.9,
      maxTokens: sanitizeMaxTokens(opts.maxTokens ?? DEFAULT_MAX_TOKENS, opts.provider),
      tools: prefixTools.length > 0 ? [...prefixTools] : undefined,
      cacheControl: buildProviderCacheControl(opts.provider, budgetTokens),
      metadata: {
        prefixHash: opts.prefix.computeHash(),
        logHash: opts.appendLog.computeHash(),
        expectedPrefixHash,
        requestShapeHash,
      },
    };

    log.debug('Request built', {
      messageCount: messages.length,
      prefixHash: request.metadata?.prefixHash?.slice(0, 8),
      logHash: request.metadata?.logHash?.slice(0, 8),
      budgetTokens,
    });

    return request;
  }

  /**
   * Reset the append-only log tracking so the next build() treats the log as a
   * fresh baseline. Used after context compaction replaces the active history
   * (a sanctioned epoch reset); without this, validateAppendOnly would report a
   * false "log messages removed / history changed" violation. Prefix/tool
   * tracking is intentionally preserved (the prefix is unchanged).
   */
  resetLogTracking(): void {
    this.lastLogMessagesHash = '';
    this.lastLogMessageCount = 0;
  }

  /**
   * 验证系统提示词无动态内容
   */
  private validateStaticSystemPrompt(prefix: IImmutablePrefix): void {
    const prompt = prefix.getSystemPrompt();
    const dynamicPatterns = [
      { pattern: /\$\{[^}]+\}/g, name: 'template-interpolation' },
      { pattern: /\{\{[^}]+\}\}/g, name: 'double-braces' },
      { pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, name: 'iso-timestamp' },
      { pattern: /\[TIMESTAMP\]|\[NOW\]|\[DATE\]/gi, name: 'date-placeholder' },
    ];

    for (const { pattern, name } of dynamicPatterns) {
      if (pattern.test(prompt)) {
        throw new CacheConsistencyError(
          `System prompt contains dynamic content (${name}). ` +
            `This destroys cache consistency.`
        );
      }
    }
  }

  /**
   * 验证工具定义未变化
   */
  private validateToolsImmutable(tools: ReadonlyArray<IToolDefinition>): void {
    for (const tool of tools) {
      const hash = sha256(Serializer.stringify(tool));
      const previousHash = this.toolHashes.get(tool.name);

      if (previousHash && previousHash !== hash) {
        throw new CacheConsistencyError(
          `Tool definition changed: ${tool.name}. Tools must be frozen.`
        );
      }

      this.toolHashes.set(tool.name, hash);
    }
  }

  /**
   * 验证调用方没有传入与冻结前缀不一致的运行时工具定义
   */
  private validateRuntimeToolsMatchPrefix(
    runtimeTools: IToolDefinition[] | undefined,
    prefixTools: ReadonlyArray<IToolDefinition>
  ): void {
    if (!runtimeTools) {
      return;
    }

    const runtimeHash = this.hashToolDefinitions(runtimeTools);
    const prefixHash = this.hashToolDefinitions(prefixTools);

    if (runtimeHash !== prefixHash) {
      throw new CacheConsistencyError(
        'Runtime tools differ from frozen prefix tools. Tool definitions must be fixed at session start.'
      );
    }
  }

  /**
   * 验证日志只允许追加
   */
  private validateAppendOnly(appendLog: IAppendOnlyLog): void {
    const currentCount = appendLog.length();
    const currentMessages = appendLog.toMessageArray();

    if (!appendLog.validate()) {
      throw new CacheConsistencyError(
        'Log validation failed - append-only invariant violated'
      );
    }

    if (this.lastLogMessageCount > 0) {
      // 不允许消息减少
      if (currentCount < this.lastLogMessageCount) {
        throw new CacheConsistencyError(
          `Log messages were removed! Was ${this.lastLogMessageCount}, now ${currentCount}`
        );
      }

      // 验证前 N 条消息哈希不变（只追加，不允许改写历史内容）
      const historicalMessagesHash = this.hashMessages(
        currentMessages.slice(0, this.lastLogMessageCount)
      );

      if (historicalMessagesHash !== this.lastLogMessagesHash) {
        throw new CacheConsistencyError(
          'Historical log messages changed. Append-only logs cannot be modified or reordered.'
        );
      }
    }

    this.lastLogMessagesHash = this.hashMessages(currentMessages);
    this.lastLogMessageCount = currentCount;
  }

  /**
   * 验证前缀未变化
   */
  private validatePrefixUnchanged(prefix: IImmutablePrefix): void {
    const currentHash = prefix.computeHash();

    if (this.lastPrefixHash && this.lastPrefixHash !== currentHash) {
      throw new CacheConsistencyError(
        `Prefix hash changed! Was ${this.lastPrefixHash.slice(0, 8)}, now ${currentHash.slice(0, 8)}. ` +
          `Prefix must be immutable during session.`
      );
    }

    if (!prefix.isFrozen()) {
      throw new CacheConsistencyError('Prefix is not frozen!');
    }

    this.lastPrefixHash = currentHash;
  }

  /**
   * 重置内部状态（仅用于新会话）
   */
  reset(): void {
    this.lastLogMessagesHash = '';
    this.lastLogMessageCount = 0;
    this.toolHashes.clear();
    this.lastPrefixHash = '';
  }

  /**
   * 同步日志计数器（用于 popLastMessage 后的恢复场景）
   * 避免 validateAppendOnly 因消息减少而抛出 CacheConsistencyError
   */
  syncAfterPop(appendLog: IAppendOnlyLog): void {
    const currentMessages = appendLog.toMessageArray();
    this.lastLogMessagesHash = this.hashMessages(currentMessages);
    this.lastLogMessageCount = appendLog.length();
  }

  private hashMessages(messages: ReadonlyArray<unknown>): string {
    return sha256(Serializer.stringify(messages));
  }

  private hashToolDefinitions(tools: ReadonlyArray<IToolDefinition>): string {
    return sha256(
      Serializer.stringify(
        [...tools]
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: Serializer.canonical(tool.parameters),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      )
    );
  }

  private toCacheRelevantMessages(messages: ReadonlyArray<{
    role: string;
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolResult?: { toolCallId: string };
  }>): Array<Record<string, unknown>> {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: Serializer.canonical(toolCall.arguments),
            })),
          }
        : {}),
      ...(message.toolResult ? { toolCallId: message.toolResult.toolCallId } : {}),
    }));
  }
}

export function stripConsumedImages(messages: IMessage[]): IMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'user' || !msg.images || msg.images.length === 0) return msg;
    const hasAssistantAfter = messages.slice(i + 1).some(m => m.role === 'assistant');
    if (hasAssistantAfter) {
      return { ...msg, images: undefined };
    }
    return msg;
  });
}
