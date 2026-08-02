/**
 * 旧工具结果清理：在构建 LLM 请求时，把较早的工具结果替换为占位符。
 *
 * 设计参考 OpenCode 的 SessionCompaction.prune：
 *  - 从消息数组末尾向前遍历，按 assistant 消息计"轮次"
 *  - 超过 protectRecentRounds 的 tool 消息标记为可清理
 *  - protectedTools（如 todo、question）永不清理
 *  - 可清理总量 > minPrunableChars 时才执行
 *  - 只修改发给 LLM 的副本，不修改 AppendOnlyLog 原始数据
 */

import type { IMessage } from '@codepapr/types';
import { TOOL_SUMMARY_METADATA_KEY } from './toolOutputSummary';

export interface PruneOptions {
  enabled: boolean;
  protectRecentRounds: number;
  minPrunableChars: number;
  protectedTools: Set<string>;
  placeholder: string;
}

const SHORT_CONTENT_THRESHOLD = 200;

interface PrunableEntry {
  index: number;
  charCount: number;
}

export function pruneOldToolResults(
  messages: IMessage[],
  options: PruneOptions | undefined
): IMessage[] {
  if (!options?.enabled || messages.length === 0) {
    return messages;
  }

  const toolCallToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallToName.set(tc.id, tc.name);
      }
    }
  }

  let roundCount = 0;
  const prunable: PrunableEntry[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;

    if (msg.role === 'assistant') {
      roundCount++;
      continue;
    }

    if (msg.role !== 'tool' || !msg.toolResult) {
      continue;
    }

    if (roundCount <= options.protectRecentRounds) {
      continue;
    }

    const toolName = toolCallToName.get(msg.toolResult.toolCallId);
    if (toolName && options.protectedTools.has(toolName)) {
      continue;
    }

    const contentLength = msg.content?.length ?? 0;
    if (contentLength < SHORT_CONTENT_THRESHOLD) {
      continue;
    }

    prunable.push({ index: i, charCount: contentLength });
  }

  const totalPrunableChars = prunable.reduce((sum, e) => sum + e.charCount, 0);
  if (totalPrunableChars < options.minPrunableChars) {
    return messages;
  }

  const prunedSet = new Set(prunable.map((e) => e.index));
  return messages.map((msg, i) => {
    if (!prunedSet.has(i)) return msg;
    // Drop the frozen history summary (if any) so a later summarization pass
    // cannot resurrect a pruned result: placeholder < summary < full.
    let metadata: Record<string, unknown> | undefined;
    if (msg.metadata) {
      metadata = { ...msg.metadata };
      delete metadata[TOOL_SUMMARY_METADATA_KEY];
      if (Object.keys(metadata).length === 0) metadata = undefined;
    }
    return {
      ...msg,
      content: options.placeholder,
      toolResult: { ...msg.toolResult!, result: options.placeholder },
      metadata,
    };
  });
}
