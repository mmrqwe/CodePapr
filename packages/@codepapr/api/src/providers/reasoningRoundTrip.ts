/**
 * reasoningRoundTrip: DeepSeek thinking 模式 reasoning_content 回传规则
 *
 * DeepSeek 官方要求（Thinking Mode → Tool Calls）：
 * - 请求开启 thinking 且携带 tools 时，历史中所有带 tool_calls 的 assistant
 *   消息必须携带**非空** reasoning_content 回传，否则 API 返回 400
 *   （"The reasoning_content in the thinking mode must be passed back to the API."）。
 * - 经 opencode Console Go 中继转发时，缺失的 reasoning 会被补成空字符串，
 *   依然被上游拒绝 —— 因此中继侧无解，必须由客户端保证回传。
 *
 * 规则（与 thinking 开关解耦）：
 * 1) 带 tool_calls 且存有 reasoning 的 assistant 消息必须回传（无论 thinking 开关、
 *    无论模型是否支持 thinking 载荷）。
 * 2) 不带 tool_calls 的 assistant 消息在模型支持 thinking 载荷时回传已存 reasoning。
 * 3) 带 tool_calls 但缺失 reasoning 的 assistant 消息（模型跳过思考、旧会话、
 *    中继丢字段等）注入占位符，避免 API 400 且不降级 thinking。
 *
 * 占位符设计（重要）：
 * - 必须是**存储消息的纯函数**（只用首个工具名）：同一条历史消息在任意一轮
 *   请求中生成的字节完全一致，前缀缓存按字节匹配，确定性是缓存命中的前提。
 * - 禁止拼入参数/时间戳等可变内容：参数序列化漂移会击穿前缀缓存，且带参数
 *   的假推理更容易被模型照抄出错误内容。
 * - 文本写成自然推理句式：历史中大量占位符会被模型模仿（实测会把占位符当作
 *   新回复的 reasoning_content 回声回来）。旧的错误标记式字面量
 *   `[reasoning not captured]` 已废弃，仅保留识别用。
 * - 回声并非无害：长工具循环中模型可能退化成**只输出回声句**（无内容、无
 *   工具调用），若被当作有效思考放行，回合将静默终止。因此响应侧统一剥离
 *   占位符回声（stripReasoningPlaceholderEchoes）：被剥离的消息按「缺失
 *   reasoning」处理，下次请求注入字节一致的占位符，前缀缓存行为不变。
 *
 * 兜底：若注入占位符后仍被 API 拒绝（极小概率），withReasoningRoundTripFallback
 * 会以 thinking 关闭重试一次 —— 仅此一种情况降级，且不改变任何持久状态，
 * 下一条消息自动恢复 thinking。
 */

import type { IChatRequest, IMessage } from '@codepapr/types';
import { sortedStringify } from '@codepapr/common';
import { buildOpenAIImageContent } from './imageContent';
import { sanitizeToolCallArguments } from './streaming';

/** 已废弃的旧占位符字面量：仅用于识别历史会话/模型回声，禁止再注入。 */
export const LEGACY_REASONING_PLACEHOLDER = '[reasoning not captured]';

/** 缺失工具名时的回退占位句（固定常量，同样字节稳定）。 */
export const REASONING_PLACEHOLDER_FALLBACK = 'Proceeding with the next tool call.';

/** 占位符模板句的回声形态：`Called ${toolName} to proceed.`（见
 *  buildReasoningPlaceholder）。回声与注入的占位符逐字节相同，按模板精确匹配。 */
const PLACEHOLDER_ECHO_PATTERN = /^Called [\w.-]+ to proceed\.$/;

/** 识别旧占位符（trim 后精确匹配）：历史会话回传或模型回声都会命中。 */
export function isLegacyReasoningPlaceholder(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trim() === LEGACY_REASONING_PLACEHOLDER;
}

/**
 * 识别占位符回声（任意一代，trim 后精确匹配）：旧字面量、模板句、回退句。
 * 模型会把历史中注入的占位符鹦鹉学舌成自己的 reasoning_content；回声不是
 * 有效思考——长工具循环中模型可能退化成只输出回声句（无内容/无工具调用），
 * 持久化后还会继续污染上下文。
 */
export function isReasoningPlaceholderEcho(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    trimmed === LEGACY_REASONING_PLACEHOLDER ||
    trimmed === REASONING_PLACEHOLDER_FALLBACK ||
    PLACEHOLDER_ECHO_PATTERN.test(trimmed)
  );
}

/**
 * 清洗响应中的 reasoning_content：占位符回声（历史会话回传或注入占位符被
 * 模型鹦鹉学舌回来的）视为无效推理置空，避免渲染/持久化/再回声的循环。
 * 被剥离的 assistant 消息按「缺失 reasoning」处理：下次请求回传时注入
 * 字节一致的占位符，前缀缓存行为不变。
 */
export function stripReasoningPlaceholderEchoes(
  reasoningContent: string | undefined
): string | undefined {
  if (!reasoningContent || isReasoningPlaceholderEcho(reasoningContent)) {
    return undefined;
  }
  return reasoningContent;
}

/**
 * 为缺失 reasoning 的工具轮生成占位符。
 * 纯函数：只取首个 tool call 的名称，同一消息任意轮次生成结果字节一致。
 */
export function buildReasoningPlaceholder(message: IMessage): string {
  const toolName = message.toolCalls?.[0]?.name;
  if (typeof toolName === 'string' && toolName.trim().length > 0) {
    return `Called ${toolName.trim()} to proceed.`;
  }
  return REASONING_PLACEHOLDER_FALLBACK;
}

function hasNonEmptyReasoning(message: IMessage): boolean {
  return typeof message.reasoningContent === 'string' && message.reasoningContent.length > 0;
}

export function isToolCallAssistant(message: IMessage): boolean {
  return message.role === 'assistant' && !!message.toolCalls && message.toolCalls.length > 0;
}

/** 历史中带 tool_calls 但没有非空 reasoning 的 assistant 消息（API 400 的根因）。 */
export function isToolCallAssistantLackingReasoning(message: IMessage): boolean {
  return isToolCallAssistant(message) && !hasNonEmptyReasoning(message);
}

/**
 * 识别 DeepSeek 的 reasoning 回传校验 400：
 * 覆盖 Console Go 中继包装（"...reasoning_content... must be passed back..."）
 * 与旧版 deepseek-reasoner 的 "Load fail" 错误。
 */
export function isReasoningRoundTripError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    /reasoning_content/i.test(message) &&
    /passed back|must be returned|must be passed|required|Load fail/i.test(message)
  );
}

export interface ReasoningRoundTripOptions {
  /**
   * 模型是否支持 thinking 载荷。legacy reasoner 等不支持 thinking 载荷的模型
   * 不回传、不注入 reasoning_content（与旧行为一致；带 tool_calls 且存有
   * reasoning 的消息仍必须回传，不受此开关限制）。
   */
  supportsThinkingPayload: boolean;
}

/**
 * 计算单条 assistant 消息应回传的 reasoning_content 字段值。
 */
export function resolveReasoningContent(
  message: IMessage,
  opts: ReasoningRoundTripOptions
): string | undefined {
  if (isToolCallAssistant(message)) {
    if (hasNonEmptyReasoning(message)) return message.reasoningContent;
    return opts.supportsThinkingPayload ? buildReasoningPlaceholder(message) : undefined;
  }
  if (opts.supportsThinkingPayload && message.role === 'assistant' && hasNonEmptyReasoning(message)) {
    return message.reasoningContent;
  }
  return undefined;
}

/**
 * 构造发送给 API 的 messages 数组（OpenAI 兼容格式）：
 * 统一处理 content 多模态映射、reasoning_content 回传/占位注入、tool_calls
 * 稳定序列化与 tool_call_id。
 */
export function buildOpenAICompatibleMessages(
  request: IChatRequest,
  opts: ReasoningRoundTripOptions
): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    const reasoningContent = resolveReasoningContent(message, opts);
    return {
      role: message.role,
      content: buildOpenAIImageContent(message.content, message.images) ?? message.content,
      ...(reasoningContent !== undefined && { reasoning_content: reasoningContent }),
      ...(message.toolCalls &&
        message.toolCalls.length > 0 && {
          tool_calls: message.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: sortedStringify(sanitizeToolCallArguments(tc.arguments)),
            },
          })),
        }),
      ...(message.toolResult && {
        tool_call_id: message.toolResult.toolCallId,
      }),
    };
  });
}

/**
 * 对单个请求执行 run；若命中 reasoning 回传校验 400 且本请求 thinking 开启，
 * 自动以 thinking 关闭重试一次（占位符方案的兜底）。重试不修改任何持久状态，
 * 下一条消息自动恢复 thinking。
 */
export async function withReasoningRoundTripFallback<T>(
  request: IChatRequest,
  run: (effective: IChatRequest) => Promise<T>,
  onFallback: (err: Error) => void,
  shouldFallback: (err: Error) => boolean = (err) =>
    isReasoningRoundTripError(err) && request.thinking?.type === 'enabled'
): Promise<T> {
  try {
    return await run(request);
  } catch (err) {
    if (shouldFallback(err as Error)) {
      onFallback(err as Error);
      return await run({ ...request, thinking: { type: 'disabled' } });
    }
    throw err;
  }
}
