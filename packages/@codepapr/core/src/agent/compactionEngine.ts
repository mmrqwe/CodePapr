/**
 * 压缩引擎 v4（骨架优先，确定性，零 LLM）——所有压缩入口的唯一决策核心。
 *
 * 与 v3 的根本区别：
 * - 触发只有一条线：usage ≥ 窗口 × COMPACT_TRIGGER_RATIO（不再有轮数上限、
 *   软预算分层、prune-first）；
 * - 主压缩产物是「骨架」：每个旧回合只保留用户问题（截断）与该回合最后一条
 *   可见 assistant 文本（头尾截断），工具调用/结果全部丢弃（计数注记）——
 *   完全确定性，不烧 LLM；
 * - 最近 TAIL_ROUNDS_VERBATIM 个回合逐字保留（含工具调用/结果）；预算不足时
 *   先降逐字轮数（到 1），再把最后一轮做轮内折叠（checkpoint 落进回合内部，
 *   保留最后几个 turn 组，更早的 turn 折成活动行）；
 * - 以上全部装不下时才允许一次 LLM 二级摘要（由调用方执行，输入经
 *   preSizeSummaryInput 确定性预瘦身，绝不递归）；
 * - TodoList 权威 digest 是 pinned 信息，由调用方独立注入，不参与任何折叠。
 *
 * 边界契约：checkpoint 消息插在 boundaryMessageId 之前；boundary 及其后的
 * 消息逐字保留，boundary 之前的全部消失（内容已进 checkpoint 块）。轮内折叠
 * 时 boundary = 保留的最后一个 turn，用户问题与更早 turn 都在 boundary 之前，
 * 由 questionLine/activityText 在 checkpoint 内重建。
 *
 * 引擎只消费 core 形态的 IMessage（assistant 携带 toolCalls、tool 消息独立）。
 * 回合 = 一条 user 消息 + 其后全部 assistant/tool，直到下一条 user。
 * token 口径是文本估算（选型用）；最终缩容校验由调用方按 wire 口径执行。
 */

import { estimateTokens } from '@codepapr/common';
import type { IMessage } from '@codepapr/types';

export const CONTEXT_COMPACTION_VERSION_V4 = 4;

/** usage 达到窗口的该比例即触发压缩（唯一触发线）。 */
export const COMPACT_TRIGGER_RATIO = 0.9;
/** 逐字保留的最近回合数（预算压力下向 TAIL_ROUNDS_FLOOR 降级）。 */
export const TAIL_ROUNDS_VERBATIM = 5;
export const TAIL_ROUNDS_FLOOR = 1;
/** 轮内折叠：逐字保留回合尾部的 turn 组数（从该值降到 1）。 */
export const TAIL_TURNS_VERBATIM = 3;
/** 骨架行截断参数（确定性：Q 保头 300；A 头 300 + 尾 100，结构感知、
 *  行边界吸附、中段标题/代码块优先）。 */
export const SKELETON_Q_MAX_CHARS = 300;
export const SKELETON_A_HEAD_CHARS = 300;
export const SKELETON_A_TAIL_CHARS = 100;
/** 轮内活动行文本上限（字）。 */
export const ACTIVITY_TEXT_MAX_CHARS = 120;
/** 轮内活动行里每 turn 列出的工具名上限。 */
export const ACTIVITY_TOOLS_MAX = 6;
/** 二级摘要输入上限占窗口比例（超出整块丢最老行并注记，不递归）。 */
export const SUMMARY_INPUT_RATIO = 0.9;
/** 无需 LLM 的确定性摘要降级：块长 = 可用预算 × 该比例（防回写即超限）。 */
export const SUMMARY_FIT_RATIO = 0.9;

export type CompactionEngineLang = 'en' | 'zh-CN' | 'zh-TW';

/** 二级摘要（含子代理 headless）系统提示词——骨架进、摘要出，全链路唯一口径。 */
export const SKELETON_SUMMARY_SYSTEM_PROMPTS: Record<CompactionEngineLang, string> = {
  'zh-CN':
    '你是上下文压缩器。把下面的对话骨架（用户问题与最终结论的行）合并成一份简洁的上下文摘要，供之后的对话继续参考。必须保留：所有决定、文件路径、命令、标识符、数字、约束与未完成事项；不得发明骨架中不存在的信息；用行式纯文本输出，不要 JSON、不要客套话。',
  'zh-TW':
    '你是上下文壓縮器。把下面的對話骨架（使用者問題與最終結論的行）合併成一份簡潔的上下文摘要，供之後的對話繼續參考。必須保留：所有決定、檔案路徑、命令、識別符、數字、約束與未完成事項；不得發明骨架中不存在的信息；用行式純文字輸出，不要 JSON、不要客套話。',
  en: 'You are a context compactor. Merge the conversation skeleton lines below (user questions and final summaries) into a concise context summary for later turns. Preserve every decision, file path, command, identifier, number, constraint, and unfinished item; never invent content; output plain text lines only, no JSON, no pleasantries.',
};

export interface EngineTurn {
  /** assistant 消息 id（UI/surface 同一 id 空间）。 */
  id: string;
  /** 该 turn 的可见文本（可能为空——纯工具轮）。 */
  text: string;
  /** 该 turn 发起的工具名（顺序保留，用于活动行与计数）。 */
  toolNames: string[];
  /** 该 turn 上线 token 估算（assistant 文本 + toolCalls + 对应 tool 结果）。 */
  tokens: number;
}

export interface EngineRound {
  userId: string;
  userText: string;
  turns: EngineTurn[];
  /** 属于该回合的原始消息 id（user + assistant + tool），provenance/审计用。 */
  sourceMessageIds: string[];
  /** 原始形态 token 估算（逐字保留时的成本）。 */
  originalTokens: number;
}

export interface SkeletonEntry {
  userId: string;
  /** 该回合最后一条有文本的 assistant turn id；无则 null。 */
  assistantId: string | null;
  q: string;
  a: string;
  droppedToolCalls: number;
}

export interface InRoundFold {
  userId: string;
  /** 逐字保留的尾部 turn id（旧→新）。 */
  retainedTurnIds: string[];
  /** 被折叠的早期 turn 的活动行（已渲染，\n 连接）。 */
  activityText: string;
}

/** 引擎输出的确定性骨架方案。needsSummary=true 时方案未达预算：调用方跑一次
 *  二级摘要（summaryInput 已预瘦身）或用 deterministicSummary 截断降级。 */
export interface SkeletonPlan {
  /** 逐字保留的回合（旧→新；轮内折叠时最后一个回合只含保留的 turn）。 */
  retainedRounds: EngineRound[];
  /** checkpoint 插入边界消息 id（含之及其后逐字保留）。 */
  boundaryMessageId: string;
  /** 轮内折叠信息（未折叠为 null）。 */
  inRoundFold: InRoundFold | null;
  /** 折叠回合的用户问题行（boundary 落在回合内部时非空，重建 Q 上下文）。 */
  questionLine: string;
  /** 被骨架化的回合条目（旧→新）。 */
  skeleton: SkeletonEntry[];
  /** 渲染好的骨架块文本（不含前言/pinned）。 */
  skeletonText: string;
  /** 轮内活动块文本（未折叠为空串）。 */
  activityText: string;
  /** 逐字保留部分的 token 估算（wire 换算由调用方按消息 id 精确执行）。 */
  retainedTokens: number;
  needsSummary: boolean;
  /** 二级摘要输入（needsSummary 时非空，已预瘦身）。 */
  summaryInput: string | null;
  /** 估算口径的装配后总 token（fixed + prior + 骨架/摘要 + 逐字保留）。 */
  estimatedTokensAfter: number;
}

export interface SkeletonPlanParams {
  /** 本次压缩源的全部回合（旧→新；prior checkpoint 文本另传）。 */
  rounds: EngineRound[];
  /** 上一次 checkpoint 的已压缩文本（骨架/摘要），保留在块首。可为空串。 */
  priorFoldedText: string;
  /** 固定开销（bootstrap + 前言 + todo digest 等），token 估算口径。 */
  fixedOverheadTokens: number;
  /** 预算线（窗口 × 0.9）。 */
  triggerTokens: number;
  /** 二级摘要输入上限（通常 窗口 × 0.9）。 */
  summaryInputTokens: number;
  lang: CompactionEngineLang;
}

function copy(lang: CompactionEngineLang) {
  switch (lang) {
    case 'en':
      return {
        roundLabel: (n: number, tools: number) => `[Round ${n} · ${tools} tool call(s)]`,
        currentLabel: '[Current task]',
        q: 'Q:',
        a: 'A:',
        noAnswer: '(no text summary; tool-only round)',
        activity: (n: number, names: string, text: string) =>
          `- [Step ${n}] ${names}${text ? ` — ${text}` : ''}`,
        moreTools: (extra: number) => ` +${extra} more`,
        droppedSummary: 'Earlier conversation (deterministic skeleton; overflow omitted):',
        omittedMark: '…(older skeleton lines omitted to fit the summary input)',
      };
    case 'zh-TW':
      return {
        roundLabel: (n: number, tools: number) => `[第 ${n} 輪 · ${tools} 次工具呼叫]`,
        currentLabel: '[當前任務]',
        q: '問：',
        a: '答：',
        noAnswer: '（該輪為工具執行，無文字總結）',
        activity: (n: number, names: string, text: string) =>
          `- [步驟 ${n}] ${names}${text ? ` —— ${text}` : ''}`,
        moreTools: (extra: number) => ` 等 ${extra} 個`,
        droppedSummary: '更早的對話（確定性骨架；超出部分已省略）：',
        omittedMark: '…（更早的骨架行因摘要輸入上限省略）',
      };
    default:
      return {
        roundLabel: (n: number, tools: number) => `[第 ${n} 轮 · ${tools} 次工具调用]`,
        currentLabel: '[当前任务]',
        q: '问：',
        a: '答：',
        noAnswer: '（该轮为工具执行，无文字总结）',
        activity: (n: number, names: string, text: string) =>
          `- [步骤 ${n}] ${names}${text ? ` —— ${text}` : ''}`,
        moreTools: (extra: number) => ` 等 ${extra} 个`,
        droppedSummary: '更早的对话（确定性骨架；超出部分已省略）：',
        omittedMark: '…（更早的骨架行因摘要输入上限省略）',
      };
  }
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 行内空白折叠、保留换行与段落（结构信息是标题/代码围栏识别的前提）。 */
function normalizeStructuredText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ``` 开/闭都是整行标记；奇数 = 片段起始于未闭合围栏内。 */
function countFenceLines(text: string): number {
  return (text.match(/^```/gm) ?? []).length;
}

/** 中段被丢弃时的优先片段：首条标题 + 首个代码块（各截断），总长 ≤ budget。 */
function extractPrioritySnippets(dropped: string, budget: number): string[] {
  if (budget <= 0) return [];
  const snippets: string[] = [];
  let remaining = budget;
  const heading = /^#{1,6}\s+\S.*$/m.exec(dropped)?.[0]?.trim();
  if (heading) {
    const clipped = heading.length > 60 ? `${heading.slice(0, 59)}…` : heading;
    snippets.push(clipped);
    remaining -= clipped.length + 1;
  }
  const fence = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m.exec(dropped);
  if (fence && remaining > 24) {
    const openLine = fence[0].split('\n', 1)[0]!.trimEnd();
    const bodyBudget = remaining - openLine.length - 8;
    if (bodyBudget > 16) {
      let body = fence[2]!.trim();
      if (body.length > bodyBudget) {
        body = `${body.slice(0, Math.max(1, bodyBudget - 1)).trimEnd()}…`;
      }
      snippets.push(`${openLine}\n${body}\n\`\`\``);
    }
  }
  return snippets;
}

/**
 * 结构感知的头尾截断（长方案轮防「中段全丢」）：
 * - 行边界吸附：切点优先落在换行处，不把标题/列表/代码行劈成两半；
 * - 代码围栏平衡：head 内围栏奇数补闭合、tail 起于未闭合围栏内补开，
 *   单条骨架行始终可独立阅读；
 * - 标题/代码块优先：被丢弃的中段若含标题或 fenced code，保留首条标题与
 *   首个代码块（在头尾最小预算之外，总长仍受 headChars + tailChars 约束）。
 * 单行文本（无换行）退化为纯头尾切片，保持既有 401 字形状。
 */
function clipHeadTail(text: string, headChars: number, tailChars: number): string {
  const normalized = normalizeStructuredText(text);
  if (!normalized.includes('\n')) {
    const flat = normalized.replace(/\s+/g, ' ').trim();
    if (flat.length <= headChars + tailChars) return flat;
    return `${flat.slice(0, headChars)}…${flat.slice(-tailChars)}`;
  }
  if (normalized.length <= headChars + tailChars) return normalized;

  const minHead = Math.floor(headChars * 0.6);
  const minTail = Math.floor(tailChars * 0.5);
  let headEnd = normalized.lastIndexOf('\n', headChars);
  if (headEnd < minHead) headEnd = headChars;
  let tailStart = normalized.indexOf('\n', normalized.length - tailChars);
  if (tailStart === -1 || tailStart > normalized.length - minTail) {
    tailStart = normalized.length - tailChars;
  }
  const extraBudget = Math.max(0, headChars + tailChars - minHead - minTail);
  let extras = extractPrioritySnippets(normalized.slice(headEnd, tailStart), extraBudget);
  if (extras.length > 0) {
    // 优先片段从头预算里扣；头至少保留 minHead。
    headEnd = Math.min(headEnd, Math.max(minHead, headChars - extras.join('\n').length));
    extras = extractPrioritySnippets(normalized.slice(headEnd, tailStart), extraBudget);
  }
  let head = normalized.slice(0, headEnd).trimEnd();
  let tail = normalized.slice(tailStart).trimStart();
  if (countFenceLines(head) % 2 === 1) head = `${head}\n\`\`\``;
  if (countFenceLines(normalized.slice(0, tailStart)) % 2 === 1) tail = `\`\`\`\n${tail}`;
  const middle = extras.length > 0 ? `\n…\n${extras.join('\n')}` : '';
  return `${head}${middle}\n…\n${tail}`;
}

/** IMessage → 回合结构。首条 user 之前的 assistant/tool 归入匿名前导回合。 */
export function roundsFromCoreMessages(messages: readonly IMessage[]): EngineRound[] {
  const rounds: EngineRound[] = [];
  let current: EngineRound | null = null;
  let lastTurn: EngineTurn | null = null;
  const ensureRound = (userText: string, userId: string): EngineRound => {
    const round: EngineRound = { userId, userText, turns: [], sourceMessageIds: [], originalTokens: 0 };
    rounds.push(round);
    current = round;
    lastTurn = null;
    return round;
  };
  for (const message of messages) {
    const contentText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    if (message.role === 'user') {
      current = ensureRound(message.content ?? '', message.id);
      current.sourceMessageIds.push(message.id);
      current.originalTokens += estimateTokens(contentText);
      continue;
    }
    if (message.role === 'assistant') {
      if (!current) ensureRound('', `${message.id}-head`);
      const round = current!;
      round.sourceMessageIds.push(message.id);
      const toolTokens = estimateTokens(JSON.stringify(message.toolCalls ?? []));
      const textTokens = estimateTokens(contentText);
      const turn: EngineTurn = {
        id: message.id,
        text: contentText,
        toolNames: (message.toolCalls ?? []).map((call) => call.name),
        tokens: textTokens + toolTokens,
      };
      round.turns.push(turn);
      round.originalTokens += textTokens + toolTokens;
      lastTurn = turn;
      continue;
    }
    if (message.role === 'tool') {
      if (!current) continue;
      current.sourceMessageIds.push(message.id);
      const toolTokens = estimateTokens(contentText);
      current.originalTokens += toolTokens;
      if (lastTurn) lastTurn.tokens += toolTokens;
    }
  }
  return rounds;
}

function roundToolCalls(round: EngineRound): number {
  return round.turns.reduce((sum, turn) => sum + turn.toolNames.length, 0);
}

function roundFinalText(round: EngineRound): { id: string | null; text: string } {
  for (let index = round.turns.length - 1; index >= 0; index -= 1) {
    const turn = round.turns[index]!;
    if (turn.text.trim()) return { id: turn.id, text: turn.text };
  }
  return { id: null, text: '' };
}

export function skeletonEntryFromRound(round: EngineRound, lang: CompactionEngineLang): SkeletonEntry {
  const c = copy(lang);
  const final = roundFinalText(round);
  const q = clip(round.userText, SKELETON_Q_MAX_CHARS);
  const a = final.text ? clipHeadTail(final.text, SKELETON_A_HEAD_CHARS, SKELETON_A_TAIL_CHARS) : c.noAnswer;
  return {
    userId: round.userId,
    assistantId: final.id,
    q: q || '…',
    a,
    droppedToolCalls: roundToolCalls(round),
  };
}

export function renderSkeletonEntries(entries: readonly SkeletonEntry[], lang: CompactionEngineLang, startIndex = 1): string {
  const c = copy(lang);
  const lines: string[] = [];
  entries.forEach((entry, offset) => {
    lines.push(c.roundLabel(startIndex + offset, entry.droppedToolCalls));
    lines.push(`${c.q} ${entry.q}`);
    lines.push(`${c.a} ${entry.a}`);
  });
  return lines.join('\n');
}

/** 轮内折叠时，被 boundary 越过的回合用户问题在 checkpoint 内的重建行。 */
export function renderRoundQuestionLine(round: EngineRound, lang: CompactionEngineLang): string {
  const c = copy(lang);
  const q = clip(round.userText, SKELETON_Q_MAX_CHARS);
  return `${c.currentLabel} ${c.q} ${q || '…'}`;
}

/** 轮内折叠：回合前段 turns → 活动行；尾部 keepLastTurns 个 turns 逐字。 */
export function foldRoundActivity(
  round: EngineRound,
  keepLastTurns: number,
  lang: CompactionEngineLang
): InRoundFold {
  const c = copy(lang);
  const keepCount = Math.max(0, Math.min(keepLastTurns, round.turns.length));
  const splitIndex = round.turns.length - keepCount;
  const kept = round.turns.slice(splitIndex);
  const folded = round.turns.slice(0, splitIndex);
  const lines = folded.map((turn, index) => {
    const shown = turn.toolNames.slice(0, ACTIVITY_TOOLS_MAX).join(', ');
    const extra = turn.toolNames.length > ACTIVITY_TOOLS_MAX ? c.moreTools(turn.toolNames.length - ACTIVITY_TOOLS_MAX) : '';
    const text = turn.text.trim() ? clip(turn.text, ACTIVITY_TEXT_MAX_CHARS) : '';
    return c.activity(index + 1, shown ? `${shown}${extra}` : '(no tools)', text);
  });
  return {
    userId: round.userId,
    retainedTurnIds: kept.map((turn) => turn.id),
    activityText: lines.join('\n'),
  };
}

/** 预瘦身：摘要输入压进 token 上限——从最老的行起整块丢弃并加省略注记。
 *  最新一行无条件保留（单行自身上限由上游 toolOutputTruncation/骨架截断保证）。 */
export function preSizeSummaryInput(
  lines: readonly string[],
  headerLines: readonly string[],
  tokenLimit: number,
  lang: CompactionEngineLang
): { text: string; omitted: number } {
  const c = copy(lang);
  let headerTokens = 0;
  for (const line of headerLines) headerTokens += estimateTokens(line);
  const budget = Math.max(0, tokenLimit - headerTokens);
  const kept: string[] = [];
  let tokens = 0;
  let omitted = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > budget && kept.length > 0) {
      omitted = index + 1;
      break;
    }
    kept.unshift(line);
    tokens += lineTokens;
    if (tokens > budget) {
      omitted = index;
      break;
    }
  }
  if (omitted === 0 && kept.length < lines.length) omitted = lines.length - kept.length;
  const body = omitted > 0 ? [c.omittedMark, ...kept] : kept;
  return { text: [...headerLines, c.droppedSummary, ...body].join('\n'), omitted };
}

/** 二级摘要不可用（LLM 失败）时的确定性降级：按行保尾截断到预算内，
 *  最新一行永远保留。 */
export function deterministicSummary(text: string, budgetTokens: number, lang: CompactionEngineLang): string {
  const c = copy(lang);
  const budget = Math.max(1, Math.floor(budgetTokens * SUMMARY_FIT_RATIO));
  const lines = text.split('\n').filter(Boolean);
  const kept: string[] = [];
  let tokens = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > budget && kept.length > 0) break;
    kept.unshift(line);
    tokens += lineTokens;
    if (tokens > budget) break;
  }
  if (kept.length < lines.length) kept.unshift(c.omittedMark);
  return kept.join('\n');
}

function tailTokensOf(rounds: readonly EngineRound[]): number {
  return rounds.reduce((sum, round) => sum + round.originalTokens, 0);
}

/** 组装完整 checkpoint 块文本（prior 摘要 → 骨架 → 当前任务行/活动行）。 */
export function renderCompactedBlock(plan: {
  skeletonText: string;
  activityText: string;
  questionLine: string;
}): string {
  return [plan.skeletonText, plan.questionLine, plan.activityText].filter((part) => part.trim()).join('\n');
}

/**
 * 对最后一轮做轮内折叠：checkpoint 边界落在回合内部（首个保留 turn 之前），
 * 更早的 turn 折成活动行、用户问题重建为 [当前任务] 行。回合全部进骨架。
 */
function tryInRoundFold(
  params: SkeletonPlanParams,
  fixedPlusPrior: number
): SkeletonPlan | null {
  const { rounds, lang, triggerTokens } = params;
  const lastRound = rounds[rounds.length - 1];
  if (!lastRound || lastRound.turns.length < 2) return null;
  const skeletonRounds = rounds.slice(0, rounds.length - 1);
  const skeleton = skeletonRounds.map((round) => skeletonEntryFromRound(round, lang));
  const skeletonText = renderSkeletonEntries(skeleton, lang);
  const questionLine = renderRoundQuestionLine(lastRound, lang);
  for (let keep = Math.min(TAIL_TURNS_VERBATIM, lastRound.turns.length - 1); keep >= 1; keep -= 1) {
    const fold = foldRoundActivity(lastRound, keep, lang);
    if (!fold.activityText || fold.retainedTurnIds.length === 0) continue;
    const keptIds = new Set(fold.retainedTurnIds);
    const keptTurnTokens = lastRound.turns
      .filter((turn) => keptIds.has(turn.id))
      .reduce((sum, turn) => sum + turn.tokens, 0);
    const estimated =
      fixedPlusPrior +
      estimateTokens(skeletonText) +
      estimateTokens(questionLine) +
      estimateTokens(fold.activityText) +
      keptTurnTokens;
    if (estimated <= triggerTokens) {
      const retainedLast: EngineRound = {
        ...lastRound,
        turns: lastRound.turns.filter((turn) => keptIds.has(turn.id)),
        sourceMessageIds: fold.retainedTurnIds,
        originalTokens: keptTurnTokens,
      };
      return {
        retainedRounds: [retainedLast],
        boundaryMessageId: fold.retainedTurnIds[0]!,
        inRoundFold: fold,
        questionLine,
        skeleton,
        skeletonText,
        activityText: fold.activityText,
        retainedTokens: keptTurnTokens,
        needsSummary: false,
        summaryInput: null,
        estimatedTokensAfter: estimated,
      };
    }
  }
  return null;
}

/** 确定性手段用尽 → 一次二级摘要（输入已预瘦身；摘要块上限另给）。 */
function makeSummaryPlan(params: SkeletonPlanParams, fixedPlusPrior: number): SkeletonPlan {
  const { rounds, lang, summaryInputTokens, priorFoldedText } = params;
  const skeletonRounds = rounds.slice(0, rounds.length - 1);
  const skeleton = skeletonRounds.map((round) => skeletonEntryFromRound(round, lang));
  const skeletonText = renderSkeletonEntries(skeleton, lang);
  const lastRound = rounds[rounds.length - 1]!;
  const canFold = lastRound.turns.length >= 2;
  const fold = canFold ? foldRoundActivity(lastRound, Math.min(TAIL_TURNS_VERBATIM, lastRound.turns.length - 1), lang) : null;
  const activityText = fold?.activityText ?? '';
  const questionLine = fold && fold.activityText && fold.retainedTurnIds.length > 0
    ? renderRoundQuestionLine(lastRound, lang)
    : '';
  const boundaryMessageId =
    fold && fold.activityText && fold.retainedTurnIds.length > 0
      ? fold.retainedTurnIds[0]!
      : lastRound.userId;
  const keptTurnTokens =
    fold && questionLine
      ? lastRound.turns
          .filter((turn) => fold.retainedTurnIds.includes(turn.id))
          .reduce((sum, turn) => sum + turn.tokens, 0)
      : lastRound.originalTokens;
  const lines = [
    ...(priorFoldedText.trim() ? priorFoldedText.trim().split('\n') : []),
    ...skeletonText.split('\n').filter(Boolean),
    ...(questionLine ? [questionLine] : []),
    ...(activityText ? activityText.split('\n') : []),
  ];
  const preSized = preSizeSummaryInput(lines, [], summaryInputTokens, lang);
  const retainedLast: EngineRound =
    questionLine && fold
      ? {
          ...lastRound,
          turns: lastRound.turns.filter((turn) => fold.retainedTurnIds.includes(turn.id)),
          sourceMessageIds: fold.retainedTurnIds,
          originalTokens: keptTurnTokens,
        }
      : lastRound;
  return {
    retainedRounds: [retainedLast],
    boundaryMessageId,
    inRoundFold: questionLine && fold ? fold : null,
    questionLine,
    skeleton,
    skeletonText,
    activityText,
    retainedTokens: keptTurnTokens,
    needsSummary: true,
    summaryInput: preSized.text,
    estimatedTokensAfter: fixedPlusPrior + estimateTokens(preSized.text) + keptTurnTokens,
  };
}

/**
 * 核心决策：在预算线内做最大保真的确定性骨架方案。
 * 收敛顺序（全部零 LLM）：
 *   1. tail = 最近 5 回合逐字，更早 → 骨架；
 *   2. 超 → tail 4/3/2/1；
 *   3. 超 → 对最后一轮做轮内折叠（checkpoint 进回合内部，保最后 3/2/1 个 turn 组）；
 *   4. 仍超 → needsSummary=true（调用方跑一次二级摘要或确定性截断）。
 * 返回 null = 无可压缩内容。
 */
export function planSkeletonCompaction(params: SkeletonPlanParams): SkeletonPlan | null {
  const { rounds, priorFoldedText, fixedOverheadTokens, triggerTokens, lang } = params;
  if (rounds.length === 0) return null;
  const fixedPlusPrior = fixedOverheadTokens + estimateTokens(priorFoldedText);

  // 回合级：tail 从 min(5, n-1) 降到 1（骨架非空的前提下逐字保真最大化的
  // 首个达标方案即返回；1 轮逐字仍超限才交给轮内折叠）。
  for (let tailRounds = Math.min(TAIL_ROUNDS_VERBATIM, rounds.length - 1); tailRounds >= 1; tailRounds -= 1) {
    const skeletonRounds = rounds.slice(0, rounds.length - tailRounds);
    const tail = rounds.slice(rounds.length - tailRounds);
    const skeleton = skeletonRounds.map((round) => skeletonEntryFromRound(round, lang));
    const skeletonText = renderSkeletonEntries(skeleton, lang);
    const estimated = fixedPlusPrior + estimateTokens(skeletonText) + tailTokensOf(tail);
    if (estimated <= triggerTokens) {
      return {
        retainedRounds: tail,
        boundaryMessageId: tail[0]!.userId,
        inRoundFold: null,
        questionLine: '',
        skeleton,
        skeletonText,
        activityText: '',
        retainedTokens: tailTokensOf(tail),
        needsSummary: false,
        summaryInput: null,
        estimatedTokensAfter: estimated,
      };
    }
  }

  const folded = tryInRoundFold(params, fixedPlusPrior);
  if (folded) return folded;

  return makeSummaryPlan(params, fixedPlusPrior);
}
