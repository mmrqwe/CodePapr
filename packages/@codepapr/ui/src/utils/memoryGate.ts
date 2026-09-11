/**
 * memoryGate（v5）：交付卡点的「双信号门」与 curator 素材构造（纯函数）。
 *
 * 门只决定「要不要问 curator」，不决定「记什么」——判断内容永远是 curator。
 * 两个信号（都零 LLM，沿用账本时代的启发式）：
 *   A 线索词：本轮用户消息出现「记住/以后都/必须/禁止…」类强信号；
 *   B 工作事件：本轮出现验证成功的测试/构建命令（[bash] ✓）。
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
  /** 用户线索词命中（记住/以后都/必须/禁止…）。 */
  cue: boolean;
  /** 本轮验证成功的测试/构建命令（取第一条，用于素材注记）。 */
  verifiedCommand: string | null;
}

const CUE_PATTERN =
  /记住|请记住|记得|以后都|往后都|下次请|都统一|一律|please remember|remember (that|this|to)|from now on|always use|never use|must use/i;
const CONSTRAINT_CUE_PATTERN =
  /必须|务必|禁止|不得|只能|不准|不要再用|一律|must|forbidden|never again|always/i;

export function detectTurnMemorySignals(messages: readonly GateMessage[]): TurnMemorySignals {
  let cue = false;
  let verifiedCommand: string | null = null;
  for (const message of messages) {
    if (
      message.role === 'user' &&
      !message.synthetic &&
      !message.hidden &&
      !message.contextCheckpoint
    ) {
      const text = message.promptContent ?? message.content ?? '';
      if (CUE_PATTERN.test(text) || CONSTRAINT_CUE_PATTERN.test(text)) cue = true;
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
  return { cue, verifiedCommand };
}

export function shouldRunDeliveryCurator(signals: TurnMemorySignals): boolean {
  return signals.cue || signals.verifiedCommand !== null;
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
