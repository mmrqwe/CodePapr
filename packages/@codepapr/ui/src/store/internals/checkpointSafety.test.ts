import { describe, expect, it } from 'vitest';
import { isSafeCheckpointInsert } from './sendMessage';
import type { UIMessage } from './types';

function msg(id: string): UIMessage {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: 1,
  } as UIMessage;
}

describe('isSafeCheckpointInsert（#15 checkpoint 插入基座校验）', () => {
  it('同一数组引用直接放行', () => {
    const base = [msg('a'), msg('b')];
    expect(isSafeCheckpointInsert(base, base, 1)).toBe(true);
  });

  it('基座不变（内容逐项相同）时允许插入', () => {
    const a = msg('a');
    const b = msg('b');
    expect(isSafeCheckpointInsert([a, b], [a, b], 1)).toBe(true);
  });

  it('压缩期间追加消息（尾部增长）仍安全', () => {
    const a = msg('a');
    const b = msg('b');
    expect(isSafeCheckpointInsert([a, b], [a, b, msg('c')], 1)).toBe(true);
  });

  it('压缩期间清空会话（长度变短）必须拒绝', () => {
    const a = msg('a');
    const b = msg('b');
    expect(isSafeCheckpointInsert([a, b], [], 1)).toBe(false);
  });

  it('压缩期间 reset 截断（长度变短）必须拒绝', () => {
    const a = msg('a');
    const b = msg('b');
    const c = msg('c');
    expect(isSafeCheckpointInsert([a, b, c], [a], 2)).toBe(false);
  });

  it('insertIndex 之前的消息被替换（reset 重建）必须拒绝', () => {
    const a = msg('a');
    const b = msg('b');
    // 长度相同但前缀对象不同（如 reset 后重建的消息）
    expect(isSafeCheckpointInsert([a, b], [msg('a2'), b], 1)).toBe(false);
  });

  it('insertIndex 为 0 时任何非缩短变化都安全（检查空前缀）', () => {
    const a = msg('a');
    expect(isSafeCheckpointInsert([a], [msg('x'), msg('y')], 0)).toBe(true);
  });

  it('base/current 缺失时拒绝', () => {
    const a = msg('a');
    expect(isSafeCheckpointInsert(undefined, [a], 0)).toBe(false);
    expect(isSafeCheckpointInsert([a], undefined, 0)).toBe(false);
  });

  it('insertIndex 越界时按 base 长度钳制校验', () => {
    const a = msg('a');
    const b = msg('b');
    expect(isSafeCheckpointInsert([a, b], [a, b], 99)).toBe(true);
    expect(isSafeCheckpointInsert([a, b], [msg('x'), b], 99)).toBe(false);
  });
});
