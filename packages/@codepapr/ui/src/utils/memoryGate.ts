/**
 * memoryGate（v5）：交付卡点的「多信号门」与 curator 素材构造（纯函数）。
 *
 * 门只决定「要不要问 curator」，不决定「记什么」——判断内容永远是 curator。
 * 信号（全部零 LLM）：
 *   A 线索词：显式记忆意图（记住/以后都/please remember…）；
 *   B 持久禁令：行为约定式禁止（不要再用/never again…）——普通模态词
 *     （必须/务必/must/always…）不触发，它们是日常任务指令的高频词；
 *   C Agent 主动提议：最终答复里的「记忆候选：」标记（promptSystem 同源指令）；
 *   D 工作事件：本轮出现验证成功的测试/构建命令（[bash] ✓）。
 * 素材纪律：只放用户原话与 assistant 最终文本 / 骨架行，绝不含原始工具输出
 * （注入写记忆的主通道就此堵死）。
 */

import { TEST_COMMAND_PATTERN } from './contextClassification';

export interface GateMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  promptContent?: string;
  synthetic?: boolean;
  hidden?: boolean;
  workMode?: string;
  /** checkpoint 消息等合成内容不带素材价值。 */
  contextCheckpoint?: unknown;
  toolInvocations?: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    status: string;
    error?: string;
  }>;
}

export interface TurnMemorySignals {
  /** 用户显式记忆意图（记住/以后都/please remember…）。 */
  cue: boolean;
  /** 用户表达的持久禁令（不要再用/never again…；普通「必须/always」不算）。 */
  constraint: boolean;
  /** 本轮验证成功的测试/构建命令（取第一条，用于素材注记）。 */
  verifiedCommand: string | null;
  /** assistant 最终答复出现「记忆候选」标记：Agent 主动提议长期事实。 */
  agentProposal: boolean;
}

const CUE_PATTERN =
  /记住|请记住|记得|以后都|往后都|下次请|都统一|一律|please remember|remember (that|this|to)|from now on|always use|never use|must use/i;
/** 持久禁令（行为约定）。普通模态词（必须/务必/不得/只能/不准/must/forbidden/
 *  always）故意不在此列：日常任务指令高频命中 = 每回合误触 curator（费 token
 *  + 前缀缓存抖动）。兜底由压缩前卡点（无条件）承担。 */
const CONSTRAINT_CUE_PATTERN =
  /不要再用|禁止使用|永久禁止|never\s+(?:use|do)\b[^.!?\n]{0,40}\bagain\b/i;
/** Agent 主动提议标记：与 promptSystem 的项目记忆指令同一约定。 */
const AGENT_PROPOSAL_PATTERN =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:记忆候选|記憶候選|memory candidate)\s*[:：]/i;

export function detectTurnMemorySignals(messages: readonly GateMessage[]): TurnMemorySignals {
  let cue = false;
  let constraint = false;
  let agentProposal = false;
  let verifiedCommand: string | null = null;
  for (const message of messages) {
    if (
      message.role === 'user' &&
      !message.synthetic &&
      !message.hidden &&
      !message.contextCheckpoint
    ) {
      const text = message.promptContent ?? message.content ?? '';
      if (CUE_PATTERN.test(text)) cue = true;
      if (CONSTRAINT_CUE_PATTERN.test(text)) constraint = true;
    }
    if (
      message.role === 'assistant' &&
      !message.synthetic &&
      !message.hidden &&
      !message.contextCheckpoint &&
      message.workMode !== 'ask' &&
      message.content &&
      !agentProposal
    ) {
      if (AGENT_PROPOSAL_PATTERN.test(message.content)) {
        agentProposal = true;
      }
    }
    if (message.role === 'assistant' && !verifiedCommand) {
      for (const invocation of message.toolInvocations ?? []) {
        if (invocation.name !== 'bash' || invocation.status !== 'success' || invocation.error) continue;
        const command =
          typeof invocation.arguments?.command === 'string' ? invocation.arguments.command : '';
        if (command && TEST_COMMAND_PATTERN.test(command)) {
          verifiedCommand = command.slice(0, 120);
          break;
        }
      }
    }
  }
  return { cue, constraint, verifiedCommand, agentProposal };
}

export function shouldRunDeliveryCurator(signals: TurnMemorySignals): boolean {
  return (
    signals.cue ||
    signals.constraint ||
    signals.agentProposal ||
    signals.verifiedCommand !== null
  );
}

/**
 * 交付卡点素材：本轮（含 goal 多迭代）的用户原话 + 最终 assistant 文本。
 * 用户消息截 1000 字、最终文本截 1500 字——curator 只需要结论层信息。
 */
export function buildTurnMaterial(messages: readonly GateMessage[]): string {
  const lines: string[] = [];
  const realUsers = messages.filter(
    (m) => m.role === 'user' && !m.synthetic && !m.hidden && !m.contextCheckpoint && m.content.trim()
  );
  const lastUser = realUsers[realUsers.length - 1];
  if (lastUser) {
    const text = (lastUser.promptContent ?? lastUser.content).replace(/\s+/g, ' ').trim();
    lines.push(`User: ${text.slice(0, 1000)}`);
  }
  const finals = messages.filter(
    (m) =>
      m.role === 'assistant' &&
      !m.synthetic &&
      !m.hidden &&
      !m.contextCheckpoint &&
      m.content.trim() &&
      m.workMode !== 'ask'
  );
  for (const final of finals.slice(-2)) {
    const text = final.content.replace(/\s+/g, ' ').trim();
    lines.push(`Assistant: ${text.slice(0, 1500)}`);
  }
  return lines.join('\n');
}

/** 压缩卡点素材：v4 骨架行（[第 n 轮] Q/A）+ 轮内活动行，已是最高密度形式。 */
export interface SkeletonLike {
  userId: string;
  q: string;
  a: string;
  droppedToolCalls?: number;
}

export function buildSkeletonMaterial(
  skeleton: readonly SkeletonLike[],
  options?: { activityText?: string; summaryBlock?: string }
): string {
  const lines: string[] = [];
  if (options?.summaryBlock?.trim()) {
    lines.push('（更早历史的既有摘要，供合并参考）');
    lines.push(options.summaryBlock.trim().slice(0, 1500));
  }
  skeleton.forEach((entry, index) => {
    lines.push(`[轮次 ${index + 1}] User: ${entry.q.slice(0, 400)}`);
    lines.push(`Assistant: ${entry.a.slice(0, 600)}`);
  });
  if (options?.activityText?.trim()) {
    lines.push('（本轮内步骤）');
    lines.push(options.activityText.trim().slice(0, 800));
  }
  return lines.join('\n');
}
