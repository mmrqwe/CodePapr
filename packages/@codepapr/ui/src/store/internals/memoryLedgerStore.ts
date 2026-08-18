/**
 * Memory Ledger 编排：主线程 Store 的自动写入路径。
 *
 * 回合结束：抽取已验证命令与用户原话 → persist/drop。
 * Bootstrap 从账本渲染，不再投影 memory.md。
 */

import type { ContextMessageLike } from '../../utils/contextCompaction';
import {
  buildMemoryProjection,
  collectUserUtteranceMemoryCandidates,
  collectVerifiedMemoryCandidates,
  type ProjectionEntry,
} from '../../utils/memoryLedger';
import { persistMemoryProposal } from '../../utils/memoryPersist';
import {
  ingestLegacyMemoryMd,
  loadMemoryEntries,
  type PersistedMemoryEntry,
} from '../../utils/projectStorage';

function toProjectionEntry(entry: PersistedMemoryEntry): ProjectionEntry {
  return {
    category: entry.category,
    content: entry.content,
    confidence: entry.confidence,
    trust: entry.trust,
    verifiedAt: entry.verifiedAt,
  };
}

/** 会话启动 / 压缩刷新：迁移旧文件后从账本渲染 Bootstrap 记忆段。 */
export async function loadMemoryBootstrapSection(
  workspacePath: string
): Promise<string | undefined> {
  try {
    await ingestLegacyMemoryMd(workspacePath);
  } catch (err) {
    console.warn(
      '[memory-ledger] 遗留 memory.md 迁移失败:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const entries = await loadMemoryEntries(workspacePath, true);
    const rendered = buildMemoryProjection(entries.map(toProjectionEntry)).trim();
    if (!rendered || rendered.includes('暂无已验证')) {
      return undefined;
    }
    return rendered;
  } catch (err) {
    console.warn(
      '[memory-ledger] 读取账本失败:',
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

export async function refreshMemoryLedgerProjection(
  workspacePath: string,
  sessionId: string,
  messages: readonly ContextMessageLike[]
): Promise<void> {
  const extracted = [
    ...collectVerifiedMemoryCandidates(messages),
    ...collectUserUtteranceMemoryCandidates(messages),
  ];
  for (const { envelope, category, sourceMessageIds } of extracted) {
    try {
      await persistMemoryProposal({
        workspacePath,
        sessionId,
        sourceMessageIds,
        envelope,
        category,
      });
    } catch (err) {
      console.warn(
        '[memory-ledger] 记忆落库失败:',
        err instanceof Error ? err.message : err
      );
    }
  }
}
