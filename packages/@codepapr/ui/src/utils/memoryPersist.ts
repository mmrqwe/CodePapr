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
import {
  admitMemoryCandidate,
  loadMemoryEntries,
  saveMemoryCandidate,
  type MemoryAdmitOutcome,
} from './projectStorage';

export interface PersistMemoryResult {
  status: 'saved' | 'stored-as-citation' | 'duplicate' | 'dropped';
  /** 可直接交给 memory_forget / supersedesEntryId 的 entry id（非候选 id）。
   *  dropped、或 duplicate 且既有条目非 active（forgotten/superseded）时为空串。 */
  id: string;
  kind?: string;
  projectToBootstrap?: boolean;
  reason?: string;
  redacted: boolean;
  note: string;
  /** 准入实际发生了什么（duplicate/dropped 时为 undefined）。 */
  action?: MemoryAdmitOutcome['action'];
}

export async function persistMemoryProposal(params: {
  workspacePath: string;
  sessionId?: string;
  sourceMessageIds?: string[];
  envelope: ContentEnvelope;
  category?: string;
  /** 写即更新：指名替换的记忆条目 id（跨 category 允许）。不传时，
   *  与既有 active 条目近似的写入也会在账本侧替换旧条目（新者胜）。 */
  supersedesEntryId?: string;
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
        note =
          '相同内容已存在，未重复写入。如需遗忘，用返回的 id 调 memory_forget；' +
          '如需更正，直接写新表述（会替换近义旧条目）或带 supersedesEntryId 指名替换。';
      } else if (forgotten) {
        note =
          `该内容的既往记忆条目已被遗忘（id: ${forgotten.id}）。` +
          '自动写入不会复活已遗忘条目：找回该条目请用户在记忆面板恢复；' +
          '更正过时事实无需先 forget——直接写新表述即可替换近义旧条目。';
      } else if (same.length > 0) {
        note = '相同内容的条目已被更新替代（superseded），未重复写入。';
      } else {
        // 账本无同 hash 条目：候选行是历史被拒记录（如 content-forgotten），
        // 或曾命中 kept-confirmed（候选记了 admitted 但未建新条目）。
        note = '相同内容此前已被记忆账本处理（未新建条目或按原样保留），本次未重复入账。';
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

  let outcome: MemoryAdmitOutcome;
  try {
    // admit 返回真正落库的 entry id 与动作（幂等/替换/保留原文都如实报告）。
    outcome = await admitMemoryCandidate(
      params.workspacePath,
      input.id,
      createId(),
      params.supersedesEntryId
    );
  } catch (err) {
    throw new Error(`记忆写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const citation = decision.kind === 'citation';
  const base = {
    id: outcome.entryId,
    kind: decision.kind,
    projectToBootstrap: decision.projectToBootstrap,
    redacted,
    action: outcome.action,
  } as const;

  switch (outcome.action) {
    case 'kept-confirmed':
      return {
        ...base,
        status: 'saved',
        note:
          '未写入：命中的既有条目来自用户原话或工具实证（confirmed），未证实的写入不得覆盖其原文。' +
          '如需更正它，请用户在记忆面板编辑该条目。',
      };
    case 'superseded':
      return {
        ...base,
        status: citation ? 'stored-as-citation' : 'saved',
        note:
          (citation
            ? '已保存为带出处的引用，并替换了被指向的旧条目（旧条目已归档，可在面板查看）。'
            : '已用新内容替换旧记忆条目（写即更新；旧条目归档为 superseded，可在面板查看）。') +
          (decision.projectToBootstrap ? '下次会话启动时自动加载新条目。' : '新条目按需召回。'),
      };
    case 'existing':
      return {
        ...base,
        status: 'saved',
        note: '相同内容已存在（幂等，未重复写入），沿用既有 entry id。',
      };
    default:
      return {
        ...base,
        status: citation ? 'stored-as-citation' : 'saved',
        note: citation
          ? '已保存为带出处的引用（不进入下次会话固定前缀，可按需召回）。'
          : decision.projectToBootstrap
            ? '已记住，下次会话启动时自动加载。'
            : '已记住，需要时会按需召回。',
      };
  }
}

