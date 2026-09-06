import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  registerAppPoster,
  postAppEvent,
  flushPendingAppEvents,
  clearAppPosters,
  type AppChannelEnvelope,
} from './appChannelHub';

const event = { channel: 'cards', seq: 1, ts: 123, payload: { op: 'add' } };

describe('appChannelHub', () => {
  beforeEach(() => {
    clearAppPosters();
  });

  it('无挂载实例时 postAppEvent 返回 false', () => {
    expect(postAppEvent('no-such-app', event)).toBe(false);
  });

  it('注册后广播信封（papr://event + payload）', () => {
    const received: AppChannelEnvelope[] = [];
    registerAppPoster('kanban', (envelope) => received.push(envelope));

    expect(postAppEvent('kanban', event)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ __papr: true, type: 'papr://event', payload: event });
  });

  it('不同 appId 互不串扰', () => {
    const received: AppChannelEnvelope[] = [];
    registerAppPoster('app-a', (envelope) => received.push(envelope));

    postAppEvent('app-b', event);
    expect(received).toHaveLength(0);
    postAppEvent('app-a', event);
    expect(received).toHaveLength(1);
  });

  it('注销函数移除 poster；最后一个移除后回到未挂载', () => {
    const received: AppChannelEnvelope[] = [];
    const unregister = registerAppPoster('kanban', (envelope) => received.push(envelope));

    unregister();
    expect(postAppEvent('kanban', event)).toBe(false);
    expect(received).toHaveLength(0);
  });

  it('同一 app 多个实例全部收到广播', () => {
    const a: AppChannelEnvelope[] = [];
    const b: AppChannelEnvelope[] = [];
    registerAppPoster('kanban', (envelope) => a.push(envelope));
    registerAppPoster('kanban', (envelope) => b.push(envelope));

    postAppEvent('kanban', event);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('单个 poster 抛错不影响其他订阅者', () => {
    const received: AppChannelEnvelope[] = [];
    registerAppPoster('kanban', () => {
      throw new Error('iframe gone');
    });
    registerAppPoster('kanban', (envelope) => received.push(envelope));

    expect(postAppEvent('kanban', event)).toBe(true);
    expect(received).toHaveLength(1);
  });

  describe('未挂载事件排队与 app-ready 冲刷（挂载竞态缓冲）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function eventN(seq: number): typeof event {
      return { ...event, seq };
    }

    it('无挂载实例时入队，flush 按序补发并清空', () => {
      expect(postAppEvent('kanban', eventN(1))).toBe(false);
      expect(postAppEvent('kanban', eventN(2))).toBe(false);

      const received: AppChannelEnvelope[] = [];
      expect(flushPendingAppEvents('kanban', (e) => received.push(e))).toBe(2);
      expect(received.map((e) => e.payload.seq)).toEqual([1, 2]);

      const second: AppChannelEnvelope[] = [];
      expect(flushPendingAppEvents('kanban', (e) => second.push(e))).toBe(0);
      expect(second).toHaveLength(0);
    });

    it('超过 TTL 的排队事件被丢弃且清空', () => {
      postAppEvent('kanban', eventN(1));
      vi.advanceTimersByTime(30_001);

      const received: AppChannelEnvelope[] = [];
      expect(flushPendingAppEvents('kanban', (e) => received.push(e))).toBe(0);
      expect(received).toHaveLength(0);
    });

    it('有挂载实例时直接广播、不入队（热重载文档不会被二次投递）', () => {
      registerAppPoster('kanban', () => {});
      expect(postAppEvent('kanban', eventN(1))).toBe(true);
      expect(flushPendingAppEvents('kanban', () => {})).toBe(0);
    });

    it('队列按 app 隔离，条数封顶保留最新', () => {
      for (let i = 1; i <= 40; i += 1) postAppEvent('kanban', eventN(i));
      postAppEvent('other', eventN(1));

      const received: AppChannelEnvelope[] = [];
      expect(flushPendingAppEvents('kanban', (e) => received.push(e))).toBe(32);
      expect(received[0]?.payload.seq).toBe(9);
      expect(received[31]?.payload.seq).toBe(40);

      const other: AppChannelEnvelope[] = [];
      expect(flushPendingAppEvents('other', (e) => other.push(e))).toBe(1);
    });
  });
});
