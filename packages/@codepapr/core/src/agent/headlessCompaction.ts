/**
 * v4 子代理 headless 压缩：与主会话同一引擎（90% 触发线、骨架、轮内折叠、
 * 一次二级摘要），但**不持久化**——没有 surface epoch / archive checkpoint 行 /
 * bootstrap prime（子代理前缀在 ImmutablePrefix，不在 log），压缩只是内存
 * replaceLog。compactor（internal）不接入：二级摘要是纯 LLM 调用，压缩链
 * 深度因此在结构上封顶为 1（执行器 → compactor），不存在递归压缩。
 */

import { estimateTokens } from '@codepapr/common';
import type { IMessage } from '@codepapr/types';
import {
  COMPACT_TRIGGER_RATIO,
  deterministicSummary,
  planSkeletonCompaction,
  renderCompactedBlock,
  roundsFromCoreMessages,
  SKELETON_SUMMARY_SYSTEM_PROMPTS,
  type CompactionEngineLang,
} from './compactionEngine';
import type { ContextCompactionConfig } from './Agent';

const HEADLESS_PREFIX_PREAMBLE: Record<CompactionEngineLang, string> = {
  'zh-CN': '以下是该子代理更早步骤的压缩骨架（历史背景）；如与后续逐字步骤冲突，以逐字步骤为准。',
  'zh-TW': '以下是該子代理更早步驟的壓縮骨架（歷史背景）；如與後續逐字步驟衝突，以逐字步驟為準。',
  en: 'Below is the compacted skeleton of this sub-agent\'s earlier steps (historical background); if it conflicts with the later verbatim steps, trust the verbatim steps.',
};

export interface HeadlessCompactionParams {
  /** 子代理生效窗口（通常是用户的 maxContextTokens）。 */
  windowTokens: number;
  lang: CompactionEngineLang;
  /** 可选的二级摘要器（compactor 会话）；缺省/失败走确定性截断。 */
  summarize?: (input: string) => Promise<string | null>;
  /** 固定前缀开销估算（system prompt 之外的额外注入），token 口径。 */
  fixedOverheadTokens?: number;
}

/** 供 UI 侧 summarizer 复用的系统提示词（与主会话二级摘要同口径）。 */
export const HEADLESS_SUMMARY_PROMPTS = SKELETON_SUMMARY_SYSTEM_PROMPTS;

export function createHeadlessCompaction(
  params: HeadlessCompactionParams
): ContextCompactionConfig {
  const triggerTokens = Math.floor(params.windowTokens * COMPACT_TRIGGER_RATIO);
  return {
    maxContextTokens: triggerTokens,
    softMaxTokens: triggerTokens,
    handler: async (coreMessages: IMessage[]) => {
      const isBootstrap = (m: IMessage) =>
        m.metadata?.sessionBootstrap === true || m.id === 'session-bootstrap';
      const isCheckpoint = (m: IMessage) => m.metadata?.contextCheckpoint === true;
      const bootstrap = coreMessages.filter(isBootstrap);
      const priorCheckpoint = [...coreMessages].reverse().find(isCheckpoint);
      const priorFoldedText =
        typeof priorCheckpoint?.content === 'string' ? priorCheckpoint.content.trim() : '';
      const body = coreMessages.filter((m) => !isBootstrap(m) && !isCheckpoint(m));
      const fixed =
        (params.fixedOverheadTokens ?? 0) +
        bootstrap.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);

      const plan = planSkeletonCompaction({
        rounds: roundsFromCoreMessages(body),
        priorFoldedText,
        fixedOverheadTokens: fixed,
        triggerTokens,
        summaryInputTokens: triggerTokens,
        lang: params.lang,
      });
      if (!plan) return null;

      const boundaryIndex = body.findIndex((m) => m.id === plan.boundaryMessageId);
      if (boundaryIndex <= 0) return null;

      let block = [priorFoldedText, renderCompactedBlock(plan)]
        .filter((part) => part.trim())
        .join('\n\n');
      if (plan.needsSummary) {
        const retainedTokens = plan.retainedTokens;
        const budget = Math.max(1, triggerTokens - fixed - retainedTokens);
        let summarized: string | null = null;
        if (plan.summaryInput && params.summarize) {
          try {
            summarized = (await params.summarize(plan.summaryInput))?.trim() || null;
          } catch {
            summarized = null;
          }
        }
        block = summarized ?? deterministicSummary(block, budget, params.lang);
        if (estimateTokens(block) > budget) {
          block = deterministicSummary(block, budget, params.lang);
        }
      }

      const preamble = HEADLESS_PREFIX_PREAMBLE[params.lang];
      const checkpointMessage: IMessage = {
        id: `subagent-cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: `${preamble}\n\n${block}`,
        timestamp: priorCheckpoint?.timestamp ?? body[0]?.timestamp ?? 1,
        metadata: { contextCheckpoint: true },
      };
      const messages = [...bootstrap, checkpointMessage, ...body.slice(boundaryIndex)];
      return { messages };
    },
  };
}
