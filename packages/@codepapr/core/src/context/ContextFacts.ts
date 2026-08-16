/**
 * Context Facts：压缩前分类的产物类型（PR2，ADR-007 前置）。
 *
 * 分类策略（deterministic rules first，绝不依赖 LLM 做基线安全判定）：
 * - 最新用户目标 / 显式约束 / 未完成 Todo / 未回答提问 → pinned；
 * - 最近完整工作轮 → retained；
 * - 已完成工作 → summarized；
 * - 测试成功/失败 → verification/failure fact + artifact 引用；
 * - 大工具输出 / 文件全文读取 → externalized（fact 只带路径与统计）；
 * - web/MCP 内容 → untrusted externalized 引用；
 * - 子代理转录 → discarded，最终结论 → summarized；
 * - reasoning / 流式碎片 / 重试 / UI 进度 → discarded。
 */

export type ContextTrust = 'trusted' | 'workspace' | 'derived' | 'untrusted';

export type ContextDisposition =
  | 'pinned'
  | 'retained'
  | 'summarized'
  | 'externalized'
  | 'discarded';

export type ContextFactKind =
  | 'user-goal'
  | 'user-constraint'
  | 'todo'
  | 'open-question'
  | 'verification'
  | 'failure'
  | 'completed-work'
  | 'file-read'
  | 'tool-output'
  | 'web-content'
  | 'mcp-content'
  | 'subagent-result'
  | 'reference';

export interface ContextArtifactRef {
  /** artifact 的唯一标识：现有落盘机制的相对路径（`.CodePapr/tool-output/…`）。 */
  artifactId: string;
  kind: 'tool-output' | 'file-read' | 'web' | 'mcp' | 'subagent';
  /** 原始内容字符数（截断前）。 */
  sizeChars: number;
  /** 文件/路径提示（read 工具的 relativePath、web 的 URL 等）。 */
  pathHint?: string;
}

/**
 * 分类事实：checkpoint 合并（PR3）与 durable memory 准入（PR4）的最小单元。
 * 永远携带来源消息 ID（不可变 provenance），大内容一律走 artifactRef 而非
 * 复制进 fact。
 */
export interface ContextFact {
  id: string;
  kind: ContextFactKind;
  trust: ContextTrust;
  disposition: ContextDisposition;
  /** 简洁摘要（有长度上限，见分类器实现）。 */
  summary: string;
  sourceMessageIds: string[];
  artifactRef?: ContextArtifactRef;
  createdAt: number;
}

/** fact 摘要长度上限：checkpoint 里复制大文本会击穿「surface 不复制消息文本」不变式。 */
export const CONTEXT_FACT_MAX_SUMMARY_CHARS = 400;

export function truncateFactSummary(summary: string, maxChars: number = CONTEXT_FACT_MAX_SUMMARY_CHARS): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}
