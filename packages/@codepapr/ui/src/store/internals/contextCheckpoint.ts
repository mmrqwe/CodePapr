import type { ICacheStatistics } from '@codepapr/types';
import { estimateTokens } from '@codepapr/common';
import { createId } from '../../utils/createId';
import {
  computeCheckpointProvenanceRanges,
} from '../../utils/contextSurface';
import {
  CONTEXT_COMPACTION_VERSION,
  buildContextCheckpointPrompt,
  buildContextCompactionTranscript,
  buildLocalContextCheckpointSections,
  parseContextCheckpointSections,
  planContextCompaction,
  renderContextCheckpointContent,
  renderContextCheckpointSummary,
  type ContextCheckpointPayload,
} from '../../utils/contextCompaction';
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

export async function maybeGenerateContextCheckpoint(
  settings: CompactionSettings,
  messages: UIMessage[],
  force?: boolean,
  todoDigest?: string,
  abortSignal?: AbortSignal,
  provenance?: ContextCheckpointProvenanceOptions
): Promise<{ message: UIMessage; cacheStats?: ICacheStatistics; modelTier: 'primary' | 'fast' | 'local'; insertIndex: number } | null> {
  const plan = planContextCompaction(messages, {
    maxRounds: settings.maxConversationRounds,
    maxTokens: effectiveMaxContextTokens(settings, resolveProviderName(settings)),
    force,
  });
  if (!plan.shouldCompact) {
    return null;
  }

  const fallbackSections = buildLocalContextCheckpointSections({
    priorCheckpoint: plan.priorCheckpoint,
    sourceMessages: plan.sourceMessages,
    retainedMessages: plan.retainedMessages,
    lang: settings.lang,
  });
  const fallbackSummary = renderContextCheckpointSummary(fallbackSections, settings.lang);
  let sections = fallbackSections;
  let summary = fallbackSummary;
  let modelName = 'local-checkpoint';
  let modelTier: ContextCheckpointPayload['modelTier'] = 'local';
  let cacheStats: ICacheStatistics | undefined;

  const lang =
    settings.lang === 'zh-TW' ? 'zh-TW' : settings.lang === 'en' ? 'en' : 'zh-CN';
  const baseModel = settings.model.trim();

  // 与旧 selectContextCompactionModelRoute 语义对齐：compactionModel 为 fast 但
  // fastModel 未启用时，路由返回 null → 完全跳过 LLM 压缩，走本地规则降级。
  // （verifier 式的 fast→primary 降级不适用于压缩：旧行为是「不调 LLM」。）
  const compactorTier = resolveEffectiveCompactorTier(settings);
  const canRunLlm =
    settings.compactionModel === 'fast'
      ? settings.fastModelEnabled && settings.fastModel.trim().length > 0
      : true;

  if (canRunLlm) {
    const definition = buildCompactorDefinition({
      settings,
      lang,
      baseModel,
    });
    const { userPrompt } = buildContextCheckpointPrompt({
      transcript: buildContextCompactionTranscript(plan.sourceMessages),
      priorCheckpoint: plan.priorCheckpoint,
      lang: settings.lang,
    });

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
        const parsedSections = parseContextCheckpointSections(content);
        if (parsedSections) {
          sections = parsedSections;
          summary = renderContextCheckpointSummary(parsedSections, settings.lang);
          modelName = compactorTier === 'fast' ? settings.fastModel.trim() : baseModel;
          modelTier = compactorTier;
        }
      }
    } catch (e) {
      // 用户中断必须上抛（全仓取消约定：AbortError 原样传播），不能吞掉后
      // 继续走本地降级——调用方（mid-loop 压缩 / 发送流程）需要感知中断。
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw e;
      }
      console.warn('Smart context enrichment failed:', e);
    }
  }

  const timestamp = Date.now();
  const compactionId = createId();
  const ranges = computeCheckpointProvenanceRanges(messages, plan.insertIndex);
  const renderedContent = renderContextCheckpointContent(summary, settings.lang);
  const checkpointTokens = estimateTokens(renderedContent || summary || '');
  const retainedTokens = plan.retainedMessages.reduce(
    (sum, message) =>
      sum +
      estimateTokens([message.role, message.content ?? ''].filter(Boolean).join('\n')),
    0
  );
  return {
    message: {
      id: createId(),
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp,
      contextCheckpoint: {
        version: CONTEXT_COMPACTION_VERSION,
        summary,
        renderedContent,
        sourceMessageCount: plan.sourceMessages.length,
        sourceChars: plan.sourceChars,
        generatedAt: timestamp,
        modelName,
        modelTier,
        sections,
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
        retainedMessageCount: plan.retainedMessages.length,
        tokenStats: {
          estimatedTokensBefore: plan.effectiveTokens,
          estimatedTokensAfter: checkpointTokens + retainedTokens,
          sourceTokens: plan.sourceTokens,
          checkpointTokens,
        },
        summaryInfo:
          modelTier === 'local'
            ? { kind: 'local-fallback' }
            : { kind: 'llm', model: modelName },
      },
    },
    cacheStats,
    modelTier,
    insertIndex: plan.insertIndex,
  };
}
