// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentResponse, IMessage } from '@codepapr/types';
import { createDefaultMcpSettings, normalizeMcpSettings, type McpSettings } from '../utils/mcpTypes';
import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';
import {
  AgentDestroyedError,
  WorkerBackedAgent,
  WorkerCrashError,
  type AgentRuntimeStreamEvent,
} from './WorkerBackedAgent';

function makeMcpSearchSettings(): McpSettings {
  const base = createDefaultMcpSettings();
  return {
    ...base,
    enabled: true,
    exposeTools: true,
    servers: base.servers.map((server) =>
      server.id === 'search' ? { ...server, enabled: true } : server
    ),
  };
}

class MockWorker {
  static instances: MockWorker[] = [];

  readonly messages: MainToAgentWorkerMessage[] = [];
  terminated = false;
  private messageListeners: Array<(event: MessageEvent<AgentWorkerToMainMessage>) => void> = [];
  private errorListeners: Array<(event: ErrorEvent) => void> = [];

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener as (event: MessageEvent<AgentWorkerToMainMessage>) => void);
    } else if (type === 'error') {
      this.errorListeners.push(listener as (event: ErrorEvent) => void);
    }
  }

  postMessage(message: MainToAgentWorkerMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: AgentWorkerToMainMessage): void {
    const event = { data: message } as MessageEvent<AgentWorkerToMainMessage>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  emitError(message: string): void {
    const event = { message, filename: '', lineno: 0, colno: 0 } as ErrorEvent;
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }
}

function createAgent(
  initialMessages: IMessage[] = [],
  overrides?: { multimodalEnabled?: boolean; mcpSearch?: boolean }
): WorkerBackedAgent {
  return new WorkerBackedAgent({
    sessionId: 'session-1',
    workspacePath: '/tmp/codepapr-worker-agent-test',
    initialMessages,
    settings: {
      apiMode: 'deepseek',
      apiFormat: 'openai',
      provider: 'deepseek',
      baseURL: 'https://example.invalid',
      apiKey: 'test-key',
      model: 'deepseek-test',
      fastModelEnabled: true,
      fastModel: 'deepseek-fast',
      temperature: 0,
      maxTokens: 1024,
      maxToolRounds: 500,
      thinkingEnabled: true,
      thinkingEffort: 'max',
      lang: 'zh-CN',
      mentorEnabled: false,
      mentorModel: '',
      mentorBaseURL: '',
      mentorApiKey: '',
      mentorApiFormat: 'openai',
      mentorMaxTokens: 10000,
      mentorThinkingEnabled: false,
      exploreTopP: 0.9,
      exploreMaxTokens: 393_216,
      exploreThinkingEnabled: true,
      exploreTemperature: 0.5,
      exploreMaxToolRounds: 200,
      exploreMaxDepth: 2,
      exploreModelTier: 'fast',
      scoutTopP: 0.9,
      scoutMaxTokens: 400000,
      scoutThinkingEnabled: false,
      scoutTemperature: 0.3,
      scoutMaxToolRounds: 200,
      scoutMaxDepth: 2,
      scoutModelTier: 'fast',
      appSubAgentModelTier: 'primary',
      appSubAgentThinkingEnabled: false,
      appSubAgentMaxToolRounds: 50,
      mcp: overrides?.mcpSearch ? makeMcpSearchSettings() : normalizeMcpSettings(),
      graphToolTimeoutMs: 600_000,
      toolIpcTimeoutMs: 120_000,
      streamIdleTimeoutMs: 300_000,
      multimodalEnabled: overrides?.multimodalEnabled ?? false,
      multimodalModelTier: 'all',
      toolOutputInterceptChars: 30_000,
      toolOutputOffloadChars: 50_000,
      toolOutputCeilingChars: 150_000,
      toolOutputPreviewChars: 2_000,
      toolOutputMiddleKeepChars: 20_000,
      pruneOldToolResults: true,
      pruneProtectRounds: 6,
      pruneMinChars: 20_000,
      toolContextDefaultMode: 'auto',
      toolContextOverrides: {},
      toolContextSummaryMaxChars: 500,
      toolContextAutoThresholdChars: 5_000,
      maxContextTokens: 500_000,
      maxConversationRounds: 24,
      compactionModel: 'fast',
      compactionMaxTokens: 8_000,
      compactionTemperature: 0.1,
    },
    providerName: 'deepseek',
    model: 'deepseek-test',
    systemPrompt: 'test system prompt',
    parameters: {
      temperature: 0,
      topP: 0.9,
      maxTokens: 1024,
      thinkingEnabled: true,
      reasoningEffort: 'max',
    },
    runtime: {},
  });
}

type ChatWorkerMessage = Extract<MainToAgentWorkerMessage, { type: 'chat' }>;

/** The constructor posts an 'init' message before any chat, so tests must
 *  filter for chat messages instead of indexing raw worker messages. */
function chatMessages(worker: MockWorker | undefined): ChatWorkerMessage[] {
  return (worker?.messages ?? []).filter((m): m is ChatWorkerMessage => m.type === 'chat');
}

describe('WorkerBackedAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts an init message with settings/tools/workspace before any chat', () => {
    createAgent();
    const worker = MockWorker.instances[0];
    const initMessage = worker?.messages[0];
    expect(initMessage?.type).toBe('init');
    if (initMessage?.type !== 'init') throw new Error('expected init message');
    expect(initMessage.payload.workspacePath).toBe('/tmp/codepapr-worker-agent-test');
    expect(initMessage.payload.settings.model).toBe('deepseek-test');
    expect(initMessage.payload.toolDefinitions.length).toBeGreaterThan(0);
  });

  it('buffers content and reasoning deltas before flushing them to the UI', async () => {
    const agent = createAgent();
    const events: AgentRuntimeStreamEvent[] = [];
    const response: IAgentResponse = {
      role: 'assistant',
      content: 'AB',
      reasoningContent: 'XY',
    };

    const chatPromise = agent.chat('hello', (event) => events.push(event));
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];

    expect(chatMessage?.type).toBe('chat');
    if (chatMessage?.type !== 'chat') {
      throw new Error('expected chat message');
    }
    const { requestId } = chatMessage.payload;

    worker.emit({ type: 'stream', requestId, event: { type: 'content-delta', delta: 'A' } });
    worker.emit({ type: 'stream', requestId, event: { type: 'content-delta', delta: 'B' } });
    worker.emit({ type: 'stream', requestId, event: { type: 'reasoning-delta', delta: 'X' } });
    worker.emit({ type: 'stream', requestId, event: { type: 'reasoning-delta', delta: 'Y' } });

    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(239);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([
      { type: 'content-delta', delta: 'AB' },
      { type: 'reasoning-delta', delta: 'XY' },
    ]);

    worker.emit({ type: 'result', requestId, response, deltaMessages: [], logLength: 0 });
    await expect(chatPromise).resolves.toEqual(response);
  });

  it('flushes very large stream buffers without waiting for the timer', async () => {
    const agent = createAgent();
    const events: AgentRuntimeStreamEvent[] = [];
    const response: IAgentResponse = {
      role: 'assistant',
      content: 'x'.repeat(4096),
    };

    const chatPromise = agent.chat('hello', (event) => events.push(event));
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') {
      throw new Error('expected chat message');
    }
    const { requestId } = chatMessage.payload;

    worker.emit({
      type: 'stream',
      requestId,
      event: { type: 'content-delta', delta: 'x'.repeat(4096) },
    });

    expect(events).toEqual([{ type: 'content-delta', delta: 'x'.repeat(4096) }]);

    worker.emit({ type: 'result', requestId, response, deltaMessages: [], logLength: 0 });
    await expect(chatPromise).resolves.toEqual(response);
  });

  it('replaces its authoritative log with the compacted epoch when the worker reports compaction', async () => {
    const original: IMessage[] = [
      { id: 'u1', role: 'user', content: '旧消息 1', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '旧回复 1', timestamp: 2 },
      { id: 'u2', role: 'user', content: '旧消息 2', timestamp: 3 },
    ];
    const agent = createAgent(original);
    const response: IAgentResponse = { role: 'assistant', content: '压缩后回复' };

    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') {
      throw new Error('expected chat message');
    }
    const { requestId } = chatMessage.payload;

    const compacted: IMessage[] = [
      { id: 'cp', role: 'user', content: '检查点摘要', timestamp: 9 },
      { id: 'a-new', role: 'assistant', content: '压缩后回复', timestamp: 10 },
    ];
    worker.emit({
      type: 'result',
      requestId,
      response,
      deltaMessages: [],
      logLength: compacted.length,
      compacted: true,
      fullMessages: compacted,
    });
    await expect(chatPromise).resolves.toEqual(response);

    // The authoritative log must be the compacted epoch, not original + deltas.
    expect(agent.getSession().logStore.getAllMessages().map((m) => m.id)).toEqual(['cp', 'a-new']);
  });

  it('syncs incrementally on subsequent turns instead of re-sending the full log', async () => {
    const agent = createAgent();
    const worker = MockWorker.instances[0];

    // Turn 1: empty history => full sync (no incrementalSync).
    const chat1 = agent.chat('hello');
    const msg1 = chatMessages(worker)[0];
    if (msg1?.type !== 'chat') throw new Error('expected chat message');
    expect(msg1.payload.incrementalSync).toBeUndefined();
    const requestId1 = msg1.payload.requestId;

    const delta1: IMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'r1', timestamp: 2 },
    ];
    worker?.emit({
      type: 'result',
      requestId: requestId1,
      response: { role: 'assistant', content: 'r1' },
      deltaMessages: delta1,
      logLength: 2,
    });
    await chat1;

    // Turn 2: main log length (2) matches the tracked worker length => incremental.
    const chat2 = agent.chat('again');
    const msg2 = chatMessages(worker)[1];
    if (msg2?.type !== 'chat') throw new Error('expected chat message');
    expect(msg2.payload.incrementalSync?.expectedBaseLength).toBe(2);
    expect(msg2.payload.incrementalSync?.newMessages).toEqual([]);
    expect(msg2.payload.messages).toEqual([]);
    const requestId2 = msg2.payload.requestId;

    const delta2: IMessage[] = [
      { id: 'u2', role: 'user', content: 'again', timestamp: 3 },
      { id: 'a2', role: 'assistant', content: 'r2', timestamp: 4 },
    ];
    worker?.emit({
      type: 'result',
      requestId: requestId2,
      response: { role: 'assistant', content: 'r2' },
      deltaMessages: delta2,
      logLength: 4,
    });
    await chat2;

    expect(agent.getSession().logStore.getAllMessages().map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('excludes read_image and graph from worker tool definitions when multimodal is off', async () => {
    const agent = createAgent([], { multimodalEnabled: false });
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    const toolNames = chatMessage.payload.toolDefinitions.map((t) => t.name);
    expect(toolNames).not.toContain('read_image');
    expect(toolNames).not.toContain('graph');

    worker?.emit({
      type: 'result',
      requestId: chatMessage.payload.requestId,
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [],
      logLength: 0,
    });
    await chatPromise;
  });

  it('includes read_image in worker tool definitions when multimodal is on', async () => {
    const agent = createAgent([], { multimodalEnabled: true });
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    const toolNames = chatMessage.payload.toolDefinitions.map((t) => t.name);
    expect(toolNames).toContain('read_image');

    worker?.emit({
      type: 'result',
      requestId: chatMessage.payload.requestId,
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [],
      logLength: 0,
    });
    await chatPromise;
  });

  it('excludes websearch/webfetch from worker tool definitions when MCP search is enabled', async () => {
    const agent = createAgent([], { mcpSearch: true });
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    const toolNames = chatMessage.payload.toolDefinitions.map((t) => t.name);
    expect(toolNames).not.toContain('websearch');
    expect(toolNames).not.toContain('webfetch');

    worker?.emit({
      type: 'result',
      requestId: chatMessage.payload.requestId,
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [],
      logLength: 0,
    });
    await chatPromise;
  });

  it('includes websearch/webfetch in worker tool definitions when MCP search is disabled', async () => {
    const agent = createAgent([], { mcpSearch: false });
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    const toolNames = chatMessage.payload.toolDefinitions.map((t) => t.name);
    expect(toolNames).toContain('websearch');
    expect(toolNames).toContain('webfetch');

    worker?.emit({
      type: 'result',
      requestId: chatMessage.payload.requestId,
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [],
      logLength: 0,
    });
    await chatPromise;
  });

  it('declares the worker crashed when heartbeats go unanswered during a request', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    // Attach the rejection handler before advancing timers so the crash
    // rejection fired inside the timer callback is never "unhandled".
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(WorkerCrashError);

    // Answer one ping so the heartbeat leaves the initial grace window, then
    // go silent: after 15s without a pong the worker is declared crashed.
    await vi.advanceTimersByTimeAsync(5_000);
    worker?.emit({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(21_000);

    expect(agent.isCrashed()).toBe(true);
    expect(worker?.terminated).toBe(true);
    expect(worker?.messages.some((m) => m.type === 'ping')).toBe(true);
    await rejection;
    await expect(chatPromise).rejects.toThrow(/unresponsive/i);
  });

  it('gives a never-answered worker the longer initial grace window', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(WorkerCrashError);

    // No pong ever arrives, but the first turn gets the 60s initial grace
    // (full-sync + hashing can legitimately block pong replies that long,
    // especially right after a page thaw). Ticks at 5s intervals: the 60s
    // tick is exactly at the limit (not over), the 65s tick declares crash.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(agent.isCrashed()).toBe(false);

    await vi.advanceTimersByTimeAsync(7_000);
    expect(agent.isCrashed()).toBe(true);
    expect(worker?.terminated).toBe(true);
    await rejection;
    await expect(chatPromise).rejects.toThrow(/no heartbeat for 60s/i);
  });

  it('refreshes the heartbeat baseline when the page becomes visible again', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(WorkerCrashError);

    // Answer one ping to leave the initial grace window.
    await vi.advanceTimersByTimeAsync(5_000);
    worker?.emit({ type: 'pong' });

    // 12s of silence: within the 15s window.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(agent.isCrashed()).toBe(false);

    // Page thaws (visibilitychange→visible): baseline refreshes. Without the
    // refresh the next tick (total 25s since the pong) would declare a crash.
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(17_000);
    expect(agent.isCrashed()).toBe(false);

    // A genuine silence window after the thaw still crashes as expected.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(agent.isCrashed()).toBe(true);
    await rejection;
  });

  it('keeps the worker alive while heartbeats are answered', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    // Answer every ping for longer than the crash timeout.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      worker?.emit({ type: 'pong' });
    }
    expect(agent.isCrashed()).toBe(false);

    worker?.emit({
      type: 'result',
      requestId: chatMessage.payload.requestId,
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [],
      logLength: 0,
    });
    await expect(chatPromise).resolves.toEqual({ role: 'assistant', content: 'ok' });
  });

  it('reports the original crash cause when chat() is called after a crash', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(WorkerCrashError);

    worker?.emitError('Simulated OOM');

    await rejection;
    await expect(chatPromise).rejects.toThrow(/Simulated OOM/);

    // A subsequent chat on the same dead agent must carry the original cause,
    // not just a generic "has crashed" message.
    await expect(agent.chat('again')).rejects.toThrow(/Simulated OOM/);
    expect(agent.isCrashed()).toBe(true);
  });

  it('destroy() rejects in-flight chat with AgentDestroyedError, not WorkerCrashError', async () => {    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const worker = MockWorker.instances[0];
    const chatMessage = chatMessages(worker)[0];
    if (chatMessage?.type !== 'chat') throw new Error('expected chat message');

    // 旧实现：destroy 用 WorkerCrashError 拒绝 → 崩溃恢复链重建并重跑整个
    // 回合（非幂等工具副作用重复执行）。销毁是用户主动中断，必须用独立的
    // AgentDestroyedError 区分。
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(AgentDestroyedError);
    agent.destroy();

    await rejection;
    await expect(chatPromise).rejects.toMatchObject({ name: 'AgentDestroyedError' });
    expect(agent.isCrashed()).toBe(true);
    expect(worker?.terminated).toBe(true);
  });

  it('chat() on a destroyed agent throws AgentDestroyedError (no crash-recovery reuse)', async () => {
    const agent = createAgent();
    agent.destroy();
    await expect(agent.chat('after destroy')).rejects.toMatchObject({
      name: 'AgentDestroyedError',
    });
  });

  // 回归 #2：崩溃/销毁后 worker 已 terminate，任何后续 postMessage（取消、
  // 心跳、工具回包等异步回调）都必须被拦截——向已终止 worker 投递在部分
  // 引擎会抛异常。
  it('does not postMessage to a worker after it crashed', async () => {
    const agent = createAgent();
    // chat 在崩溃时以 WorkerCrashError 拒绝：这里只验证崩溃后的消息行为，
    // 必须显式 catch，否则未处理拒绝会让测试偶发报错（时序敏感）。
    void agent.chat('hello').catch(() => undefined);
    const worker = MockWorker.instances[0];
    if (!worker) throw new Error('expected worker instance');
    const beforeCrash = worker.messages.length;
    expect(beforeCrash).toBeGreaterThan(0);

    worker.emitError('Simulated OOM');
    expect(agent.isCrashed()).toBe(true);
    expect(worker.terminated).toBe(true);

    // 崩溃后仍可能被调用的路径：取消会话 / 取消 app-agent / 销毁
    agent.cancelSession();
    agent.cancelAppAgent('req-1');
    agent.destroy();

    expect(worker.messages.length).toBe(beforeCrash);
  });

  it('keeps an app agent run alive while stream events keep arriving', async () => {
    const agent = createAgent();
    const runPromise = agent.runAppAgent(
      { appId: 'app-1', agentName: 'assistant', task: 'long analysis' },
      undefined,
      'run-1',
    );
    const worker = MockWorker.instances[0];

    // 360s total — beyond the 300s idle window — but a stream event every 10s
    // keeps re-arming the idle timer, so the run must survive.
    for (let i = 0; i < 36; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      worker?.emit({ type: 'pong' });
      worker?.emit({
        type: 'app-agent-stream',
        requestId: 'run-1',
        event: { type: 'content-delta', delta: '.' },
      });
    }

    worker?.emit({ type: 'app-agent-result', requestId: 'run-1', content: 'done' });
    await expect(runPromise).resolves.toEqual({
      content: 'done',
      reasoningContent: undefined,
      steps: undefined,
    });
  });

  it('times out an app agent run after 300s without activity', async () => {
    const agent = createAgent();
    const runPromise = agent.runAppAgent(
      { appId: 'app-1', agentName: 'assistant', task: 'long analysis' },
      undefined,
      'run-2',
    );
    const rejection = expect(runPromise).rejects.toThrow(/no activity for 300s/);
    const worker = MockWorker.instances[0];

    // Keep the heartbeat alive so only the app-agent idle timer fires.
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      worker?.emit({ type: 'pong' });
    }

    await rejection;
  });

  it('executes tool requests from app-agent runs and replies with tool-response', async () => {
    const agent = createAgent();
    const runPromise = agent.runAppAgent(
      { appId: 'app-1', agentName: 'assistant', task: 'search the web' },
      undefined,
      'run-tools',
    );
    const worker = MockWorker.instances[0];

    // App-agent runs are tracked in appAgentRequests (not pendingRequests);
    // their tool calls must still be executed instead of silently dropped.
    worker?.emit({
      type: 'tool-request',
      requestId: 'run-tools',
      toolRequestId: 'run-tools:1',
      toolName: 'local_time_now',
      arguments: {},
    });
    await vi.advanceTimersByTimeAsync(0);

    const response = worker?.messages.find(
      (m): m is Extract<MainToAgentWorkerMessage, { type: 'tool-response' }> =>
        m.type === 'tool-response' && m.payload.toolRequestId === 'run-tools:1',
    );
    expect(response?.payload.success).toBe(true);

    worker?.emit({ type: 'app-agent-result', requestId: 'run-tools', content: 'done' });
    await expect(runPromise).resolves.toMatchObject({ content: 'done' });
  });

  it('drops tool requests after an app-agent run was cancelled', async () => {
    const agent = createAgent();
    const runPromise = agent.runAppAgent(
      { appId: 'app-1', agentName: 'assistant', task: 'search the web' },
      undefined,
      'run-cancel',
    );
    // Avoid unhandled rejection noise; cancelAppAgent rejects with AbortError.
    runPromise.catch(() => undefined);
    agent.cancelAppAgent('run-cancel');
    const worker = MockWorker.instances[0];

    worker?.emit({
      type: 'tool-request',
      requestId: 'run-cancel',
      toolRequestId: 'run-cancel:1',
      toolName: 'local_time_now',
      arguments: {},
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(worker?.messages.some((m) => m.type === 'tool-response')).toBe(false);
    await expect(runPromise).rejects.toBeInstanceOf(DOMException);
  });

  it('cancelSession 只取消会话，不连带取消在飞的 app-agent（停止按钮语义）', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    chatPromise.catch(() => undefined);
    const runPromise = agent.runAppAgent(
      { appId: 'app-1', agentName: 'assistant', task: 'keep running' },
      undefined,
      'run-keep',
    );
    runPromise.catch(() => undefined);
    const worker = MockWorker.instances[0];
    if (worker) worker.messages.length = 0; // 清掉 init/chat 消息，只看后续

    agent.cancelSession();

    const posted = worker?.messages ?? [];
    expect(posted.some((m) => m.type === 'cancel-session')).toBe(true);
    // 不得发送 cancel-app-agent：停止按钮只停当前回合
    expect(posted.some((m) => m.type === 'cancel-app-agent')).toBe(false);

    // worker 回 cancel ACK 后 app-agent 仍在飞（未被 reject）
    const requestId = posted.find((m) => m.type === 'cancel-session')?.requestId;
    worker?.emit({ type: 'cancelled', requestId: requestId! });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.hasActiveAppAgentRequests()).toBe(true);
  });

  it('cancel（销毁路径）仍会连带取消所有在飞的 app-agent', async () => {
    const agent = createAgent();
    agent.chat('hello').catch(() => undefined);
    agent
      .runAppAgent(
        { appId: 'app-1', agentName: 'assistant', task: 'kill me' },
        undefined,
        'run-kill',
      )
      .catch(() => undefined);
    const worker = MockWorker.instances[0];
    if (worker) worker.messages.length = 0;

    agent.cancel();

    const posted = worker?.messages ?? [];
    expect(posted.some((m) => m.type === 'cancel-session')).toBe(true);
    expect(posted.some((m) => m.type === 'cancel-app-agent')).toBe(true);
  });

  it('取消 ACK 宽限：worker 未应答时 10s 才硬终止（旧实现 2s 误杀慢同步 worker）', async () => {
    const agent = createAgent();
    const chatPromise = agent.chat('hello');
    const rejection = expect(chatPromise).rejects.toBeInstanceOf(DOMException);
    const worker = MockWorker.instances[0];
    agent.cancel();

    // 2s 时（旧实现终止点）worker 仍存活——大上下文同步 >2s 是正常情况
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker?.terminated).toBe(false);
    expect(agent.isCrashed()).toBe(false);

    // 宽限期内 worker 任何响应（如 pong）都会重新武装窗口
    worker?.emit({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker?.terminated).toBe(false);

    // 彻底无响应后 10s 窗口到期 → terminate + crashed
    await vi.advanceTimersByTimeAsync(9000);
    expect(worker?.terminated).toBe(true);
    expect(agent.isCrashed()).toBe(true);
    await rejection;
  });

  it('includes worker diagnostics emitted before a crash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const agent = createAgent();
      const chatPromise = agent.chat('hello');
      const worker = MockWorker.instances[0];
      const rejection = expect(chatPromise).rejects.toBeInstanceOf(WorkerCrashError);

      worker?.emit({
        type: 'worker-diagnostic',
        message: 'Unhandled rejection: boom',
        detail: 'worker.ts:10:5',
      });
      worker?.emitError('fatal');

      await rejection;
      expect(warnSpy).toHaveBeenCalledWith(
        '[AgentWorker] diagnostic:',
        'Unhandled rejection: boom (worker.ts:10:5)',
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
