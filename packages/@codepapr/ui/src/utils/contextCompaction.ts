import type { IImageContent, IMessage } from '@codepapr/types';
import { estimateTokens, sortedStringify } from '@codepapr/common';
import { stripInternalFields, pruneOldToolResults, type PruneOptions } from '@codepapr/core';
import type { Lang } from './i18n';
import type { UIToolInvocation } from '../store/internals/types';

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
          '以下是先前長會話的上下文檢查點。把它視為已驗證的歷史摘要；若與後續原始訊息衝突，以後續原始訊息為準。如果你看不到當前任務清單，立即調用 `todo(action: list)` 恢復。',
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
          'The block below is a checkpoint summary for earlier conversation context. Treat it as verified history; if it conflicts with later raw messages, trust the later raw messages. If you do not see your current task list, call `todo(action: list)` immediately to restore it.',
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
          '以下是先前长会话的上下文检查点。把它视为已验证的历史摘要；如果与后续原始消息冲突，以后续原始消息为准。如果你看不到当前任务清单，立即调用 `todo(action: list)` 恢复。',
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
        };
        const toolMsgs: IMessage[] = message.toolInvocations.map((ti) => {
          const cleanedOutput =
            typeof ti.output === 'string' ? ti.output : stripInternalFields(ti.output);
          return {
            id: `${message.id}-tool-${ti.id}`,
            role: 'tool' as const,
            // Prefer contextContent: the byte-exact content appended to the live
            // log (already truncated + sortedStringify'd). Falling back to
            // sortedStringify(cleanedOutput) only matches the live path for
            // non-truncated object results, so contextContent is what keeps a
            // rebuilt history byte-identical (and the prefix cache intact).
            content:
              ti.contextContent ??
              (typeof cleanedOutput === 'string' ? cleanedOutput : sortedStringify(cleanedOutput)),
            timestamp: message.timestamp,
            toolResult: {
              toolCallId: ti.id,
              success: ti.status === 'success',
              result: cleanedOutput,
              error: ti.error,
            },
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
  return pruneOldToolResults(repairOrphanedToolCalls(result), options?.pruneOptions);
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
      const placeholder = '[tool result missing: interrupted before completion]';
      repaired.push({
        id: `${msg.id}-tool-${call.id}-repaired`,
        role: 'tool',
        content: placeholder,
        timestamp: msg.timestamp,
        toolResult: {
          toolCallId: call.id,
          success: false,
          result: placeholder,
          error: '工具执行中断，结果缺失',
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

  if (!priorCheckpoint && sourceMessages.length === 0 && finalRetainedMessages.length === 0) {
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

  switch (params.lang ?? 'zh-CN') {
    case 'zh-TW':
      return {
        systemPrompt:
          '你負責把長編程會話壓縮成可恢復的上下文檢查點。你必須合併已有檢查點與較早原始對話，只保留後續繼續工作真正需要的事實：用戶目標、約束、已完成修改、重要文件/命令/錯誤、當前任務清單、尚未完成事項。對話中包含工具調用及其結果（標記為 TOOL），這些是事實的主要來源，務必從中提取任務清單狀態和已完成的工作。不要杜撰，不要丟掉仍然有效的約束。輸出必須是 JSON 對象，且只能包含 userGoal、constraints、completedWork、importantContext、todoList、pendingWork 這六個鍵，每個鍵的值都必須是字符串數組。',
        userPrompt: `請根據已有檢查點和新增較早對話，輸出新的恢復檢查點 JSON。\n\n已有檢查點：\n${priorCheckpointBlock}\n\n新增較早對話原文：\n${params.transcript}`,
      };
    case 'en':
      return {
        systemPrompt:
          'Compress a long coding conversation into a recoverable checkpoint. Merge the existing checkpoint with the earlier raw transcript and keep only facts needed for future execution: user goals, constraints, completed work, important files/commands/errors, current task list, and remaining work. The transcript includes tool calls and their results (marked as TOOL); these are the primary source of facts - extract task list state and completed work from them. Do not invent details or drop still-valid constraints. Output JSON only with exactly six keys: userGoal, constraints, completedWork, importantContext, todoList, pendingWork. Every value must be an array of strings.',
        userPrompt:
          `Update the recovery checkpoint JSON using the existing checkpoint and the earlier raw transcript below.\n\nExisting checkpoint:\n${priorCheckpointBlock}\n\nEarlier raw transcript:\n${params.transcript}`,
      };
    default:
      return {
        systemPrompt:
          '你负责把长编程会话压缩成可恢复的上下文检查点。你必须合并已有检查点与较早原始对话，只保留后续继续工作真正需要的事实：用户目标、约束、已完成修改、重要文件/命令/错误、当前任务清单、尚未完成事项。对话中包含工具调用及其结果（标记为 TOOL），这些是事实的主要来源，务必从中提取任务清单状态和已完成的工作。不要杜撰，不要丢掉仍然有效的约束。输出必须是 JSON 对象，且只能包含 userGoal、constraints、completedWork、importantContext、todoList、pendingWork 这六个键，每个键的值都必须是字符串数组。',
        userPrompt: `请根据已有检查点和新增较早对话，输出新的恢复检查点 JSON。\n\n已有检查点：\n${priorCheckpointBlock}\n\n新增较早对话原文：\n${params.transcript}`,
      };
  }
}
