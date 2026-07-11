/**
 * Message: 消息工厂工具
 */

import { IMessage, IToolCall, IToolResult, IImageContent } from '@codepapr/types';
import { generateUUID, deepFreeze, sortedStringify } from '@codepapr/common';

export class MessageFactory {
  static user(content: string, images?: IImageContent[]): IMessage {
    return deepFreeze({
      id: generateUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(images && images.length ? { images } : {}),
    }) as IMessage;
  }

  static assistant(
    content: string,
    toolCalls?: IToolCall[],
    reasoningContent?: string
  ): IMessage {
    return deepFreeze({
      id: generateUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      reasoningContent,
      toolCalls,
    }) as IMessage;
  }

  static tool(toolCallId: string, result: unknown, success: boolean = true): IMessage {
    const toolResult: IToolResult = { toolCallId, success, result };
    return deepFreeze({
      id: generateUUID(),
      role: 'tool',
      content: typeof result === 'string' ? result : sortedStringify(result),
      timestamp: Date.now(),
      toolResult,
    }) as IMessage;
  }

}
