import { afterEach, describe, expect, it, vi } from 'vitest';
import { Serializer } from '../src/cache/Serializer';
import { ImmutablePrefix, ImmutablePrefixFactory } from '../src/cache/ImmutablePrefix';
import { AppendOnlyLog } from '../src/cache/AppendOnlyLog';
import { VolatileScratch } from '../src/cache/VolatileScratch';
import { CachePartition } from '../src/cache/CachePartition';
import { MessageFactory } from '../src/message/Message';
import { ToolRegistry } from '../src/tool/ToolRegistry';
import { AppendOnlyViolationError, type IMessage, type IToolDefinition } from '@codepapr/types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Serializer - 确定性序列化', () => {
  it('应对相同对象产生相同字节序列 (key 排序)', () => {
    const a = { c: 3, a: 1, b: 2 };
    const b = { a: 1, b: 2, c: 3 };
    expect(Serializer.stringify(a)).toBe(Serializer.stringify(b));
  });

  it('应对嵌套对象递归排序 key', () => {
    const a = { x: { z: 1, y: 2 } };
    const b = { x: { y: 2, z: 1 } };
    expect(Serializer.stringify(a)).toBe(Serializer.stringify(b));
  });
});

describe('ImmutablePrefix - 冻结前缀', () => {
  const config = {
    systemPrompt: '你是助手',
    tools: [],
    model: 'deepseek-chat',
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2000 },
  };

  it('hash 在多次调用间保持一致', () => {
    const p = new ImmutablePrefix(config);
    expect(p.computeHash()).toBe(p.computeHash());
  });

  it('相同 config 产生相同 hash', () => {
    const p1 = new ImmutablePrefix(config);
    const p2 = new ImmutablePrefix(config);
    expect(p1.computeHash()).toBe(p2.computeHash());
  });

  it('系统提示词改变 → hash 改变', () => {
    const p1 = new ImmutablePrefix(config);
    const p2 = new ImmutablePrefix({ ...config, systemPrompt: '不同的提示' });
    expect(p1.computeHash()).not.toBe(p2.computeHash());
  });

  it('toMessageArray 返回 system 消息', () => {
    const p = new ImmutablePrefix(config);
    const msgs = p.toMessageArray();
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.timestamp).toBe(0);
    expect(msgs[0]?.metadata?.prefixHash).toBe(p.computeHash());
  });

  it('工具定义顺序不同也产生相同前缀 hash', () => {
    const searchTool: IToolDefinition = {
      name: 'search',
      description: 'Search docs',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    };
    const readTool: IToolDefinition = {
      name: 'read',
      description: 'Read file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, encoding: { type: 'string' } },
        required: ['path', 'encoding'],
      },
    };

    const p1 = new ImmutablePrefix({
      ...config,
      tools: [searchTool, readTool],
    });
    const p2 = new ImmutablePrefix({
      ...config,
      tools: [readTool, searchTool],
    });

    expect(p1.computeHash()).toBe(p2.computeHash());
    expect(p1.toJSON().tools.map((tool) => tool.name)).toEqual(['read', 'search']);
    expect(p1.toJSON().tools[0]?.parameters.required).toEqual(['encoding', 'path']);
  });

  it('保留额外模型参数', () => {
    const p = new ImmutablePrefix({
      ...config,
      parameters: {
        ...config.parameters,
        thinkingEnabled: true,
      },
    });

    expect(p.getParameters().thinkingEnabled).toBe(true);
  });

  it('字面模板示例文本默认触发 PrefixModificationError（动态内容保护）', () => {
    expect(
      () => new ImmutablePrefix({ ...config, systemPrompt: '填充 ${name} 变量' })
    ).toThrow(/dynamic content/);
    expect(
      () => new ImmutablePrefix({ ...config, systemPrompt: '使用 {{var}} 占位' })
    ).toThrow(/dynamic content/);
    expect(
      () =>
        new ImmutablePrefix({
          ...config,
          systemPrompt: '时间格式示例：2024-01-01T12:00',
        })
    ).toThrow(/dynamic content/);
  });

  it('allowTemplateLiterals 豁免字面示例文本，且 hash 保持稳定', () => {
    const literalPrompt = '示例：请把 ${name} 替换为 {{value}}，格式见 2024-01-01T12:00';
    const p1 = new ImmutablePrefix({ ...config, systemPrompt: literalPrompt, allowTemplateLiterals: true });
    const p2 = new ImmutablePrefix({ ...config, systemPrompt: literalPrompt, allowTemplateLiterals: true });
    expect(p1.computeHash()).toBe(p2.computeHash());
    expect(p1.getSystemPrompt()).toBe(literalPrompt);
  });

  it('fromJSON 透传 allowTemplateLiterals 豁免', () => {
    const literalPrompt = '字面 ${name}';
    const p = ImmutablePrefixFactory.fromJSON(
      {
        systemPrompt: literalPrompt,
        tools: [],
        fewShots: undefined,
        model: 'deepseek-chat',
        parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2000 },
      },
      { allowTemplateLiterals: true }
    );
    expect(p.getSystemPrompt()).toBe(literalPrompt);
  });
});

describe('AppendOnlyLog - 追加式日志', () => {
  it('append 后 length 增加', async () => {
    const log = new AppendOnlyLog('s1');
    await log.append(MessageFactory.user('hi'));
    expect(log.length()).toBe(1);
  });

  it('hash 在追加后改变', async () => {
    const log = new AppendOnlyLog('s1');
    await log.append(MessageFactory.user('a'));
    const h1 = log.computeHash();
    await log.append(MessageFactory.user('b'));
    expect(log.computeHash()).not.toBe(h1);
  });

  it('appendBatch 保证索引连续', async () => {
    const log = new AppendOnlyLog('s2');
    await log.appendBatch([
      MessageFactory.user('a'),
      MessageFactory.assistant('b'),
    ]);
    expect(log.length()).toBe(2);
    expect(log.validate()).toBe(true);
  });

  it('返回的消息已被冻结', async () => {
    const log = new AppendOnlyLog('s3');
    await log.append(MessageFactory.user('x'));
    const m = log.getMessageAt(0)!;
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('validate 能发现历史消息被内部改写', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const log = new AppendOnlyLog('s4');
    await log.append(MessageFactory.user('x'));

    const internals = log as unknown as { messages: IMessage[] };
    internals.messages[0] = {
      ...internals.messages[0]!,
      content: 'tampered',
    };

    expect(log.validate()).toBe(false);
  });

  it('loadFromSnapshot 会拒绝非法的恢复消息', () => {
    const log = new AppendOnlyLog('s5');

    expect(() =>
      log.loadFromSnapshot({
        messages: [
          {
            id: 'session-bootstrap',
            role: 'assistant',
            content: 'restored context',
            timestamp: 0,
          },
        ],
        lastMessageIndex: 0,
        totalBytes: 78,
      })
    ).toThrow(AppendOnlyViolationError);
  });

  it('computeHashUpTo 与全量哈希的前缀语义一致且幂等', async () => {
    const log = new AppendOnlyLog('s6');
    await log.appendBatch([
      MessageFactory.user('a'),
      MessageFactory.assistant('b'),
      MessageFactory.user('c'),
    ]);

    expect(log.computeHashUpTo(0)).toBe('');
    expect(log.computeHashUpTo(3)).toBe(log.computeHash());
    // 幂等 + 增量扩展：两次调用同值，扩展 1 条后前缀哈希与重新计算一致
    expect(log.computeHashUpTo(2)).toBe(log.computeHashUpTo(2));
    const ref = new AppendOnlyLog('s6-ref');
    await ref.appendBatch(log.getAllMessages().slice(0, 2) as IMessage[]);
    expect(log.computeHashUpTo(2)).toBe(ref.computeHash());

    await log.append(MessageFactory.assistant('d'));
    expect(log.computeHashUpTo(4)).toBe(log.computeHash());
    expect(() => log.computeHashUpTo(5)).toThrow(AppendOnlyViolationError);
  });

  it('truncateTo 裁剪尾部并保持一致性，越界抛错', async () => {
    const log = new AppendOnlyLog('s8');
    await log.appendBatch([
      MessageFactory.user('a'),
      MessageFactory.assistant('b'),
      MessageFactory.user('c'),
    ]);

    expect(() => log.truncateTo(4)).toThrow(AppendOnlyViolationError);
    log.truncateTo(2);
    expect(log.length()).toBe(2);
    expect(log.validate()).toBe(true);
    expect(log.getAllMessages().map((m) => m.content)).toEqual(['a', 'b']);
    // 裁剪后继续追加：哈希链仍自洽
    await log.append(MessageFactory.user('d'));
    expect(log.length()).toBe(3);
    expect(log.validate()).toBe(true);
  });

  it('popLastMessage 后前缀哈希记忆化失效（不会串用旧链）', async () => {
    const log = new AppendOnlyLog('s9');
    const before = [MessageFactory.user('a'), MessageFactory.assistant('b')];
    await log.appendBatch(before as IMessage[]);
    const h2 = log.computeHashUpTo(2);
    log.popLastMessage();
    await log.append(MessageFactory.user('different'));
    // 长度回到 2 但内容已变，不得复用旧的 2 条哈希
    expect(log.computeHashUpTo(2)).not.toBe(h2);
  });
});

describe('MessageFactory - API 缓存内容稳定性', () => {
  it('tool result 对象 key 顺序不同也产生相同 content', () => {
    const a = MessageFactory.tool('call-1', { b: 2, a: 1 });
    const b = MessageFactory.tool('call-1', { a: 1, b: 2 });

    expect(a.content).toBe('{"a":1,"b":2}');
    expect(a.content).toBe(b.content);
  });
});

describe('VolatileScratch - 易失存储', () => {
  it('toJSON 始终返回 null (防止序列化)', () => {
    const s = new VolatileScratch();
    s.setThinking('一些想法');
    expect(s.toJSON()).toBeNull();
    expect(JSON.parse(JSON.stringify(s))).toBeNull();
  });

  it('reset 清除状态', () => {
    const s = new VolatileScratch();
    s.setThinking('hello');
    s.reset();
    expect(s.getThinking()).toBe('');
  });
});

describe('CachePartition - 三分区容器', () => {
  it('toMessageArray 不包含 scratch', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: 's',
      tools: [],
      model: 'm',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
    });
    const log = new AppendOnlyLog('x');
    const scratch = new VolatileScratch();
    scratch.setThinking('SECRET');
    await log.append(MessageFactory.user('hi'));
    const part = new CachePartition(prefix, log, scratch);
    const serialized = JSON.stringify(part.toMessageArray());
    expect(serialized).not.toContain('SECRET');
  });
});

describe('ToolRegistry - 工具注册', () => {
  it('freeze 后无法继续注册', () => {
    const r = new ToolRegistry();
    r.register(
      { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
      () => 1
    );
    r.freeze();
    expect(() =>
      r.register(
        { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } },
        () => 2
      )
    ).toThrow();
  });

  it('hash 在工具集合相同时一致', () => {
    const r1 = new ToolRegistry();
    const r2 = new ToolRegistry();
    const tool = { name: 't', description: 'T', parameters: { type: 'object', properties: {} } };
    r1.register(tool, () => 1);
    r2.register(tool, () => 1);
    expect(r1.getHash()).toBe(r2.getHash());
  });
});
