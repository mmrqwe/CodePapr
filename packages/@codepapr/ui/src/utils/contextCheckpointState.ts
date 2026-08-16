/**
 * ContextCheckpoint v3 结构化状态与纯迁移函数（PR0）。
 *
 * PR0 只冻结类型 + 实现确定性 migrator；PR3 才把它接进压缩运行时
 * （LLM merge 输出、本地 fallback 输出、prior checkpoint 合并输入）。
 *
 * 渲染器绑定（ADR-007）：
 * - 已归档的 v2 payload 保持 v2 渲染器渲染（renderedContent 不动）；
 * - migrator 只生成「用于合并 / 生成新 checkpoint」的 v3 state，
 *   不重写已持久化的 v2 payload。
 */

import type {
  ContextCheckpointPayload,
  ContextCheckpointSections,
} from './contextCompaction';

export const CONTEXT_CHECKPOINT_VERSION_3 = 3;

/**
 * 最小 ContextFact 占位（PR2 在 core/src/context 补全并收敛正式定义；
 * 届时本文件改为从 core 导入）。providence 字段仅为形状占位。
 */
export interface ContextFactPlaceholder {
  id: string;
  kind: string;
  trust: 'trusted' | 'workspace' | 'derived' | 'untrusted';
  disposition: 'pinned' | 'retained' | 'summarized' | 'externalized' | 'discarded';
  summary: string;
  artifactRef?: string;
  sourceMessageIds?: string[];
}

/** 结构化 checkpoint 状态（ADR-007）。所有分区为 string[]。 */
export interface ContextCheckpointStateV3 {
  goal: string[];
  constraints: string[];
  confirmedFacts: string[];
  assumptions: string[];
  decisions: string[];
  completedWork: string[];
  activeWork: string[];
  verification: string[];
  failuresAndRisks: string[];
  todos: string[];
  openQuestions: string[];
  references: string[];
  provenance: ContextFactPlaceholder[];
}

export interface CheckpointTokenStats {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  sourceTokens: number;
  checkpointTokens: number;
}

export interface CheckpointSummaryInfo {
  kind: 'llm' | 'local-fallback';
  provider?: string;
  model?: string;
}

/** v3 payload：在 v2 字段之上新增结构化 state 与不可变 provenance（ADR-001）。 */
export interface ContextCheckpointPayloadV3 extends ContextCheckpointPayload {
  version: typeof CONTEXT_CHECKPOINT_VERSION_3;
  state: ContextCheckpointStateV3;
  compactionId?: string;
  generation?: number;
  parentGeneration?: number;
  trigger?: 'round-limit' | 'token-limit' | 'manual' | 'provider-overflow';
  sourceStartMessageId?: string;
  sourceEndMessageId?: string;
  retainedTailStartMessageId?: string;
  retainedMessageCount?: number;
  tokenStats?: CheckpointTokenStats;
  summaryInfo: CheckpointSummaryInfo;
}

export function createEmptyCheckpointStateV3(): ContextCheckpointStateV3 {
  return {
    goal: [],
    constraints: [],
    confirmedFacts: [],
    assumptions: [],
    decisions: [],
    completedWork: [],
    activeWork: [],
    verification: [],
    failuresAndRisks: [],
    todos: [],
    openQuestions: [],
    references: [],
    provenance: [],
  };
}

/** v2 validationNotes 中命中这些模式 → failuresAndRisks，其余 → verification。 */
const FAILURE_RISK_PATTERN =
  /失败|风险|错误|阻塞|待解决|未通过|修复|blocked|failed|error|risk|fix|todo:? fix/i;

/**
 * v2 importantContext → confirmedFacts / references 的确定性拆分规则（ADR-007）：
 * - 命中验证关键词（通过/成功/verified/passed/test/构建/修复/命令…）→ confirmedFacts；
 * - 或包含文件路径（含扩展名）→ confirmedFacts；
 * - 其余 → references。
 */
const VERIFIED_PATTERN =
  /通过|成功|已验证|verified|passed|test|测试|构建成功|命令|实现|已修复|已完成|已确认/i;
const FILE_PATH_PATTERN = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}(?:\s|$)/;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function splitImportantContext(items: string[]): {
  confirmedFacts: string[];
  references: string[];
} {
  const confirmedFacts: string[] = [];
  const references: string[] = [];
  for (const item of items) {
    if (VERIFIED_PATTERN.test(item) || FILE_PATH_PATTERN.test(item)) {
      confirmedFacts.push(item);
    } else {
      references.push(item);
    }
  }
  return { confirmedFacts, references };
}

function splitValidationNotes(items: string[]): {
  verification: string[];
  failuresAndRisks: string[];
} {
  const verification: string[] = [];
  const failuresAndRisks: string[] = [];
  for (const item of items) {
    if (FAILURE_RISK_PATTERN.test(item)) {
      failuresAndRisks.push(item);
    } else {
      verification.push(item);
    }
  }
  return { verification, failuresAndRisks };
}

/** v2 modelTier → v3 summaryInfo（ADR-007 映射）。 */
function summaryInfoFromPayload(payload: ContextCheckpointPayload): CheckpointSummaryInfo {
  if (payload.modelTier === 'local') {
    return { kind: 'local-fallback' };
  }
  return { kind: 'llm', model: payload.modelName };
}

/**
 * 把 v2（或缺失 sections 的退化）payload 迁移为 v3 state。
 *
 * 纯函数、确定性；已归档 payload 本身不被修改（渲染器绑定，ADR-007）。
 */
export function migrateCheckpointSectionsToV3(
  sections: ContextCheckpointSections | undefined
): ContextCheckpointStateV3 {
  const state = createEmptyCheckpointStateV3();
  if (!sections) {
    return state;
  }

  state.goal = asStringArray(sections.userGoal);
  state.constraints = asStringArray(sections.constraints);
  state.completedWork = asStringArray(sections.completedWork);
  state.assumptions = asStringArray(sections.assumptions);
  state.activeWork = asStringArray(sections.pendingWork);
  state.openQuestions = asStringArray(sections.openQuestions);
  state.todos = asStringArray(sections.todoList);

  const important = splitImportantContext(asStringArray(sections.importantContext));
  state.confirmedFacts = important.confirmedFacts;
  state.references = important.references;

  const validation = splitValidationNotes(asStringArray(sections.validationNotes));
  state.verification = validation.verification;
  state.failuresAndRisks = validation.failuresAndRisks;

  return state;
}

/**
 * 把任意历史 checkpoint payload 迁移为 v3 payload（纯函数）。
 *
 * - v3 输入：规范化后返回等价结构（幂等）；
 * - v2 输入：按 ADR-007 映射表生成 state；provenance 字段为 undefined
 *   （legacy 无来源）；summary/renderedContent/sourceMessageCount/sourceChars/
 *   generatedAt/todoDigest 原样保留（不重渲染）；
 * - 缺失 sections 的退化输入：state 为空分区，不抛错。
 */
export function migrateContextCheckpointToV3(
  payload: ContextCheckpointPayload | ContextCheckpointPayloadV3
): ContextCheckpointPayloadV3 {
  if (payload.version === CONTEXT_CHECKPOINT_VERSION_3) {
    const v3 = payload as ContextCheckpointPayloadV3;
    return {
      ...v3,
      state: {
        ...createEmptyCheckpointStateV3(),
        ...v3.state,
      },
      summaryInfo: v3.summaryInfo ?? summaryInfoFromPayload(v3),
    };
  }

  const v2 = payload as ContextCheckpointPayload;
  return {
    version: CONTEXT_CHECKPOINT_VERSION_3,
    summary: v2.summary ?? '',
    renderedContent: v2.renderedContent ?? '',
    sourceMessageCount: v2.sourceMessageCount ?? 0,
    sourceChars: v2.sourceChars ?? 0,
    generatedAt: v2.generatedAt ?? 0,
    modelName: v2.modelName ?? '',
    modelTier: v2.modelTier ?? 'local',
    sections: v2.sections,
    todoDigest: v2.todoDigest,
    state: migrateCheckpointSectionsToV3(v2.sections),
    summaryInfo: summaryInfoFromPayload(v2),
  };
}
