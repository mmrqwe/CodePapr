import type { ICacheStatistics, IMessage } from '@codepapr/types';
import {
  renderTodoListDigest,
  TOOL_SUMMARY_METADATA_KEY,
  type ContextCompactionConfig,
} from '@codepapr/core';
import {
  buildEffectiveContextMessages,
  insertCheckpointAtRetainedBoundary,
  type ContextMessageLike,
} from '../utils/contextCompaction';
import { COMPACT_TRIGGER_RATIO } from '@codepapr/core';
import { isModelVisibleUiMessage, SESSION_BOOTSTRAP_MESSAGE_ID } from '../utils/contextSurface';
import { maybeGenerateContextCheckpoint } from '../store/internals/contextCheckpoint';
import { effectiveMaxContextTokens, type ContextProvider } from '../utils/contextLimits';
import { getTodoListContext } from '../tools/todoListRegistry';
import type { CompactionSettings, UIToolInvocation } from '../store/internals/types';
import type { MidLoopCompactionCommit } from './agentWorkerProtocol';

/** v4：prune 层已随骨架引擎删除（buildEffectiveContextMessages 不再裁剪；
 *  工具结果只存在于逐字 tail 内，单条巨型输出由入口护栏约束）。 */

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
        const frozenSummary = toolMsg?.metadata?.[TOOL_SUMMARY_METADATA_KEY];
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: success ? 'success' : 'error',
          output: typeof toolMsg?.content === 'string' ? toolMsg.content : '',
          error: toolMsg?.toolResult?.error,
          ...(typeof frozenSummary === 'string' ? { contextSummary: frozenSummary } : {}),
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
      ...(msg.id === SESSION_BOOTSTRAP_MESSAGE_ID || msg.metadata?.sessionBootstrap === true
        ? { sessionBootstrap: true }
        : {}),
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
 * Build the session-bootstrap log message (log[0] shape) carrying a freshly
 * rendered bootstrap. Mid-loop compaction drops the original bootstrap (it sits
 * before the checkpoint and is summarized away); re-injecting a fresh one here
 * restores the MEMORY.md-rendered memory / skills / plugins into the new epoch.
 * The epoch is already being reset, so this adds no extra prefix-cache break.
 */
export function buildSessionBootstrapMessage(bootstrap: string): IMessage {
  return {
    id: SESSION_BOOTSTRAP_MESSAGE_ID,
    role: 'assistant',
    content: bootstrap,
    timestamp: 1,
    metadata: {
      sessionBootstrap: true,
      isPrefixSystem: true,
    },
  };
}

/**
 * Build the mid-loop context-compaction config injected into the Agent.
 *
 * When the Agent's round-start estimate exceeds the effective context budget, it
 * calls `handler` with the current log messages; we run the same compaction the
 * UI uses between turns (checkpoint summary + pruning) and return the compacted
 * core messages, which the Agent swaps in as a new context epoch.
 *
 * `refreshBootstrap` (optional) re-reads MEMORY.md and rebuilds the session
 * bootstrap;
 * when it returns a non-empty string, the compacted epoch is prefixed with a
 * fresh bootstrap message so memory stays current across long sessions without
 * breaking the prefix cache (the epoch is reset anyway).
 */
export function createContextCompactionHandler(
  settings: CompactionSettings,
  providerName: ContextProvider,
  sessionId: string,
  refreshBootstrap?: () => Promise<string | null>,
  getAbortSignal?: () => AbortSignal | undefined,
  onCheckpoint?: (commit: MidLoopCompactionCommit) => void | Promise<void>,
  /** 本回合 user 消息 ID（主线程生成）：commit 的回合映射锚点。 */
  turnUserMessageId?: string
): ContextCompactionConfig {
  const hardBudget = effectiveMaxContextTokens(settings, providerName);
  // v4：单一触发线 = 窗口 × 90%（与 maybeGenerateContextCheckpoint 同源）；
  // reject-request 超限兜底保留。
  const triggerTokens = Math.floor(hardBudget * COMPACT_TRIGGER_RATIO);
  return {
    maxContextTokens: triggerTokens,
    handler: async (
      coreMessages: IMessage[],
      trigger?: import('@codepapr/types').CompactionTrigger
    ): Promise<{ messages: IMessage[]; cacheStats?: ICacheStatistics } | null> => {
      try {
        return await runCompactionHandler(
          settings,
          sessionId,
          coreMessages,
          refreshBootstrap,
          getAbortSignal?.(),
          onCheckpoint,
          trigger ?? 'token-limit',
          turnUserMessageId
        );
      } catch (err) {
        // 用户中断：mid-loop 压缩中飞被 abort → 返回 null 让 Agent 轮循环
        // 优雅收尾（轮首 aborted 检查立即 break），不把取消误报为压缩失败。
        if (err instanceof DOMException && err.name === 'AbortError') {
          return null;
        }
        throw err;
      }
    },
  };
}

async function runCompactionHandler(
  settings: CompactionSettings,
  sessionId: string,
  coreMessages: IMessage[],
  refreshBootstrap: (() => Promise<string | null>) | undefined,
  abortSignal: AbortSignal | undefined,
  onCheckpoint: ((commit: MidLoopCompactionCommit) => void | Promise<void>) | undefined,
  trigger: import('@codepapr/types').CompactionTrigger,
  turnUserMessageId?: string
): Promise<{ messages: IMessage[]; cacheStats?: ICacheStatistics } | null> {
  const contextMessages = coreMessagesToContextMessages(coreMessages);
  const checkpoint = await maybeGenerateContextCheckpoint(
    settings,
    contextMessages,
    true,
    currentTodoDigest(sessionId),
    abortSignal,
    // mid-loop 压缩：round 首溢出 → token-limit；provider 溢出恢复 → provider-overflow。
    { trigger },
    sessionId
  );
  if (!checkpoint || !('message' in checkpoint)) {
    return null;
  }
  // Insert the checkpoint at the planned retention boundary (not at the end)
  // so the recent tool-call tail follows it and stays verbatim in the rebuilt
  // context. Appending at the end would make buildEffectiveContextMessages
  // treat the tail as empty and drop the recent tool calls.
  const withCheckpoint = insertCheckpointAtRetainedBoundary(
    contextMessages,
    checkpoint.message,
    checkpoint.insertIndex
  );

  // PR1：把压缩提交数据交给主线程 Store 持久化（ADR-005）。
  // 必须 await：主线程校验失败则本轮不 replaceLog，避免 worker 已缩容但
  // archive/surface 未提交。
  if (onCheckpoint) {
    // 回合映射锚点：source 区间内、本回合 user 消息之后的 model-visible
    // assistant 回合数。retained 起点落在 worker-only 区域（本回合 assistant ID
    // 不在 archive）时，主线程据此在 UI 数组里按回合顺序定位插入边界。
    let sourceAssistantRoundsInTurn: number | undefined;
    if (turnUserMessageId) {
      const turnStartIndex = contextMessages.findIndex((m) => m.id === turnUserMessageId);
      if (turnStartIndex >= 0) {
        sourceAssistantRoundsInTurn = contextMessages
          .slice(turnStartIndex + 1, checkpoint.insertIndex)
          .filter((m) => m.role === 'assistant' && isModelVisibleUiMessage(m))
          .length;
      }
    }
    try {
      await onCheckpoint({
        checkpointMessageId: checkpoint.message.id,
        checkpointMessage: {
          id: checkpoint.message.id,
          role: 'assistant',
          content: checkpoint.message.content,
          timestamp: checkpoint.message.timestamp,
          synthetic: true,
          hidden: true,
          contextCheckpoint: checkpoint.message.contextCheckpoint,
        },
        insertIndex: checkpoint.insertIndex,
        sourceMessageIds: contextMessages
          .slice(0, checkpoint.insertIndex)
          .filter(isModelVisibleUiMessage)
          .map((message) => message.id),
        retainedMessageIds: contextMessages
          .slice(checkpoint.insertIndex)
          .filter(isModelVisibleUiMessage)
          .map((message) => message.id),
        ...(turnUserMessageId ? { turnUserMessageId } : {}),
        ...(typeof sourceAssistantRoundsInTurn === 'number'
          ? { sourceAssistantRoundsInTurn }
          : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      console.warn('[compaction] mid-loop 提交被主线程拒绝:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  const compacted = buildEffectiveContextMessages(withCheckpoint);
  if (refreshBootstrap) {
    try {
      const freshBootstrap = await refreshBootstrap();
      if (freshBootstrap && freshBootstrap.trim()) {
        return {
          messages: [buildSessionBootstrapMessage(freshBootstrap.trim()), ...compacted],
          cacheStats: checkpoint.cacheStats,
        };
      }
    } catch {
      // refresh 失败继续走下方兜底（非致命）
    }
    // v4：绝不允许「无 Bootstrap 的 epoch」——刷新拿不到新版时，沿用压缩前
    // 冻结的 bootstrap 消息（记忆段可能陈旧一帧，但整体前缀不会蒸发）。
    const frozenBootstrap = coreMessages.find(
      (m) => m.metadata?.sessionBootstrap === true || m.id === SESSION_BOOTSTRAP_MESSAGE_ID
    );
    if (frozenBootstrap && compacted[0]?.id !== frozenBootstrap.id) {
      return { messages: [frozenBootstrap, ...compacted], cacheStats: checkpoint.cacheStats };
    }
  }
  return { messages: compacted, cacheStats: checkpoint.cacheStats };
}
