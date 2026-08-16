/**
 * Context 分类器（PR2）：压缩前把消息流确定性地分类为 ContextFact[]。
 *
 * 纯函数、无 IPC、无 LLM——基线安全判定不依赖模型。PR3 的 checkpoint 合并
 * 以本分类结果为输入；PR4 的 memory 准入复用同一事实格式。
 *
 * 策略（不变式 7-9 的落地）：
 * - pinned：最新用户目标、显式约束、未完成 Todo、未回答提问；
 * - summarized：已完成工作、子代理最终结论；
 * - externalized：大工具输出、文件全文读取（只保留路径/统计/artifact 引用）；
 * - untrusted externalized：web / MCP 内容（默认不进入约束/决策/规则）；
 * - discarded：reasoning、流式碎片、重试/进度类合成消息、子代理转录、旧文件读。
 */

import type {
  ContextArtifactRef,
  ContextDisposition,
  ContextFact,
  ContextFactKind,
  ContextTrust,
} from '@codepapr/core';
import { truncateFactSummary } from '@codepapr/core';
import { createId } from './createId';
import type { ContextMessageLike } from './contextCompaction';

/** 超过该字符数的大工具输出 → externalized（否则原样可摘要）。 */
export const LARGE_TOOL_OUTPUT_CHARS = 4_000;

/** 判定为「显式约束」的用户措辞模式。 */
const CONSTRAINT_PATTERN =
  /必须|务必|不要|禁止|避免|优先|限制|约束|只能|不得|must|should not|avoid|required|forbidden|never/i;

/** 判定为「提问」的措辞模式。 */
const QUESTION_PATTERN = /[?？]|是否|要不要|应该|哪个|怎么|如何|为什么|可以吗|行不行/i;

/** 测试/验证类命令模式（bash 等工具的 args.command / content 命中）。 */
export const TEST_COMMAND_PATTERN =
  /(^|\s)(pnpm|npm|yarn|cargo|go|python3?|pytest|vitest|jest|mocha)\s+(test|run|check|build|lint)|pytest|vitest|jest/i;

const UNTRUSTED_WEB_TOOLS = new Set(['web_fetch', 'webfetch', 'browser', 'search_web', 'websearch']);

function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

export interface ToolInvocationLike {
  id: string;
  name: string;
  arguments: Record<string, unknown> | undefined;
  status: string;
  output: unknown;
  error?: string;
  contextSummary?: string;
  /** 截断管线已落盘的相对路径（= artifactId）。 */
  spilledPath?: string;
}

function toolInvocationsOf(message: ContextMessageLike): ToolInvocationLike[] {
  const invocations = (message as unknown as { toolInvocations?: ToolInvocationLike[] })
    .toolInvocations;
  return Array.isArray(invocations) ? invocations : [];
}

function pathArg(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['relativePath', 'path', 'filePath', 'url']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function outputChars(output: unknown): number {
  if (typeof output === 'string') return output.length;
  try {
    return JSON.stringify(output).length;
  } catch {
    return 0;
  }
}

function outputHead(output: unknown, maxChars: number): string {
  if (typeof output === 'string') {
    return output.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }
  try {
    return JSON.stringify(output).replace(/\s+/g, ' ').slice(0, maxChars);
  } catch {
    return '';
  }
}

function artifactRefOf(
  invocation: ToolInvocationLike,
  kind: ContextArtifactRef['kind'],
  pathHint?: string
): ContextArtifactRef | undefined {
  if (!invocation.spilledPath) return undefined;
  return {
    artifactId: invocation.spilledPath,
    kind,
    sizeChars: outputChars(invocation.output),
    ...(pathHint ? { pathHint } : {}),
  };
}

function makeFact(
  kind: ContextFactKind,
  trust: ContextTrust,
  disposition: ContextDisposition,
  summary: string,
  sourceMessageIds: string[],
  artifactRef?: ContextArtifactRef,
  createdAt = Date.now()
): ContextFact {
  return {
    id: createId(),
    kind,
    trust,
    disposition,
    summary: truncateFactSummary(summary),
    sourceMessageIds,
    ...(artifactRef ? { artifactRef } : {}),
    createdAt,
  };
}

export interface ContextClassificationInput {
  /** 待分类的消息（调用方传入压缩源区间：checkpoint 之后、retained tail 之前）。 */
  messages: readonly ContextMessageLike[];
  /** 权威 TodoList 状态（未完成项 → pinned fact）。 */
  incompleteTodos?: readonly { title: string }[];
}

/**
 * 确定性分类。返回的 facts 按消息顺序排列，disposition 已按策略标注；
 * reasoning/合成消息/流式噪音不产生任何 fact。
 */
export function classifyContextMessages(input: ContextClassificationInput): ContextFact[] {
  const facts: ContextFact[] = [];
  const visible = input.messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      (!message.synthetic || (message.role === 'assistant' && message.carryForwardInContext === true))
  );

  // 最新用户目标：最后一条用户消息 → pinned
  const lastUserIndex = findLastIndex(visible, (message) => message.role === 'user');
  const readFactIdByPath = new Map<string, string>();
  const staleReadFactIds = new Set<string>();

  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index]!;
    const id = message.id;

    if (message.role === 'user') {
      const content = message.promptContent ?? message.content;
      if (index === lastUserIndex && content.trim()) {
        facts.push(makeFact('user-goal', 'trusted', 'pinned', content, [id]));
      }
      if (CONSTRAINT_PATTERN.test(content) && index !== lastUserIndex) {
        facts.push(makeFact('user-constraint', 'trusted', 'pinned', content, [id]));
      }
      if (index !== lastUserIndex && QUESTION_PATTERN.test(content)) {
        facts.push(makeFact('open-question', 'trusted', 'pinned', content, [id]));
      }
      continue;
    }

    // assistant 消息
    const invocations = toolInvocationsOf(message);

    if (invocations.length === 0) {
      const content = (message.content ?? '').trim();
      if (content) {
        facts.push(makeFact('completed-work', 'derived', 'summarized', content, [id]));
      }
      // reasoningContent 属于思维链：永远丢弃，不产生 fact。
      continue;
    }

    for (const invocation of invocations) {
      const toolName = invocation.name;
      const status = invocation.status;
      const success = status === 'success' && !invocation.error;
      const sizeChars = outputChars(invocation.output);

      // 提问工具 → pinned open-question
      if (toolName === 'question') {
        const questionText =
          typeof (invocation.arguments as Record<string, unknown> | undefined)?.['question'] ===
          'string'
            ? String((invocation.arguments as Record<string, unknown>)['question'])
            : invocation.contextSummary ?? '';
        if (questionText.trim()) {
          facts.push(makeFact('open-question', 'trusted', 'pinned', questionText, [id]));
        }
        continue;
      }

      // TodoList 工具：权威状态由调用方传入（incompleteTodos），此处不重复生成。
      if (toolName === 'todo' || toolName === 'skill') {
        continue;
      }

      // web / MCP 内容 → untrusted externalized（默认不成为约束/决策/规则）
      if (UNTRUSTED_WEB_TOOLS.has(toolName) || isMcpTool(toolName)) {
        const pathHint = pathArg(invocation.arguments);
        facts.push(
          makeFact(
            isMcpTool(toolName) ? 'mcp-content' : 'web-content',
            'untrusted',
            'externalized',
            outputHead(invocation.output, 200),
            [id],
            artifactRefOf(invocation, isMcpTool(toolName) ? 'mcp' : 'web', pathHint)
          )
        );
        continue;
      }

      // 子代理：转录丢弃，最终结论摘要（derived）
      if (toolName === 'task') {
        const record = invocation.output as { content?: string } | undefined;
        const finalContent = typeof record?.content === 'string' ? record.content : '';
        if (finalContent.trim()) {
          facts.push(makeFact('subagent-result', 'derived', 'summarized', finalContent, [id]));
        }
        continue;
      }

      // 测试/验证命令结果 → verification / failure fact（可带 artifact 引用）
      const commandText =
        typeof (invocation.arguments as Record<string, unknown> | undefined)?.['command'] ===
        'string'
          ? String((invocation.arguments as Record<string, unknown>)['command'])
          : '';
      if (TEST_COMMAND_PATTERN.test(commandText) && toolName === 'bash') {
        facts.push(
          makeFact(
            success ? 'verification' : 'failure',
            'workspace',
            'summarized',
            `[${toolName}] ${success ? '✓' : '✗'} ${commandText}`,
            [id],
            artifactRefOf(invocation, 'tool-output')
          )
        );
        continue;
      }

      // 文件读取 → externalized（保留路径与统计；同路径只保留最后一次读取，
      // 旧文件内容丢弃但保留最新引用）
      if (toolName === 'read') {
        const pathHint = pathArg(invocation.arguments);
        if (pathHint) {
          const previousFactId = readFactIdByPath.get(pathHint);
          if (previousFactId) staleReadFactIds.add(previousFactId);
        }
        const fact = makeFact(
          'file-read',
          'workspace',
          'externalized',
          `[read] ${pathHint ?? ''} | ${sizeChars} 字符`,
          [id],
          artifactRefOf(invocation, 'file-read', pathHint)
        );
        facts.push(fact);
        if (pathHint) readFactIdByPath.set(pathHint, fact.id);
        continue;
      }

      // 大工具输出（grep/glob/graph/lsp/diagnostics/git/bash 等）→ externalized
      if (sizeChars > LARGE_TOOL_OUTPUT_CHARS || invocation.spilledPath) {
        facts.push(
          makeFact(
            'tool-output',
            'workspace',
            'externalized',
            `[${toolName}] ${sizeChars} 字符${pathHintSuffix(invocation)}`,
            [id],
            artifactRefOf(invocation, 'tool-output', pathArg(invocation.arguments))
          )
        );
        continue;
      }

      // 其余小结果：不单列 fact（留在 retained tail / 摘要路径由 PR3 决定）。
    }
  }

  // 未完成 Todo → pinned（权威 TodoList 状态，不来自消息推理）
  for (const todo of input.incompleteTodos ?? []) {
    facts.push(makeFact('todo', 'trusted', 'pinned', todo.title, []));
  }

  // 旧文件读取去重：同路径只保留最后一次读取的 fact（旧内容丢弃，保留最新引用）
  return facts.filter((fact) => !staleReadFactIds.has(fact.id));
}

function pathHintSuffix(invocation: ToolInvocationLike): string {
  const hint = pathArg(invocation.arguments);
  return hint ? ` @ ${hint}` : '';
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}
