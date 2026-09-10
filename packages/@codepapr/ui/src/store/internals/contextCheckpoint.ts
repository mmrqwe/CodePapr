import type { ICacheStatistics } from '@codepapr/types';
import { estimateTokens } from '@codepapr/common';
import { hasUnsettledTodoTasks } from '@codepapr/core';
import { createId } from '../../utils/createId';
import {
  computeCheckpointProvenanceRanges,
} from '../../utils/contextSurface';
import {
  CONTEXT_COMPACTION_SOFT_BUDGET_RATIO,
  getLatestCheckpoint,
  measureWireTokens,
  planContextCompaction,
  renderContextCheckpointContent,
  type ContextCheckpointPayload,
} from '../../utils/contextCompaction';
import {
  CONTEXT_CHECKPOINT_VERSION_3,
  createEmptyCheckpointStateV3,
  migrateContextCheckpointToV3,
  type ContextCheckpointStateV3,
} from '../../utils/contextCheckpointState';
import {
  buildStateMergePrompt,
  mergeContextStateDeterministic,
  parseContextCheckpointStateV3,
  renderContextCheckpointStateV3,
  validatePinnedStatePreserved,
} from '../../utils/contextStateMerge';
import { classifyContextMessages } from '../../utils/contextClassification';
import { getTodoListContext } from '../../tools/todoListRegistry';
import {
  buildCompactorDefinition,
  resolveEffectiveCompactorTier,
  runCompactorSession,
} from '../../utils/compactorRunner';
import { effectiveMaxContextTokens } from '../../utils/contextLimits';
import { resolveProviderName } from './settingsNormalizer';
import type { CompactionSettings, UIMessage } from './types';

export interface ContextCheckpointProvenanceOptions {
  /** 触发来源；缺省时由 plan 判定（force → manual / rounds / tokens）。 */
  trigger?: import('@codepapr/types').CompactionTrigger;
  /** 目标 generation（主线程可在生成前读取最新 surface 得出）。 */
  generation?: number;
  parentGeneration?: number;
}

export type ContextCheckpointResult =
  | {
      message: UIMessage;
      cacheStats?: ICacheStatistics;
      modelTier: 'primary' | 'fast' | 'local';
      insertIndex: number;
    }
  | { pruneOnly: true }
  | null;

function isEmptyState(state: ContextCheckpointStateV3): boolean {
  return (
    state.goal.length === 0 &&
    state.constraints.length === 0 &&
    state.confirmedFacts.length === 0 &&
    state.assumptions.length === 0 &&
    state.decisions.length === 0 &&
    state.completedWork.length === 0 &&
    state.activeWork.length === 0 &&
    state.verification.length === 0 &&
    state.failuresAndRisks.length === 0 &&
    state.todos.length === 0 &&
    state.openQuestions.length === 0 &&
    state.references.length === 0 &&
    state.provenance.length === 0
  );
}

export async function maybeGenerateContextCheckpoint(
  settings: CompactionSettings,
  messages: UIMessage[],
  force?: boolean,
  todoDigest?: string,
  abortSignal?: AbortSignal,
  provenance?: ContextCheckpointProvenanceOptions,
  /** PR3：TodoList 权威状态查询需要 session id（缺省则跳过 todo 分区）。 */
  sessionId?: string
): Promise<ContextCheckpointResult> {
  const hardBudget = effectiveMaxContextTokens(settings, resolveProviderName(settings));
  const plan = planContextCompaction(messages, {
    maxRounds: settings.maxConversationRounds,
    maxTokens: hardBudget,
    // PR3：软预算 = 硬预算 × 比例；软硬区间走 prune-first。
    softMaxTokens: Math.floor(hardBudget * CONTEXT_COMPACTION_SOFT_BUDGET_RATIO),
    force,
  });
  if (!plan.shouldCompact) {
    if (plan.shouldPrune) {
      return { pruneOnly: true };
    }
    return null;
  }

  // ── PR3：结构化状态合并（deterministic fallback → 可选 LLM merge） ──
  const priorCheckpointIndex = getLatestCheckpoint(messages)?.index ?? -1;
  const sourceUI = messages.slice(priorCheckpointIndex + 1, plan.insertIndex);

  const todoContext = sessionId ? getTodoListContext(sessionId) : undefined;
  const incompleteTodos = todoContext
    ? todoContext.tasks
        .filter((task) => task.status !== 'completed')
        .map((task) => ({ title: task.title }))
    : undefined;

  const facts = classifyContextMessages({
    messages: sourceUI,
    incompleteTodos: incompleteTodos ?? [],
  });
  const priorState = plan.priorCheckpoint
    ? migrateContextCheckpointToV3(plan.priorCheckpoint).state
    : null;

  const fallbackState = mergeContextStateDeterministic({
    priorState,
    facts,
    incompleteTodos,
  });

  // 失败安全：fallback 也产出空状态且确有可压缩内容 → 不改变 active surface。
  if (isEmptyState(fallbackState) && plan.sourceMessages.length > 0) {
    return null;
  }

  // pinned 基线：todos 以权威状态为准（非空时），LLM 输出必须保住基线内容。
  const pinnedBaseline: ContextCheckpointStateV3 = {
    ...(priorState ?? createEmptyCheckpointStateV3()),
    todos:
      incompleteTodos !== undefined
        ? incompleteTodos.map((todo) => todo.title)
        : (priorState?.todos ?? []),
  };

  let state = fallbackState;
  let modelName = 'local-checkpoint';
  let modelTier: ContextCheckpointPayload['modelTier'] = 'local';
  // F：降级原因。历史上 22/31 次压缩都是 local-fallback 却什么也没记下，
  // 只能从 console.warn 里猜；现在写进 failure_code 供审计与 eval。
  let degradeReason: string | undefined;
  let cacheStats: ICacheStatistics | undefined;

  const lang =
    settings.lang === 'zh-TW' ? 'zh-TW' : settings.lang === 'en' ? 'en' : 'zh-CN';
  const baseModel = settings.model.trim();

  // 与旧 selectContextCompactionModelRoute 语义对齐：compactionModel 为 fast 但
  // fastModel 未启用时，路由返回 null → 完全跳过 LLM 合并，走确定性降级。
  const compactorTier = resolveEffectiveCompactorTier(settings);
  const canRunLlm =
    settings.compactionModel === 'fast'
      ? settings.fastModelEnabled && settings.fastModel.trim().length > 0
      : true;

  if (!canRunLlm) {
    degradeReason = 'compactor_unavailable';
  }
  if (canRunLlm) {
    const { systemPrompt, userPrompt } = buildStateMergePrompt({
      priorState,
      facts,
      incompleteTodos,
      lang,
    });
    // PR3：LLM 合并的系统提示词 = 状态合并规则（ADR-007），覆盖 compactor 默认提示词。
    const definition = {
      ...buildCompactorDefinition({
        settings,
        lang,
        baseModel,
      }),
      prompt: systemPrompt,
    };

    try {
      const result = await runCompactorSession({
        definition,
        prompt: userPrompt,
        settings,
        baseModel,
        lang,
        abortSignal,
      });
      cacheStats = result.cacheStats;

      const content = result.content?.trim();
      if (content) {
        const parsedState = parseContextCheckpointStateV3(content);
        if (parsedState) {
          const pinned = validatePinnedStatePreserved(pinnedBaseline, parsedState);
          if (pinned.ok) {
            state = parsedState;
            modelName = compactorTier === 'fast' ? settings.fastModel.trim() : baseModel;
            modelTier = compactorTier;
          } else {
            degradeReason = 'pinned_validation_failed';
            console.warn(
              '[checkpoint] LLM 合并丢失 pinned 状态，回退确定性合并:',
              pinned.missing.slice(0, 3)
            );
          }
        } else {
          degradeReason = 'parse_failed';
        }
      } else {
        degradeReason = 'empty_output';
      }
    } catch (e) {
      // 用户中断必须上抛（全仓取消约定：AbortError 原样传播），不能吞掉后
      // 继续走本地降级——调用方（mid-loop 压缩 / 发送流程）需要感知中断。
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw e;
      }
      degradeReason = 'merge_failed';
      console.warn('Smart context state merge failed:', e);
    }
  }

  const summary = renderContextCheckpointStateV3(state, settings.lang);
  const timestamp = Date.now();
  const compactionId = createId();
  const ranges = computeCheckpointProvenanceRanges(messages, plan.insertIndex);
  // D：进行中的任务清单必须跨压缩存活。todoDigest 此前只塞进 payload 元数据、
  // 从不进入模型可见的 surface，而 checkpoint 只带「未完成任务的标题」（且封顶
  // 12 条），前言还写着「不要恢复旧任务清单」——于是每压缩一次，模型就把计划
  // 从头再规划一遍（实测一个回合内 todo 全量重建 11 次，永远收不了尾）。
  // 这里把权威清单（含状态、retry、current 指针）整块渲染进 checkpoint 正文，
  // 仅在清单确有未完成项时使用「继续原清单」版前言。
  const resumableTodoDigest =
    todoContext && hasUnsettledTodoTasks(todoContext)
      ? todoDigest?.trim() || undefined
      : undefined;
  const renderedContent = renderContextCheckpointContent(
    summary,
    settings.lang,
    resumableTodoDigest
  );
  const checkpointTokens = estimateTokens(renderedContent || summary || '');
  // wire 口径：与 planContextCompaction 的 effectiveTokens 同一算法，否则
  // estimatedTokensAfter 会「纸面变小」而实际请求量没变（无效缩检查看不见）。
  const retainedTokens = measureWireTokens(plan.retainedMessages);
  return {
    message: {
      id: createId(),
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp,
      contextCheckpoint: {
        version: CONTEXT_CHECKPOINT_VERSION_3,
        summary,
        renderedContent,
        sourceMessageCount: plan.sourceMessages.length,
        sourceChars: plan.sourceChars,
        generatedAt: timestamp,
        modelName,
        modelTier,
        todoDigest: todoDigest?.trim() || undefined,
        // PR1 provenance（ADR-001/005）：全部用不可变 message ID，不用
        // 可变 positional index。generation/parentGeneration 由主线程在
        // 生成前读取最新 surface 传入；worker（mid-loop）路径留空由
        // 主线程 commit 时定 generation。
        compactionId,
        generation: provenance?.generation,
        parentGeneration: provenance?.parentGeneration,
        trigger: provenance?.trigger ?? plan.trigger,
        sourceStartMessageId: ranges.sourceStartMessageId,
        sourceEndMessageId: ranges.sourceEndMessageId,
        retainedTailStartMessageId: ranges.retainedTailStartMessageId,
        // 与 provenance ID 同口径：UI 可见 retained 条数，不是 core 展开后的消息数。
        retainedMessageCount: ranges.retainedMessageCount,
        tokenStats: {
          estimatedTokensBefore: plan.effectiveTokens,
          estimatedTokensAfter: checkpointTokens + retainedTokens,
          sourceTokens: plan.sourceTokens,
          checkpointTokens,
        },
        summaryInfo:
          modelTier === 'local'
            ? { kind: 'local-fallback', failureCode: degradeReason ?? 'unspecified' }
            : { kind: 'llm', model: modelName },
        // PR3：v3 payload 用结构化 state（渲染器绑定：旧 v2 payload 不重渲染）
        state,
      },
    },
    cacheStats,
    modelTier,
    insertIndex: plan.insertIndex,
  };
}
