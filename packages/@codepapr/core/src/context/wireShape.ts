/**
 * Wire shape：估算「实际会随请求上线的字节」，而不是 log 的全量字节。
 *
 * log 里有两类内容永远不再上行（RequestBuilder.build 在发送前对请求副本改写）：
 *  1. 已被消费的图片 base64——`stripConsumedImages` 只保留「最后一条未被
 *     assistant 回复消费」的图片消息，其余整段 base64 从请求副本里剥离；但
 *     AppendOnlyLog 的 totalBytes 永久记着它们（一张 read_image 截图就是数百
 *     KB base64）。
 *  2. 「最新一批」之外的工具全文——`applyHistoryToolSummaries` 在请求副本里把
 *     它们换成写入时冻结的摘要；log 里仍是全文。
 *
 * 预算决策若按 log 全量字节估算，会把这两块永久计入，系统性高估一个数量级：
 * 每轮都判定「超硬预算 → compact」，而压缩计划本身看不见图片（只按
 * role+content 估），于是「纸面缩容」通过无效缩容校验 → 提交 → 下一轮仍然
 * 「超预算」→ 压缩风暴（每几分钟毁掉一次上下文纪元）。
 *
 * 本模块是这条规则的唯一事实源：AppendOnlyLog 在 append 时记录每条消息的 wire
 * 元数据（一次序列化，不进热路径），`getWireFootprint()` 只做算术；Agent 的
 * round-start 预算与 UI 的缩容判定统一使用 wire 口径。
 *
 * 图片按「实际上线时真正消耗的 vision token」计价，而不是 base64 字节/4：
 * 主流 provider 的一张截图约 1~2K token（OpenAI high-detail ≈765~1105、
 * Claude ≈1.6 token/千像素² 量级），与 base64 体积无关；`data` 为空的图片
 * （仅 path 骨架，provider 侧会被过滤）不计费。
 */

import { IMessage, IToolCall } from '@codepapr/types';
import { Serializer } from '../cache/Serializer';
import { TOOL_SUMMARY_METADATA_KEY } from '../tool/toolOutputSummary';

/** 一张实际进入请求的图片按多少 token 计价（vision 口径，与 base64 体积无关）。 */
export const IMAGE_WIRE_TOKEN_WEIGHT = 2048;

/** 每条 log 消息的 wire 计量（在 append 时一次性算好，之后只做算术）。 */
export interface LogWireMeta {
  /** 整条消息的序列化字节（与 AppendOnlyLog.totalBytes 同口径）。 */
  bytes: number;
  role: IMessage['role'];
  /** images 字段（含数组括号与键名）占用的字节——从字节口径里扣除。 */
  imageBytes: number;
  hasImages: boolean;
  /** 该消息若成为「唯一未被消费」的图片消息，实际计费的 vision token。 */
  imageWireTokens: number;
  /** 该工具结果被冻结摘要替换时可省下的字节（0 = 无摘要 / 摘要不更短）。 */
  summarySavingsBytes: number;
  hasToolCalls: boolean;
  /** 预算分解阶段归属（与 Agent.computeBudgetBreakdown 的 7 阶段口径一致）。 */
  stage: 'bootstrap' | 'checkpoint' | 'other';
}

export interface LogWireFootprint {
  /** log 全量字节（旧口径，仅用于诊断对比）。 */
  logBytes: number;
  /** 实际会随请求上线的字节（不含任何图片 base64）。 */
  wireBytes: number;
  /** 图片按 vision 口径计的 token（只算最后一条未消费图片消息）。 */
  imageTokens: number;
  /** 因摘要替换而不上线的字节。 */
  summarySavingsBytes: number;
  /** 因已消费而不再上行的图片 base64 字节。 */
  offWireImageBytes: number;
  /** Session Bootstrap（memory / skills / project-graph）的上线字节。 */
  bootstrapBytes: number;
  /** 上下文检查点摘要的上线字节。 */
  checkpointBytes: number;
  /** 最后一条 user 消息的上线字节（不含图片 base64）。 */
  lastUserBytes: number;
  /** 最后一条 user 消息是否就是仍在线的那条图片消息（图片 token 归属它）。 */
  lastUserHoldsLiveImages: boolean;
}

/** 把一条消息折算成 wire 计量。会做 1~3 次确定性序列化，只在 append 时调用。 */
export function describeLogWireMeta(message: IMessage, serialized?: string): LogWireMeta {
  const bytes =
    serialized === undefined
      ? Serializer.getByteLength(message)
      : new TextEncoder().encode(serialized).length;
  const images = message.images ?? [];
  let imageBytes = 0;
  let imageWireTokens = 0;
  if (images.length > 0) {
    imageBytes = Math.max(0, bytes - Serializer.getByteLength({ ...message, images: undefined }));
    imageWireTokens =
      images.filter((image) => Boolean(image.data)).length * IMAGE_WIRE_TOKEN_WEIGHT;
  }

  let summarySavingsBytes = 0;
  if (message.role === 'tool' && message.toolResult) {
    const summary = message.metadata?.[TOOL_SUMMARY_METADATA_KEY];
    if (typeof summary === 'string') {
      const shapedBytes = Serializer.getByteLength({
        ...message,
        content: summary,
        toolResult: { ...message.toolResult, result: summary },
      });
      summarySavingsBytes = Math.max(0, bytes - shapedBytes);
    }
  }

  const metadata = message.metadata ?? {};
  return {
    bytes,
    role: message.role,
    imageBytes,
    hasImages: images.length > 0,
    imageWireTokens,
    summarySavingsBytes,
    hasToolCalls: Boolean(message.toolCalls && message.toolCalls.length > 0),
    stage:
      metadata.sessionBootstrap === true
        ? 'bootstrap'
        : metadata.contextCheckpoint === true
          ? 'checkpoint'
          : 'other',
  };
}

/**
 * 按请求副本的实际形态汇总 log 的 wire 体量（纯算术，规则与
 * stripConsumedImages / applyHistoryToolSummaries 一致）。
 */
export function measureLogWireFootprint(
  metas: readonly LogWireMeta[]
): LogWireFootprint {
  let logBytes = 0;
  let imageBytesTotal = 0;
  let savingsTotal = 0;
  let bootstrapBytes = 0;
  let checkpointBytes = 0;
  for (const meta of metas) {
    logBytes += meta.bytes;
    imageBytesTotal += meta.imageBytes;
    savingsTotal += meta.summarySavingsBytes;
    if (meta.stage === 'bootstrap') {
      bootstrapBytes += meta.bytes - meta.imageBytes - meta.summarySavingsBytes;
    } else if (meta.stage === 'checkpoint') {
      checkpointBytes += meta.bytes - meta.imageBytes - meta.summarySavingsBytes;
    }
  }
  bootstrapBytes = Math.max(0, bootstrapBytes);
  checkpointBytes = Math.max(0, checkpointBytes);

  // 图片：只有「最后一条后面没有 assistant 回复」的图片消息仍在上线
  // （与请求副本的 stripConsumedImages 共用同一条规则实现）。
  const keptImageIndex = findLastUnconsumedImageIndexOf(metas);
  const keptImageMeta = keptImageIndex >= 0 ? metas[keptImageIndex]! : null;
  const keptImageBytes = keptImageMeta?.imageBytes ?? 0;
  const imageTokens = keptImageMeta?.imageWireTokens ?? 0;

  let lastUserIndex = -1;
  for (let i = metas.length - 1; i >= 0; i--) {
    if (metas[i]!.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  const lastUserMeta = lastUserIndex >= 0 ? metas[lastUserIndex]! : null;
  const lastUserBytes = lastUserMeta
    ? Math.max(0, lastUserMeta.bytes - lastUserMeta.imageBytes)
    : 0;

  // 工具摘要：最后一条带 toolCalls 的 assistant 之后的那一批保持全文。
  let protectedSavings = 0;
  for (let i = metas.length - 1; i >= 0; i--) {
    const meta = metas[i]!;
    if (meta.role === 'assistant' && meta.hasToolCalls) break;
    protectedSavings += meta.summarySavingsBytes;
  }

  // 图片一律不按字节计入（在线的那张改按 vision 权重计）；offWireImageBytes 只是
  // 诊断量：其中有多少是「本来就已经不再上线」的死数据。
  const offWireImageBytes = Math.max(0, imageBytesTotal - keptImageBytes);
  const summarySavingsBytes = Math.max(0, savingsTotal - protectedSavings);
  return {
    logBytes,
    imageTokens,
    offWireImageBytes,
    summarySavingsBytes,
    bootstrapBytes,
    checkpointBytes,
    lastUserBytes,
    lastUserHoldsLiveImages:
      keptImageIndex >= 0 && lastUserIndex >= 0 && keptImageIndex === lastUserIndex,
    wireBytes: Math.max(0, logBytes - imageBytesTotal - summarySavingsBytes),
  };
}

/** 判定「哪条图片消息仍上线」所需的最小信息（消息本体或 wire 计量都满足）。 */
interface ImagePresence {
  role: IMessage['role'];
  hasImages: boolean;
}

/**
 * 「唯一仍上线」的图片消息下标：从尾部往前数，第一条后面没有 assistant 回复的
 * 图片消息（规则 2 下更早的未消费图片同样被剥离）。找不到返回 -1。
 * 这条规则只允许有一份实现——请求副本剥离、epoch 清数据、预算计量都用它。
 */
function findLastUnconsumedImageIndexOf(items: readonly ImagePresence[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.role === 'assistant') return -1;
    if (item.role === 'user' && item.hasImages) return i;
  }
  return -1;
}

export function findLastUnconsumedImageIndex(
  messages: readonly Pick<IMessage, 'role' | 'images'>[]
): number {
  return findLastUnconsumedImageIndexOf(
    messages.map((message) => ({
      role: message.role,
      hasImages: Boolean(message.images && message.images.length > 0),
    }))
  );
}

/**
 * 从请求副本里剥离已消费的图片 base64。
 *
 * 规则：
 * 1) 图片消息之后已有 assistant 回复 → 已消费，剥离图片；
 * 2) 多条「未消费」的图片消息（如连续的 user 图片消息）→ 只保留最后一条，
 *    其余剥离。旧实现对未消费的全部保留，与「仅最后一条保留」的契约不符，
 *    多份 base64 会反复膨胀请求。
 */
export function stripConsumedImages<T extends Pick<IMessage, 'role' | 'images'>>(
  messages: T[]
): T[] {
  const keep = findLastUnconsumedImageIndex(messages);
  return messages.map((msg, i) => {
    if (msg.role !== 'user' || !msg.images || msg.images.length === 0) return msg;
    if (i === keep) return msg;
    return { ...msg, images: undefined };
  });
}

/**
 * 把「不再上线」的图片消息的 base64 从消息本体里清掉（保留 mediaType/path，
 * 需要时按 path 重新 hydrate）。
 *
 * 与 stripConsumedImages 的区别：后者只改请求副本（不改 log，否则会破坏
 * append-only 哈希链与 prompt 缓存）；本函数用于 **epoch 重写**（压缩 / prune
 * 之后的 replaceLog）——那里历史本来就要重排，顺手把数百 KB 的死 base64 清出
 * 内存与快照，不额外损失任何缓存。判定与 stripConsumedImages 同一规则：仅
 * 「最后一条仍上线」的图片保留 data。
 */
export function clearConsumedImageData(messages: IMessage[]): IMessage[] {
  const keep = findLastUnconsumedImageIndex(messages);
  let changed = false;
  const result = messages.map((msg, i) => {
    if (msg.role !== 'user' || !msg.images || msg.images.length === 0) return msg;
    if (i === keep) return msg;
    if (!msg.images.some((image) => Boolean(image.data))) return msg;
    changed = true;
    return {
      ...msg,
      images: msg.images.map((image) => (image.data ? { ...image, data: '' } : image)),
    };
  });
  return changed ? result : messages;
}

/** 缺失工具结果的占位文案。与 UI 重建路径 repairOrphanedToolCalls 共用同一份
 *  常量，保证 live 与 rebuild 两条路径生成的请求字节一致。 */
export const TOOL_RESULT_MISSING_PLACEHOLDER = '[tool result missing: interrupted before completion]';
export const TOOL_RESULT_MISSING_ERROR = '工具执行中断，结果缺失';

/**
 * 保证每个 assistant `toolCalls` 消息后面紧跟每个 tool_call_id 的 tool 消息。
 *
 * 旧版本或中断路径可能在工具结果之间插入过非 tool 消息（典型：工具返回
 * `__images` 生成的 `[Image from tool ...]` user 消息），或工具结果缺失；
 * OpenAI/DeepSeek 会以 400「An assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'」拒绝整个请求。
 *
 * 保守修复（纯函数、确定性，只作用于请求副本，不写回 AppendOnlyLog）：
 *  - 在 assistant 消息之后、下一条 assistant 消息之前的区段里，按调用顺序
 *    收拢配对的 tool 消息；
 *  - 缺失的结果补失败占位；
 *  - 被打断的非 tool 消息（如工具图片 user 消息）原序移到本批 tool 消息之后。
 * 已经合法的历史原样返回（保持引用，不产生额外拷贝）。
 */
export function normalizeToolCallRuns(messages: IMessage[]): IMessage[] {
  const consumed = new Set<number>();
  const output: IMessage[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    if (consumed.has(i)) continue;
    const message = messages[i]!;
    output.push(message);
    if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
      continue;
    }

    const pending = new Set(message.toolCalls.map((call) => call.id));
    const results = new Map<string, { message: IMessage; index: number }>();
    for (let j = i + 1; j < messages.length; j += 1) {
      if (consumed.has(j)) continue;
      const candidate = messages[j]!;
      if (candidate.role === 'assistant') break;
      const toolCallId = candidate.role === 'tool' ? candidate.toolResult?.toolCallId : undefined;
      if (toolCallId && pending.has(toolCallId) && !results.has(toolCallId)) {
        results.set(toolCallId, { message: candidate, index: j });
      }
    }

    for (const call of message.toolCalls) {
      const found = results.get(call.id);
      if (found) {
        output.push(found.message);
        consumed.add(found.index);
      } else {
        output.push(buildMissingToolResult(call, message));
      }
    }
  }

  if (
    output.length === messages.length &&
    output.every((message, index) => message === messages[index])
  ) {
    return messages;
  }
  return output;
}

function buildMissingToolResult(call: IToolCall, assistantMessage: IMessage): IMessage {
  return {
    id: `${assistantMessage.id}-tool-${call.id}-placeholder`,
    role: 'tool',
    content: TOOL_RESULT_MISSING_PLACEHOLDER,
    timestamp: assistantMessage.timestamp,
    toolResult: {
      toolCallId: call.id,
      success: false,
      result: TOOL_RESULT_MISSING_PLACEHOLDER,
      error: TOOL_RESULT_MISSING_ERROR,
    },
  };
}
