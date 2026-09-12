import type { CompactionTrigger, IImageContent, IMessage } from '@codepapr/types';
import type { SkeletonEntry } from '@codepapr/core';
import { sortedStringify } from '@codepapr/common';
import {
  stripInternalFields,
  redactTranscriptOutputString,
  applyHistoryToolSummaries,
  describeLogWireMeta,
  measureLogWireFootprint,
  TOOL_SUMMARY_METADATA_KEY,
} from '@codepapr/core';
import type { Lang } from './i18n';
import type { UIToolInvocation } from '../store/internals/types';

export const TOOL_RESULT_MISSING_PLACEHOLDER = '[tool result missing: interrupted before completion]';
export const TOOL_RESULT_MISSING_ERROR = '工具执行中断，结果缺失';

export interface ContextCheckpointSections {
  userGoal: string[];
  constraints: string[];
  completedWork: string[];
  importantContext: string[];
  assumptions: string[];
  validationNotes: string[];
  pendingWork: string[];
  openQuestions: string[];
  todoList: string[];
}

export interface ContextCheckpointPayload {
  version: number;
  summary: string;
  renderedContent: string;
  sourceMessageCount: number;
  sourceChars: number;
  generatedAt: number;
  modelName: string;
  modelTier: 'fast' | 'primary' | 'local';
  sections?: ContextCheckpointSections;
  /** Todo digest frozen at checkpoint generation time. Reusing this (instead of
   *  re-rendering from live todo state on every rebuild) keeps the rebuilt
   *  context byte-stable so the prefix cache is not broken on agent rebuild. */
  todoDigest?: string;
  /** PR1：不可变 provenance（ADR-001/005）。全部为可选：旧 payload 与
   *  worker 生成路径（generation 未定）允许缺省，缺失时由主线程 commit
   *  补齐到 context_compactions 行。 */
  compactionId?: string;
  generation?: number;
  parentGeneration?: number;
  trigger?: CompactionTrigger;
  sourceStartMessageId?: string;
  sourceEndMessageId?: string;
  retainedTailStartMessageId?: string;
  retainedMessageCount?: number;
  tokenStats?: {
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    sourceTokens: number;
    checkpointTokens: number;
  };
  summaryInfo?: {
    kind: 'llm' | 'local-fallback';
    provider?: string;
    model?: string;
    /** F：kind 为 local-fallback 时的降级原因（写入 failure_code）。 */
    failureCode?: string;
  };
  /** v4（骨架引擎）：被骨架化回合的结构化条目（审计/识别用，模型可见文本在
   *  renderedContent/summary）。 */
  skeleton?: SkeletonEntry[];
  /** v4：needsSummary 时的二级摘要块（= summary 主体）。 */
  summaryBlock?: string;
  /** v4：轮内折叠的活动行文本。 */
  activityText?: string;
}

export interface ContextMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  promptContent?: string;
  reasoningContent?: string;
  toolInvocations?: UIToolInvocation[];
  images?: IImageContent[];
  timestamp: number;
  durationMs?: number;
  synthetic?: boolean;
  hidden?: boolean;
  carryForwardInContext?: boolean;
  contextCheckpoint?: ContextCheckpointPayload;
  /** Worker log 注入的 session-bootstrap（不属于 archive / surface）。 */
  sessionBootstrap?: boolean;
}

export interface CheckpointMatch {
  index: number;
  message: ContextMessageLike;
  payload: ContextCheckpointPayload;
}

interface ContextCopy {
  checkpointPreamble: string;
  /** 有活跃任务清单时的替代前言：清单跨压缩仍然有效，必须继续而不是重排。 */
  checkpointPreambleWithTodos: string;
  /** 权威任务清单分区的标题。 */
  todoDigestHeading: string;
  summaryHeading: string;
  userGoalHeading: string;
  constraintsHeading: string;
  completedHeading: string;
  importantHeading: string;
  assumptionsHeading: string;
  validationHeading: string;
  pendingHeading: string;
  openQuestionsHeading: string;
  todoListHeading: string;
}

function getContextCopy(lang: Lang | undefined): ContextCopy {
  switch (lang ?? 'zh-CN') {
    case 'zh-TW':
      return {
        checkpointPreamble:
          '以下是先前長會話的上下文檢查點，僅作為已驗證的歷史背景摘要；若與後續原始訊息衝突，以後續原始訊息為準。當前回合的任務以用戶最新訊息為準：除非用戶明確要求繼續先前的工作，否則不要主動恢復或繼續檢查點中的舊任務、舊任務清單。',
        checkpointPreambleWithTodos:
          '以下是先前長會話的上下文檢查點，僅作為已驗證的歷史背景摘要；若與後續原始訊息衝突，以後續原始訊息為準。下方的「當前任務清單（權威狀態）」是用戶目標尚未完成的進行中計劃，仍舊有效：請繼續推進其中 running/pending 的任務，不要重建或重新規劃清單——只有當用戶最新消息改變了目標時才重排（re-plan）。',
        todoDigestHeading: '當前任務清單（權威狀態）',
        summaryHeading: '檢查點摘要',
        userGoalHeading: '用戶目標',
        constraintsHeading: '約束與偏好',
        completedHeading: '已完成工作',
        importantHeading: '重要文件 / 命令 / 錯誤',
        assumptionsHeading: '關鍵假設',
        validationHeading: '驗證狀態 / 結果',
        pendingHeading: '待繼續事項',
        openQuestionsHeading: '待確認問題',
        todoListHeading: '當前任務清單',
      };
    case 'en':
      return {
        checkpointPreamble:
          'The block below is a checkpoint summary of earlier conversation context, provided only as verified historical background; if it conflicts with later raw messages, trust the later raw messages. The current turn is governed by the user\'s latest message: do not resume or restore old tasks or task lists from the checkpoint unless the user explicitly asks to continue the previous work.',
        checkpointPreambleWithTodos:
          'The block below is a checkpoint summary of earlier conversation context, provided only as verified historical background; if it conflicts with later raw messages, trust the later raw messages. The "Current Task List (authoritative)" section below is the in-flight plan for the user\'s still-active goal and remains valid: keep executing its running/pending tasks instead of rebuilding or re-planning the list. Only re-plan when the user\'s latest message changes the goal.',
        todoDigestHeading: 'Current Task List (authoritative)',
        summaryHeading: 'Checkpoint Summary',
        userGoalHeading: 'User Goal',
        constraintsHeading: 'Constraints & Preferences',
        completedHeading: 'Completed Work',
        importantHeading: 'Important Files / Commands / Errors',
        assumptionsHeading: 'Key Assumptions',
        validationHeading: 'Validation Status / Results',
        pendingHeading: 'Remaining Work',
        openQuestionsHeading: 'Open Questions',
        todoListHeading: 'Current Task List',
      };
    default:
      return {
        checkpointPreamble:
          '以下是先前长会话的上下文检查点，仅作为已验证的历史背景摘要；如果与后续原始消息冲突，以后续原始消息为准。当前回合的任务以用户最新消息为准：除非用户明确要求继续先前的工作，否则不要主动恢复或继续检查点中的旧任务、旧任务清单。',
        checkpointPreambleWithTodos:
          '以下是先前长会话的上下文检查点，仅作为已验证的历史背景摘要；如果与后续原始消息冲突，以后续原始消息为准。下方的「当前任务清单（权威状态）」是用户目标尚未完成的进行中计划，依然有效：请继续推进其中 running/pending 的任务，不要重建或重新规划清单——只有当用户最新消息改变了目标时才需要重排（re-plan）。',
        todoDigestHeading: '当前任务清单（权威状态）',
        summaryHeading: '检查点摘要',
        userGoalHeading: '用户目标',
        constraintsHeading: '约束与偏好',
        completedHeading: '已完成工作',
        importantHeading: '重要文件 / 命令 / 错误',
        assumptionsHeading: '关键假设',
        validationHeading: '验证状态 / 结果',
        pendingHeading: '待继续事项',
        openQuestionsHeading: '待确认问题',
        todoListHeading: '当前任务清单',
      };
  }
}

function createEmptySections(): ContextCheckpointSections {
  return {
    userGoal: [],
    constraints: [],
    completedWork: [],
    importantContext: [],
    assumptions: [],
    validationNotes: [],
    pendingWork: [],
    openQuestions: [],
    todoList: [],
  };
}

export function getLatestCheckpoint(messages: readonly ContextMessageLike[]): CheckpointMatch | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.contextCheckpoint) {
      return {
        index,
        message,
        payload: message.contextCheckpoint,
      };
    }
  }

  return null;
}

export function toCoreTailMessages(messages: readonly ContextMessageLike[]): IMessage[] {
  return messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        (!message.synthetic || (message.role === 'assistant' && message.carryForwardInContext === true))
    )
    .flatMap((message): IMessage[] => {
      if (message.role === 'assistant' && message.toolInvocations && message.toolInvocations.length > 0) {
        const assistantMsg: IMessage = {
          id: message.id,
          role: 'assistant',
          content: message.content || '',
          reasoningContent: message.reasoningContent || undefined,
          toolCalls: message.toolInvocations.map((ti) => ({
            id: ti.id,
            name: ti.name,
            arguments: ti.arguments,
          })),
          timestamp: message.timestamp,
          ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}),
        };
        const toolMsgs: IMessage[] = message.toolInvocations.map((ti) => {
          // 存量转录可能嵌着修复前的 __images base64：重建进模型前 redact
          // 成路径引用，避免每回合把几 MB 的乱码文本当工具结果重发。
          const cleanedOutput =
            typeof ti.output === 'string'
              ? redactTranscriptOutputString(ti.output)
              : stripInternalFields(ti.output);
          // Prefer contextContent: the byte-exact content appended to the live
          // log (already truncated + sortedStringify'd). Falling back to
          // sortedStringify(cleanedOutput) only matches the live path for
          // non-truncated object results, so contextContent is what keeps a
          // rebuilt history byte-identical (and the prefix cache intact).
          const fallbackContent =
            typeof cleanedOutput === 'string' ? cleanedOutput : sortedStringify(cleanedOutput);
          // Interrupted invocations (abort/crash before tool-call-end) carry no
          // contextContent/output, and sortedStringify(undefined) is undefined;
          // a non-string content would fail AppendOnlyLog.loadFromSnapshot
          // validation on restore. Fall back to the same placeholder
          // repairOrphanedToolCalls inserts so rebuilt history stays valid.
          const content =
            ti.contextContent ??
            (typeof fallbackContent === 'string' ? fallbackContent : TOOL_RESULT_MISSING_PLACEHOLDER);
          return {
            id: `${message.id}-tool-${ti.id}`,
            role: 'tool' as const,
            content,
            timestamp: message.timestamp,
            toolResult: {
              toolCallId: ti.id,
              success: ti.status === 'success',
              result: cleanedOutput === undefined ? content : cleanedOutput,
              error: ti.error ?? (content === TOOL_RESULT_MISSING_PLACEHOLDER ? TOOL_RESULT_MISSING_ERROR : undefined),
            },
            // Carry the frozen history summary so applyHistoryToolSummaries
            // rewrites rebuilt requests byte-identically to the live path.
            ...(ti.contextSummary
              ? { metadata: { [TOOL_SUMMARY_METADATA_KEY]: ti.contextSummary } }
              : {}),
            ...(typeof ti.durationMs === 'number' ? { durationMs: ti.durationMs } : {}),
          };
        });
        return [assistantMsg, ...toolMsgs];
      }
      const rawContent =
        message.role === 'user' ? message.promptContent ?? message.content : message.content;
      // Match the live path (Agent stores `assistant.content ?? ''`): empty
      // assistant content serializes as '' not ' ', so rebuilt history stays
      // byte-identical and does not break the prefix cache.
      const content = message.role === 'assistant' && !rawContent ? '' : rawContent;
      return [
        {
          id: message.id,
          role: message.role as 'user' | 'assistant',
          content,
          reasoningContent: message.role === 'assistant' ? (message.reasoningContent || undefined) : undefined,
          images:
            message.role === 'user' && message.images && message.images.length > 0
              ? message.images
              : undefined,
          timestamp: message.timestamp,
          ...(message.role === 'assistant' && typeof message.durationMs === 'number'
            ? { durationMs: message.durationMs }
            : {}),
          // UI 注入的 assistant 消息（mode-switch 指令 / carry-forward 证据）打上
          // 标记：非模型生成，上下文检查器归入用户输入泳道。checkpoint 消息不
          // 经过此路径（由 buildEffectiveContextMessages 以 user role 重建）。
          ...(message.role === 'assistant' && message.synthetic
            ? { metadata: { uiInjected: true } }
            : {}),
        },
      ];
    });
}

/** 一组消息实际随请求上线的 token 估算（wire 口径，含图片 vision 权重）。
 *  必须整组计量：是否仍「在线」取决于其后有没有 assistant 回复 / 是不是最新
 *  一批工具结果，逐条计量会失真。
 *  入参取 UI 侧的 ContextMessageLike（role 允许 'error'）：wire 计量只看
 *  role/content/images/toolResult/metadata 五个字段，其余形态一律忽略。 */
export function measureWireTokens(
  messages: readonly (IMessage | ContextMessageLike)[]
): number {
  const footprint = measureLogWireFootprint(
    messages.map((m) => describeLogWireMeta(m as IMessage))
  );
  return Math.ceil(footprint.wireBytes / 4) + footprint.imageTokens;
}

function truncateLine(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function dedupeItems(items: readonly string[], maxItems: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const normalized = truncateLine(item, maxLength);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function coerceStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeSections(sections: Partial<ContextCheckpointSections> | null | undefined): ContextCheckpointSections {
  const normalized: ContextCheckpointSections = {
    userGoal: dedupeItems(coerceStringArray(sections?.userGoal), 4, 260),
    constraints: dedupeItems(coerceStringArray(sections?.constraints), 5, 240),
    completedWork: dedupeItems(coerceStringArray(sections?.completedWork), 6, 240),
    importantContext: dedupeItems(coerceStringArray(sections?.importantContext), 6, 260),
    assumptions: dedupeItems(coerceStringArray(sections?.assumptions), 4, 220),
    validationNotes: dedupeItems(coerceStringArray(sections?.validationNotes), 6, 240),
    pendingWork: dedupeItems(coerceStringArray(sections?.pendingWork), 5, 240),
    openQuestions: dedupeItems(coerceStringArray(sections?.openQuestions), 4, 220),
    todoList: dedupeItems(coerceStringArray(sections?.todoList), 8, 240),
  };

  return normalized;
}

function getLegacyCheckpointSections(checkpoint: ContextCheckpointPayload | null): ContextCheckpointSections {
  if (!checkpoint) {
    return createEmptySections();
  }
  if (checkpoint.sections) {
    return normalizeSections(checkpoint.sections);
  }

  return normalizeSections({
    importantContext: checkpoint.summary
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean),
  });
}

function collectPatternHighlights(
  messages: readonly IMessage[],
  pattern: RegExp,
  maxItems: number,
  maxLength: number
): string[] {
  return dedupeItems(
    messages
      .map((message) => truncateLine(message.content ?? '', maxLength))
      .filter((line) => pattern.test(line)),
    maxItems,
    maxLength
  );
}

function renderSection(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }

  return [
    `${heading}：`,
    ...items.map((item) => `- ${item}`),
  ];
}

export function renderContextCheckpointSummary(
  sections: ContextCheckpointSections,
  lang: Lang | undefined
): string {
  const copy = getContextCopy(lang);
  const normalized = normalizeSections(sections);
  const lines = [
    ...renderSection(copy.userGoalHeading, normalized.userGoal),
    ...renderSection(copy.constraintsHeading, normalized.constraints),
    ...renderSection(copy.completedHeading, normalized.completedWork),
    ...renderSection(copy.importantHeading, normalized.importantContext),
    ...renderSection(copy.assumptionsHeading, normalized.assumptions),
    ...renderSection(copy.validationHeading, normalized.validationNotes),
    ...renderSection(copy.todoListHeading, normalized.todoList),
    ...renderSection(copy.pendingHeading, normalized.pendingWork),
    ...renderSection(copy.openQuestionsHeading, normalized.openQuestions),
  ];

  return lines.join('\n').trim();
}

export function renderContextCheckpointContent(
  summary: string,
  lang: Lang | undefined,
  todoDigest?: string
): string {
  const copy = getContextCopy(lang);
  const digest = todoDigest?.trim();
  // 有活跃清单时用「继续原清单」版前言并把权威清单（含状态与 current 指针）整块
  // 附在末尾：压缩只毁掉模型可见的历史，毁掉计划就等于每压一次就重新规划一次。
  const preamble = digest ? copy.checkpointPreambleWithTodos : copy.checkpointPreamble;
  const body = `${preamble}\n\n${copy.summaryHeading}：\n${summary.trim()}`;
  return digest ? `${body}\n\n${copy.todoDigestHeading}：\n${digest}` : body;
}

export function buildEffectiveContextMessages(
  messages: readonly ContextMessageLike[]
): IMessage[] {
  const checkpoint = getLatestCheckpoint(messages);
  const tailStart = checkpoint ? checkpoint.index + 1 : 0;
  const tailMessages = toCoreTailMessages(messages.slice(tailStart));

  let result: IMessage[];
  if (!checkpoint) {
    result = tailMessages;
  } else {
    result = [
      {
        id: checkpoint.message.id,
        // Emitted as a user turn (not assistant) so the rebuilt context never
        // starts with — or stacks consecutive — assistant messages, which some
        // providers reject. Detection is payload-based (contextCheckpoint), and
        // the checkpoint is not processed by toCoreTailMessages, so the retained
        // tail logic is unaffected.
        role: 'user',
        content: checkpoint.payload.renderedContent,
        timestamp: checkpoint.message.timestamp,
        metadata: {
          contextCheckpoint: true,
          generatedAt: checkpoint.payload.generatedAt,
          modelName: checkpoint.payload.modelName,
        },
      },
    ];

    result.push(...tailMessages);
  }

  // v4：prune 层已删除——工具结果只存在于逐字 tail 内（更早的已被骨架折叠），
  // 单条巨型输出由入口护栏（截断/artifact 外置）约束。这里仍做孤儿工具修复 +
  // 冻结摘要回写（toolContext 外置），保证重建与实时路径字节一致。
  return applyHistoryToolSummaries(repairOrphanedToolCalls(result));
}

/**
 * Ensure every assistant `toolCalls` entry has a matching `tool` result message.
 * A hard crash mid-tool-execution can persist an assistant tool-call whose result
 * was never produced; some providers (OpenAI/DeepSeek) reject assistant tool_calls
 * without a matching tool message. Insert a small placeholder result so rebuilt
 * history is always well-formed. The UI→core path normally pairs these already, so
 * this is a defensive no-op except after an interrupted run.
 */
export function repairOrphanedToolCalls(messages: IMessage[]): IMessage[] {
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolResult) {
      resolvedIds.add(msg.toolResult.toolCallId);
    }
  }

  const repaired: IMessage[] = [];
  for (const msg of messages) {
    repaired.push(msg);
    if (msg.role !== 'assistant' || !msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }
    for (const call of msg.toolCalls) {
      if (resolvedIds.has(call.id)) {
        continue;
      }
      repaired.push({
        id: `${msg.id}-tool-${call.id}-repaired`,
        role: 'tool',
        content: TOOL_RESULT_MISSING_PLACEHOLDER,
        timestamp: msg.timestamp,
        toolResult: {
          toolCallId: call.id,
          success: false,
          result: TOOL_RESULT_MISSING_PLACEHOLDER,
          error: TOOL_RESULT_MISSING_ERROR,
        },
      });
    }
  }

  return repaired;
}

/**
 * Insert a checkpoint message at the planned retention boundary so the retained
 * tail follows it. `buildEffectiveContextMessages` then keeps that tail verbatim
 * (recent tool calls included) instead of dropping it.
 */
export function insertCheckpointAtRetainedBoundary<T>(
  messages: readonly T[],
  checkpoint: T,
  insertIndex: number
): T[] {
  const clamped = Math.max(0, Math.min(insertIndex, messages.length));
  return [...messages.slice(0, clamped), checkpoint, ...messages.slice(clamped)];
}

export function buildContextCompactionTranscript(messages: readonly IMessage[]): string {
  const toolCallMap = new Map<string, { name: string; args: string }>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallMap.set(tc.id, {
          name: tc.name,
          args: JSON.stringify(tc.arguments).slice(0, 200),
        });
      }
    }
  }

  return messages
    .map((message, index) => {
      const prefix = `${index + 1}. ${message.role.toUpperCase()}`;

      if (message.role === 'tool' && message.toolResult) {
        const callInfo = toolCallMap.get(message.toolResult.toolCallId);
        const toolName = callInfo?.name ?? 'unknown';
        const toolArgs = callInfo?.args ?? '';
        const status = message.toolResult.success ? 'ok' : 'failed';
        const output = truncateLine(message.content ?? '', 1500);
        return `${prefix} [${toolName}(${toolArgs}) ${status}]: ${output}`;
      }

      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        const tools = message.toolCalls
          .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`)
          .join(', ');
        const content = truncateLine(message.content ?? '', 640);
        return content
          ? `${prefix}: ${content}\n   [calls: ${tools}]`
          : `${prefix} [calls: ${tools}]`;
      }

      return `${prefix}: ${truncateLine(message.content ?? '', 640)}`;
    })
    .join('\n\n');
}

export function buildLocalContextCheckpointSections(params: {
  priorCheckpoint?: ContextCheckpointPayload | null;
  sourceMessages: readonly IMessage[];
  retainedMessages: readonly IMessage[];
  lang: Lang | undefined;
}): ContextCheckpointSections {
  const previous = getLegacyCheckpointSections(params.priorCheckpoint ?? null);
  const allMessages = [...params.sourceMessages, ...params.retainedMessages];
  const userMessages = allMessages.filter((message) => message.role === 'user');
  const assistantMessages = allMessages.filter((message) => message.role === 'assistant');
  const userLines = userMessages.map((message) => truncateLine(message.content ?? '', 260));
  const assistantLines = assistantMessages.map((message) => truncateLine(message.content ?? '', 240));

  return normalizeSections({
    userGoal: [
      ...previous.userGoal,
      ...userLines.slice(-3),
    ],
    constraints: [
      ...previous.constraints,
      ...collectPatternHighlights(
        userMessages,
        /(必须|不要|优先|限制|约束|prefer|must|should|avoid|required)/i,
        4,
        240
      ),
    ],
    completedWork: [
      ...previous.completedWork,
      ...collectPatternHighlights(
        assistantMessages,
        /(已|完成|修复|增加|更新|验证|implemented|fixed|updated|added|verified|ran)/i,
        5,
        240
      ),
      ...assistantLines.slice(-2),
    ],
    importantContext: [
      ...previous.importantContext,
      ...collectPatternHighlights(
        allMessages,
        /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+|npm\s+run|pnpm\s+|yarn\s+|cargo\s+|error|错误|異常|失败|失敗|test|build|lint|typecheck|命令|command)/i,
        6,
        260
      ),
    ],
    assumptions: [
      ...previous.assumptions,
      ...collectPatternHighlights(
        allMessages,
        /(假设|默认|暂按|先按|assuming|assume|for now|treat as)/i,
        4,
        220
      ),
    ],
    validationNotes: [
      ...previous.validationNotes,
      ...collectPatternHighlights(
        allMessages,
        /(验证|测试|通过|失败|exit code|退出码|passed|failed|verified|validation|lint|typecheck|build)/i,
        6,
        240
      ),
    ],
    pendingWork: [
      ...previous.pendingWork,
      ...collectPatternHighlights(
        allMessages,
        /(待|继续|下一步|后续|尚未|未完成|remaining|next|still need|todo|blocked)/i,
        4,
        240
      ),
      ...userLines.slice(-2),
    ],
    openQuestions: [
      ...previous.openQuestions,
      ...collectPatternHighlights(
        userMessages,
        /(是否|要不要|能不能|需要.*吗|\?|whether|should we|do we need|question)/i,
        4,
        220
      ),
    ],
    todoList: [
      ...previous.todoList,
      ...collectPatternHighlights(
        allMessages,
        /\[TodoList\]|← current|✗.*err|目标:/i,
        8,
        240
      ),
    ],
  });
}

/**
 * PR3（ADR-007）：v2 checkpoint JSON 解析/生成已退役——压缩主流程走 v3
 * 结构化状态合并（contextStateMerge + contextCheckpointState，见
 * contextCheckpoint.ts）。v2 payload 仅用于迁移（migrateContextCheckpointToV3）。
 */
