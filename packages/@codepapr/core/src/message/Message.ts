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

// reRecallInsertion（ADR-009 第13条）：request-only augmentation，绝不允许
// 随工具结果进入 AppendOnlyLog / archive / 搜索 / checkpoint。
const INTERNAL_FIELDS = new Set(['__images', '__question', 'reRecallInsertion']);

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

/**
 * 转录投影：保留 `__images` 条目（mediaType/path 等元数据）但把 base64
 * `data` 置空。用于工具结果进入 UI 转录/持久化链路的 `output` 字段——
 * 当轮模型视觉走日志里的独立图片消息（真实 base64，仅存内存），
 * 而转录只留可溯源的路径引用，杜绝大体积 base64 撑爆 DB 与兼容快照。
 * 无 path 的条目（落盘失败的生成类图片）数据即不可恢复，仅保留 mediaType。
 */
export function redactImagePayloadsForTranscript(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactImagePayloadsForTranscript);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__images' && Array.isArray(inner)) {
        result[key] = (inner as unknown[]).map((img) => {
          if (img && typeof img === 'object' && 'data' in (img as Record<string, unknown>)) {
            return { ...(img as Record<string, unknown>), data: '' };
          }
          return img;
        });
      } else {
        result[key] = redactImagePayloadsForTranscript(inner);
      }
    }
    return result;
  }
  return value;
}

/**
 * 字符串 output 的转录 redact：修复前的存量转录把 `__images` base64 直接
 * 嵌在工具结果 JSON 字符串里。能 parse 且含 `__images` 才重写，否则原样
 * 返回（字节稳定优先——output 参与重建历史的请求编译）。
 */
export function redactTranscriptOutputString(output: string): string {
  if (!output.includes('"__images"')) return output;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object') return output;
    return JSON.stringify(redactImagePayloadsForTranscript(parsed));
  } catch {
    return output;
  }
}
