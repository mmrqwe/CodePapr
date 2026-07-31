// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentResponse, IMessage } from '@codepapr/types';
import { normalizeMcpSettings } from '../utils/mcpTypes';
import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';
import { WorkerBackedAgent, type AgentRuntimeStreamEvent } from './WorkerBackedAgent';

class MockWorker {
  static instances: MockWorker[] = [];

  readonly messages: MainToAgentWorkerMessage[] = [];
  private messageListeners: Array<(event: MessageEvent<AgentWorkerToMainMessage>) => void> = [];

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<AgentWorkerToMainMessage>) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener);
    }
  }

  postMessage(message: MainToAgentWorkerMessage): void {
    this.messages.push(message);
  }

  emit(message: AgentWorkerToMainMessage): void {
    const event = { data: message } as MessageEvent<AgentWorkerToMainMessage>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

function createAgent(initialMessages: IMessage[] = []): WorkerBackedAgent {
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
      mcp: normalizeMcpSettings(),
      graphToolTimeoutMs: 600_000,
      toolIpcTimeoutMs: 120_000,
      multimodalEnabled: false,
      multimodalModelTier: 'all',
      toolOutputInterceptChars: 30_000,
      toolOutputOffloadChars: 50_000,
      toolOutputCeilingChars: 150_000,
      toolOutputPreviewChars: 2_000,
      pruneOldToolResults: true,
      pruneProtectRounds: 6,
      pruneMinChars: 20_000,
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
    const chatMessage = worker?.messages[0];

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
    const chatMessage = worker?.messages[0];
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
    const chatMessage = worker?.messages[0];
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
    const msg1 = worker?.messages[0];
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
    const msg2 = worker?.messages[1];
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
});
