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
import { Serializer, applyHistoryToolSummaries, normalizeToolCallRuns, stripConsumedImages } from '@codepapr/core';
import { DEFAULT_MAX_TOKENS, sanitizeMaxTokens, getProviderContextLimit } from '../tokenLimits';

const log = new Logger('RequestBuilder');

interface BuildOptions {
  prefix: IImmutablePrefix;
  appendLog: IAppendOnlyLog;
  model: string;
  provider: 'deepseek' | 'openai' | 'claude' | 'response';
  thinking?: IChatThinking;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: IToolDefinition[];
  /** 仅影响本次请求的临时尾部消息（不写入 appendLog、不参与 logHash）。
   *  用于输出被 max_tokens 截断后的自动续写：把已输出的部分 assistant 内容 +
   *  「继续」指令追加到请求尾部，让模型从截断处续写。 */
  suffixMessages?: IMessage[];
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
    // 由 ImmutablePrefix 构造器统一把关（含 allowTemplateLiterals 豁免），
    // 此处不再重复正则校验：重复校验会复现字面示例文本（如 "${name}"）的
    // 误报，且对已通过构造校验的前缀毫无增益。

    // ✅ 检查 2: 工具定义未变化
    const prefixTools = opts.prefix.getToolDefinitions();
    this.validateToolsImmutable(prefixTools);
    this.validateRuntimeToolsMatchPrefix(opts.tools, prefixTools);

    // ✅ 检查 3: 日志只追加
    this.validateAppendOnly(opts.appendLog);

    // ✅ 检查 4: 前缀未变化
    this.validatePrefixUnchanged(opts.prefix);

    // ✅ 检查 5: 构造消息数组（前缀 + 日志 [+ 临时续写尾部]）
    const prefixMessages = opts.prefix.toMessageArray();
    const logMessages = opts.appendLog.toMessageArray();
    let messages = [...prefixMessages, ...logMessages, ...(opts.suffixMessages ?? [])];

    // Tool-call continuity guard: legacy/interrupted histories can contain a
    // non-tool message between an assistant's tool_calls and its tool results
    // (e.g. the synthesized `[Image from tool ...]` user message) or a missing
    // result. OpenAI/DeepSeek reject those with HTTP 400. Deterministic repair
    // on the request copy only; live and rebuild paths share this function.
    messages = normalizeToolCallRuns(messages);

    // Strip images from consumed user messages
    // Only the LAST user message with images keeps them; all earlier ones are stripped.
    // This prevents old base64 data from bloating every subsequent request.
    messages = stripConsumedImages(messages);

    // Tool context mode: replace tool messages carrying a frozen summary
    // (metadata.toolSummary) with that summary, EXCEPT the latest tool batch
    // (which the LLM just received and is reasoning about). The full content
    // stays in the AppendOnlyLog; only this request copy is rewritten.
    //
    // The rule is a pure function of the message array (no build-history
    // state), so the live path and the rebuild path produce byte-identical
    // requests. Each tool message flips exactly once (the round after it
    // leaves the latest batch), so this costs one prefix-cache invalidation
    // per message — not the per-round break the old sliding-window prune
    // caused (its flip point sat N rounds back, invalidating the whole
    // protected window every round).
    messages = applyHistoryToolSummaries(messages);

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
    // 必须与 ImmutablePrefix.canonicalToolDefinition 保持同一归一化规则：
    // required 数组排序后参与哈希。否则「运行时传入的 required 顺序与冻结
    // 前缀不同」会误报 CacheConsistencyError（工具定义并未变化）。
    return sha256(
      Serializer.stringify(
        [...tools]
          .map((tool) => {
            const parameters = Serializer.canonical(
              tool.parameters
            ) as IToolDefinition['parameters'];
            return {
              name: tool.name,
              description: tool.description,
              parameters: {
                ...parameters,
                required: parameters.required
                  ? [...parameters.required].sort()
                  : undefined,
              },
            };
          })
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
