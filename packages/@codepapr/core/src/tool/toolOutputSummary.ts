/**
 * 工具上下文模式：控制工具输出进入上下文的详细程度。
 *
 * 三种模式（写入时一次性冻结，缓存安全）：
 *  - full:    走现有截断管线（truncateToolOutput），保留完整输出。
 *  - summary: 只放结构化摘要，完整输出落盘，LLM 可用 read 回读。
 *  - auto:    小于 autoThresholdChars 走 full，否则走 summary。
 *
 * 交互类工具（question / todo / skill / task）永不摘要。
 */

import { sortedStringify } from '@codepapr/common';

export type ToolContextMode = 'full' | 'summary' | 'auto';

export interface ToolContextConfig {
  defaultMode: ToolContextMode;
  overrides: Record<string, ToolContextMode>;
  summaryMaxChars: number;
  autoThresholdChars: number;
  spillToDisk?: (content: string, toolName: string) => Promise<string | null>;
}

export const DEFAULT_SUMMARY_MAX_CHARS = 500;
export const DEFAULT_AUTO_THRESHOLD_CHARS = 5_000;

const PROTECTED_TOOLS = new Set(['question', 'todo', 'skill', 'task']);

const TOOL_CATEGORIES: Record<string, ToolContextMode> = {
  bash: 'summary',
  browser: 'summary',
  webfetch: 'summary',
  write: 'summary',
  edit: 'summary',
  patch: 'summary',
  read: 'auto',
  grep: 'auto',
  glob: 'auto',
  list: 'auto',
  read_image: 'auto',
  graph: 'auto',
  lsp: 'auto',
  diagnostics: 'auto',
  git: 'auto',
};

export function resolveToolContextMode(
  toolName: string,
  config: ToolContextConfig
): ToolContextMode {
  if (PROTECTED_TOOLS.has(toolName)) return 'full';
  return config.overrides[toolName] ?? TOOL_CATEGORIES[toolName] ?? config.defaultMode;
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

function summarizeBash(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const cmd = truncatePreview(arg(args, 'command'), 120);
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n');
  const preview = lines.slice(0, 3).join('\n');
  return [
    `[bash] ${status} | ${cmd}`,
    `输出 ${output.length.toLocaleString()} 字符 / ${lines.length} 行`,
    preview ? `前 ${Math.min(3, lines.length)} 行:\n${truncatePreview(preview, 200)}` : '',
  ].filter(Boolean).join('\n');
}

function summarizeRead(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = arg(args, 'path') || arg(args, 'filePath');
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n');
  const preview = lines.slice(0, 3).join('\n');
  return [
    `[read] ${status} | ${path}`,
    `${lines.length} 行 / ${output.length.toLocaleString()} 字符`,
    preview ? `前 3 行:\n${truncatePreview(preview, 200)}` : '',
  ].filter(Boolean).join('\n');
}

function summarizeWrite(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = arg(args, 'path') || arg(args, 'filePath');
  const status = success ? '✓' : '✗';
  const content = arg(args, 'content');
  return `[write] ${status} | ${path} | ${content.length.toLocaleString()} 字符`;
}

function summarizeEdit(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const path = arg(args, 'path') || arg(args, 'filePath');
  const status = success ? '✓' : '✗';
  return `[edit] ${status} | ${path}`;
}

function summarizeGrep(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const pattern = arg(args, 'pattern');
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n').filter(Boolean);
  const preview = lines.slice(0, 5).join('\n');
  return [
    `[grep] ${status} | pattern: ${pattern}`,
    `${lines.length} 条匹配`,
    preview ? truncatePreview(preview, 300) : '',
  ].filter(Boolean).join('\n');
}

function summarizeGlob(args: Record<string, unknown>, result: unknown, success: boolean): string {
  const pattern = arg(args, 'pattern');
  const status = success ? '✓' : '✗';
  const output = str(result);
  const lines = output.split('\n').filter(Boolean);
  const preview = lines.slice(0, 5).join('\n');
  return [
    `[glob] ${status} | pattern: ${pattern}`,
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
  patch: summarizeEdit,
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

export interface ToolContextResult {
  content: string;
  spilledPath?: string;
  originalChars: number;
  summarized: boolean;
}

export async function applyToolContextMode(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  success: boolean,
  config: ToolContextConfig
): Promise<ToolContextResult> {
  const mode = resolveToolContextMode(toolName, config);
  const fullContent = typeof result === 'string' ? result : str(result);
  const originalChars = fullContent.length;

  if (mode === 'full') {
    return { content: fullContent, originalChars, summarized: false };
  }

  const shouldSummarize =
    mode === 'summary' || (mode === 'auto' && originalChars > config.autoThresholdChars);

  if (!shouldSummarize) {
    return { content: fullContent, originalChars, summarized: false };
  }

  let spilledPath: string | undefined;
  if (config.spillToDisk) {
    try {
      const path = await config.spillToDisk(fullContent, toolName);
      if (path) spilledPath = path;
    } catch {
      // spill 失败时降级为纯摘要
    }
  }

  const summary = summarizeToolOutput(toolName, args, result, success, config.summaryMaxChars);
  const lines = [summary];
  if (spilledPath) {
    lines.push(`完整输出: ${spilledPath}（可用 read 回读）`);
  }

  return {
    content: lines.join('\n'),
    spilledPath,
    originalChars,
    summarized: true,
  };
}
