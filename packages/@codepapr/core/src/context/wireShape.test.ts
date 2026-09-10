import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { Serializer } from '../cache/Serializer';
import {
  IMAGE_WIRE_TOKEN_WEIGHT,
  clearConsumedImageData,
  describeLogWireMeta,
  measureLogWireFootprint,
  stripConsumedImages,
} from './wireShape';

const BIG_BASE64 = 'A'.repeat(400_000);

function userMsg(content: string, id = 'u1', images?: IMessage['images']): IMessage {
  return { id, role: 'user', content, timestamp: 1, ...(images ? { images } : {}) };
}
function assistantMsg(content: string, id = 'a1'): IMessage {
  return { id, role: 'assistant', content, timestamp: 1 };
}
function toolMsg(content: string, id = 't1', summary?: string): IMessage {
  return {
    id,
    role: 'tool',
    content,
    timestamp: 1,
    toolResult: { toolCallId: id, success: true, result: content },
    ...(summary !== undefined
      ? { metadata: { toolSummary: summary } }
      : {}),
  };
}

function footprintOf(messages: IMessage[]) {
  return measureLogWireFootprint(messages.map((m) => describeLogWireMeta(m)));
}

describe('measureLogWireFootprint：图片只按上线形态计费', () => {
  const imageMessage = userMsg('[Image from tool read_image]', 'u-img', [
    { mediaType: 'image/png', data: BIG_BASE64, path: 'shots/a.png' },
  ]);

  it('未消费的图片按 vision 权重计费，base64 字节不进字节口径', () => {
    const footprint = footprintOf([imageMessage]);
    expect(footprint.wireBytes).toBeLessThan(2_000);
    expect(footprint.imageTokens).toBe(IMAGE_WIRE_TOKEN_WEIGHT);
    expect(footprint.offWireImageBytes).toBe(0);
    // 旧口径（logBytes）会把整段 base64 当上下文
    expect(footprint.logBytes).toBeGreaterThan(400_000);
  });

  it('assistant 回复之后，图片彻底不占上线体量（死数据）', () => {
    const footprint = footprintOf([imageMessage, assistantMsg('看完')]);
    expect(footprint.imageTokens).toBe(0);
    expect(footprint.offWireImageBytes).toBeGreaterThan(400_000);
    expect(footprint.wireBytes).toBeLessThan(2_000);
  });

  it('连续多条未消费图片只保留最后一条（与 stripConsumedImages 同规则）', () => {
    const first = userMsg('[Image 1]', 'u-a', [
      { mediaType: 'image/png', data: BIG_BASE64, path: 'shots/1.png' },
    ]);
    const second = userMsg('[Image 2]', 'u-b', [
      { mediaType: 'image/png', data: BIG_BASE64, path: 'shots/2.png' },
    ]);
    const footprint = footprintOf([first, second]);
    expect(footprint.imageTokens).toBe(IMAGE_WIRE_TOKEN_WEIGHT);
    expect(footprint.offWireImageBytes).toBeGreaterThan(400_000);
  });

  it('data 为空的持久化骨架不计费（provider 会过滤掉）', () => {
    const skeleton = userMsg('[Image]', 'u-s', [
      { mediaType: 'image/png', data: '', path: 'shots/a.png' },
    ]);
    expect(footprintOf([skeleton]).imageTokens).toBe(0);
  });
});

describe('measureLogWireFootprint：旧工具结果按冻结摘要计费', () => {
  it('最新一批保持全文，其余按摘要', () => {
    const big = 'x'.repeat(200_000);
    const old = toolMsg(big, 't-old', '摘要');
    const latestAssistant: IMessage = {
      id: 'a2',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ id: 't-new', name: 'read', arguments: {} }],
    };
    const latest = toolMsg(big, 't-new', '摘要');
    const footprint = footprintOf([old, assistantMsg('中间'), latestAssistant, latest]);
    // 旧的一条省下 ~200KB；最新一条不省
    expect(footprint.summarySavingsBytes).toBeGreaterThanOrEqual(190_000);
    expect(footprint.summarySavingsBytes).toBeLessThan(400_000);
  });

  it('无冻结摘要的工具结果原样计入', () => {
    const full = toolMsg('y'.repeat(50_000), 't-full');
    const footprint = footprintOf([full]);
    expect(footprint.summarySavingsBytes).toBe(0);
    expect(footprint.wireBytes).toBeGreaterThan(50_000);
  });
});

describe('stripConsumedImages / clearConsumedImageData', () => {
  it('请求副本只保留最后一条未消费图片', () => {
    const a = userMsg('[i]', 'u-a', [{ mediaType: 'image/png', data: 'AAA' }]);
    const b = userMsg('[i]', 'u-b', [{ mediaType: 'image/png', data: 'BBB' }]);
    const stripped = stripConsumedImages([a, b]);
    expect(stripped[0]!.images).toBeUndefined();
    expect(stripped[1]!.images).toEqual(b.images);
  });

  it('epoch 重写时清掉死 base64，保留 path 与仍在线的那张', () => {
    const dead = userMsg('[i]', 'u-dead', [
      { mediaType: 'image/png', data: BIG_BASE64, path: 'shots/dead.png' },
    ]);
    const live = userMsg('[i]', 'u-live', [
      { mediaType: 'image/png', data: 'LIVE', path: 'shots/live.png' },
    ]);
    const cleared = clearConsumedImageData([dead, assistantMsg('答'), live]);
    expect(cleared[0]!.images?.[0]?.data).toBe('');
    expect(cleared[0]!.images?.[0]?.path).toBe('shots/dead.png');
    expect(cleared[2]!.images?.[0]?.data).toBe('LIVE');
  });

  it('无需清理时返回同一数组引用（不触发重建）', () => {
    const messages = [userMsg('普通输入'), assistantMsg('答案')];
    expect(clearConsumedImageData(messages)).toBe(messages);
  });

  it('wireBytes 与 totalBytes 口径一致（复用同一次序列化）', () => {
    const msg = userMsg('hello 世界');
    const meta = describeLogWireMeta(msg, Serializer.stringify(msg));
    expect(meta.bytes).toBe(Serializer.getByteLength(msg));
  });
});

describe('measureLogWireFootprint：阶段归属（预算分解用）', () => {
  it('bootstrap / checkpoint / 最后一条 user 各自计入自己的分区', () => {
    const bootstrap: IMessage = {
      id: 'bootstrap',
      role: 'assistant',
      content: 'memory ledger',
      timestamp: 1,
      metadata: { sessionBootstrap: true },
    };
    const checkpoint: IMessage = {
      id: 'cp',
      role: 'user',
      content: 'checkpoint summary',
      timestamp: 1,
      metadata: { contextCheckpoint: true },
    };
    const lastUser = userMsg('用户的问题');
    const footprint = footprintOf([bootstrap, assistantMsg('历史'), checkpoint, lastUser]);
    expect(footprint.bootstrapBytes).toBeGreaterThan(0);
    expect(footprint.checkpointBytes).toBeGreaterThan(0);
    expect(footprint.lastUserBytes).toBeGreaterThan(0);
    expect(footprint.lastUserHoldsLiveImages).toBe(false);
    expect(
      footprint.bootstrapBytes + footprint.checkpointBytes + footprint.lastUserBytes
    ).toBeLessThan(footprint.wireBytes);
  });

  it('最后一条 user 就是在线图片消息时，图片 token 归它', () => {
    const imageUser = userMsg('[Image from tool read_image]', 'u-img', [
      { mediaType: 'image/png', data: BIG_BASE64, path: 'shots/a.png' },
    ]);
    const footprint = footprintOf([assistantMsg('历史'), imageUser]);
    expect(footprint.lastUserHoldsLiveImages).toBe(true);
    expect(footprint.imageTokens).toBe(IMAGE_WIRE_TOKEN_WEIGHT);
  });
});
