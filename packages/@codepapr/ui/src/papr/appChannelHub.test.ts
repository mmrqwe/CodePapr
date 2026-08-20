import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerAppPoster,
  postAppEvent,
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
});
