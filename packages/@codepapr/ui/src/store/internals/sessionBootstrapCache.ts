/**
 * Per-session cache of the session-bootstrap prompt（sendMessage / agentFactory 共享）。
 *
 * The bootstrap embeds ledger-rendered memory（volatile），but rebuilding the
 * agent whenever that changes breaks DeepSeek's prefix cache for the whole
 * history. We freeze the bootstrap per (session × stable signature) so volatile
 * ledger changes do NOT force a rebuild.
 *
 * Refresh points（与文档承诺一致：「下次会话或压缩 epoch 生效」）:
 * - 新会话：无缓存条目，首发即 fresh 计算；
 * - /compact：invalidateSessionBootstrap → 下一回合按当时账本重算；
 * - 回合末 checkpoint 重建：sendMessage 重渲染并 primeSessionBootstrap；
 * - mid-loop 压缩：agentFactory 的 refreshBootstrap 重渲染并写回缓存，
 *   后续任何重建（crash/换模型）拿到的都是刷新后的版本。
 */

const sessionBootstrapCache = new Map<string, { signature: string; bootstrap: string }>();

// 有界缓存：每个条目是一整份 bootstrap 字符串（账本记忆 + skills + prompts），
// 随会话数无限增长会长期占用内存。超过上限时按最旧（Map 插入序）逐出；
// 被逐出的会话下次需要时只是重算一次，无正确性影响。
const SESSION_BOOTSTRAP_CACHE_MAX = 64;

function evictSessionBootstrapCache(): void {
  while (sessionBootstrapCache.size > SESSION_BOOTSTRAP_CACHE_MAX) {
    const oldest = sessionBootstrapCache.keys().next().value;
    if (oldest === undefined) break;
    sessionBootstrapCache.delete(oldest);
  }
}

/** 切工作区：丢掉按 sessionId 索引的 bootstrap，避免把旧项目 memory 拼进新会话。 */
export function clearSessionBootstrapCache(): void {
  sessionBootstrapCache.clear();
}

export function resolveSessionBootstrap(
  sessionId: string | null,
  signature: string,
  computeFresh: () => string
): string {
  if (!sessionId) return computeFresh();
  const cached = sessionBootstrapCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.bootstrap;
  }
  const bootstrap = computeFresh();
  sessionBootstrapCache.set(sessionId, { signature, bootstrap });
  evictSessionBootstrapCache();
  return bootstrap;
}

/** 压缩 epoch 刷新后写回：保持原 signature，替换 bootstrap 文本。
 *  下一回合 resolveSessionBootstrap 命中同一 signature 时拿到的是刷新版，
 *  而不是回合首冻结的旧账本快照。 */
export function primeSessionBootstrap(
  sessionId: string | null,
  signature: string,
  bootstrap: string
): void {
  if (!sessionId) return;
  sessionBootstrapCache.set(sessionId, { signature, bootstrap });
  evictSessionBootstrapCache();
}

/** epoch 变化但无法就地重算（如 /compact 后 agent 已销毁）：丢条目，
 *  下次发送按当时的账本重新计算。 */
export function invalidateSessionBootstrap(sessionId: string | null): void {
  if (!sessionId) return;
  sessionBootstrapCache.delete(sessionId);
}
