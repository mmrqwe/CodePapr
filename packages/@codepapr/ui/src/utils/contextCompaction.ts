import type { IImageContent, IMessage } from '@codepapr/types';
import { estimateTokens } from '@codepapr/common';
import type { Lang } from './i18n';

export const CONTEXT_COMPACTION_VERSION = 2;
export const CONTEXT_COMPACTION_DEFAULT_MAX_ROUNDS = 24;
export const CONTEXT_COMPACTION_DEFAULT_MAX_TOKENS = 200_000;
export const CONTEXT_COMPACTION_MIN_RETAIN_MESSAGES = 6;
export const CONTEXT_COMPACTION_MAX_RETAIN_MESSAGES = 12;
export const CONTEXT_COMPACTION_TARGET_RETAIN_TOKENS = 1_800;

export interface ContextCheckpointSections {
  userGoal: string[];
  constraints: string[];
  completedWork: string[];
  importantContext: string[];
  assumptions: string[];
  validationNotes: string[];
  pendingWork: string[];
  openQuestions: string[];
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
}

export interface ContextMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  promptContent?: string;
  reasoningContent?: string;
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
}

function getContextCopy(lang: Lang | undefined): ContextCopy {
  switch (lang ?? 'zh-CN') {
    case 'zh-TW':
      return {
        checkpointPreamble:
          '以下是先前長會話的上下文檢查點。把它視為已驗證的歷史摘要；若與後續原始訊息衝突，以後續原始訊息為準。',
        summaryHeading: '檢查點摘要',
        userGoalHeading: '用戶目標',
        constraintsHeading: '約束與偏好',
        completedHeading: '已完成工作',
        importantHeading: '重要文件 / 命令 / 錯誤',
        assumptionsHeading: '關鍵假設',
        validationHeading: '驗證狀態 / 結果',
        pendingHeading: '待繼續事項',
        openQuestionsHeading: '待確認問題',
      };
    case 'en':
      return {
        checkpointPreamble:
          'The block below is a checkpoint summary for earlier conversation context. Treat it as verified history; if it conflicts with later raw messages, trust the later raw messages.',
        summaryHeading: 'Checkpoint Summary',
        userGoalHeading: 'User Goal',
        constraintsHeading: 'Constraints & Preferences',
        completedHeading: 'Completed Work',
        importantHeading: 'Important Files / Commands / Errors',
        assumptionsHeading: 'Key Assumptions',
        validationHeading: 'Validation Status / Results',
        pendingHeading: 'Remaining Work',
        openQuestionsHeading: 'Open Questions',
      };
    default:
      return {
        checkpointPreamble:
          '以下是先前长会话的上下文检查点。把它视为已验证的历史摘要；如果与后续原始消息冲突，以后续原始消息为准。',
        summaryHeading: '检查点摘要',
        userGoalHeading: '用户目标',
        constraintsHeading: '约束与偏好',
        completedHeading: '已完成工作',
        importantHeading: '重要文件 / 命令 / 错误',
        assumptionsHeading: '关键假设',
        validationHeading: '验证状态 / 结果',
        pendingHeading: '待继续事项',
        openQuestionsHeading: '待确认问题',
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
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content:
        message.role === 'user' ? message.promptContent ?? message.content : message.content,
      images:
        message.role === 'user' && message.images && message.images.length > 0
          ? message.images
          : undefined,
      timestamp: message.timestamp,
    }));
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

function pickRetainedTailMessages(messages: readonly IMessage[]): {
  retainedMessages: IMessage[];
  retainedTokens: number;
} {
  const retained: IMessage[] = [];
  let retainedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const messageTokens = getMessageTokenCount(message);
    const keepByMinimum = retained.length < CONTEXT_COMPACTION_MIN_RETAIN_MESSAGES;
    const keepByBudget =
      retained.length < CONTEXT_COMPACTION_MAX_RETAIN_MESSAGES &&
      retainedTokens + messageTokens <= CONTEXT_COMPACTION_TARGET_RETAIN_TOKENS;

    if (!keepByMinimum && !keepByBudget) {
      break;
    }

    retained.unshift(message);
    retainedTokens += messageTokens;
  }

  if (retained.length === 0 && messages.length > 0) {
    const tail = messages[messages.length - 1]!;
    retained.push(tail);
    retainedTokens = getMessageTokenCount(tail);
  }

  return { retainedMessages: retained, retainedTokens };
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
    ...renderSection(copy.pendingHeading, normalized.pendingWork),
    ...renderSection(copy.openQuestionsHeading, normalized.openQuestions),
  ];

  return lines.join('\n').trim();
}

export function renderContextCheckpointContent(summary: string, lang: Lang | undefined): string {
  const copy = getContextCopy(lang);
  return `${copy.checkpointPreamble}\n\n${copy.summaryHeading}：\n${summary.trim()}`;
}

export function buildEffectiveContextMessages(messages: readonly ContextMessageLike[]): IMessage[] {
  const checkpoint = getLatestCheckpoint(messages);
  const tailStart = checkpoint ? checkpoint.index + 1 : 0;
  const tailMessages = toCoreTailMessages(messages.slice(tailStart));

  if (!checkpoint) {
    return tailMessages;
  }

  return [
    {
      id: checkpoint.message.id,
      role: 'assistant',
      content: checkpoint.payload.renderedContent,
      timestamp: checkpoint.message.timestamp,
      metadata: {
        contextCheckpoint: true,
        generatedAt: checkpoint.payload.generatedAt,
        modelName: checkpoint.payload.modelName,
      },
    },
    ...tailMessages,
  ];
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
  const tailMessages = toCoreTailMessages(messages.slice(tailStart));
  const priorCheckpoint = checkpoint?.payload ?? null;
  const effectiveTokens =
    getCheckpointTokenCount(priorCheckpoint) + getMessagesTokenCount(tailMessages);
  const effectiveRoundCount =
    tailMessages.filter((m) => m.role === 'user').length + (priorCheckpoint ? 1 : 0);

  if (
    !force &&
    effectiveRoundCount <= maxRounds &&
    effectiveTokens <= maxTokens
  ) {
    return {
      shouldCompact: false,
      priorCheckpoint,
      sourceMessages: [],
      sourceChars: 0,
      sourceTokens: 0,
      retainedMessages: tailMessages,
      effectiveTokens,
    };
  }

  const { retainedMessages } = pickRetainedTailMessages(tailMessages);
  let retainedCount = retainedMessages.length;

  if (!priorCheckpoint && retainedCount >= tailMessages.length && tailMessages.length > 0) {
    retainedCount = Math.max(0, tailMessages.length - 1);
  }

  const splitIndex = Math.max(0, tailMessages.length - retainedCount);
  const sourceMessages = tailMessages.slice(0, splitIndex);
  const finalRetainedMessages = tailMessages.slice(splitIndex);

  if (!priorCheckpoint && sourceMessages.length === 0 && finalRetainedMessages.length === 0) {
    return {
      shouldCompact: false,
      priorCheckpoint,
      sourceMessages: [],
      sourceChars: 0,
      sourceTokens: 0,
      retainedMessages: tailMessages,
      effectiveTokens,
    };
  }

  return {
    shouldCompact: true,
    priorCheckpoint,
    sourceMessages,
    sourceChars: getMessageChars(sourceMessages),
    sourceTokens: getMessagesTokenCount(sourceMessages),
    retainedMessages: finalRetainedMessages,
    effectiveTokens,
  };
}

export function buildContextCompactionTranscript(messages: readonly IMessage[]): string {
  return messages
    .map((message, index) => {
      return `${index + 1}. ${message.role.toUpperCase()}: ${truncateLine(message.content ?? '', 640)}`;
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
      normalized.openQuestions.length;

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
          '你負責把長編程會話壓縮成可恢復的上下文檢查點。你必須合併已有檢查點與較早原始對話，只保留後續繼續工作真正需要的事實：用戶目標、約束、已完成修改、重要文件/命令/錯誤、尚未完成事項。不要杜撰，不要丟掉仍然有效的約束。輸出必須是 JSON 對象，且只能包含 userGoal、constraints、completedWork、importantContext、pendingWork 這五個鍵，每個鍵的值都必須是字符串數組。',
        userPrompt: `請根據已有檢查點和新增較早對話，輸出新的恢復檢查點 JSON。\n\n已有檢查點：\n${priorCheckpointBlock}\n\n新增較早對話原文：\n${params.transcript}`,
      };
    case 'en':
      return {
        systemPrompt:
          'Compress a long coding conversation into a recoverable checkpoint. Merge the existing checkpoint with the earlier raw transcript and keep only facts needed for future execution: user goals, constraints, completed work, important files/commands/errors, and remaining work. Do not invent details or drop still-valid constraints. Output JSON only with exactly five keys: userGoal, constraints, completedWork, importantContext, pendingWork. Every value must be an array of strings.',
        userPrompt:
          `Update the recovery checkpoint JSON using the existing checkpoint and the earlier raw transcript below.\n\nExisting checkpoint:\n${priorCheckpointBlock}\n\nEarlier raw transcript:\n${params.transcript}`,
      };
    default:
      return {
        systemPrompt:
          '你负责把长编程会话压缩成可恢复的上下文检查点。你必须合并已有检查点与较早原始对话，只保留后续继续工作真正需要的事实：用户目标、约束、已完成修改、重要文件/命令/错误、尚未完成事项。不要杜撰，不要丢掉仍然有效的约束。输出必须是 JSON 对象，且只能包含 userGoal、constraints、completedWork、importantContext、pendingWork 这五个键，每个键的值都必须是字符串数组。',
        userPrompt: `请根据已有检查点和新增较早对话，输出新的恢复检查点 JSON。\n\n已有检查点：\n${priorCheckpointBlock}\n\n新增较早对话原文：\n${params.transcript}`,
      };
  }
}
