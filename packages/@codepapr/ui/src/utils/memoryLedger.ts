/**
 * Memory Ledger（PR4）：候选抽取、自动写入、Bootstrap 渲染的纯函数层。
 *
 * 写入策略（ADR-010）：确定性 persist / drop，不产生用户审核队列。
 * web/MCP 进 citation（不进 Bootstrap）；风险标记直接丢弃。
 */

import {
  envelopeContent,
  planMemoryWrite,
  redactSecrets,
  type ContentEnvelope,
  type MemoryWriteDecision,
} from '@codepapr/core';
import { sha256, estimateTokens } from '@codepapr/common';
import { createId } from './createId';
import { TEST_COMMAND_PATTERN } from './contextClassification';
import { isSessionBootstrapMessage } from './contextSurface';
import type { ContextMessageLike } from './contextCompaction';

export const MEMORY_MANAGED_ZONE_MAX_ENTRIES = 24;
/** 投影 token 预算（≈ 旧 6000 字符 / 4 的口径，但用 estimateTokens 截断——
 *  CJK 每字符 3 字节，字符数截断会低估实际注入 token，P2-2 修正）。 */
export const MEMORY_MANAGED_ZONE_MAX_TOKENS = 1_500;

const REMEMBER_PATTERN =
  /记住|请记住|记得|以后都|往后都|下次请|please remember|remember (that|this|to)|from now on|always use|never (use|do)/i;
const CONSTRAINT_PATTERN =
  /必须|务必|不要|禁止|避免|只能|不得|must|should not|avoid|required|forbidden|never/i;
/**
 * M3：无「记住」标记时约束抽取的强门槛——只认强模态词（软性「不要/避免」
 * 大概率是当下任务指令而非长期规则），且句子要有完整长度，防止闲聊
 * 「不要改那个文件」被永久记成约束。
 */
const CONSTRAINT_STRONG_PATTERN =
  /必须|务必|禁止|不得|只能|一律|任何情况下|\bmust\b|\bnever\b|forbidden/i;
const BARE_CONSTRAINT_MIN_CHARS = 10;

const BOOTSTRAP_EXCLUDED = new Set(['citation', 'procedure']);

/** 已验证命令 → 记忆候选（执行验证，自动 persist）。 */
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

/** 用户原话「记住 / 必须 / 不要」→ 指令类记忆，自动 persist。 */
export function collectUserUtteranceMemoryCandidates(
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
    if (message.role !== 'user') continue;
    if (isSessionBootstrapMessage(message)) continue;
    const content = (message.content ?? '').trim();
    if (!content) continue;
    const remembered = REMEMBER_PATTERN.test(content);
    const constrained = CONSTRAINT_PATTERN.test(content);
    if (!remembered && !constrained) continue;
    if (!remembered && content.length > 240) continue;
    if (
      !remembered &&
      (!CONSTRAINT_STRONG_PATTERN.test(content) || content.length < BARE_CONSTRAINT_MIN_CHARS)
    ) {
      continue;
    }
    const envelope = envelopeContent({
      source: 'user',
      trust: 'trusted',
      origin: `user:${message.id}`,
      content: content.slice(0, 500),
    });
    candidates.push({
      envelope,
      category: constrained ? 'constraint' : 'preference',
      sourceMessageIds: [message.id],
    });
  }
  return candidates;
}

/** 写入裁决 + 脱敏后的最终内容（供落库）。 */
export function decideMemoryCandidate(
  env: ContentEnvelope,
  kind?: string
): MemoryWriteDecision & {
  admitted: boolean;
  redactedContent: string;
  reason?: string;
} {
  const decision = planMemoryWrite({ envelope: env, kind });
  return {
    ...decision,
    admitted: decision.action === 'persist',
    redactedContent: redactSecrets(env.content),
  };
}

export interface ProjectionEntry {
  category: string;
  content: string;
  confidence: string;
  trust: string;
  verifiedAt: number | null;
}

/**
 * Session Bootstrap 渲染（token-budgeted）：每条目一行 `- [verified] content`。
 * 含 user-note 与指令/事实类；排除 citation / procedure 与非 confirmed
 * （M2：Agent 自报的 reported 内容只进 Recall，不冻结进前缀）。
 * 超预算按条数/token 截断。
 */
export function buildMemoryProjection(entries: readonly ProjectionEntry[]): string {
  const lines: string[] = [];
  let totalTokens = 0;
  const maxEntries = MEMORY_MANAGED_ZONE_MAX_ENTRIES;
  const maxTokens = MEMORY_MANAGED_ZONE_MAX_TOKENS;
  const ranked = [...entries].sort((left, right) => {
    const leftRank = left.category === 'user-note' ? 0 : 1;
    const rightRank = right.category === 'user-note' ? 0 : 1;
    return leftRank - rightRank;
  });

  for (const entry of ranked) {
    if (BOOTSTRAP_EXCLUDED.has(entry.category)) continue;
    if (entry.confidence !== 'confirmed') continue;
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
  confidence?: 'confirmed' | 'reported';
  createdAt?: number;
}): {
  id: string;
  category: string;
  content: string;
  contentHash: string;
  confidence: 'confirmed' | 'reported';
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
    confidence: params.confidence ?? 'confirmed',
    trust: params.envelope.trust,
    sourceSessionId: params.sessionId,
    sourceMessageIds: JSON.stringify(params.sourceMessageIds),
    evidence: JSON.stringify({ origin: params.envelope.origin }),
    riskFlags: JSON.stringify(params.envelope.riskFlags),
    createdAt: params.createdAt ?? Date.now(),
  };
}
