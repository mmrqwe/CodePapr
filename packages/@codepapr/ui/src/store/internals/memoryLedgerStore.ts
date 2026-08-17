/**
 * Memory Ledger 编排：主线程 Store 的自动写入 / 投影路径。
 *
 * 回合结束：user zone 同步 → 抽取已验证命令与用户原话 → persist/drop →
 * 若有 Bootstrap 类新条目则重投影 managed zone。失败静默不打断会话。
 */

import type { ContextMessageLike } from '../../utils/contextCompaction';
import {
  buildMemoryProjection,
  collectUserUtteranceMemoryCandidates,
  collectVerifiedMemoryCandidates,
} from '../../utils/memoryLedger';
import { persistMemoryProposal } from '../../utils/memoryPersist';
import {
  loadMemoryEntries,
  projectMemoryFile,
  syncUserZoneToLedger,
} from '../../utils/projectStorage';

export async function refreshMemoryLedgerProjection(
  workspacePath: string,
  sessionId: string,
  messages: readonly ContextMessageLike[]
): Promise<void> {
  try {
    await syncUserZoneToLedger(workspacePath);
  } catch (err) {
    console.warn(
      '[memory-ledger] user zone 同步失败:',
      err instanceof Error ? err.message : err
    );
  }

  const extracted = [
    ...collectVerifiedMemoryCandidates(messages),
    ...collectUserUtteranceMemoryCandidates(messages),
  ];
  let shouldProject = false;
  for (const { envelope, category, sourceMessageIds } of extracted) {
    try {
      const result = await persistMemoryProposal({
        workspacePath,
        sessionId,
        sourceMessageIds,
        envelope,
        category,
      });
      if (
        (result.status === 'saved' || result.status === 'stored-as-citation') &&
        result.projectToBootstrap
      ) {
        shouldProject = true;
      }
    } catch (err) {
      console.warn(
        '[memory-ledger] 记忆落库失败:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!shouldProject) {
    return;
  }

  try {
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
  } catch (err) {
    console.warn(
      '[memory-ledger] 投影失败:',
      err instanceof Error ? err.message : err
    );
  }
}
