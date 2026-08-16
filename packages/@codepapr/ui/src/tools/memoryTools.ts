/**
 * 记忆工具（ADR-008 PR4）：memory_write / memory_search / memory_forget /
 * memory_review_candidates。
 *
 * - memory_write：只创建 candidate（pending），绝不直写 stable memory；
 * - memory_search：检索稳定记忆 + checkpoint 事实；同时按 ADR-009 第11条
 *   触发受控 re-recall（order 递增的第二个 RequestContextInsertion，由
 *   Worker 桥回 Agent 的 contextInsertions，每 turn 至多一次）；
 * - memory_forget：active → forgotten（软删除）并重新投影 managed zone；
 * - memory_review_candidates：Agent 侧仅 list/reject；admit（准入）必须由
 *   用户在记忆面板完成——Agent 自我准入会绕过 human-in-the-loop（ADR-008
 *   「user-confirmed」安全边界）。
 *
 * 准入策略仍是唯一防线：本工具创建的候选 trust=derived（agent-proposed），
 * 只有用户审查准入后才进入稳定记忆。
 */

import {
  ToolRegistry,
  asString,
  asOptionalString,
  asOptionalStringArray,
  envelopeContent,
  redactSecrets,
} from '@codepapr/core';
import { sha256 } from '@codepapr/common';
import { toolByName } from './workspaceToolDefinitions';
import { createId } from '../utils/createId';
import {
  forgetMemoryEntry,
  loadMemoryCandidates,
  loadMemoryEntries,
  projectMemoryFile,
  rejectMemoryCandidate,
  saveMemoryCandidate,
  saveMemoryRecall,
  searchMemoryForRecall,
  type PersistedMemoryCandidate,
  type RecallSearchItem,
} from '../utils/projectStorage';
import { buildMemoryProjection } from '../utils/memoryLedger';
import {
  buildRecallInsertion,
  buildRecallQuery,
  renderRecallBlock,
} from '../utils/memoryRecall';

const MEMORY_CATEGORIES = new Set([
  'general',
  'verification',
  'decision',
  'api',
  'constraint',
  'preference',
  'fact',
]);

const MEMORY_WRITE_MAX_CHARS = 8_000;

/** 拦截路径归一化后与 .CodePapr/memory.md 比对。 */
export function isMemoryFilePath(relativePath: string): boolean {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return normalized === '.CodePapr/memory.md';
}

/**
 * 候选入队门槛（非准入门）：风险标记 / 尺寸。准入门（planMemoryAdmission）
 * 在审查准入（memory_review_candidates action=admit）时执行，见下方。
 */
function assertCandidateQueueable(envelope: ReturnType<typeof envelopeContent>): void {
  if (envelope.riskFlags.length > 0) {
    throw new Error(`候选被风险检测拦截: ${envelope.riskFlags.join(',')}`);
  }
  const trimmed = envelope.content.trim();
  if (trimmed.length < 8) {
    throw new Error('候选内容过短（至少 8 字符）');
  }
  if (trimmed.length > MEMORY_WRITE_MAX_CHARS) {
    throw new Error(`候选内容超过 ${MEMORY_WRITE_MAX_CHARS} 字符上限`);
  }
}

/**
 * ADR-008：Agent write/patch 工具写 .CodePapr/memory.md 时拦截，不落盘，
 * 转 memory_candidate（trust=derived，source=agent-proposed）。风险检测是
 * 入队门槛；准入策略在审查时才是真正防线。
 */
export async function proposeMemoryCandidateFromWrite(params: {
  workspacePath: string;
  sessionId?: string;
  content: string;
  origin: string;
}): Promise<{ candidateId: string; redacted: boolean; deduplicated: boolean }> {
  const content = params.content.trim();
  if (!content) throw new Error('memory.md 写入内容为空');
  const envelope = envelopeContent({
    source: 'agent-proposed',
    trust: 'derived',
    origin: params.origin,
    content,
  });
  assertCandidateQueueable(envelope);
  const redacted = redactSecrets(envelope.content);
  const candidate = {
    id: createId(),
    category: 'general',
    content: redacted,
    contentHash: sha256(redacted),
    confidence: 'reported' as const,
    trust: envelope.trust,
    sourceSessionId: params.sessionId,
    sourceMessageIds: JSON.stringify([]),
    evidence: JSON.stringify({ origin: params.origin }),
    riskFlags: JSON.stringify(envelope.riskFlags),
    createdAt: Date.now(),
  };
  const inserted = await saveMemoryCandidate(params.workspacePath, candidate);
  return {
    candidateId: candidate.id,
    redacted: redacted !== envelope.content,
    deduplicated: !inserted,
  };
}

export const MEMORY_WRITE_INTERCEPT_NOTE =
  'memory.md 由 CodePapr 双区管理（ADR-008）：Agent 直接写入已拦截并转为记忆候选（pending），未落盘。请改用 memory_write 工具提交记忆；候选需用户在记忆面板审查准入。';

/** memory_search 创建的 re-recall 审计行 id，按 session 归集；回合结束由
 *  sendMessage 排空并归档（ADR-009 生命周期：turn 结束 status='archived'）。 */
const reRecallAuditIds = new Map<string, Set<string>>();

export function drainReRecallAuditIds(sessionId: string): string[] {
  const ids = reRecallAuditIds.get(sessionId);
  reRecallAuditIds.delete(sessionId);
  return ids ? [...ids] : [];
}

interface MemoryToolContext {
  signal?: AbortSignal;
  userMessageId?: string;
}

async function reprojectManagedZone(workspacePath: string): Promise<void> {
  try {
    await reprojectMemoryManagedZone(workspacePath);
  } catch (err) {
    console.warn('[memory-tools] 重新投影失败:', err instanceof Error ? err.message : err);
  }
}

/** 重投影 managed zone（active entries → buildMemoryProjection → 落盘）。
 *  供 memory 工具与 Memory Inspector 面板共用。 */
export async function reprojectMemoryManagedZone(workspacePath: string): Promise<void> {
  const entries = await loadMemoryEntries(workspacePath, true);
  const projection = buildMemoryProjection(
    entries.map((entry) => ({
      category: entry.category,
      content: entry.content,
      confidence: entry.confidence,
      trust: entry.trust,
      verifiedAt: entry.verifiedAt,
    }))
  );
  await projectMemoryFile(workspacePath, projection);
}

function renderCandidateList(candidates: PersistedMemoryCandidate[]): string {
  if (candidates.length === 0) {
    return '（无 pending 候选）';
  }
  return candidates
    .map((candidate) => {
      const preview = candidate.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      return `- id: ${candidate.id}\n  category: ${candidate.category} | trust: ${candidate.trust} | confidence: ${candidate.confidence}\n  content: ${preview}${candidate.rejectionReason ? `\n  rejectionReason: ${candidate.rejectionReason}` : ''}`;
    })
    .join('\n');
}

function renderSearchResults(query: string, items: RecallSearchItem[]): string {
  const block = renderRecallBlock(
    items.map((item) => ({
      title: item.title,
      content: item.content,
      confidence: item.confidence,
      trust: item.trust,
    })),
    { maxItems: 5 }
  );
  if (!block) {
    return `memory_search 无匹配结果（query: ${query}）`;
  }
  return `${block}\n\n（${items.length} 条命中；内容仅作辅助参考，可能过时，请对照当前 workspace 验证）`;
}

/**
 * 注册 4 个记忆工具。`sessionId` 用于候选来源溯源；worker 路径经
 * tool-request 桥回主线程执行，context.userMessageId 为 recall anchor。
 */
export function registerMemoryTools(
  registry: ToolRegistry,
  workspacePath: string,
  sessionId: string
): void {
  registry.register(toolByName('memory_write'), async (args) => {
    const content = asString(args.content, 'content').trim();
    if (!content) throw new Error('content 不能为空');
    if (content.length > MEMORY_WRITE_MAX_CHARS) {
      throw new Error(`content 超过 ${MEMORY_WRITE_MAX_CHARS} 字符上限`);
    }
    const category = (asOptionalString(args.category) ?? 'general').trim() || 'general';
    if (!MEMORY_CATEGORIES.has(category)) {
      throw new Error(`未知类别: ${category}（可用：${[...MEMORY_CATEGORIES].join('/')}）`);
    }
    const evidence = asOptionalString(args.evidence)?.trim();

    // 入队门槛：风险检测 + 尺寸（准入门在审查时执行）。
    const envelope = envelopeContent({
      source: 'agent-proposed',
      trust: 'derived',
      origin: 'memory_write',
      content,
    });
    assertCandidateQueueable(envelope);
    const redacted = redactSecrets(envelope.content);
    const candidate = {
      id: createId(),
      category,
      content: redacted,
      contentHash: sha256(redacted),
      confidence: 'reported' as const,
      trust: envelope.trust,
      sourceSessionId: sessionId,
      sourceMessageIds: JSON.stringify([]),
      evidence: JSON.stringify({ origin: 'memory_write', evidence: evidence ?? null }),
      riskFlags: JSON.stringify(envelope.riskFlags),
      createdAt: Date.now(),
    };
    let inserted: boolean;
    try {
      inserted = await saveMemoryCandidate(workspacePath, candidate);
    } catch (err) {
      throw new Error(`候选落库失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!inserted) {
      return {
        id: candidate.id,
        status: 'duplicate',
        note: '相同内容的候选已存在（pending/已准入/已拒绝），未重复入队。',
      };
    }
    return {
      id: candidate.id,
      status: 'pending',
      note: '已创建记忆候选（pending）。准入需要用户在记忆面板确认，Agent 不能自我准入。',
    };
  });

  registry.register(toolByName('memory_search'), async (args, context) => {
    const query = asString(args.query, 'query').trim();
    if (!query) throw new Error('query 不能为空');
    const category = asOptionalString(args.category)?.trim();
    const tokens = buildRecallQuery(query, category ? [category] : []);
    if (tokens.length === 0) {
      return { query, note: '查询无法 token 化（过短或全停用词）' };
    }

    let items: RecallSearchItem[];
    try {
      items = await searchMemoryForRecall(workspacePath, { tokens, limit: 10 });
    } catch (err) {
      console.warn('[memory-tools] memory_search 检索失败:', err instanceof Error ? err.message : err);
      items = [];
    }
    if (category && items.length > 0) {
      items = items.filter((item) => item.title === category);
    }

    const rendered = renderSearchResults(query, items);

    // PR5（ADR-009 第11条）：memory_search 触发受控 re-recall——order 递增的
    // 第二个 insertion（锚定本回合 user 消息之前）。主线程 Agent 路径无
    // userMessageId 时不生成（worker 路径经 tool-request 桥下发）。
    const toolCtx = context as MemoryToolContext | undefined;
    let reRecallInsertion: ReturnType<typeof buildRecallInsertion> | undefined;
    if (toolCtx?.userMessageId) {
      const recallId = createId();
      const renderedBlock = renderRecallBlock(
        items.map((item) => ({
          title: item.title,
          content: item.content,
          confidence: item.confidence,
          trust: item.trust,
        })),
        { maxItems: 5 }
      );
      if (renderedBlock) {
        reRecallInsertion = buildRecallInsertion({
          recallId,
          anchorMessageId: toolCtx.userMessageId,
          renderedBlock,
          order: 1,
        });
        // 审计行：与回合 Recall 同构，回合结束由 sendMessage 排空归档。
        try {
          await saveMemoryRecall(workspacePath, {
            id: recallId,
            workspaceId: workspacePath.trim(),
            sessionId,
            anchorMessageId: toolCtx.userMessageId,
            queryText: query,
            renderedContent: renderedBlock,
            itemsJson: JSON.stringify(items.slice(0, 5)),
            estimatedTokens: Math.ceil(renderedBlock.length / 4),
            retrievalStrategy: 'like-token-v1',
            retrievalVersion: 1,
            createdAt: Date.now(),
          });
          let set = reRecallAuditIds.get(sessionId);
          if (!set) {
            set = new Set();
            reRecallAuditIds.set(sessionId, set);
          }
          set.add(recallId);
        } catch (err) {
          console.warn(
            '[memory-tools] re-recall 审计行落库失败:',
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    return { query, results: rendered, reRecallInsertion };
  });

  registry.register(toolByName('memory_forget'), async (args) => {
    const id = asString(args.id, 'id').trim();
    if (!id) throw new Error('id 不能为空');
    const reason = asOptionalString(args.reason)?.trim();
    try {
      await forgetMemoryEntry(workspacePath, id, reason || undefined);
    } catch (err) {
      throw new Error(`遗忘失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    await reprojectManagedZone(workspacePath);
    return { forgotten: id, note: '已遗忘（软删除），managed zone 已重新投影。' };
  });

  registry.register(toolByName('memory_review_candidates'), async (args) => {
    const action = (asOptionalString(args.action) ?? 'list').trim() || 'list';
    const candidateIds = asOptionalStringArray(args.candidateIds) ?? [];
    const reason = asOptionalString(args.reason)?.trim();

    if (action === 'list') {
      let candidates: PersistedMemoryCandidate[];
      try {
        candidates = await loadMemoryCandidates(workspacePath, 'pending');
      } catch (err) {
        throw new Error(`读取候选失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { action, count: candidates.length, candidates: renderCandidateList(candidates) };
    }

    // ADR-008 安全边界：准入 = user-confirmed。Agent 不允许自我准入
    // （memory_write → 自我 admit 会绕过 human-in-the-loop，使「候选 only」
    // 保证失效）；admit 只能在记忆面板由用户操作。
    if (action === 'admit') {
      throw new Error(
        '准入需要用户确认：Agent 不能自我准入记忆候选。请告知用户在记忆面板（Memory Ledger）审查准入。'
      );
    }

    if (action === 'reject') {
      if (candidateIds.length === 0) {
        throw new Error('reject 需要 candidateIds');
      }
      const results: string[] = [];
      for (const candidateId of candidateIds) {
        try {
          await rejectMemoryCandidate(workspacePath, candidateId, reason);
          results.push(`rejected: ${candidateId}`);
        } catch (err) {
          results.push(
            `failed: ${candidateId} — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return { action, results };
    }

    throw new Error(`未知 action: ${action}（可用：list / reject；admit 仅限用户在记忆面板操作）`);
  });
}
