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
import { admitMemoryCandidate, saveMemoryCandidate } from './projectStorage';

export interface PersistMemoryResult {
  status: 'saved' | 'stored-as-citation' | 'duplicate' | 'dropped';
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
    return {
      status: 'duplicate',
      id: input.id,
      kind: decision.kind,
      projectToBootstrap: decision.projectToBootstrap,
      redacted,
      note: '相同内容已存在，未重复写入。',
    };
  }

  try {
    await admitMemoryCandidate(params.workspacePath, input.id, createId());
  } catch (err) {
    throw new Error(`记忆写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const citation = decision.kind === 'citation';
  return {
    status: citation ? 'stored-as-citation' : 'saved',
    id: input.id,
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

