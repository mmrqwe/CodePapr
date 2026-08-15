import type { IImageContent, IMessage } from '@codepapr/types';
import { estimateTokens, sortedStringify } from '@codepapr/common';
import {
  COMPACTOR_PROMPT,
  stripInternalFields,
  pruneOldToolResults,
  applyHistoryToolSummaries,
  TOOL_SUMMARY_METADATA_KEY,
  type PruneOptions,
} from '@codepapr/core';
import type { Lang } from './i18n';
import type { UIToolInvocation } from '../store/internals/types';

export const TOOL_RESULT_MISSING_PLACEHOLDER = '[tool result missing: interrupted before completion]';
export const TOOL_RESULT_MISSING_ERROR = '工具执行中断，结果缺失';

export const CONTEXT_COMPACTION_VERSION = 2;
export const CONTEXT_COMPACTION_DEFAULT_MAX_ROUNDS = 24;
export const CONTEXT_COMPACTION_DEFAULT_MAX_TOKENS = 200_000;
export const CONTEXT_COMPACTION_MIN_RETAIN_MESSAGES = 6;
export const CONTEXT_COMPACTION_MAX_RETAIN_MESSAGES = 12;
export const CONTEXT_COMPACTION_TARGET_RETAIN_TOKENS = 8_000;

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
}

export interface ContextCompactionPlan {
  shouldCompact: boolean;
  priorCheckpoint: ContextCheckpointPayload | null;
  sourceMessages: IMessage[];
  sourceChars: number;
  sourceTokens: number;
  retainedMessages: IMessage[];
  effectiveTokens: number;
  /**
   * Absolute index (into the UI message list passed to `planContextCompaction`)
   * where the newly generated checkpoint must be inserted so the retained tail
   * follows it. `buildEffectiveContextMessages` treats messages AFTER the
   * checkpoint as the retained tail, so inserting here (instead of appending at
   * the end) keeps the recent tool-call tail verbatim in the rebuilt context.
   */
  insertIndex: number;
}

interface CheckpointMatch {
  index: number;
  message: ContextMessageLike;
  payload: ContextCheckpointPayload;
}

interface ContextCopy {
  checkpointPreamble: string;
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

function getLatestCheckpoint(messages: readonly ContextMessageLike[]): CheckpointMatch | null {
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

function toCoreTailMessages(messages: readonly ContextMessageLike[]): IMessage[] {
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
          const cleanedOutput =
            typeof ti.output === 'string' ? ti.output : stripInternalFields(ti.output);
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

function getMessageChars(messages: readonly IMessage[]): number {
  return messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
}

function getMessageTokenCount(message: IMessage): number {
  return estimateTokens([message.role, message.content ?? ''].filter(Boolean).join('\n'));
}

function getMessagesTokenCount(messages: readonly IMessage[]): number {
  return messages.reduce((sum, message) => sum + getMessageTokenCount(message), 0);
}

function getCheckpointTokenCount(checkpoint: ContextCheckpointPayload | null): number {
  if (!checkpoint) {
    return 0;
  }

  return estimateTokens(checkpoint.renderedContent || checkpoint.summary || '');
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

/**
 * Choose the retained tail in UI-message space and return its start index
 * (relative to `tailUI`), so the checkpoint can be inserted at a UI boundary.
 * Each UI assistant message expands atomically to an assistant+tools group via
 * `toCoreTailMessages`, so splitting at a UI index never orphans a tool message
 * in either the source or the retained partition. Token accounting reuses the
 * core conversion so it stays consistent with the live/rebuild path.
 */
function pickRetainedTailUIStart(tailUI: readonly ContextMessageLike[]): number {
  let retainedTokens = 0;
  let retainedCount = 0;
  let startIndex = tailUI.length;

  for (let index = tailUI.length - 1; index >= 0; index -= 1) {
    const message = tailUI[index]!;
    const coreMessages = toCoreTailMessages([message]);
    const messageTokens = getMessagesTokenCount(coreMessages);
    const keepByMinimum = retainedCount < CONTEXT_COMPACTION_MIN_RETAIN_MESSAGES;
    const keepByBudget =
      retainedCount < CONTEXT_COMPACTION_MAX_RETAIN_MESSAGES &&
      retainedTokens + messageTokens <= CONTEXT_COMPACTION_TARGET_RETAIN_TOKENS;

    if (!keepByMinimum && !keepByBudget) {
      break;
    }

    startIndex = index;
    // Synthetic/hidden messages contribute no core messages; keep them in the
    // tail span (they are filtered out downstream) but do not let them consume
    // the retention budget.
    if (coreMessages.length > 0) {
      retainedCount += 1;
      retainedTokens += messageTokens;
    }
  }

  return startIndex;
}

/**
 * Smallest boundary such that `toCoreTailMessages(tailUI.slice(0, boundary))`
 * is non-empty. Used when there is no prior checkpoint and retention would keep
 * everything, to guarantee at least one message is compacted into a checkpoint.
 */
function firstNonEmptyCoreBoundary(tailUI: readonly ContextMessageLike[]): number {
  for (let boundary = 1; boundary <= tailUI.length; boundary += 1) {
    if (toCoreTailMessages(tailUI.slice(0, boundary)).length > 0) {
      return boundary;
    }
  }
  return tailUI.length;
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

export function renderContextCheckpointContent(summary: string, lang: Lang | undefined): string {
  const copy = getContextCopy(lang);
  return `${copy.checkpointPreamble}\n\n${copy.summaryHeading}：\n${summary.trim()}`;
}

export function buildEffectiveContextMessages(
  messages: readonly ContextMessageLike[],
  options?: { pruneOptions?: PruneOptions }
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

  // Prune old tool results once, at context-rebuild time. This is idempotent for
  // identical input and coincides with the compaction prefix rewrite, so it does
  // not add per-round prefix-cache breaks (the old per-request sliding-window
  // pruning mutated mid-prefix bytes on essentially every round).
  const pruned = pruneOldToolResults(repairOrphanedToolCalls(result), options?.pruneOptions);
  // Apply frozen history summaries (tool context mode) with the same pure rule the
  // live RequestBuilder uses, so rebuilt history is byte-identical to live.
  // Layering: prune (oldest → placeholder) runs first on full-content sizes,
  // then summarization folds the middle-aged results; the latest batch stays full.
  return applyHistoryToolSummaries(pruned);
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

export function planContextCompaction(
  messages: readonly ContextMessageLike[],
  options?: { maxRounds?: number; maxTokens?: number; force?: boolean }
): ContextCompactionPlan {
  const maxRounds = options?.maxRounds ?? CONTEXT_COMPACTION_DEFAULT_MAX_ROUNDS;
  const maxTokens = options?.maxTokens ?? CONTEXT_COMPACTION_DEFAULT_MAX_TOKENS;
  const force = options?.force ?? false;
  const checkpoint = getLatestCheckpoint(messages);
  const tailStart = checkpoint ? checkpoint.index + 1 : 0;
  const tailUI = messages.slice(tailStart);
  const tailMessages = toCoreTailMessages(tailUI);
  const priorCheckpoint = checkpoint?.payload ?? null;
  const effectiveTokens =
    getCheckpointTokenCount(priorCheckpoint) + getMessagesTokenCount(tailMessages);
  const effectiveRoundCount =
    tailMessages.filter((m) => m.role === 'user').length + (priorCheckpoint ? 1 : 0);

  const noCompact: ContextCompactionPlan = {
    shouldCompact: false,
    priorCheckpoint,
    sourceMessages: [],
    sourceChars: 0,
    sourceTokens: 0,
    retainedMessages: tailMessages,
    effectiveTokens,
    insertIndex: messages.length,
  };

  if (
    !force &&
    effectiveRoundCount <= maxRounds &&
    effectiveTokens <= maxTokens
  ) {
    return noCompact;
  }

  // Split in UI-message space so the new checkpoint can be inserted at a UI
  // boundary (assistant+tools groups stay atomic), and the retained tail keeps
  // its tool calls verbatim after the checkpoint.
  let retainedUIStart = pickRetainedTailUIStart(tailUI);

  if (!priorCheckpoint && retainedUIStart === 0 && tailUI.length > 0) {
    retainedUIStart = firstNonEmptyCoreBoundary(tailUI);
  }

  const sourceMessages = toCoreTailMessages(tailUI.slice(0, retainedUIStart));
  const finalRetainedMessages = toCoreTailMessages(tailUI.slice(retainedUIStart));

  // 源为空就没有可压缩内容：旧实现仅在「无既有 checkpoint」时拦截，有 checkpoint
  // 且保留尾覆盖全部时会拿空转录跑模型，把既有 checkpoint 换成退化版本。
  if (sourceMessages.length === 0) {
    return noCompact;
  }

  return {
    shouldCompact: true,
    priorCheckpoint,
    sourceMessages,
    sourceChars: getMessageChars(sourceMessages),
    sourceTokens: getMessagesTokenCount(sourceMessages),
    retainedMessages: finalRetainedMessages,
    effectiveTokens,
    insertIndex: tailStart + retainedUIStart,
  };
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

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return candidate.slice(start, end + 1);
}

export function parseContextCheckpointSections(content: string): ContextCheckpointSections | null {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<ContextCheckpointSections>;
    const normalized = normalizeSections(parsed);
    const totalItems =
      normalized.userGoal.length +
      normalized.constraints.length +
      normalized.completedWork.length +
      normalized.importantContext.length +
      normalized.assumptions.length +
      normalized.validationNotes.length +
      normalized.pendingWork.length +
      normalized.openQuestions.length +
      normalized.todoList.length;

    return totalItems > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function serializePriorCheckpoint(
  checkpoint: ContextCheckpointPayload | null,
  lang: Lang | undefined
): string {
  if (!checkpoint) {
    switch (lang ?? 'zh-CN') {
      case 'zh-TW':
        return '無';
      case 'en':
        return 'None';
      default:
        return '无';
    }
  }

  const sections = getLegacyCheckpointSections(checkpoint);
  return JSON.stringify(sections, null, 2);
}

export function buildContextCheckpointPrompt(params: {
  transcript: string;
  priorCheckpoint?: ContextCheckpointPayload | null;
  lang: Lang | undefined;
}): {
  systemPrompt: string;
  userPrompt: string;
} {
  const priorCheckpointBlock = serializePriorCheckpoint(params.priorCheckpoint ?? null, params.lang);
  // 系统提示词单一来源：core 的 COMPACTOR_PROMPT（compactor 子代理定义与
  // 此处运行时 prompt 共用，避免漂移）。
  const lang = params.lang ?? 'zh-CN';
  const systemPrompt =
    COMPACTOR_PROMPT[lang === 'zh-TW' ? 'zh-TW' : lang === 'en' ? 'en' : 'zh-CN'];

  switch (lang) {
    case 'zh-TW':
      return {
        systemPrompt,
        userPrompt: `請根據已有檢查點和新增較早對話，輸出新的恢復檢查點 JSON。\n\n已有檢查點：\n${priorCheckpointBlock}\n\n新增較早對話原文：\n${params.transcript}`,
      };
    case 'en':
      return {
        systemPrompt,
        userPrompt:
          `Update the recovery checkpoint JSON using the existing checkpoint and the earlier raw transcript below.\n\nExisting checkpoint:\n${priorCheckpointBlock}\n\nEarlier raw transcript:\n${params.transcript}`,
      };
    default:
      return {
        systemPrompt,
        userPrompt: `请根据已有检查点和新增较早对话，输出新的恢复检查点 JSON。\n\n已有检查点：\n${priorCheckpointBlock}\n\n新增较早对话原文：\n${params.transcript}`,
      };
  }
}
