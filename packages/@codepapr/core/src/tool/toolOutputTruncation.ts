/**
 * 工具结果截断：在工具输出进入 AppendOnlyLog 之前裁剪大小。
 *
 * 设计原则（缓存安全）：截断在「写入时」一次性完成并冻结进消息内容，重建上下文时
 * 直接读取已冻结的字符串，绝不二次改写——因此不会破坏 DeepSeek 的逐字节前缀缓存。
 * 也正因为每条工具结果出生即有界，事后基于滑动窗口的旧结果裁剪不再必要。
 *
 * 三阶梯（阈值单位均为「字符」content.length）：
 *  - Tier 1 拦截（interceptChars，默认 30,000）：超过则「中间截断」，保留头尾各半
 *    （middleKeepChars，默认 8,000，头 50% + 尾 50%），删除中间。
 *  - Tier 2 落盘（offloadChars，默认 50,000）：超过则离线落盘，上下文只留
 *    offloadPreviewChars（默认 2,000）头部预览 + 磁盘文件路径，LLM 可用 read 回读全文。
 *  - Tier 3 硬上限（ceilingChars，默认 150,000）：钳制 intercept/offload 的最高值，
 *    即使配置更高也强行按上限截断。
 */

import { sortedStringify, generateUUID } from '@codepapr/common';

export interface ToolOutputTruncationOptions {
  /** Tier 1 拦截阈值（字符）。超过则中间截断。默认 30,000。 */
  interceptChars?: number;
  /** 中间截断保留的总字符数，头尾各半。默认 8,000。 */
  middleKeepChars?: number;
  /** Tier 2 落盘阈值（字符）。超过则落盘 + 预览。默认 50,000。 */
  offloadChars?: number;
  /** 落盘时保留的头部预览字符数。默认 2,000。 */
  offloadPreviewChars?: number;
  /** Tier 3 硬上限（字符），钳制 intercept/offload 的最高值。默认 150,000。 */
  ceilingChars?: number;
  /** 可选：把完整内容写盘并返回相对路径；失败返回 null。 */
  spillToDisk?: (content: string, toolName: string) => Promise<string | null>;
}

export interface TruncationResult {
  content: string;
  spilledPath?: string;
  originalChars: number;
  truncated: boolean;
}

export const DEFAULT_INTERCEPT_CHARS = 30_000;
export const DEFAULT_MIDDLE_KEEP_CHARS = 8_000;
export const DEFAULT_OFFLOAD_CHARS = 50_000;
export const DEFAULT_OFFLOAD_PREVIEW_CHARS = 2_000;
export const DEFAULT_CEILING_CHARS = 150_000;

const INTERNAL_FIELDS = new Set(['__images', '__question']);

function stripInternalFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripInternalFields);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!INTERNAL_FIELDS.has(key)) {
        result[key] = stripInternalFields((value as Record<string, unknown>)[key]);
      }
    }
    return result;
  }
  return value;
}

export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  const cleaned = stripInternalFields(result);
  return typeof cleaned === 'string' ? cleaned : sortedStringify(cleaned);
}

export function getByteSize(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function getCharLength(content: string): number {
  return content.length;
}

export function formatMiddleTruncated(
  head: string,
  tail: string,
  originalChars: number
): string {
  return [
    head,
    '',
    `[... 中间已省略：原始 ${originalChars} 字符，保留头部 ${head.length} + 尾部 ${tail.length} 字符。如需完整内容请缩小查询范围或重新调用工具 ...]`,
    '',
    tail,
  ].join('\n');
}

export function formatOffloadedContent(
  preview: string,
  spilledPath: string | undefined,
  originalChars: number,
  toolName: string
): string {
  const lines: string[] = [preview, ''];

  if (spilledPath) {
    lines.push(
      `[已截断，原始 ${originalChars} 字符，完整输出已保存到 ${spilledPath}]`,
      `[可用 read 工具查看完整内容：read("${spilledPath}")]`
    );
  } else {
    lines.push(
      `[已截断，原始 ${originalChars} 字符]`,
      `[如需完整内容，请重新调用 ${toolName} 工具或缩小查询范围]`
    );
  }

  return lines.join('\n');
}

interface ResolvedThresholds {
  intercept: number;
  middleKeep: number;
  offload: number;
  offloadPreview: number;
}

function resolveThresholds(options: ToolOutputTruncationOptions): ResolvedThresholds {
  const ceiling = Math.max(1, Math.floor(options.ceilingChars ?? DEFAULT_CEILING_CHARS));
  const clampToCeiling = (value: number) =>
    Math.max(1, Math.min(ceiling, Math.floor(value)));
  const intercept = clampToCeiling(options.interceptChars ?? DEFAULT_INTERCEPT_CHARS);
  const offload = Math.max(
    intercept,
    clampToCeiling(options.offloadChars ?? DEFAULT_OFFLOAD_CHARS)
  );
  const middleKeep = Math.max(2, Math.floor(options.middleKeepChars ?? DEFAULT_MIDDLE_KEEP_CHARS));
  const offloadPreview = Math.max(
    1,
    Math.floor(options.offloadPreviewChars ?? DEFAULT_OFFLOAD_PREVIEW_CHARS)
  );
  return { intercept, middleKeep, offload, offloadPreview };
}

export async function truncateToolOutput(
  result: unknown,
  toolName: string,
  options: ToolOutputTruncationOptions
): Promise<TruncationResult> {
  const content = stringifyToolResult(result);
  const originalChars = getCharLength(content);
  const { intercept, middleKeep, offload, offloadPreview } = resolveThresholds(options);

  if (originalChars <= intercept) {
    return { content, originalChars, truncated: false };
  }

  if (originalChars > offload) {
    let spilledPath: string | undefined;
    if (options.spillToDisk) {
      try {
        const path = await options.spillToDisk(content, toolName);
        if (path) spilledPath = path;
      } catch {
        // spill 失败时降级为纯截断（不写磁盘）
      }
    }
    const preview = content.slice(0, offloadPreview);
    return {
      content: formatOffloadedContent(preview, spilledPath, originalChars, toolName),
      spilledPath,
      originalChars,
      truncated: true,
    };
  }

  if (originalChars <= middleKeep) {
    return { content, originalChars, truncated: false };
  }

  const half = Math.floor(middleKeep / 2);
  const head = content.slice(0, half);
  const tail = content.slice(originalChars - half);
  return {
    content: formatMiddleTruncated(head, tail, originalChars),
    originalChars,
    truncated: true,
  };
}

export function generateToolOutputFilename(toolName: string): string {
  const timestamp = Date.now();
  const shortId = generateUUID().replace(/-/g, '').slice(0, 8);
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  return `tool_${timestamp}_${shortId}_${safeName}.txt`;
}
