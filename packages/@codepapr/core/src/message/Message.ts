/**
 * Message: 消息工厂工具
 */

import { IMessage, IToolCall, IToolResult, IImageContent } from '@codepapr/types';
import { generateUUID, deepFreeze, sortedStringify } from '@codepapr/common';

export class MessageFactory {
  /** PR1（ADR-009 前置）：user 消息 ID 由主线程生成并贯穿 log，作为
   *  recall anchor 与 surface 引用的稳定 ID；缺省时回退 UUID。 */
  static user(content: string, images?: IImageContent[], id?: string): IMessage {
    return deepFreeze({
      id: id || generateUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(images && images.length ? { images } : {}),
    }) as IMessage;
  }

  static assistant(
    content: string,
    toolCalls?: IToolCall[],
    reasoningContent?: string,
    durationMs?: number
  ): IMessage {
    return deepFreeze({
      id: generateUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      reasoningContent,
      toolCalls,
      ...(typeof durationMs === 'number' && durationMs > 0 ? { durationMs } : {}),
    }) as IMessage;
  }

  static tool(
    toolCallId: string,
    result: unknown,
    success: boolean = true,
    metadata?: Record<string, unknown>,
    durationMs?: number
  ): IMessage {
    const cleanedResult =
      typeof result === 'string' ? result : stripInternalFields(result);
    const toolResult: IToolResult = { toolCallId, success, result: cleanedResult };
    const content =
      typeof cleanedResult === 'string'
        ? cleanedResult
        : sortedStringify(cleanedResult);
    return deepFreeze({
      id: generateUUID(),
      role: 'tool',
      content,
      timestamp: Date.now(),
      toolResult,
      ...(metadata ? { metadata } : {}),
      ...(typeof durationMs === 'number' && durationMs > 0 ? { durationMs } : {}),
    }) as IMessage;
  }
}

const INTERNAL_FIELDS = new Set(['__images', '__question']);

export function stripInternalFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(stripInternalFields);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!INTERNAL_FIELDS.has(key)) {
        result[key] = stripInternalFields((value as Record<string, unknown>)[key]);
      }
    }
    return result;
  }
  return value;
}
