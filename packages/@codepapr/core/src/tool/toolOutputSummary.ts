/**
 * 工具上下文模式：控制工具输出变成「历史上下文」后的形态。
 *
 * 语义（与「发给 LLM 的内容」解耦）：
 *  - 工具结果产生时永远把全文发给 LLM（由截断管线 truncateToolOutput 约束大小）；
 *  - 若模式判定需要摘要，写入时一次性计算「冻结摘要」，存入 message.metadata.toolSummary；
 *  - 构建请求时 applyHistoryToolSummaries 把「最新一批」之外的工具消息替换为冻结摘要。
 *    该替换是消息数组的纯函数：实时路径与重建路径字节一致；每条消息只翻转一次，
 *    只在翻转那轮产生一次性前缀缓存失效，稳定摘要区随后照常命中。
 *
 * 三种模式（写入时一次性冻结，缓存安全）：
 *  - full:    不产生冻结摘要，历史永远保留全文（等价于关闭本机制）。
 *  - summary: 总是产生冻结摘要。
 *  - auto:    原始输出字符数 > autoThresholdChars 时产生冻结摘要。
 *
 * 交互类工具（question / todo / skill / task）永不摘要。
 *
 * 冻结摘要不是内容切片，而是结构化卡片：
 *  `[工具] ✓/✗ | 关键参数` → `规模统计（基于原始输出）` → `头+尾预览`
 *  → `完整输出: {落盘路径}（可用 read 回读）`（仅当截断管线已落盘），整卡钳制 summaryMaxChars。
 */

import type { IMessage } from '@codepapr/types';
import { sortedStringify } from '@codepapr/common';

export type ToolContextMode = 'full' | 'summary' | 'auto';

export interface ToolContextConfig {
  defaultMode: ToolContextMode;
  overrides: Record<string, ToolContextMode>;
  summaryMaxChars: number;
  autoThresholdChars: number;
}

/** 冻结摘要在 message.metadata 中的键。构建请求时据此替换历史工具消息内容。 */
export const TOOL_SUMMARY_METADATA_KEY = 'toolSummary';

export const DEFAULT_SUMMARY_MAX_CHARS = 500;
export const DEFAULT_AUTO_THRESHOLD_CHARS = 5_000;

const PROTECTED_TOOLS = new Set(['question', 'todo', 'skill', 'task']);

export function resolveToolContextMode(
  toolName: string,
  config: ToolContextConfig
): ToolContextMode {
  if (PROTECTED_TOOLS.has(toolName)) return 'full';
  return config.overrides[toolName] ?? config.defaultMode;
}

function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return sortedStringify(value);
}

function arg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** 工具路径参数兼容：新定义用 relativePath，旧数据可能是 path / filePath。 */
function pathArg(args: Record<string, unknown>): string {
  return arg(args, 'relativePath') || arg(args, 'path') || arg(args, 'filePath');
}

/**
 * 头+尾预览：前 maxLines 行 + 后 maxLines 行（各钳制 headChars/tailChars）。
 * 输出行数 ≤ 2*maxLines 时不分头尾，单块展示全文。
 */
export function headTailPreview(
  text: string,
  opts?: { maxLines?: number; headChars?: number; tailChars?: number }
): string {
  const maxLines = opts?.maxLines ?? 3;
  const headChars = opts?.headChars ?? 150;
  const tailChars = opts?.tailChars ?? 150;
  const lines = text.split('\n');
  if (lines.length <= maxLines * 2) {
    const body = truncatePreview(lines.join('\n'), headChars + tailChars);
    return body ? `全文 ${lines.length} 行:\n${body}` : '';
  }
  const head = truncatePreview(lines.slice(0, maxLines).join('\n'), headChars);
  const tail = truncatePreview(lines.slice(-maxLines).join('\n'), tailChars);
  return [`前 ${maxLines} 行:\n${head}`, `后 ${maxLines} 行:\n${tail}`].join('\n');
}

function readRangeSuffix(args: Record<string, unknown>): string {
  const symbol = arg(args, 'symbol');
  if (symbol) return ` (symbol: ${truncatePreview(symbol, 40)})`;
  const start = args.startLine;
  const end = args.endLine;
  const around = args.aroundLine;
  if (typeof start === 'number' && typeof end === 'number') return ` (L${start}-${end})`;
  if (typeof start === 'number') return ` (L${start}-)`;
  if (typeof around === 'number') return ` (around L${around})`;
  return '';
}

function summarizeBash(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const cmd = truncatePreview(arg(args, 'command'), 120);
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n');
  return [
    `[bash] ${status} | ${cmd}`,
    `输出 ${output.length.toLocaleString()} 字符 / ${lines.length} 行`,
    headTailPreview(output),
  ].filter(Boolean).join('\n');
}

function summarizeRead(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = pathArg(args);
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n');
  return [
    `[read] ${status} | ${path}${readRangeSuffix(args)}`,
    `${lines.length} 行 / ${output.length.toLocaleString()} 字符`,
    headTailPreview(output),
  ].filter(Boolean).join('\n');
}

function summarizeWrite(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = pathArg(args);
  const status = success ? '✓' : '✗';
  const content = arg(args, 'content');
  return `[write] ${status} | ${path} | ${content.length.toLocaleString()} 字符`;
}

function summarizeEdit(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = pathArg(args);
  const status = success ? '✓' : '✗';
  const oldChars = arg(args, 'search').length;
  const newChars = arg(args, 'replace').length;
  return oldChars || newChars
    ? `[edit] ${status} | ${path} | -${oldChars}/+${newChars} 字符`
    : `[edit] ${status} | ${path}`;
}

function summarizePatch(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const status = success ? '✓' : '✗';
  const patches = Array.isArray(args.patches) ? args.patches : [];
  const files = new Set<string>();
  let oldChars = 0;
  let newChars = 0;
  for (const p of patches) {
    if (!p || typeof p !== 'object') continue;
    const item = p as Record<string, unknown>;
    if (typeof item.relativePath === 'string' && item.relativePath) files.add(item.relativePath);
    if (typeof item.search === 'string') oldChars += item.search.length;
    if (typeof item.replace === 'string') newChars += item.replace.length;
  }
  return `[patch] ${status} | ${files.size} 个文件 / ${patches.length} 块 | -${oldChars}/+${newChars} 字符`;
}

function summarizeGrep(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const query = arg(args, 'query') || arg(args, 'pattern');
  const semantic = args.semantic === true ? ' (语义)' : '';
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n').filter(Boolean);
  const preview = lines.slice(0, 5).join('\n');
  return [
    `[grep] ${status} | ${query}${semantic}`,
    `${lines.length} 条匹配`,
    preview ? truncatePreview(preview, 300) : '',
  ].filter(Boolean).join('\n');
}

function summarizeGlob(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const query = arg(args, 'query') || arg(args, 'pattern');
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n').filter(Boolean);
  const preview = lines.slice(0, 5).join('\n');
  return [
    `[glob] ${status} | ${query}`,
    `${lines.length} 个文件`,
    preview ? truncatePreview(preview, 300) : '',
  ].filter(Boolean).join('\n');
}

function summarizeBrowser(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const action = arg(args, 'action');
  const url = arg(args, 'url');
  const status = success ? '✓' : '✗';
  const output = str(result);
  return [
    `[browser] ${status} | ${action}${url ? ` | ${url}` : ''}`,
    `输出 ${output.length.toLocaleString()} 字符`,
  ].join('\n');
}

function summarizeWebfetch(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const url = arg(args, 'url');
  const status = success ? '✓' : '✗';
  const output = str(result);
  return `[webfetch] ${status} | ${url} | ${output.length.toLocaleString()} 字符`;
}

function summarizeGit(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const action = arg(args, 'action');
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n');
  const preview = lines.slice(0, 3).join('\n');
  return [
    `[git] ${status} | ${action}`,
    `${output.length.toLocaleString()} 字符`,
    preview ? truncatePreview(preview, 200) : '',
  ].filter(Boolean).join('\n');
}

function summarizeGeneric(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean): string {
  const status = success ? '✓' : '✗';
  const output = str(result);
  const argKeys = Object.keys(args).slice(0, 3);
  const argSummary = argKeys.map((k) => `${k}=${truncatePreview(str(args[k]), 60)}`).join(', ');
  return [
    `[${toolName}] ${status}${argSummary ? ` | ${argSummary}` : ''}`,
    `输出 ${output.length.toLocaleString()} 字符`,
  ].join('\n');
}

const SUMMARIZERS: Record<
  string,
  (args: Record<string, unknown>, result: unknown, success: boolean) => string
> = {
  bash: summarizeBash,
  read: summarizeRead,
  write: summarizeWrite,
  edit: summarizeEdit,
  patch: summarizePatch,
  grep: summarizeGrep,
  glob: summarizeGlob,
  browser: summarizeBrowser,
  webfetch: summarizeWebfetch,
  git: summarizeGit,
};

export function summarizeToolOutput(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  success: boolean,
  maxChars: number
): string {
  const summarizer = SUMMARIZERS[toolName];
  const raw = summarizer
    ? summarizer(args, result, success)
    : summarizeGeneric(toolName, args, result, success);
  return truncatePreview(raw, maxChars);
}

export interface HistorySummaryInput {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  /** 原始输出字符数（截断前），用于 auto 阈值判定与卡片统计。 */
  originalChars: number;
  /** 截断管线已落盘时复用其路径，作为摘要里的回读指针；不重复写盘。 */
  spilledPath?: string;
}

/**
 * 写入时计算冻结摘要。返回 undefined 表示该结果在历史中保留全文
 * （full 模式 / auto 未超阈值 / 保护工具）。
 */
export function prepareHistorySummary(
  input: HistorySummaryInput,
  config: ToolContextConfig
): string | undefined {
  const mode = resolveToolContextMode(input.toolName, config);
  if (mode === 'full') return undefined;

  const shouldSummarize =
    mode === 'summary' || input.originalChars > config.autoThresholdChars;
  if (!shouldSummarize) return undefined;

  const lines = [
    summarizeToolOutput(input.toolName, input.args, input.result, input.success, config.summaryMaxChars),
  ];
  if (input.spilledPath) {
    lines.push(`完整输出: ${input.spilledPath}（可用 read 回读）`);
  }
  return lines.join('\n');
}

/**
 * 历史上下文摘要：构建 LLM 请求时，把「最新一批」之外的工具消息替换为冻结摘要。
 *
 * 纯函数（只依赖消息数组），实时路径与重建路径共用，字节一致：
 *  - 最新一批 = 从尾部数第一个带 toolCalls 的 assistant 轮的工具结果，保持全文
 *    （LLM 刚拿到、正要据此推理；用户新消息追加后它也多保留一轮全文）；
 *  - 其余带 metadata.toolSummary 的 tool 消息替换为冻结摘要；
 *  - 无冻结摘要（full 模式 / 保护工具 / 旧数据）原样保留。
 *
 * 只修改返回的副本，不修改入参数组。
 */
export function applyHistoryToolSummaries(messages: IMessage[]): IMessage[] {
  let latestBatch: Set<string> | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      latestBatch = new Set(msg.toolCalls.map((tc) => tc.id));
      break;
    }
  }
  const protectedIds = latestBatch ?? new Set<string>();

  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== 'tool' || !msg.toolResult) return msg;
    const summary = msg.metadata?.[TOOL_SUMMARY_METADATA_KEY];
    if (typeof summary !== 'string') return msg;
    if (protectedIds.has(msg.toolResult.toolCallId)) return msg;
    changed = true;
    return {
      ...msg,
      content: summary,
      toolResult: { ...msg.toolResult, result: summary },
    };
  });
  return changed ? result : messages;
}
