/**
 * 记忆工具：memory_write / memory_search / memory_forget / memory_list。
 *
 * - memory_write：按确定性策略立刻 persist 或 drop，不排队等用户审核；
 * - memory_search：检索稳定记忆 + checkpoint 事实；可触发受控 re-recall；
 * - memory_forget：active → forgotten（手写笔记只能在面板遗忘）；
 * - memory_list：列出已写入的记忆目录（原名 memory_review_candidates，
 *   零审核策略下它不是审核队列）。
 */

import {
  ToolRegistry,
  asString,
  asOptionalString,
  envelopeContent,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_KINDS,
  type ContentSourceKind,
  type ContentTrust,
} from '@codepapr/core';
import { estimateTokens } from '@codepapr/common';
import { toolByName } from './workspaceToolDefinitions';
import { createId } from '../utils/createId';
import {
  forgetMemoryEntry,
  loadMemoryEntries,
  saveMemoryRecall,
  searchMemoryForRecall,
  type RecallSearchItem,
} from '../utils/projectStorage';
import { persistMemoryProposal, type PersistMemoryResult } from '../utils/memoryPersist';
import {
  buildRecallInsertion,
  buildRecallQuery,
  renderRecallBlock,
} from '../utils/memoryRecall';

const MEMORY_CATEGORIES = MEMORY_KINDS;

/** 入队尺寸上限与准入门共用 core 常量（MEMORY_CONTENT_MAX_CHARS），
 *  避免「可入队但永不可准入」的契约断裂。 */
const MEMORY_WRITE_MAX_CHARS = MEMORY_CONTENT_MAX_CHARS;

/** 拦截路径归一化后与 .CodePapr/memory.md 比对。
 *  大小写不敏感：macOS 默认 APFS 大小写不敏感，`.codepapr/memory.md` 等
 *  变体指向同一文件，严格大小写比对会被绕过（注入内容直接落盘）。 */
export function isMemoryFilePath(relativePath: string): boolean {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalized === '.codepapr/memory.md';
}

/**
 * ADR-008/010：Agent write/patch 工具写 .CodePapr/memory.md 时拦截，不落盘，
 * 转自动写入策略（persist 或 drop）。
 */
export async function proposeMemoryCandidateFromWrite(params: {
  workspacePath: string;
  sessionId?: string;
  content: string;
  origin: string;
  source?: ContentSourceKind;
  trust?: ContentTrust;
  category?: string;
}): Promise<{
  candidateId: string;
  redacted: boolean;
  deduplicated: boolean;
  status: PersistMemoryResult['status'];
  note: string;
  projectToBootstrap: boolean;
}> {
  const content = params.content.trim();
  if (!content) throw new Error('记忆内容为空');
  const envelope = envelopeContent({
    source: params.source ?? 'agent-proposed',
    trust: params.trust ?? 'derived',
    origin: params.origin,
    content,
  });
  if (envelope.riskFlags.length > 0) {
    throw new Error(`候选被风险检测拦截: ${envelope.riskFlags.join(',')}`);
  }
  const result = await persistMemoryProposal({
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    envelope,
    category: params.category ?? 'general',
  });
  if (result.status === 'dropped') {
    throw new Error(result.note);
  }
  return {
    candidateId: result.id,
    redacted: result.redacted,
    deduplicated: result.status === 'duplicate',
    status: result.status,
    note: result.note,
    projectToBootstrap: Boolean(result.projectToBootstrap),
  };
}

export const MEMORY_WRITE_INTERCEPT_NOTE =
  '没有独立的 memory.md。Agent 直接写入已被拦截，并按自动策略写入记忆账本（或因风险丢弃）。请改用 memory_write，手写笔记请在记忆面板添加。';

/** memory_search 创建的 re-recall 审计行 id，按 session 归集；回合结束由
 *  sendMessage 排空并归档（ADR-009 生命周期：turn 结束 status='archived'）。 */
const reRecallAuditIds = new Map<string, Set<string>>();

export function drainReRecallAuditIds(sessionId: string): string[] {
  const ids = reRecallAuditIds.get(sessionId);
  reRecallAuditIds.delete(sessionId);
  return ids ? [...ids] : [];
}

/** 切工作区：丢掉未归档的 re-recall 审计 id，避免写进新项目账本。 */
export function clearAllReRecallAuditIds(): void {
  reRecallAuditIds.clear();
}

interface MemoryToolContext {
  signal?: AbortSignal;
  userMessageId?: string;
}

export async function reprojectMemoryManagedZone(_workspacePath: string): Promise<void> {
  // Bootstrap 从账本渲染，不再写 memory.md。
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
    const origin =
      evidence && /^https?:\/\//i.test(evidence) ? evidence : 'memory_write';

    const envelope = envelopeContent({
      source: 'agent-proposed',
      trust: 'derived',
      origin,
      content,
    });
    if (envelope.riskFlags.length > 0) {
      throw new Error(`候选被风险检测拦截: ${envelope.riskFlags.join(',')}`);
    }

    const result = await persistMemoryProposal({
      workspacePath,
      sessionId,
      envelope,
      category,
    });
    if (result.status === 'dropped') {
      return {
        id: result.id || undefined,
        status: 'dropped',
        reason: result.reason,
        note: result.note,
      };
    }
    return {
      id: result.id,
      status: result.status,
      kind: result.kind,
      note: result.note,
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
      items = items.filter((item) => item.category === category);
    }

    const rendered = renderSearchResults(query, items);

    // PR5（ADR-009 第11条）：memory_search 触发受控 re-recall——order 递增的
    // 第二个 insertion（锚定本回合 user 消息之前）。主线程 Agent 路径无
    // userMessageId 时不生成（worker 路径经 tool-request 桥下发）。
    // 每 turn 至多一次：worker 只 push 第一次，后续搜索若再写审计行会虚增。
    const toolCtx = context as MemoryToolContext | undefined;
    let reRecallInsertion: ReturnType<typeof buildRecallInsertion> | undefined;
    const alreadyRecalledThisTurn = (reRecallAuditIds.get(sessionId)?.size ?? 0) > 0;
    if (toolCtx?.userMessageId && !alreadyRecalledThisTurn) {
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
            estimatedTokens: estimateTokens(renderedBlock),
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
      const entries = await loadMemoryEntries(workspacePath, false);
      const target = entries.find((entry) => entry.id === id);
      if (target?.category === 'user-note') {
        throw new Error('手写笔记只能在记忆面板中遗忘');
      }
      await forgetMemoryEntry(workspacePath, id, reason || undefined);
    } catch (err) {
      throw new Error(`遗忘失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { forgotten: id, note: '已遗忘（软删除）。下次会话前缀将不再包含该条目。' };
  });

  registry.register(toolByName('memory_list'), async (args) => {
    const action = (asOptionalString(args.action) ?? 'list').trim() || 'list';

    if (action === 'admit' || action === 'reject') {
      throw new Error(
        '记忆已自动写入，无需审核。错误或过时的条目请用 memory_forget。'
      );
    }

    if (action === 'list') {
      let entries: Awaited<ReturnType<typeof loadMemoryEntries>>;
      try {
        entries = await loadMemoryEntries(workspacePath, true);
      } catch (err) {
        throw new Error(`读取记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (entries.length === 0) {
        return { action, count: 0, memories: '（暂无稳定记忆）' };
      }
      const memories = entries
        .slice(0, 40)
        .map((entry) => {
          const preview = entry.content.replace(/\s+/g, ' ').trim().slice(0, 200);
          return `- id: ${entry.id}\n  category: ${entry.category} | trust: ${entry.trust} | confidence: ${entry.confidence}\n  content: ${preview}`;
        })
        .join('\n');
      return { action, count: entries.length, memories };
    }

    throw new Error(`未知 action: ${action}（可用：list）`);
  });
}
