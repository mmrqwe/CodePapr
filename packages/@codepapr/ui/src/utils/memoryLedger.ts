/**
 * Memory Ledger（PR4）：候选抽取、准入、双区投影渲染的纯函数层。
 *
 * 准入策略（ADR-008，不变式 9）：只自动准入「执行验证 / 用户确认 / 可信项目
 * 证据」来源；web/MCP/注入/密钥/策略绕过永不自准入。基线判定确定性，不依赖
 * LLM。IPC 编排在 store 层（sendMessage），本文件纯函数可单测。
 */

import {
  envelopeContent,
  planMemoryAdmission,
  redactSecrets,
  type ContentEnvelope,
  type MemoryAdmissionResult,
} from '@codepapr/core';
import { sha256, estimateTokens } from '@codepapr/common';
import { createId } from './createId';
import { TEST_COMMAND_PATTERN } from './contextClassification';
import type { ContextMessageLike } from './contextCompaction';

export const MEMORY_MANAGED_ZONE_MAX_ENTRIES = 24;
/** 投影 token 预算（≈ 旧 6000 字符 / 4 的口径，但用 estimateTokens 截断——
 *  CJK 每字符 3 字节，字符数截断会低估实际注入 token，P2-2 修正）。 */
export const MEMORY_MANAGED_ZONE_MAX_TOKENS = 1_500;

/** 已验证命令 → 记忆候选（PR4 唯一 v1 自动准入来源：执行验证）。 */
export function collectVerifiedMemoryCandidates(
  messages: readonly ContextMessageLike[]
): Array<{
  envelope: ContentEnvelope;
  category: string;
  sourceMessageIds: string[];
}> {
  const candidates: Array<{
    envelope: ContentEnvelope;
    category: string;
    sourceMessageIds: string[];
  }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const invocations = (message as unknown as { toolInvocations?: unknown[] }).toolInvocations;
    if (!Array.isArray(invocations)) continue;
    for (const raw of invocations) {
      const invocation = raw as {
        name?: string;
        status?: string;
        output?: unknown;
        error?: string;
        arguments?: Record<string, unknown>;
      };
      if (invocation.name !== 'bash' || invocation.status !== 'success' || invocation.error) {
        continue;
      }
      const command =
        typeof invocation.arguments?.command === 'string' ? invocation.arguments.command : '';
      if (!TEST_COMMAND_PATTERN.test(command)) continue;
      const output = typeof invocation.output === 'string' ? invocation.output : '';
      if (output.length > 2_000) continue;
      const envelope = envelopeContent({
        source: 'tool-output',
        trust: 'workspace',
        origin: `bash:${command.slice(0, 80)}`,
        content: `[bash] ✓ ${command}${output.trim() ? `\n${output.trim().slice(0, 300)}` : ''}`,
      });
      candidates.push({ envelope, category: 'verification', sourceMessageIds: [message.id] });
    }
  }
  return candidates;
}

/** 准入裁决 + 脱敏后的最终内容（供落库）。 */
export function decideMemoryCandidate(env: ContentEnvelope): MemoryAdmissionResult & {
  redactedContent: string;
} {
  const admission = planMemoryAdmission(env);
  return { ...admission, redactedContent: redactSecrets(env.content) };
}

export interface ProjectionEntry {
  category: string;
  content: string;
  confidence: string;
  trust: string;
  verifiedAt: number | null;
}

/**
 * managed zone 渲染（token-budgeted）：每条目一行 `- [verified] content`，
 * 带上类别；超预算按条数/token 截断（estimateTokens，CJK 字节口径正确）。
 * user-note（user zone 同步条目，ADR-008 第4点）不进 managed zone——它已在
 * user zone 展示，只进 ledger 供 Recall 检索。
 */
export function buildMemoryProjection(entries: readonly ProjectionEntry[]): string {
  const lines: string[] = [];
  let totalTokens = 0;
  const maxEntries = MEMORY_MANAGED_ZONE_MAX_ENTRIES;
  const maxTokens = MEMORY_MANAGED_ZONE_MAX_TOKENS;

  for (const entry of entries) {
    if (entry.category === 'user-note') continue;
    if (lines.length >= maxEntries) break;
    const content = redactSecrets(entry.content).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const badge =
      entry.trust === 'untrusted'
        ? '[unverified]'
        : entry.confidence === 'confirmed'
          ? '[verified]'
          : '[reported]';
    const line = `- ${badge} ${entry.category} — ${content}`;
    const lineTokens = estimateTokens(line);
    if (totalTokens + lineTokens > maxTokens) continue;
    lines.push(line);
    totalTokens += lineTokens;
  }

  if (lines.length === 0) {
    return '（暂无已验证的项目记忆）';
  }
  return lines.join('\n');
}

/** 生成候选落库所需的输入（含内容哈希、来源溯源）。字段名与 Rust
 *  MemoryCandidateInput 的 serde camelCase 对齐（否则溯源静默丢失）。 */
export function buildMemoryCandidateInput(params: {
  sessionId: string;
  sourceMessageIds: string[];
  envelope: ContentEnvelope;
  category: string;
  createdAt?: number;
}): {
  id: string;
  category: string;
  content: string;
  contentHash: string;
  confidence: 'confirmed';
  trust: 'trusted' | 'workspace' | 'derived' | 'untrusted';
  sourceSessionId: string;
  sourceMessageIds: string;
  evidence: string;
  riskFlags: string;
  createdAt: number;
} {
  const content = redactSecrets(params.envelope.content);
  return {
    id: createId(),
    category: params.category,
    content,
    contentHash: sha256(content),
    confidence: 'confirmed',
    trust: params.envelope.trust,
    sourceSessionId: params.sessionId,
    sourceMessageIds: JSON.stringify(params.sourceMessageIds),
    evidence: JSON.stringify({ origin: params.envelope.origin }),
    riskFlags: JSON.stringify(params.envelope.riskFlags),
    createdAt: params.createdAt ?? Date.now(),
  };
}
