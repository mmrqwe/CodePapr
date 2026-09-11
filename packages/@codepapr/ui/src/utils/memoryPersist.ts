/**
 * 记忆自动落库：候选表只作去重/审计，写入后同一路径 admit 或 drop。
 * Bootstrap 从账本渲染，不再投影 memory.md。
 */

import { type ContentEnvelope } from '@codepapr/core';
import { createId } from './createId';
import {
  buildMemoryCandidateInput,
  decideMemoryCandidate,
} from './memoryLedger';
import { admitMemoryCandidate, loadMemoryEntries, saveMemoryCandidate } from './projectStorage';

export interface PersistMemoryResult {
  status: 'saved' | 'stored-as-citation' | 'duplicate' | 'dropped';
  /** 可直接交给 memory_forget 的 entry id（非候选 id）。
   *  dropped、或 duplicate 且既有条目非 active（forgotten/superseded）时为空串。 */
  id: string;
  kind?: string;
  projectToBootstrap?: boolean;
  reason?: string;
  redacted: boolean;
  note: string;
}

export async function persistMemoryProposal(params: {
  workspacePath: string;
  sessionId?: string;
  sourceMessageIds?: string[];
  envelope: ContentEnvelope;
  category?: string;
}): Promise<PersistMemoryResult> {
  const decision = decideMemoryCandidate(params.envelope, params.category);
  const redacted = decision.redactedContent !== params.envelope.content;
  if (decision.action === 'drop') {
    return {
      status: 'dropped',
      id: '',
      reason: decision.reason,
      redacted,
      note: `未写入项目记忆（${decision.reason}）。`,
    };
  }

  const input = buildMemoryCandidateInput({
    sessionId: params.sessionId ?? '',
    sourceMessageIds: params.sourceMessageIds ?? [],
    envelope: { ...params.envelope, content: decision.redactedContent },
    category: decision.kind,
    confidence: decision.confidence,
  });

  let inserted: boolean;
  try {
    inserted = await saveMemoryCandidate(params.workspacePath, input);
  } catch (err) {
    throw new Error(`记忆落库失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!inserted) {
    // 去重命中：候选闸门按 content_hash 拦截且不看条目现状（save_memory_candidate
    // 只查候选表）。原 entry 可能早已被遗忘——必须按账本实际状态报告，否则会出现
    // 「相同内容已存在」但 active 里根本没有、又拿不到可操作 id 的误导提示（MEM-02）。
    // revive 仅面板（M7/ADR-010）：自动写入路径绝不复活已遗忘条目。
    let duplicateEntryId = '';
    let note = '相同内容已存在，未重复写入。';
    try {
      const entries = await loadMemoryEntries(params.workspacePath, false);
      const same = entries.filter((entry) => entry.contentHash === input.contentHash);
      const active = same.find((entry) => entry.status === 'active');
      const forgotten = same.find((entry) => entry.status === 'forgotten');
      if (active) {
        duplicateEntryId = active.id;
        note = '相同内容已存在，未重复写入。如需遗忘，用返回的 id 调 memory_forget。';
      } else if (forgotten) {
        note =
          `该内容的既往记忆条目已被遗忘（id: ${forgotten.id}）。` +
          '自动写入不会复活已遗忘条目：请改写表述重新记忆，或请用户在记忆面板恢复该条目。';
      } else if (same.length > 0) {
        note = '相同内容的条目已被更新替代（superseded），未重复写入。';
      } else {
        // 账本无同 hash 条目：候选行是历史被拒记录（如 content-forgotten）。
        // 退回空 id：好过返回一个不可 forget 的候选 id。
        note = '相同内容此前已被记忆闸门拦截（未入账），本次未重复入队。';
      }
    } catch {
      // 查不到就维持通用去重说明。
    }
    return {
      status: 'duplicate',
      id: duplicateEntryId,
      kind: decision.kind,
      projectToBootstrap: decision.projectToBootstrap,
      redacted,
      note,
    };
  }

  let entryId: string;
  try {
    // admit 返回真正落库的 entry id（同内容 active 时幂等返回既有 id）。
    entryId = await admitMemoryCandidate(params.workspacePath, input.id, createId());
  } catch (err) {
    throw new Error(`记忆写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const citation = decision.kind === 'citation';
  return {
    status: citation ? 'stored-as-citation' : 'saved',
    id: entryId,
    kind: decision.kind,
    projectToBootstrap: decision.projectToBootstrap,
    redacted,
    note: citation
      ? '已保存为带出处的引用（不进入下次会话固定前缀，可按需召回）。'
      : decision.projectToBootstrap
        ? '已记住，下次会话启动时自动加载。'
        : '已记住，需要时会按需召回。',
  };
}

