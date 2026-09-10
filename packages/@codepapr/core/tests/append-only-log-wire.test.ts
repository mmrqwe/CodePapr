/**
 * wire 计量的 log 侧不变式：AppendOnlyLog 增量维护的计量必须与 totalBytes /
 * 快照 / pop 保持一致，且 Session.replaceLog（epoch 重写）要把已经不再上线的
 * 图片 base64 清出内存。
 */
import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { AppendOnlyLog, ImmutablePrefix, Session, ToolRegistry } from '../src';

const BIG_BASE64 = 'iVBORw0KGgo'.repeat(30_000); // ~180KB

function imageMessage(id: string, data = BIG_BASE64): IMessage {
  return {
    id,
    role: 'user',
    content: '[Image from tool read_image]',
    timestamp: 1,
    images: [{ mediaType: 'image/png', data, path: `.CodePapr/screenshots/${id}.png` }],
  };
}

function textMessage(id: string, role: IMessage['role'], content: string): IMessage {
  return { id, role, content, timestamp: 1 };
}

describe('AppendOnlyLog.getWireFootprint', () => {
  it('与 getContentBytes 在同一口径下自洽（logBytes === totalBytes）', async () => {
    const log = new AppendOnlyLog('wire-1');
    await log.append(textMessage('u1', 'user', '问题'));
    await log.append(imageMessage('img1'));
    await log.append(textMessage('a1', 'assistant', '看过'));
    expect(log.getWireFootprint().logBytes).toBe(log.getContentBytes());
    expect(log.getWireFootprint().wireBytes).toBeLessThan(log.getContentBytes());
  });

  it('pop / truncateTo 之后计量仍然一致', async () => {
    const log = new AppendOnlyLog('wire-2');
    await log.append(textMessage('u1', 'user', '问题'));
    await log.append(imageMessage('img1'));
    await log.append(textMessage('a1', 'assistant', '看过'));
    log.popLastMessage();
    expect(log.getWireFootprint().logBytes).toBe(log.getContentBytes());
    // 现在最后一条图片仍未被消费 → 按 vision 权重计费而不是字节
    const footprint = log.getWireFootprint();
    expect(footprint.imageTokens).toBeGreaterThan(0);
    expect(footprint.wireBytes).toBeLessThan(footprint.logBytes);
    log.truncateTo(1);
    expect(log.getWireFootprint().logBytes).toBe(log.getContentBytes());
  });

  it('快照 round-trip 保留计量（loadFromSnapshot 重建 metas）', async () => {
    const log = new AppendOnlyLog('wire-3');
    await log.append(textMessage('u1', 'user', '问题'));
    await log.append(imageMessage('img1'));
    await log.append(textMessage('a1', 'assistant', '看过'));
    const snapshot = log.createSnapshot();
    const restored = new AppendOnlyLog('wire-3-restored');
    restored.loadFromSnapshot(snapshot);
    expect(restored.getWireFootprint()).toEqual(log.getWireFootprint());
    expect(restored.validate()).toBe(true);
  });
});

describe('Session.replaceLog：死图片 base64 出清（B）', () => {
  function makeSession(): Session {
    const toolRegistry = new ToolRegistry();
    return new Session({
      sessionId: 'replace-log',
      prefix: new ImmutablePrefix({
        systemPrompt: '测试',
        tools: [],
        model: 'test-model',
        parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
      }),
      toolRegistry,
    });
  }

  it('已被回复消费的图片只保留 path，仍在线的那张保留 data', async () => {
    const session = makeSession();
    await session.logStore.append(textMessage('u1', 'user', '开始'));
    session.replaceLog([
      textMessage('u1', 'user', '开始'),
      imageMessage('img-dead'),
      textMessage('a1', 'assistant', '看过'),
      imageMessage('img-live'),
    ]);
    const messages = session.logStore.getAllMessages();
    expect(messages[1]!.images?.[0]?.data).toBe('');
    expect(messages[1]!.images?.[0]?.path).toBe('.CodePapr/screenshots/img-dead.png');
    expect(messages[3]!.images?.[0]?.data).toBe(BIG_BASE64);
    // 内存里死数据已清 → log 全量字节也降下来了（不只是 wire 口径）
    expect(session.logStore.getContentBytes()).toBeLessThan(BIG_BASE64.length * 2);
    expect(session.logStore.validate()).toBe(true);
  });

  it('无图片时 replaceLog 行为不变（同一份内容、计量一致）', () => {
    const session = makeSession();
    session.replaceLog([textMessage('u1', 'user', '开始'), textMessage('a1', 'assistant', '好')]);
    expect(session.logStore.length()).toBe(2);
    expect(session.logStore.getWireFootprint().logBytes).toBe(session.logStore.getContentBytes());
  });
});
