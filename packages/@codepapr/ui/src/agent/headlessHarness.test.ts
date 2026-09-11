import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({})),
}));

import { createHarnessMediator, type HarnessMediator } from './headlessHarness';
import type {
  AgentWorkerToMainMessage,
  MainToAgentWorkerMessage,
} from './agentWorkerProtocol';
import { SESSION_BOOTSTRAP_MESSAGE_ID } from '../utils/contextSurface';

interface Harness {
  mediator: HarnessMediator;
  toLoop: MainToAgentWorkerMessage[];
  emitted: AgentWorkerToMainMessage[];
  init(payload: Record<string, unknown>): void;
  run(payload: Record<string, unknown>): void;
}

function createHarness(): Harness {
  const toLoop: MainToAgentWorkerMessage[] = [];
  const emitted: AgentWorkerToMainMessage[] = [];
  const mediator = createHarnessMediator({
    deliverToLoop: (message) => { toLoop.push(message); },
    emit: (message) => { emitted.push(message); },
  });
  return {
    mediator,
    toLoop,
    emitted,
    init(payload) {
      mediator.handleInbound(
        { type: 'harness/init', payload } as unknown as MainToAgentWorkerMessage
      );
    },
    run(payload) {
      mediator.handleInbound(
        { type: 'harness/run', payload } as unknown as MainToAgentWorkerMessage
      );
    },
  };
}

function toolRequest(
  overrides: Partial<Extract<AgentWorkerToMainMessage, { type: 'tool-request' }>>
): Extract<AgentWorkerToMainMessage, { type: 'tool-request' }> {
  return {
    type: 'tool-request',
    requestId: 'r1',
    toolRequestId: 'r1:1',
    toolName: 'unknown',
    arguments: {},
    ...overrides,
  };
}

function lastToolResponse(harness: Harness) {
  const response = [...harness.toLoop].reverse().find((m) => m.type === 'tool-response');
  if (!response || response.type !== 'tool-response') {
    throw new Error('no tool-response delivered');
  }
  return response.payload;
}

const BASE_INIT = {
  requestId: 'h1',
  workspacePath: '/tmp/ws',
  settingsOverride: { provider: 'openai', model: 'gpt-test', apiKey: 'k', baseURL: 'https://x', apiMode: 'custom', apiFormat: 'openai' },
};

describe('harness mediator handshake', () => {
  it('pings back with the protocol version', () => {
    const harness = createHarness();
    expect(harness.mediator.handleInbound({ type: 'harness/ping' })).toBe(true);
    expect(harness.emitted[0]).toMatchObject({ type: 'harness-pong', protocolVersion: 1 });
  });

  it('passes non-harness frames through untouched before init', () => {
    const harness = createHarness();
    expect(harness.mediator.handleInbound({ type: 'ping' })).toBe(false);
    const forwarded = harness.mediator.handleOutgoing({ type: 'pong' });
    expect(forwarded).toEqual([{ type: 'pong' }]);
  });

  it('init delivers a desktop-shaped init frame and reports toolNames per mode', () => {
    const ask = createHarness();
    ask.init({ ...BASE_INIT, mode: 'ask' });
    const initFrame = ask.toLoop.find((m) => m.type === 'init');
    expect(initFrame).toBeDefined();
    if (initFrame?.type !== 'init') throw new Error();
    expect(initFrame.payload.toolDefinitions.map((t) => t.name)).not.toContain('write');
    expect(initFrame.payload.toolDefinitions.map((t) => t.name)).not.toContain('bash');
    expect(initFrame.payload.toolDefinitions.map((t) => t.name)).toContain('read');
    const ready = ask.emitted.find((m) => m.type === 'harness-ready');
    expect(ready).toMatchObject({ mode: 'ask', requestId: 'h1' });

    const agent = createHarness();
    agent.init({ ...BASE_INIT, mode: 'agent' });
    const agentInit = agent.toLoop.find((m) => m.type === 'init');
    if (agentInit?.type !== 'init') throw new Error();
    expect(agentInit.payload.toolDefinitions.map((t) => t.name)).toContain('write');
  });

  it('rejects unknown modes with an error frame', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'app' });
    expect(harness.emitted.some((m) => m.type === 'error' && /mode/.test(String((m as { error?: string }).error)))).toBe(true);
  });
});

describe('harness tool profile (default | minimal)', () => {
  const initToolNames = (harness: Harness): string[] => {
    const initFrame = harness.toLoop.find((m) => m.type === 'init');
    if (initFrame?.type !== 'init') throw new Error('no init frame');
    return initFrame.payload.toolDefinitions.map((t) => t.name);
  };

  it('minimal + agent：恰好 7 项 allowlist，无 git/todo/lsp/app', () => {
    const harness = createHarness();
    harness.init({
      ...BASE_INIT,
      mode: 'agent',
      settingsOverride: { ...BASE_INIT.settingsOverride, agentToolProfile: 'minimal' },
    });
    expect([...initToolNames(harness)].sort()).toEqual(
      ['bash', 'edit', 'grep', 'read', 'webfetch', 'websearch', 'write']
    );
    const ready = harness.emitted.find((m) => m.type === 'harness-ready');
    if (ready?.type !== 'harness-ready') throw new Error('no harness-ready');
    expect([...ready.toolNames].sort()).toEqual(
      ['bash', 'edit', 'grep', 'read', 'webfetch', 'websearch', 'write']
    );
  });

  it('minimal + ask：mode 先砍写/bash，schema 只剩读与网页（无 write/edit/bash）', () => {
    const harness = createHarness();
    harness.init({
      ...BASE_INIT,
      mode: 'ask',
      settingsOverride: { ...BASE_INIT.settingsOverride, agentToolProfile: 'minimal' },
    });
    const names = initToolNames(harness);
    expect([...names].sort()).toEqual(['grep', 'read', 'webfetch', 'websearch']);
  });

  it('未指定 profile：与今天一致（全量，含 git/todo/lsp）', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    const names = initToolNames(harness);
    expect(names).toContain('git');
    expect(names).toContain('todo');
    expect(names).toContain('lsp');
  });

  it('minimal 的 chat bootstrap 含极简工具面说明，且默认档不含该说明', () => {
    const minimal = createHarness();
    minimal.init({
      ...BASE_INIT,
      mode: 'agent',
      settingsOverride: { ...BASE_INIT.settingsOverride, agentToolProfile: 'minimal' },
    });
    minimal.run({ requestId: 'r1', sessionId: 's1', prompt: 'hi' });
    const chat = minimal.toLoop.find((m) => m.type === 'chat');
    if (chat?.type !== 'chat') throw new Error('no chat frame');
    const bootstrap = chat.payload.messages.find((m) => m.id === SESSION_BOOTSTRAP_MESSAGE_ID);
    expect(bootstrap?.content).toMatch(/极简|極簡|Minimal/);
    expect(bootstrap?.content).toContain('read / edit / write / grep / bash / websearch / webfetch');

    const dflt = createHarness();
    dflt.init({ ...BASE_INIT, mode: 'agent' });
    dflt.run({ requestId: 'r1', sessionId: 's1', prompt: 'hi' });
    const dfltChat = dflt.toLoop.find((m) => m.type === 'chat');
    if (dfltChat?.type !== 'chat') throw new Error('no chat frame');
    const dfltBootstrap = dfltChat.payload.messages.find((m) => m.id === SESSION_BOOTSTRAP_MESSAGE_ID);
    expect(dfltBootstrap?.content).not.toMatch(/极简工具面|極簡工具面|Minimal tool surface/);
  });
});

describe('harness run frame assembly', () => {
  it('run feeds the loop a chat frame with bootstrap + accumulated history', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'first' });
    const chat = harness.toLoop.find((m) => m.type === 'chat');
    if (chat?.type !== 'chat') throw new Error('no chat frame');
    expect(chat.payload.userInput).toBe('first');
    expect(chat.payload.messages[0]?.id).toBe(SESSION_BOOTSTRAP_MESSAGE_ID);
    expect(chat.payload.messages[0]?.metadata?.sessionBootstrap).toBe(true);
    expect(chat.payload.systemPrompt.length).toBeGreaterThan(0);
    expect(chat.payload.settings.model).toBe('gpt-test');

    // result 回写镜像后，第二个回合携带历史（含上一条 user 消息）
    harness.mediator.handleOutgoing({
      type: 'result',
      requestId: 'r1',
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [
        { id: 'u1', role: 'user', content: 'first', timestamp: 2 },
        { id: 'a1', role: 'assistant', content: 'ok', timestamp: 3 },
      ],
      logLength: 3,
    } as Extract<AgentWorkerToMainMessage, { type: 'result' }>);
    harness.run({ requestId: 'r2', sessionId: 's1', prompt: 'second' });
    const chat2 = harness.toLoop.filter((m) => m.type === 'chat')[1];
    if (chat2?.type !== 'chat') throw new Error();
    expect(chat2.payload.messages.map((m) => m.id)).toEqual([SESSION_BOOTSTRAP_MESSAGE_ID, 'u1', 'a1']);
    expect(chat2.payload.userInput).toBe('second');
  });

  it('run seeds the session mirror from host-restored history (fresh process)', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({
      requestId: 'r1',
      sessionId: 'restored-s1',
      prompt: 'follow-up',
      history: [
        { id: SESSION_BOOTSTRAP_MESSAGE_ID, role: 'assistant', content: 'stale bootstrap', timestamp: 1 },
        { id: 'u0', role: 'user', content: 'earlier', timestamp: 2 },
        { id: 'a0', role: 'assistant', content: 'answer', timestamp: 3 },
      ],
    });
    const chat = harness.toLoop.find((m) => m.type === 'chat');
    if (chat?.type !== 'chat') throw new Error('no chat frame');
    // stale bootstrap from the DB is dropped; the fresh one is prepended
    expect(chat.payload.messages.map((m) => m.id)).toEqual([SESSION_BOOTSTRAP_MESSAGE_ID, 'u0', 'a0']);
  });

  it('in-process history wins over host-restored payload on the same mirror', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'first' });
    harness.mediator.handleOutgoing({
      type: 'result',
      requestId: 'r1',
      response: { role: 'assistant', content: 'ok' },
      deltaMessages: [{ id: 'u1', role: 'user', content: 'first', timestamp: 2 }],
      logLength: 2,
    } as Extract<AgentWorkerToMainMessage, { type: 'result' }>);
    harness.run({
      requestId: 'r2',
      sessionId: 's1',
      prompt: 'second',
      history: [{ id: 'stale', role: 'user', content: 'should be ignored', timestamp: 0 }],
    });
    const chat2 = harness.toLoop.filter((m) => m.type === 'chat')[1];
    if (chat2?.type !== 'chat') throw new Error();
    expect(chat2.payload.messages.map((m) => m.id)).toEqual([SESSION_BOOTSTRAP_MESSAGE_ID, 'u1']);
  });
});

describe('UI-bound headless policies', () => {
  it('question skip: immediate tool error + question.skipped event (never hangs)', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'plan' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const outgoing = harness.mediator.handleOutgoing(
      toolRequest({ toolName: 'question', arguments: { question: 'which?', options: [{ label: 'A' }] } })
    );
    expect(outgoing).toEqual([]);
    expect(lastToolResponse(harness)).toMatchObject({
      success: false,
      toolRequestId: 'r1:1',
    });
    expect(harness.emitted.some((m) => m.type === 'harness-event' && m.name === 'question.skipped')).toBe(true);
  });

  it('question auto-default: answers with first option + question.answered', () => {
    const harness = createHarness();
    harness.init({
      ...BASE_INIT,
      mode: 'plan',
      policy: { question: { mode: 'auto-default', answers: { 'which?': 'custom-b' } } },
    });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    harness.mediator.handleOutgoing(
      toolRequest({ toolName: 'question', arguments: { question: 'which?', options: [{ label: 'A' }, { label: 'B' }] } })
    );
    expect(lastToolResponse(harness)).toMatchObject({ success: true });
    const result = lastToolResponse(harness).result as Record<string, unknown>;
    expect(result.answer).toBe('custom-b');
    const harnessEvent = harness.emitted.find((m) => m.type === 'harness-event');
    expect(harnessEvent).toMatchObject({ name: 'question.answered' });
  });

  it('todo runs in memory and snapshots via todo.updated', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    harness.mediator.handleOutgoing(toolRequest({
      toolName: 'todo',
      arguments: { goal: 'g', tasks: [{ id: 't1', summary: 's', status: 'pending' }] },
    }));
    const response = lastToolResponse(harness);
    expect(response.success).toBe(true);
    const payload = (response.result ?? {}) as Record<string, unknown>;
    expect((payload.todoList as Record<string, unknown>).goal).toBe('g');
    expect(harness.emitted.some((m) => m.type === 'harness-event' && m.name === 'todo.updated')).toBe(true);
  });

  it('UI-bound hallucinations fail fast with tool.unsupported', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    for (const name of ['app_list', 'app_render', 'browser', 'workspace_project_graph', 'mcp__srv__tool']) {
      const routed = harness.mediator.handleOutgoing(toolRequest({ toolName: name }));
      expect(routed).toEqual([]);
    }
    const events = harness.emitted.filter((m) => m.type === 'harness-event' && m.name === 'tool.unsupported');
    expect(events.length).toBe(5);
    expect(String(lastToolResponse(harness).error)).toContain('uiBoundUnsupported');
  });

  it('ask mode blocks mutating git actions at execution time (desktop FilteringToolRegistry semantics)', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'ask' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const blocked = harness.mediator.handleOutgoing(
      toolRequest({ toolName: 'git', toolRequestId: 'r1:2', arguments: { action: 'commit' } })
    );
    expect(blocked).toEqual([]);
    expect(harness.emitted.some((m) => m.type === 'harness-event' && m.name === 'tool.blocked')).toBe(true);

    const allowed = harness.mediator.handleOutgoing(
      toolRequest({ toolName: 'git', toolRequestId: 'r1:3', arguments: { action: 'status' } })
    );
    expect(allowed).toHaveLength(1);
  });

  it('rust-hosted tool requests pass through unmediated', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const frame = toolRequest({ toolName: 'workspace_read_file' });
    expect(harness.mediator.handleOutgoing(frame)).toEqual([frame]);
  });

  it('stream/result/tool-host-activity frames flow out unchanged', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const stream = { type: 'stream', requestId: 'r1', event: { type: 'content-delta', delta: 'x' } } as const;
    expect(harness.mediator.handleOutgoing(stream)).toEqual([stream]);
    const activity = { type: 'tool-host-activity', requestId: 'r1', toolRequestId: 't', phase: 'start' } as const;
    expect(harness.mediator.handleOutgoing(activity)).toEqual([activity]);
  });
});

describe('context pipeline local responders', () => {
  it('answers refresh-bootstrap-request in place', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const routed = harness.mediator.handleOutgoing({
      type: 'refresh-bootstrap-request',
      requestId: 'r1',
      bootstrapRequestId: 'r1:bootstrap-1',
    });
    expect(routed).toEqual([]);
    const response = harness.toLoop.find((m) => m.type === 'refresh-bootstrap-response');
    expect(response).toMatchObject({ bootstrapRequestId: 'r1:bootstrap-1', success: true });
  });

  it('acknowledges commit-context-compaction in memory with increasing generations', () => {
    const harness = createHarness();
    harness.init({ ...BASE_INIT, mode: 'agent' });
    harness.run({ requestId: 'r1', sessionId: 's1', prompt: 'p' });
    const intent = {
      requestId: 'cmp1',
      intent: { sessionId: 's1' },
      commit: { checkpointMessageId: 'c1', checkpointMessage: { id: 'c1', role: 'assistant' as const, content: '', timestamp: 1 }, insertIndex: 0, sourceMessageIds: [], retainedMessageIds: [] },
    };
    harness.mediator.handleOutgoing({ type: 'commit-context-compaction', chatRequestId: 'r1', request: intent } as never);
    const ack = harness.toLoop.find((m) => m.type === 'commit-context-compaction-response');
    expect(ack).toMatchObject({ success: true, generation: 1 });
  });
});
