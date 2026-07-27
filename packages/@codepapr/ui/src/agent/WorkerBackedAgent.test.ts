// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentResponse } from '@codepapr/types';
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

function createAgent(): WorkerBackedAgent {
  return new WorkerBackedAgent({
    sessionId: 'session-1',
    workspacePath: '/tmp/codepapr-worker-agent-test',
    initialMessages: [],
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

    worker.emit({ type: 'result', requestId, response, deltaMessages: [] });
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

    worker.emit({ type: 'result', requestId, response, deltaMessages: [] });
    await expect(chatPromise).resolves.toEqual(response);
  });
});
