import type { ICacheStatistics } from '@codepapr/types';
import { estimateTokens } from '@codepapr/common';
import {
  COMPACT_TRIGGER_RATIO,
  CONTEXT_COMPACTION_VERSION_V4,
  SUMMARY_INPUT_RATIO,
  deterministicSummary,
  renderCompactedBlock,
  planSkeletonCompaction,
  roundsFromCoreMessages,
  SKELETON_SUMMARY_SYSTEM_PROMPTS,
  type CompactionEngineLang,
  type SkeletonEntry,
} from '@codepapr/core';
import { createId } from '../../utils/createId';
import {
  computeCheckpointProvenanceRanges,
} from '../../utils/contextSurface';
import {
  getLatestCheckpoint,
  measureWireTokens,
  renderContextCheckpointContent,
  toCoreTailMessages,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from '../../utils/contextCompaction';
import { hasUnsettledTodoTasks } from '@codepapr/core';
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
  /** 触发来源；缺省 token-limit（force → manual 由调用方传入）。 */
  trigger?: import('@codepapr/types').CompactionTrigger;
  /** 目标 generation（主线程可在生成前读取最新 surface 得出）。 */
  generation?: number;
  parentGeneration?: number;
}

export type ContextCheckpointResult = {
  message: UIMessage;
  cacheStats?: ICacheStatistics;
  modelTier: 'primary' | 'fast' | 'local';
  insertIndex: number;
} | null;

function engineLang(lang: CompactionSettings['lang']): CompactionEngineLang {
  return lang === 'en' ? 'en' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
}


/**
 * 生成 v4 检查点（骨架优先引擎；见 core compactionEngine.ts）。
 *
 * 触发只有一条线：usage ≥ 窗口 × 90%（force 表示手动/溢出恢复）。产物装配：
 *   prior 摘要文本 → 骨架行 → [当前任务] 行 + 活动行 →（可选）二级摘要替换
 * 前三者；todo digest 作为 pinned 信息独立附在块尾。确定性装配装不下时才调用
 * 一次 LLM 摘要（输入已预瘦身，失败走 deterministicSummary 截断，绝不递归）。
 */
export async function maybeGenerateContextCheckpoint(
  settings: CompactionSettings,
  messages: UIMessage[],
  force?: boolean,
  todoDigest?: string,
  abortSignal?: AbortSignal,
  provenance?: ContextCheckpointProvenanceOptions,
  /** TodoList 权威状态查询需要 session id（缺省则跳过 pinned 清单）。 */
  sessionId?: string
): Promise<ContextCheckpointResult> {
  const hardBudget = effectiveMaxContextTokens(settings, resolveProviderName(settings));
  const triggerTokens = Math.floor(hardBudget * COMPACT_TRIGGER_RATIO);

  const priorCheckpoint = getLatestCheckpoint(messages as readonly ContextMessageLike[]);
  const tailStart = priorCheckpoint ? priorCheckpoint.index + 1 : 0;
  const tailUI = (messages as readonly ContextMessageLike[]).slice(tailStart);
  // worker log 注入的 session-bootstrap：前缀缓存资产，不计入压缩源，只算固定开销。
  const bootstrapUI = tailUI.filter((m) => m.sessionBootstrap);
  const compactableUI = tailUI.filter((m) => !m.sessionBootstrap);
  const priorFoldedText = priorCheckpoint
    ? (priorCheckpoint.payload.renderedContent || priorCheckpoint.payload.summary || '').trim()
    : '';
  const priorTokens = estimateTokens(priorFoldedText);
  const coreTail = toCoreTailMessages(compactableUI);
  const bootstrapTokens = measureWireTokens(toCoreTailMessages(bootstrapUI));
  const effectiveTokens = priorTokens + measureWireTokens(coreTail) + bootstrapTokens;
  if (!force && effectiveTokens < triggerTokens) {
    return null;
  }

  const todoContext = sessionId ? getTodoListContext(sessionId) : undefined;
  const resumableTodoDigest =
    todoContext && hasUnsettledTodoTasks(todoContext)
      ? todoDigest?.trim() || undefined
      : undefined;

  // 固定开销：前言/标题模板 + pinned todo digest + bootstrap（文本估算口径）。
  const overheadText = renderContextCheckpointContent('', settings.lang, resumableTodoDigest);
  const fixedOverheadTokens = estimateTokens(overheadText) + bootstrapTokens;

  const plan = planSkeletonCompaction({
    rounds: roundsFromCoreMessages(coreTail),
    priorFoldedText,
    fixedOverheadTokens,
    triggerTokens,
    summaryInputTokens: Math.floor(hardBudget * SUMMARY_INPUT_RATIO),
    lang: engineLang(settings.lang),
  });
  if (!plan) {
    return null;
  }

  const insertIndex = messages.findIndex((m) => m.id === plan.boundaryMessageId);
  const boundaryInTail = compactableUI.findIndex((m) => m.id === plan.boundaryMessageId);
  if (insertIndex <= 0 || boundaryInTail <= 0) {
    return null;
  }
  const sourceMessages = toCoreTailMessages(compactableUI.slice(0, boundaryInTail));
  if (sourceMessages.length === 0) {
    return null;
  }

  const lang = engineLang(settings.lang);
  let body: string;
  let modelName = 'local-checkpoint';
  let modelTier: ContextCheckpointPayload['modelTier'] = 'local';
  let degradeReason: string | undefined;
  let cacheStats: ICacheStatistics | undefined;

  const deterministicAssembly = [
    priorFoldedText,
    renderCompactedBlock(plan),
  ].filter((part) => part.trim()).join('\n');

  const availableForBlock = Math.max(1, triggerTokens - fixedOverheadTokens - plan.retainedTokens);

  if (!plan.needsSummary) {
    body = deterministicAssembly;
  } else {
    const compactorTier = resolveEffectiveCompactorTier(settings);
    const baseModel = settings.model.trim();
    const canRunLlm =
      settings.compactionModel === 'fast'
        ? settings.fastModelEnabled && settings.fastModel.trim().length > 0
        : true;
    let summaryText: string | null = null;
    if (canRunLlm && plan.summaryInput) {
      const definition = {
        ...buildCompactorDefinition({
          settings,
          lang,
          baseModel,
        }),
        prompt: SKELETON_SUMMARY_SYSTEM_PROMPTS[lang],
      };
      try {
        const result = await runCompactorSession({
          definition,
          prompt: plan.summaryInput,
          settings,
          baseModel,
          lang,
          abortSignal,
        });
        cacheStats = result.cacheStats;
        const content = result.content?.trim();
        if (content) {
          summaryText = content;
          modelName = compactorTier === 'fast' ? settings.fastModel.trim() : baseModel;
          modelTier = compactorTier;
        } else {
          degradeReason = 'summary_empty_output';
        }
      } catch (err) {
        // 用户中断必须上抛（全仓取消约定：AbortError 原样传播）。
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        degradeReason = 'summary_failed';
        console.warn('[checkpoint] 二级摘要失败，走确定性截断降级:', err);
      }
    } else {
      degradeReason = 'compactor_unavailable';
    }
    body = summaryText ?? deterministicSummary(deterministicAssembly, availableForBlock, lang);
    if (estimateTokens(body) > availableForBlock) {
      body = deterministicSummary(body, availableForBlock, lang);
    }
  }

  const renderedContent = renderContextCheckpointContent(body, settings.lang, resumableTodoDigest);
  const checkpointTokens = estimateTokens(renderedContent);
  const retainedCore = toCoreTailMessages(compactableUI.slice(boundaryInTail));
  const retainedTokens = measureWireTokens(retainedCore);
  const tokensAfter = checkpointTokens + retainedTokens + bootstrapTokens;
  // 无效缩容（含 force）：不改 active surface（commit 校验同口径兜底）。
  if (tokensAfter >= effectiveTokens) {
    return null;
  }

  const timestamp = Date.now();
  const compactionId = createId();
  const ranges = computeCheckpointProvenanceRanges(
    messages as readonly ContextMessageLike[],
    insertIndex
  );
  const skeleton: SkeletonEntry[] = plan.skeleton;

  return {
    message: {
      id: createId(),
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp,
      contextCheckpoint: {
        version: CONTEXT_COMPACTION_VERSION_V4,
        summary: body,
        renderedContent,
        sourceMessageCount: sourceMessages.length,
        sourceChars: sourceMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
        generatedAt: timestamp,
        modelName,
        modelTier,
        todoDigest: todoDigest?.trim() || undefined,
        // v4 结构化块（审计与 UI 识别用；summary/renderedContent 是模型可见文本）
        skeleton,
        summaryBlock: plan.needsSummary ? body : undefined,
        activityText: plan.activityText || undefined,
        compactionId,
        generation: provenance?.generation,
        parentGeneration: provenance?.parentGeneration,
        trigger: provenance?.trigger ?? (force ? 'manual' : 'token-limit'),
        sourceStartMessageId: ranges.sourceStartMessageId,
        sourceEndMessageId: ranges.sourceEndMessageId,
        retainedTailStartMessageId: ranges.retainedTailStartMessageId,
        retainedMessageCount: ranges.retainedMessageCount,
        tokenStats: {
          estimatedTokensBefore: effectiveTokens,
          estimatedTokensAfter: tokensAfter,
          sourceTokens: measureWireTokens(sourceMessages),
          checkpointTokens,
        },
        summaryInfo:
          modelTier === 'local'
            ? { kind: 'local-fallback', failureCode: degradeReason ?? 'deterministic-skeleton' }
            : { kind: 'llm', model: modelName },
      },
    },
    cacheStats,
    modelTier,
    insertIndex,
  };
}
