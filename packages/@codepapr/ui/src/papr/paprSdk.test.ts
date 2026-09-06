// @vitest-environment jsdom
//
// papr-sdk.js（resources/papr-sdk.js，注入到每个 papr app 页面）的安全回归测试：
// #26 —— 无来源校验（任何窗口可伪造响应/主题）+ pending 原型污染
// （pending['__proto__'] 命中 Object.prototype，armIdleTimer 把 timer 写进原型）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SDK_SOURCE = readFileSync(
  resolve(__dirname, '../../src-tauri/resources/papr-sdk.js'),
  'utf-8',
);

function loadSdk(): void {
  // 每次重新加载前重置 window.papr（IIFE 的幂等守卫）
  delete (window as unknown as { papr?: unknown }).papr;
  // 直接加载 SDK 资源做安全回归（vitest jsdom 环境内 eval 无真实执行风险）
  eval(SDK_SOURCE);
  expect((window as unknown as { papr?: unknown }).papr).toBeDefined();
}

/** 捕获 SDK 发往父窗口的消息（db.get 等 API 返回 .then 链，promise 上没有
 *  reqId——从 postMessage 载荷取真实 reqId）。 */
function captureSentMessages(): Array<{ reqId: string; type: string }> {
  const sent: Array<{ reqId: string; type: string }> = [];
  const original = window.parent.postMessage.bind(window.parent);
  window.parent.postMessage = ((
    message: unknown,
    options?: string | WindowPostMessageOptions,
  ) => {
    const data = message as { __papr?: boolean; reqId?: string; type?: string };
    if (data?.__papr) {
      sent.push({ reqId: String(data.reqId), type: String(data.type) });
    }
    // 绕过 postMessage 重载（targetOrigin 与 options 两种签名），原样转发
    return (original as (m: unknown, o?: unknown) => void)(message, options);
  }) as typeof window.parent.postMessage;
  return sent;
}

function dispatchFrom(source: unknown, data: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', { data, source: source as Window | null }),
  );
}

// afterEach 恢复基准：旧实现只做 `postMessage.bind(window.parent)` 叠加包装，
// console 转发的测试替换时丢弃 targetOrigin 且从不还原，泄漏给后续用例
// （任何之后再调 db.get 的测试都会踩 Invalid target origin undefined）。
const pristinePostMessage = window.parent.postMessage.bind(window.parent);

afterEach(() => {
  delete (window as unknown as { papr?: unknown }).papr;
  window.parent.postMessage = pristinePostMessage;
});

describe('papr-sdk.js message source validation (#26)', () => {
  it('只接受 window.parent 发来的消息：伪造来源的响应被忽略', async () => {
    loadSdk();
    const papr = (window as unknown as { papr: { db: { get: (k: string) => Promise<unknown> } } }).papr;
    const sent = captureSentMessages();
    const pending = papr.db.get('key-1');
    const reqId = sent[0]?.reqId ?? '';
    expect(reqId).toBeTruthy();
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // 伪造来源（既不是 parent，也没有窗口引用）
    dispatchFrom({}, { __papr: true, reqId, result: 'spoofed' });
    dispatchFrom(null, { __papr: true, reqId, result: 'spoofed' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(settled).toBe(false);

    // 来自 window.parent 的真实响应正常结算
    dispatchFrom(window.parent, { __papr: true, reqId, result: 'real' });
    await expect(pending).resolves.toBe('real');
  });

  it('伪造来源的主题消息不生效', () => {
    loadSdk();
    document.documentElement.setAttribute('data-theme', 'paper-light');

    dispatchFrom({}, { __papr: true, type: 'papr://theme', payload: { dark: true } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper-light');

    // v2 payload：theme id + mode
    dispatchFrom(window.parent, {
      __papr: true,
      type: 'papr://theme',
      payload: { theme: 'nord', mode: 'dark', dark: true },
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('旧版 v1 payload（仅 dark 布尔）仍兼容：映射到 paper-dark/paper-light', () => {
    loadSdk();
    dispatchFrom(window.parent, { __papr: true, type: 'papr://theme', payload: { dark: true } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper-dark');
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    dispatchFrom(window.parent, { __papr: true, type: 'papr://theme', payload: { dark: false } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper-light');
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('papr-sdk.js prototype pollution (#26)', () => {
  it('__proto__ reqId 不污染 Object.prototype，且不崩溃', async () => {
    loadSdk();
    dispatchFrom(window.parent, { __papr: true, reqId: '__proto__', result: 'x' });
    dispatchFrom(window.parent, { __papr: true, reqId: 'constructor', result: 'x' });
    dispatchFrom(window.parent, { __papr: true, reqId: 'prototype', result: 'x' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));

    // 旧实现：pending['__proto__'] 命中 Object.prototype（truthy），
    // armIdleTimer 会把 timer 写进原型，污染页面内所有对象。
    expect(({} as { timer?: unknown }).timer).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'timer')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'resolve')).toBe(false);
  });

  it('正常 reqId 的响应仍按 pending 结算（原型安全改造不破坏功能）', async () => {
    loadSdk();
    const papr = (window as unknown as { papr: { fs: { readFile: (p: string) => Promise<unknown> } } }).papr;
    const sent = captureSentMessages();
    const pending = papr.fs.readFile('a.txt');
    const reqId = sent[0]?.reqId ?? '';
    expect(reqId).toBeTruthy();
    dispatchFrom(window.parent, { __papr: true, reqId, result: 'file-content' });
    await expect(pending).resolves.toBe('file-content');
  });

  it('错误响应（error 对象）正常 reject', async () => {
    loadSdk();
    const papr = (window as unknown as { papr: { app: { info: () => Promise<unknown> } } }).papr;
    const sent = captureSentMessages();
    const pending = papr.app.info();
    const reqId = sent[0]?.reqId ?? '';
    expect(reqId).toBeTruthy();
    dispatchFrom(window.parent, {
      __papr: true,
      reqId,
      error: { code: 'PERMISSION_DENIED', message: 'denied' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('papr-sdk.js app.info does not cache stale access', () => {
  it('第二次 info() 再发请求，拿到新的 local/network', async () => {
    loadSdk();
    const papr = (window as unknown as {
      papr: { app: { info: () => Promise<Record<string, unknown>> } };
    }).papr;
    const sent = captureSentMessages();

    const first = papr.app.info();
    const req1 = sent[0]?.reqId ?? '';
    expect(req1).toBeTruthy();
    dispatchFrom(window.parent, {
      __papr: true,
      reqId: req1,
      result: { local: 'none', network: false, appId: 'a' },
    });
    await expect(first).resolves.toMatchObject({ local: 'none', network: false });

    const second = papr.app.info();
    const req2 = sent[1]?.reqId ?? '';
    expect(req2).toBeTruthy();
    expect(req2).not.toBe(req1);
    dispatchFrom(window.parent, {
      __papr: true,
      reqId: req2,
      result: { local: 'write', network: true, appId: 'a' },
    });
    await expect(second).resolves.toMatchObject({ local: 'write', network: true });
  });
});

describe('papr-sdk.js http.request and fs encoding payloads', () => {
  it('http.request 发送 method/headers', () => {
    loadSdk();
    const papr = (window as unknown as {
      papr: { http: { request: (opts: Record<string, unknown>) => Promise<unknown> } };
    }).papr;
    const sent = captureSentMessages();
    void papr.http.request({
      method: 'PUT',
      url: 'https://api.example.com/x',
      headers: { Authorization: 'Bearer t' },
      body: '{"a":1}',
    });
    expect(sent[0]?.type).toBe('papr://http.request');
  });

  it('fs.exists 与 readFile encoding 走对应通道', () => {
    loadSdk();
    const papr = (window as unknown as {
      papr: {
        fs: {
          exists: (p: string) => Promise<unknown>;
          readFile: (p: string, opts?: Record<string, unknown>) => Promise<unknown>;
        };
      };
    }).papr;
    const sent = captureSentMessages();
    void papr.fs.exists('a.bin');
    void papr.fs.readFile('a.bin', { encoding: 'base64' });
    expect(sent[0]?.type).toBe('papr://fs.exists');
    expect(sent[1]?.type).toBe('papr://fs.read');
  });
});

describe('papr-sdk.js console forwarding', () => {
  it('console.error 以 papr://console 发给父窗口（无 reqId）', () => {
    const sent: Array<{ type?: string; payload?: { level?: string; message?: string } }> = [];
    const original = window.parent.postMessage.bind(window.parent);
    window.parent.postMessage = ((message: unknown) => {
      const data = message as { __papr?: boolean; type?: string; payload?: { level?: string; message?: string } };
      if (data?.__papr) sent.push(data);
      return (original as (m: unknown) => void)(message);
    }) as typeof window.parent.postMessage;
    loadSdk();
    window.console.error('boom', { a: 1 });
    const entry = sent.find((s) => s.type === 'papr://console');
    expect(entry?.payload?.level).toBe('error');
    expect(entry?.payload?.message).toContain('boom');
  });
});

describe('papr-sdk.js papr.events (app_publish 下行推送)', () => {
  type EventsApi = {
    on: (channel: string, cb: (evt: unknown) => void) => () => void;
  };

  function eventsApi(): EventsApi {
    return (window as unknown as { papr: { events: EventsApi } }).papr.events;
  }

  it('父窗口 papr://event 触发对应频道订阅者，信封为 {channel, seq, ts, payload}', () => {
    loadSdk();
    const received: Array<Record<string, unknown>> = [];
    eventsApi().on('cards', (evt) => received.push(evt as Record<string, unknown>));

    dispatchFrom(window.parent, {
      __papr: true,
      type: 'papr://event',
      payload: { channel: 'cards', seq: 3, ts: 1234, payload: { op: 'add' } },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ channel: 'cards', seq: 3, ts: 1234, payload: { op: 'add' } });
  });

  it('伪造来源的 papr://event 不触发订阅者', () => {
    loadSdk();
    const received: unknown[] = [];
    eventsApi().on('cards', (evt) => received.push(evt));

    dispatchFrom({}, {
      __papr: true,
      type: 'papr://event',
      payload: { channel: 'cards', seq: 1, ts: 1, payload: { spoofed: true } },
    });

    expect(received).toHaveLength(0);
  });

  it('未订阅的频道与原型键频道名安全忽略', () => {
    loadSdk();
    expect(() => {
      dispatchFrom(window.parent, {
        __papr: true,
        type: 'papr://event',
        payload: { channel: '__proto__', seq: 1, ts: 1, payload: {} },
      });
      dispatchFrom(window.parent, {
        __papr: true,
        type: 'papr://event',
        payload: { channel: 'nobody-listens', seq: 1, ts: 1, payload: {} },
      });
    }).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'seq')).toBe(false);
  });

  it('unsubscribe 停止接收；其他订阅者不受影响', () => {
    loadSdk();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const off = eventsApi().on('cards', (evt) => a.push(evt));
    eventsApi().on('cards', (evt) => b.push(evt));

    off();
    dispatchFrom(window.parent, {
      __papr: true,
      type: 'papr://event',
      payload: { channel: 'cards', seq: 2, ts: 2, payload: {} },
    });

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it('on 参数非法返回无副作用的 unsubscribe', () => {
    loadSdk();
    const off1 = eventsApi().on('', () => {});
    const off2 = (eventsApi().on as unknown as (c: unknown, cb: unknown) => () => void)(null, () => {});
    expect(typeof off1).toBe('function');
    expect(typeof off2).toBe('function');
    expect(() => {
      off1();
      off2();
    }).not.toThrow();
  });

  it('seq 去重：已消费过的 seq（含更小 seq）不再二次送达，更新 seq 正常送达', () => {
    loadSdk();
    const received: Array<Record<string, unknown>> = [];
    eventsApi().on('cards', (evt) => received.push(evt as Record<string, unknown>));

    const post = (seq: number) => {
      dispatchFrom(window.parent, {
        __papr: true,
        type: 'papr://event',
        payload: { channel: 'cards', seq, ts: seq, payload: { n: seq } },
      });
    };
    post(7);
    post(7); // 冲刷补发的重复副本
    post(6); // 比已消费更旧
    post(8);
    expect(received.map((e) => e.seq)).toEqual([7, 8]);

    // 无 seq（0/缺省）的旧信封不参与去重，照常送达
    dispatchFrom(window.parent, { __papr: true, type: 'papr://event', payload: { channel: 'cards', payload: 'a' } });
    dispatchFrom(window.parent, { __papr: true, type: 'papr://event', payload: { channel: 'cards', payload: 'b' } });
    expect(received).toHaveLength(4);
  });

  it('db.get("inbox:<channel>") 回放后，同 seq 的实时事件被抑制、更新 seq 不受影响', async () => {
    loadSdk();
    type Sdk = { db: { get: (k: string) => Promise<unknown> }; events: EventsApi };
    const papr = (window as unknown as { papr: Sdk }).papr;
    const sent = captureSentMessages();
    const received: Array<Record<string, unknown>> = [];
    papr.events.on('cards', (evt) => received.push(evt as Record<string, unknown>));

    const replay = papr.db.get('inbox:cards');
    const reqId = sent[0]?.reqId ?? '';
    expect(reqId).toBeTruthy();
    dispatchFrom(window.parent, {
      __papr: true,
      reqId,
      result: JSON.stringify([
        { seq: 8, ts: 1, payload: { n: 8 } },
        { seq: 9, ts: 2, payload: { n: 9 } },
      ]),
    });
    await replay;

    const post = (seq: number) => {
      dispatchFrom(window.parent, {
        __papr: true,
        type: 'papr://event',
        payload: { channel: 'cards', seq, ts: seq, payload: { n: seq } },
      });
    };
    post(9); // 回放已覆盖 → 抑制（挂载竞态冲刷的副本）
    post(10); // 新事件 → 送达
    expect(received.map((e) => e.seq)).toEqual([10]);

    // 非 inbox 键的回放不影响该频道去重
    const other = papr.db.get('settings');
    const otherReqId = sent[1]?.reqId ?? '';
    dispatchFrom(window.parent, { __papr: true, reqId: otherReqId, result: JSON.stringify([{ seq: 99 }]) });
    await other;
    post(11);
    expect(received.map((e) => e.seq)).toEqual([10, 11]);
  });
});

describe('papr-sdk.js papr.window', () => {
  it('setSize/getBounds 发给父窗口', () => {
    loadSdk();
    const papr = (window as unknown as {
      papr: {
        window: {
          getBounds: () => Promise<unknown>;
          setSize: (opts: { width: number; height: number }) => Promise<unknown>;
        };
      };
    }).papr;
    const sent = captureSentMessages();
    void papr.window.getBounds().catch(() => {});
    void papr.window.setSize({ width: 400, height: 160 }).catch(() => {});
    expect(sent[0]?.type).toBe('papr://window.getBounds');
    expect(sent[1]?.type).toBe('papr://window.setSize');
  });

  it('onBounds 只接受来自 parent 的 papr://window.bounds', () => {
    loadSdk();
    const received: unknown[] = [];
    const papr = (window as unknown as {
      papr: { window: { onBounds: (cb: (b: unknown) => void) => () => void } };
    }).papr;
    papr.window.onBounds((bounds) => received.push(bounds));
    dispatchFrom({}, { __papr: true, type: 'papr://window.bounds', payload: { width: 1 } });
    expect(received).toHaveLength(0);
    dispatchFrom(window.parent, {
      __papr: true,
      type: 'papr://window.bounds',
      payload: { width: 400, height: 200 },
    });
    expect(received).toEqual([{ width: 400, height: 200 }]);
  });
});
