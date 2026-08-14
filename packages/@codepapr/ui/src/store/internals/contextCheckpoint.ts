import type { ICacheStatistics } from '@codepapr/types';
import { createId } from '../../utils/createId';
import { selectContextCompactionModelRoute } from '../../utils/modelRouting';
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
import { runCachedModelRequest } from '../../utils/cachedModelRequest';
import { effectiveMaxContextTokens } from '../../utils/contextLimits';
import { buildProviderInstance } from './providerFactory';
import { resolveProviderName } from './settingsNormalizer';
import type { CompactionSettings, UIMessage } from './types';

export async function maybeGenerateContextCheckpoint(
  settings: CompactionSettings,
  messages: UIMessage[],
  force?: boolean,
  todoDigest?: string
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

  const route = selectContextCompactionModelRoute({
    model: settings.model,
    fastModelEnabled: settings.fastModelEnabled,
    fastModel: settings.fastModel,
    temperature: settings.temperature,
    maxTokens: settings.compactionMaxTokens,
    thinkingEnabled: false,
    compactionTemperature: settings.compactionTemperature,
  }, settings.compactionModel);
  const provider = route ? buildProviderInstance(settings) : null;

  if (route && provider) {
    const { systemPrompt, userPrompt } = buildContextCheckpointPrompt({
      transcript: buildContextCompactionTranscript(plan.sourceMessages),
      priorCheckpoint: plan.priorCheckpoint,
      lang: settings.lang,
    });

    try {
      const result = await runCachedModelRequest({
        provider,
        providerName: resolveProviderName(settings),
        model: route.model,
        thinking: { type: 'disabled' },
        systemPrompt,
        userPrompt,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
      });
      cacheStats = result.cacheStats;

      const content = result.response.choices[0]?.message.content?.trim();
      if (content) {
        const parsedSections = parseContextCheckpointSections(content);
        if (parsedSections) {
          sections = parsedSections;
          summary = renderContextCheckpointSummary(parsedSections, settings.lang);
          modelName = route.model;
          modelTier = route.tier;
        }
      }
    } catch (e) {
      console.warn('Smart context enrichment failed:', e);
    }
  }

  const timestamp = Date.now();
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
        renderedContent: renderContextCheckpointContent(summary, settings.lang),
        sourceMessageCount: plan.sourceMessages.length,
        sourceChars: plan.sourceChars,
        generatedAt: timestamp,
        modelName,
        modelTier,
        sections,
        todoDigest: todoDigest?.trim() || undefined,
      },
    },
    cacheStats,
    modelTier,
    insertIndex: plan.insertIndex,
  };
}
