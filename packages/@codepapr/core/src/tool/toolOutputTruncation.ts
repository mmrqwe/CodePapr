/**
 * 工具结果截断：在工具输出进入 AppendOnlyLog 之前裁剪大小。
 *
 * 设计参考 OpenCode 的 Truncate.Service：
 *  - 超过 maxBytes 的输出截断为 previewChars 预览
 *  - 可选 spillToDisk 回调把完整内容写到磁盘，上下文里只留预览 + 文件路径
 *  - LLM 需要全文时可用 read 工具读取磁盘文件
 *
 * 截断后的 content 格式：
 *   <预览前 N 字符>
 *
 *   [已截断，原始大小 238KB，完整输出已保存到 .CodePapr/tool-output/tool_xxx.txt]
 *   [可用 read 工具查看完整内容：read(".CodePapr/tool-output/tool_xxx.txt")]
 */

import { sortedStringify, generateUUID } from '@codepapr/common';

export interface ToolOutputTruncationOptions {
  maxBytes: number;
  previewChars: number;
  spillToDisk?: (content: string, toolName: string) => Promise<string | null>;
}

export interface TruncationResult {
  content: string;
  spilledPath?: string;
  originalSize: number;
  truncated: boolean;
}

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

export function formatTruncatedContent(
  preview: string,
  spilledPath: string | undefined,
  originalSize: number,
  toolName: string
): string {
  const sizeKB = Math.max(1, Math.round(originalSize / 1000));
  const lines: string[] = [preview, ''];

  if (spilledPath) {
    lines.push(
      `[已截断，原始大小 ${sizeKB}KB，完整输出已保存到 ${spilledPath}]`,
      `[可用 read 工具查看完整内容：read("${spilledPath}")]`
    );
  } else {
    lines.push(
      `[已截断，原始大小 ${sizeKB}KB]`,
      `[如需完整内容，请重新调用 ${toolName} 工具或缩小查询范围]`
    );
  }

  return lines.join('\n');
}

export async function truncateToolOutput(
  result: unknown,
  toolName: string,
  options: ToolOutputTruncationOptions
): Promise<TruncationResult> {
  const content = stringifyToolResult(result);
  const originalSize = getByteSize(content);

  if (originalSize <= options.maxBytes) {
    return { content, originalSize, truncated: false };
  }

  let spilledPath: string | undefined;
  if (options.spillToDisk) {
    try {
      const path = await options.spillToDisk(content, toolName);
      if (path) spilledPath = path;
    } catch {
      // spill 失败时降级为纯截断（不写磁盘）
    }
  }

  const preview = content.slice(0, options.previewChars);
  const truncatedContent = formatTruncatedContent(preview, spilledPath, originalSize, toolName);

  return { content: truncatedContent, spilledPath, originalSize, truncated: true };
}

export function generateToolOutputFilename(toolName: string): string {
  const timestamp = Date.now();
  const shortId = generateUUID().replace(/-/g, '').slice(0, 8);
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  return `tool_${timestamp}_${shortId}_${safeName}.txt`;
}
