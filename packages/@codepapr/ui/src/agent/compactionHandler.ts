import type { ICacheStatistics, IMessage } from '@codepapr/types';
import {
  renderTodoListDigest,
  type ContextCompactionConfig,
  type PruneOptions,
} from '@codepapr/core';
import {
  buildEffectiveContextMessages,
  type ContextMessageLike,
} from '../utils/contextCompaction';
import { maybeGenerateContextCheckpoint } from '../store/internals/contextCheckpoint';
import { effectiveMaxContextTokens, type ContextProvider } from '../utils/contextLimits';
import { getTodoListContext } from '../tools/todoListTool';
import type { Settings, UIMessage, UIToolInvocation } from '../store/internals/types';

const PRUNE_PROTECTED_TOOLS = new Set(['todo', 'question', 'skill']);

/** Prune options used when building the compacted context (shared with the
 *  rebuild-time pruning in agentFactory). */
export function buildPruneOptions(settings: Settings): PruneOptions {
  return {
    enabled: settings.pruneOldToolResults,
    protectRecentRounds: settings.pruneProtectRounds,
    minPrunableChars: settings.pruneMinChars,
    protectedTools: PRUNE_PROTECTED_TOOLS,
    placeholder: '[Old tool result content cleared]',
  };
}

/**
 * Convert core log messages (IMessage, with toolCalls/toolResult) into the
 * ui-layer ContextMessageLike shape (with toolInvocations) that the compaction
 * pipeline consumes. Tool results are re-attached to their assistant's
 * toolInvocations (matched by toolCallId); the standalone tool messages are then
 * skipped so the round-trip back through toCoreTailMessages is wire-faithful
 * (the tool message `content` is preserved verbatim).
 */
export function coreMessagesToContextMessages(coreMessages: IMessage[]): ContextMessageLike[] {
  const toolByCallId = new Map<string, IMessage>();
  for (const msg of coreMessages) {
    if (msg.role === 'tool' && msg.toolResult) {
      toolByCallId.set(msg.toolResult.toolCallId, msg);
    }
  }

  const result: ContextMessageLike[] = [];
  for (const msg of coreMessages) {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const toolInvocations: UIToolInvocation[] = msg.toolCalls.map((tc) => {
        const toolMsg = toolByCallId.get(tc.id);
        const success = toolMsg?.toolResult?.success ?? false;
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: success ? 'success' : 'error',
          output: typeof toolMsg?.content === 'string' ? toolMsg.content : '',
          error: toolMsg?.toolResult?.error,
        };
      });
      result.push({
        id: msg.id,
        role: 'assistant',
        content: msg.content,
        reasoningContent: msg.reasoningContent,
        toolInvocations,
        timestamp: msg.timestamp,
      });
      continue;
    }

    // Standalone tool messages are represented via the preceding assistant's
    // toolInvocations; skip them (orphans are dropped).
    if (msg.role === 'tool') {
      continue;
    }

    result.push({
      id: msg.id,
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
      reasoningContent: msg.reasoningContent,
      images: msg.images,
      timestamp: msg.timestamp,
    });
  }

  return result;
}

function currentTodoDigest(sessionId: string): string | undefined {
  const ctx = getTodoListContext(sessionId);
  if (!ctx || ctx.tasks.length === 0) return undefined;
  return renderTodoListDigest(ctx);
}

/**
 * Build the mid-loop context-compaction config injected into the Agent.
 *
 * When the Agent's round-start estimate exceeds the effective context budget, it
 * calls `handler` with the current log messages; we run the same compaction the
 * UI uses between turns (checkpoint summary + pruning) and return the compacted
 * core messages, which the Agent swaps in as a new context epoch.
 */
export function createContextCompactionHandler(
  settings: Settings,
  providerName: ContextProvider,
  sessionId: string
): ContextCompactionConfig {
  return {
    maxContextTokens: effectiveMaxContextTokens(settings, providerName),
    handler: async (
      coreMessages: IMessage[]
    ): Promise<{ messages: IMessage[]; cacheStats?: ICacheStatistics } | null> => {
      const contextMessages = coreMessagesToContextMessages(coreMessages);
      const checkpoint = await maybeGenerateContextCheckpoint(
        settings,
        contextMessages as unknown as UIMessage[],
        true,
        currentTodoDigest(sessionId)
      );
      if (!checkpoint) {
        return null;
      }
      const compacted = buildEffectiveContextMessages(
        [...contextMessages, checkpoint.message as unknown as ContextMessageLike],
        { pruneOptions: buildPruneOptions(settings) }
      );
      return { messages: compacted, cacheStats: checkpoint.cacheStats };
    },
  };
}
