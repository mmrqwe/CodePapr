/**
 * Context Surface / Compaction / Memory Recall contract types (PR0).
 *
 * 契约冻结（docs/adr/）：这些类型跨 UI store、worker 协议与 Rust DDL 使用。
 * PR0 只定义形状，不做任何运行时接线；PR1/PR5 分别落地 Surface 与 Recall。
 *
 * 关键约束（ADR-002/003/004/009）：
 * - 所有 provenance 引用 message ID（应用级），不用可变 positional index；
 * - 不对 messages 建 FK；
 * - bootstrap / prefix / tools schema 永远不属于 Surface；
 * - Recall 是 request-only augmentation，不进 log / archive / surface。
 */

/** Surface 节点的类别（ADR-001）。 */
export type ContextSurfaceNodeKind = 'checkpoint' | 'conversation' | 'injected';

/** 压缩触发来源（ADR-005）。 */
export type CompactionTrigger =
  | 'round-limit'
  | 'token-limit'
  | 'manual'
  | 'provider-overflow';

/** 压缩事务状态（ADR-005：单事务提交，正常无 started 残留）。 */
export type CompactionStatus = 'started' | 'completed' | 'failed';

/** checkpoint 生成方式（ADR-007）。 */
export type SummaryMode = 'llm' | 'local-fallback';

/**
 * 冻结的 prune 参数（ADR-006 的历史列形状；v4 起 prune 层已删除）。
 *
 * render_params 列仍在 DB/Rust 契约中，v4 后写入的恒为「全部禁用」常量
 * （见 UI serializeDisabledRenderParams），此类型仅描述该线格式。
 */
export interface FrozenPruneParams {
  enabled: boolean;
  protectRecentRounds: number;
  minPrunableChars: number;
  protectedTools: string[];
  placeholder: string;
}

/**
 * Per-generation 冻结渲染参数（ADR-006）。
 *
 * hydrate 时必须用冻结参数重放编译器，忽略当前 settings 的 prune 配置；
 * 代码升级导致的字节变化 = 一次性 cache miss（renderVersion 用于标记与调试）。
 */
export interface SurfaceRenderParams {
  pruneParams: FrozenPruneParams;
  renderVersion: number;
}

export interface ContextSurfaceNode {
  position: number;
  messageId: string;
  nodeKind: ContextSurfaceNodeKind;
}

/** 某个 session 当前 generation 的完整 surface（ADR-003：唯一选择权威）。 */
export interface ContextSurfaceSnapshot {
  sessionId: string;
  generation: number;
  parentGeneration: number | null;
  compactionId: string | null;
  nodes: ContextSurfaceNode[];
  renderParams: SurfaceRenderParams;
  createdAt: number;
}

/** 压缩事务元数据（与 context_compactions 表一一对应）。 */
export interface ContextCompactionRecord {
  id: string;
  sessionId: string;
  status: CompactionStatus;
  trigger: CompactionTrigger;
  sourceGeneration: number;
  targetGeneration: number | null;
  checkpointMessageId: string | null;
  parentCheckpointMessageId: string | null;
  sourceStartMessageId: string | null;
  sourceEndMessageId: string | null;
  retainedTailStartMessageId: string | null;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensBefore: number | null;
  estimatedTokensAfter: number | null;
  sourceTokens: number | null;
  checkpointTokens: number | null;
  summaryMode: SummaryMode;
  summaryProvider: string | null;
  summaryModel: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

/**
 * 主线程统一 commit 的压缩意图（ADR-005）。
 * Worker 只产出 intent，主线程 Store 校验后单事务持久化。
 */
export interface ContextCompactionIntent {
  sessionId: string;
  trigger: CompactionTrigger;
  sourceGeneration: number | null;
  checkpointMessageId: string;
  sourceMessageIds: string[];
  retainedMessageIds: string[];
  renderParams: SurfaceRenderParams;
  tokenStats: {
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    sourceTokens: number;
    checkpointTokens: number;
  };
  summaryInfo: {
    kind: SummaryMode;
    provider?: string;
    model?: string;
  };
}

/**
 * Request-only 上下文插入（ADR-009，B3）。
 *
 * 只作用于 RequestBuilder 编译产物的 log 段，锚定在 anchorMessageId 之前；
 * 不进入 AppendOnlyLog / Archive / Surface / hash 基线。
 */
export interface RequestContextInsertion {
  id: string;
  /** 锚定目标：当前回合 canonical user 消息的 ID（主线程生成，贯穿 log）。 */
  anchorMessageId: string;
  placement: 'before';
  role: 'user';
  content: string;
  source: 'memory-recall';
  /** 同一 anchor 的多个插入按 order 升序排列（re-recall 时递增）。 */
  order: number;
}

/* ------------------------------------------------------------------------ *
 * Memory Recall（PR5 使用的最小形状；PR5 允许扩展字段）
 * ------------------------------------------------------------------------ */

export type MemoryRecallSource =
  | 'stable-memory'
  | 'session-checkpoint'
  | 'artifact'
  | 'archive';

export type MemoryRecallConfidence = 'confirmed' | 'reported' | 'unverified';

export type MemoryRecallTrust = 'trusted' | 'workspace' | 'derived' | 'untrusted';

export interface MemoryRecallItem {
  id: string;
  source: MemoryRecallSource;
  title: string;
  content: string;
  confidence: MemoryRecallConfidence;
  trust: MemoryRecallTrust;
  score: number;
  provenance: {
    sessionId?: string;
    messageIds?: string[];
    artifactId?: string;
    filePath?: string;
    createdAt?: number;
    lastVerifiedAt?: number;
  };
}

export interface MemoryRecallBlock {
  recallId: string;
  sessionId: string;
  /** 本回合 canonical user 消息 ID（anchor）。 */
  anchorMessageId: string;
  query: string;
  items: MemoryRecallItem[];
  estimatedTokens: number;
  createdAt: number;
}
