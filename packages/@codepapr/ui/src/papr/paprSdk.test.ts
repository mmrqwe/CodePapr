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

afterEach(() => {
  delete (window as unknown as { papr?: unknown }).papr;
  window.parent.postMessage = window.parent.postMessage.bind(window.parent);
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
