/**
 * 流停滞/重连诊断落盘。
 *
 * 流空闲超时、重连、无输出等待此前只存在于内存状态里：sidecar 的日志经
 * codepapr-server 转发后落进 app 的 /dev/null，事故后无法确认「是否真的
 * 触发过超时重连、等了多久、最终有没有恢复」。这里把每次重连事件与最终
 * 恢复结果写入 .CodePapr/logs/stream-stall-<messageId>.log（与
 * agent-worker-crash-*.log 同目录同模式）。
 *
 * 每个消息一个文件、每次重连覆盖为累计快照：故障风暴下不会产生海量文件，
 * 文件内容始终是最新的重试次数 / 最长等待 / 首次停滞时间。best-effort，
 * 写入失败不影响对话。
 */

export interface StreamStallRecord {
  /** 本回合观察到的最长无真实输出等待（毫秒） */
  maxWaitMs: number;
  /** 本回合流层重连次数（stream-restart / request-retry） */
  retries: number;
  /** 首次出现停滞/重连的时间（epoch ms），0 = 尚未发生 */
  firstStallAt: number;
}

export interface StreamStallLogInput {
  workspacePath: string;
  sessionId: string;
  messageId: string;
  modelName?: string;
  modelTier?: string;
  /** retry = 正在重连；recovered = 重连后该轮成功收尾 */
  outcome: 'retry' | 'recovered';
  /** outcome=retry 时的重连类型 */
  event?: 'stream-restart' | 'request-retry';
  attempt?: number;
  maxRetries?: number;
  maxWaitMs: number;
  retries: number;
  firstStallAt: number;
  /** outcome=recovered：该轮最终耗时（含重连等待） */
  roundDurationMs?: number;
}

const records = new Map<string, StreamStallRecord>();

/** stream-wait 事件：记录该消息的最长无输出等待。 */
export function noteStreamWait(messageId: string, waitMs: number): void {
  const record = records.get(messageId) ?? { maxWaitMs: 0, retries: 0, firstStallAt: 0 };
  if (waitMs > record.maxWaitMs) {
    record.maxWaitMs = waitMs;
  }
  if (record.firstStallAt === 0) {
    record.firstStallAt = Date.now();
  }
  records.set(messageId, record);
}

/** stream-restart / request-retry 事件：重连计数 +1，返回最新快照。 */
export function noteStreamRetry(messageId: string): StreamStallRecord {
  const record = records.get(messageId) ?? { maxWaitMs: 0, retries: 0, firstStallAt: 0 };
  record.retries += 1;
  if (record.firstStallAt === 0) {
    record.firstStallAt = Date.now();
  }
  records.set(messageId, record);
  return { ...record };
}

export function readStreamStallRecord(messageId: string): StreamStallRecord | undefined {
  const record = records.get(messageId);
  return record ? { ...record } : undefined;
}

export function clearStreamStallRecord(messageId: string): void {
  records.delete(messageId);
}

/** 日志正文：纯函数，便于测试。 */
export function buildStreamStallLogText(input: StreamStallLogInput, now = new Date()): string {
  const lines = [
    `time: ${now.toISOString()}`,
    `outcome: ${input.outcome}`,
    `sessionId: ${input.sessionId}`,
    `messageId: ${input.messageId}`,
    `model: ${input.modelName ?? 'n/a'}${input.modelTier ? ` (${input.modelTier})` : ''}`,
    `retriesThisRound: ${input.retries}`,
    `maxNoOutputWaitMs: ${input.maxWaitMs}`,
    `firstStallAt: ${input.firstStallAt > 0 ? new Date(input.firstStallAt).toISOString() : 'n/a'}`,
  ];
  if (input.outcome === 'retry') {
    lines.push(
      `event: ${input.event ?? 'n/a'}`,
      `attempt: ${input.attempt ?? 'n/a'}`,
      `maxRetries: ${input.maxRetries ?? 'unlimited'}`
    );
  } else if (typeof input.roundDurationMs === 'number') {
    lines.push(`roundDurationMs: ${input.roundDurationMs}`);
  }
  return `${lines.join('\n')}\n`;
}

/** best-effort 写入 .CodePapr/logs/stream-stall-<messageId>.log（覆盖为累计快照）。 */
export async function writeStreamStallLog(input: StreamStallLogInput): Promise<void> {
  if (!input.workspacePath) {
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const now = new Date();
    await invoke('write_text_file', {
      workspacePath: input.workspacePath,
      relativePath: `.CodePapr/logs/stream-stall-${input.messageId}.log`,
      content: buildStreamStallLogText(input, now),
    });
  } catch {
    // best-effort only — 诊断写入失败不得影响对话
  }
}
