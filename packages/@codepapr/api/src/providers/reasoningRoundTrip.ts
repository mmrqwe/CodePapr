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
 *   新回复的 reasoning_content 回声回来）；自然句式即使被模仿也无害。旧的
 *   错误标记式字面量 `[reasoning not captured]` 已废弃，仅保留识别用。
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

/** 识别旧占位符（trim 后精确匹配）：历史会话回传或模型回声都会命中。 */
export function isLegacyReasoningPlaceholder(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trim() === LEGACY_REASONING_PLACEHOLDER;
}

/**
 * 清洗响应中的 reasoning_content：旧占位符字面量（历史会话回传后被模型
 * 鹦鹉学舌回声回来的）视为无效推理置空，避免渲染/持久化/再回声的循环。
 * 新动态占位符无需过滤——即使被模仿也是无害的自然推理句式。
 */
export function stripLegacyReasoningPlaceholder(
  reasoningContent: string | undefined
): string | undefined {
  if (!reasoningContent || isLegacyReasoningPlaceholder(reasoningContent)) {
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
