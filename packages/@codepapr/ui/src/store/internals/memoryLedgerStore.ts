/**
 * Memory Ledger 编排（PR4，ADR-008）：主线程 Store 的准入/投影落库路径。
 *
 * v1 唯一自动准入来源：执行验证（bash 测试命令成功）。准入策略在
 * utils/memoryLedger 的纯函数层（信封 + 风险标记 + 脱敏 + 裁决），
 * 本文件只做 IPC 编排，失败静默不打断会话。
 */

import type { ContextMessageLike } from '../../utils/contextCompaction';
import {
  buildMemoryCandidateInput,
  buildMemoryProjection,
  collectVerifiedMemoryCandidates,
  decideMemoryCandidate,
} from '../../utils/memoryLedger';
import { createId } from '../../utils/createId';
import {
  admitMemoryCandidate,
  loadMemoryEntries,
  projectMemoryFile,
  saveMemoryCandidate,
  syncUserZoneToLedger,
} from '../../utils/projectStorage';

/**
 * 回合结束调用：用户手编 user zone 读入 ledger（ADR-008 第4点，幂等）→
 * 从本轮消息抽取已验证命令 → 候选 → 准入 → 重新投影 memory.md 的
 * managed zone（user zone 由 Rust 侧保留，ADR-008）。
 */
export async function refreshMemoryLedgerProjection(
  workspacePath: string,
  sessionId: string,
  messages: readonly ContextMessageLike[]
): Promise<void> {
  // 0. user zone → ledger（幂等；失败静默，不阻断后续准入/投影）
  try {
    await syncUserZoneToLedger(workspacePath);
  } catch (err) {
    console.warn(
      '[memory-ledger] user zone 同步失败:',
      err instanceof Error ? err.message : err
    );
  }

  // 1. 候选抽取 + 确定性准入裁决。
  // 每回合全量重扫历史消息，去重全部依赖 content_hash（Rust 侧）：
  // - save 对同 hash 候选（pending/admitted/rejected）静默跳过 → 同一命令
  //   不再每回合重复入队；
  // - admit 对同 hash 已 forgotten 的条目拒绝、已 active 的条目幂等，
  //   被遗忘的记忆不会随重扫复活。
  const candidates = collectVerifiedMemoryCandidates(messages);
  let admitted = false;
  for (const { envelope, category, sourceMessageIds } of candidates) {
    const decision = decideMemoryCandidate(envelope);
    if (!decision.admitted) {
      console.warn('[memory-ledger] 候选被拒绝:', decision.reason);
      continue;
    }
    try {
      const input = buildMemoryCandidateInput({
        sessionId,
        sourceMessageIds,
        envelope,
        category,
      });
      const inserted = await saveMemoryCandidate(workspacePath, input);
      if (!inserted) {
        // 同内容候选已存在（通常已准入）：无新内容，跳过。
        continue;
      }
      await admitMemoryCandidate(workspacePath, input.id, createId());
      admitted = true;
    } catch (err) {
      console.warn(
        '[memory-ledger] 候选落库失败:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!admitted) {
    // 无新准入：不触碰 memory.md（避免无意义的文件重写）。
    return;
  }

  // 2. 重新投影 managed zone（token-budgeted；user zone 保留）
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
