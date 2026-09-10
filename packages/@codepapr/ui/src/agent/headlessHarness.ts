/**
 * Headless harness mediator（外部 CLI / 评测机路径）。
 *
 * 职责（对应 CLI 运行时对等方案 §3-§5）：
 *  1. 吃 `harness/init`：在 **sidecar 进程内**用桌面同源装配逻辑构造
 *     init/chat payload——settings（DEFAULT_SETTINGS + CLI 覆盖 →
 *     toWorkerAgentSettings）、工具定义（headlessToolCatalog，core 同源
 *     可见性规则）、runtime 系统提示词（utils/runtimeSystemPrompt 同一
 *     函数）、session bootstrap（core buildSessionBootstrapPrompt）。
 *  2. 吃 `harness/run`：合成与桌面逐字节同构的 `chat` 帧喂给同一个
 *     Agent 循环（agentRuntimeLoop），CLI 不再维护第二套帧/工具/提示词。
 *  3. 出站帧中介：Rust-hosted 工具请求原样透传（server 的
 *     RUST_HOSTED_TOOLS 路径不变）；UI-bound 工具在此按 headless 策略
 *     就地应答——question（auto-default / skip）、todo（内存实现，
 *     core 同源）、ask 模式执行期只读拦截（镜像桌面
 *     FilteringToolRegistry.execute 语义）、其余 UI-bound 一律显式
 *     unsupported 错误（绝不挂到 toolIpcTimeoutMs，避免污染评测 trace）。
 *
 * 安全默认：未收到 harness/init 前本 mediator 完全透传，桌面既有
 * init/chat 路径行为零变化。
 */
import {
  allowToolForReadOnlyMode,
  buildSessionBootstrapPrompt,
  buildMinimalToolSurfaceSection,
  buildSkillsSection,
  applyTodoToolRequest,
  isReadOnlyMode,
  readOnlyModeBlockMessage,
  renderTodoListDigest,
  TODO_CREATE_REJECTED_NOTICE,
} from '@codepapr/core';
import type { IToolDefinition, IMessage, TodoListContext } from '@codepapr/types';
import { hasEnabledMcpSearch, parseMcpToolName } from '../utils/mcpTypes';
import { shouldExposeReadImage } from '../utils/visionRouting';
import { SESSION_BOOTSTRAP_MESSAGE_ID } from '../utils/contextSurface';
import {
  DEFAULT_SETTINGS,
  normalizeCustomSystemPrompt,
} from '../store/internals/defaults';
import {
  resolveWorkerMultimodalEnabled,
  toWorkerAgentSettings,
} from '../store/internals/workerSettings';
import type { Settings } from '../store/internals/types';
import { buildAgentRuntimeSystemPrompt } from '../utils/runtimeSystemPrompt';
import {
  buildHeadlessToolDefinitions,
  HEADLESS_UI_BOUND_EXCLUDED,
} from './headlessToolCatalog';
import {
  HARNESS_PROTOCOL_VERSION,
  type AgentWorkerChatPayload,
  type AgentWorkerToMainMessage,
  type HarnessEventName,
  type HarnessInitPayload,
  type HarnessRunPayload,
  type MainToAgentWorkerMessage,
} from './agentWorkerProtocol';

/** P0 评测边界：即使模型幻觉调用也立即显式失败的工具（除 catalog 排除项）。 */
const ADDITIONAL_UI_BOUND_UNSUPPORTED: ReadonlySet<string> = new Set([
  'workspace_project_graph',
  'workspace_project_diagnostics',
  'ui_task',
]);

export interface HarnessMediatorDeps {
  /** 把帧注入 Agent 循环（等同 stdin 收到该帧）。 */
  deliverToLoop: (message: MainToAgentWorkerMessage) => void;
  /** 直接向 stdout 写帧（不经出站中介，用于 mediator 合成帧）。 */
  emit: (message: AgentWorkerToMainMessage) => void;
}

interface AssembledHarness {
  mode: 'ask' | 'plan' | 'agent';
  settings: Settings;
  workerSettings: AgentWorkerChatPayload['settings'];
  toolDefinitions: IToolDefinition[];
  workspacePath: string;
  systemPrompt: string;
  bootstrapPrompt: string;
  rulesSection?: string;
  questionPolicy: NonNullable<NonNullable<HarnessInitPayload['policy']>['question']>;
}

interface SessionMirror {
  /** canonical 历史（不含 bootstrap；由 result.deltaMessages 累积）。 */
  messages: IMessage[];
  todo: TodoListContext | null;
  /** 本 run（= 一次用户回合）的 tasks 创建窗口是否尚未被消耗。 */
  creationOpen: boolean;
  compactionGeneration: number;
}

export interface HarnessMediator {
  /** 入站帧：harness/* 消费并返回 true，其余透传给循环。 */
  handleInbound(message: MainToAgentWorkerMessage): boolean;
  /** 出站帧：可吞掉/改写/追加（返回要写出的帧列表）。 */
  handleOutgoing(message: AgentWorkerToMainMessage): AgentWorkerToMainMessage[];
}

export function createHarnessMediator(deps: HarnessMediatorDeps): HarnessMediator {
  let assembled: AssembledHarness | null = null;
  const sessions = new Map<string, SessionMirror>();
  /** harness/run 登记的 requestId→session，供本地应答与历史回写查找。 */
  const requestSessions = new Map<string, string>();

  function requireAssembled(): AssembledHarness {
    if (!assembled) {
      throw new Error('harness/run received before harness/init');
    }
    return assembled;
  }

  function getSession(sessionId: string): SessionMirror {
    let mirror = sessions.get(sessionId);
    if (!mirror) {
      mirror = { messages: [], todo: null, creationOpen: false, compactionGeneration: 0 };
      sessions.set(sessionId, mirror);
    }
    return mirror;
  }

  function sessionIdForRequest(requestId: string): string {
    return requestSessions.get(requestId) ?? '';
  }

  function handleInit(payload: HarnessInitPayload): void {
    const mode = payload.mode;
    if (mode !== 'ask' && mode !== 'plan' && mode !== 'agent') {
      throw new Error(`harness mode 非法: ${String(mode)}（仅 ask/plan/agent）`);
    }
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(payload.settingsOverride as Partial<Settings> | undefined),
      systemPrompt: normalizeCustomSystemPrompt(
        payload.systemPromptOverride ??
        (payload.settingsOverride as { systemPrompt?: string } | undefined)?.systemPrompt ??
        DEFAULT_SETTINGS.systemPrompt
      ),
      experimentalCharacters: false,
    };
    const workerSettings = toWorkerAgentSettings(settings);
    const lang = settings.lang ?? 'zh-CN';
    const toolDefinitions = buildHeadlessToolDefinitions({
      mode,
      multimodalEnabled:
        resolveWorkerMultimodalEnabled(workerSettings, workerSettings.model)
        || shouldExposeReadImage(settings, settings.model),
      mcpSearchEnabled: hasEnabledMcpSearch(settings.mcp),
      toolProfile: settings.agentToolProfile ?? 'default',
    });
    const systemPrompt = buildAgentRuntimeSystemPrompt(
      settings,
      mode,
      payload.workspacePath,
      payload.rulesSection
    );
    const bootstrapPrompt = buildSessionBootstrapPrompt({
      workspacePath: payload.workspacePath,
      lang,
      skillsSection: buildSkillsSection([], lang),
      customPromptSection: (settings.systemPrompt ?? '').trim() || undefined,
      toolSurfaceSection: settings.agentToolProfile === 'minimal'
        ? buildMinimalToolSurfaceSection(lang)
        : undefined,
    });

    assembled = {
      mode,
      settings,
      workerSettings,
      toolDefinitions,
      workspacePath: payload.workspacePath,
      systemPrompt,
      bootstrapPrompt,
      rulesSection: payload.rulesSection,
      questionPolicy: payload.policy?.question ?? { mode: 'skip' },
    };

    deps.deliverToLoop({
      type: 'init',
      payload: {
        settings: workerSettings,
        toolDefinitions,
        workspacePath: payload.workspacePath,
        runtime: {
          mode,
          lang,
          rulesSection: payload.rulesSection,
          customPrompt: (settings.systemPrompt ?? '').trim() || undefined,
        },
      },
    });
    deps.emit({
      type: 'harness-ready',
      requestId: payload.requestId,
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      mode,
      toolNames: toolDefinitions.map((tool) => tool.name),
    });
  }

  function handleRun(payload: HarnessRunPayload): void {
    const harness = requireAssembled();
    const mirror = getSession(payload.sessionId);
    // 一次 harness/run = 一个用户回合，开启该回合的 todo 创建窗口。
    mirror.creationOpen = true;
    if (mirror.messages.length === 0 && payload.history && payload.history.length > 0) {
      // Host-restored multi-run history: seed the mirror so this process
      // continues the conversation instead of cold-starting.
      mirror.messages = payload.history.filter(
        (item) => item.id !== SESSION_BOOTSTRAP_MESSAGE_ID
      );
    }
    const bootstrapMessage: IMessage = {
      id: SESSION_BOOTSTRAP_MESSAGE_ID,
      role: 'assistant',
      content: harness.bootstrapPrompt,
      timestamp: 1,
      metadata: { sessionBootstrap: true, isPrefixSystem: true },
    };
    const lang = harness.settings.lang ?? 'zh-CN';
    const customPrompt = (harness.settings.systemPrompt ?? '').trim() || undefined;
    deps.deliverToLoop({
      type: 'chat',
      payload: {
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        workspacePath: harness.workspacePath,
        messages: [bootstrapMessage, ...mirror.messages],
        userInput: payload.prompt,
        userMessageId: payload.userMessageId,
        todoSnapshot: mirror.todo ?? null,
        settings: harness.workerSettings,
        providerName: harness.workerSettings.provider,
        model: harness.workerSettings.model,
        systemPrompt: harness.systemPrompt,
        parameters: {
          temperature: harness.settings.temperature,
          topP: harness.settings.topP,
          maxTokens: harness.settings.maxTokens,
          thinkingEnabled: harness.settings.thinkingEnabled,
          reasoningEffort: harness.settings.thinkingEffort,
          thinkingBudgetTokens: harness.settings.thinkingBudgetTokens,
          thinkingPayload: harness.settings.thinkingPayload,
        },
        toolDefinitions: harness.toolDefinitions,
        runtime: {
          mode: harness.mode,
          lang,
          rulesSection: harness.rulesSection,
          customPrompt,
        },
      },
    });
  }

  function respondTool(
    requestId: string,
    toolRequestId: string,
    success: boolean,
    result?: unknown,
    error?: string
  ): void {
    deps.deliverToLoop({
      type: 'tool-response',
      payload: {
        requestId,
        toolRequestId,
        success,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    });
  }

  function emitHarnessEvent(
    name: HarnessEventName,
    requestId: string,
    sessionId: string,
    payload: Record<string, unknown>
  ): void {
    deps.emit({ type: 'harness-event', requestId, sessionId, name, payload });
  }

  function handleQuestion(
    message: Extract<AgentWorkerToMainMessage, { type: 'tool-request' }>
  ): void {
    const harness = requireAssembled();
    const { requestId, toolRequestId, arguments: args } = message;
    const sessionId = sessionIdForRequest(requestId);
    const question = typeof args.question === 'string' ? args.question : '';
    const policy = harness.questionPolicy;
    const presetAnswer = policy.answers?.[question];
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const firstLabel = rawOptions
      .map((item) => (typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object'
          ? String((item as Record<string, unknown>).label ?? '').trim()
          : ''))
      .find((label) => label.length > 0);
    const answer = presetAnswer ?? firstLabel;
    if (policy.mode === 'auto-default' && answer) {
      respondTool(requestId, toolRequestId, true, {
        question,
        answer,
        source: presetAnswer !== undefined ? 'answers-file' : 'auto-default',
      });
      emitHarnessEvent('question.answered', requestId, sessionId, { question, answer });
      return;
    }
    respondTool(
      requestId,
      toolRequestId,
      false,
      undefined,
      `question skipped: headless run has no answer for this question (policy=${policy.mode})`
    );
    emitHarnessEvent('question.skipped', requestId, sessionId, { question });
  }

  function handleTodo(
    message: Extract<AgentWorkerToMainMessage, { type: 'tool-request' }>
  ): void {
    const { requestId, toolRequestId, arguments: args } = message;
    const sessionId = sessionIdForRequest(requestId);
    const mirror = getSession(sessionId);
    const result = applyTodoToolRequest(mirror.todo, args, {
      creationOpen: mirror.creationOpen,
      defaultGoal: mirror.todo?.goal ?? '',
    });
    if (result.rejected) {
      // 状态零变化：只把当前快照 + 拒绝说明回传给模型。
      respondTool(requestId, toolRequestId, true, {
        todoList: result.ctx,
        digest: renderTodoListDigest(result.ctx),
        notice: TODO_CREATE_REJECTED_NOTICE,
      });
      return;
    }
    if (result.created) {
      mirror.creationOpen = false;
    }
    mirror.todo = result.ctx;
    const digest = renderTodoListDigest(result.ctx);
    respondTool(requestId, toolRequestId, true, { todoList: result.ctx, digest });
    emitHarnessEvent('todo.updated', requestId, sessionId, { digest });
  }

  /** 返回 null = 透传；返回 [] = 已本地应答并吞掉。 */
  function routeOutgoingToolRequest(
    message: Extract<AgentWorkerToMainMessage, { type: 'tool-request' }>
  ): AgentWorkerToMainMessage[] | null {
    if (!assembled) return null;
    const { toolName, arguments: args, requestId, toolRequestId } = message;
    if (toolName === 'question') {
      handleQuestion(message);
      return [];
    }
    if (toolName === 'todo') {
      handleTodo(message);
      return [];
    }
    // ask 执行期二次校验：镜像桌面 FilteringToolRegistry.execute（如 git 仅
    // 允许 GIT_READ_ONLY_ACTIONS）。定义层已剔除变更工具，这里兜住幻觉调用。
    if (isReadOnlyMode(assembled.mode)) {
      const def: IToolDefinition = assembled.toolDefinitions.find((tool) => tool.name === toolName)
        ?? { name: toolName, description: '', parameters: { type: 'object', properties: {} } };
      if (!allowToolForReadOnlyMode(def, args)) {
        respondTool(requestId, toolRequestId, false, undefined, readOnlyModeBlockMessage(def, args));
        emitHarnessEvent('tool.blocked', requestId, sessionIdForRequest(requestId), {
          toolName,
          reason: 'readOnlyMode',
        });
        return [];
      }
    }
    if (
      HEADLESS_UI_BOUND_EXCLUDED.has(toolName)
      || ADDITIONAL_UI_BOUND_UNSUPPORTED.has(toolName)
      || parseMcpToolName(toolName) !== null
    ) {
      respondTool(
        requestId,
        toolRequestId,
        false,
        undefined,
        `uiBoundUnsupported: ${toolName} 不在 headless harness 能力面内（CLI 契约 §5）`
      );
      emitHarnessEvent('tool.unsupported', requestId, sessionIdForRequest(requestId), { toolName });
      return [];
    }
    return null; // Rust-hosted：透传给 server
  }

  function updateHistoryOnResult(
    message: Extract<AgentWorkerToMainMessage, { type: 'result' }>
  ): void {
    const sessionId = sessionIdForRequest(message.requestId);
    if (!sessionId) return;
    const mirror = getSession(sessionId);
    if (message.compacted && message.fullMessages) {
      mirror.messages = message.fullMessages.filter(
        (item) => item.id !== SESSION_BOOTSTRAP_MESSAGE_ID
      );
    } else {
      mirror.messages = [
        ...mirror.messages,
        ...message.deltaMessages.filter((item) => item.id !== SESSION_BOOTSTRAP_MESSAGE_ID),
      ];
    }
  }

  return {
    handleInbound(message) {
      if (message.type === 'harness/ping') {
        deps.emit({ type: 'harness-pong', protocolVersion: HARNESS_PROTOCOL_VERSION });
        return true;
      }
      if (message.type === 'harness/init') {
        try {
          handleInit(message.payload);
        } catch (error) {
          deps.emit({
            type: 'error',
            requestId: message.payload.requestId,
            error: `harness/init failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return true;
      }
      if (message.type === 'harness/run') {
        const payload = message.payload;
        requestSessions.set(payload.requestId, payload.sessionId);
        try {
          handleRun(payload);
        } catch (error) {
          requestSessions.delete(payload.requestId);
          deps.emit({
            type: 'error',
            requestId: payload.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      }
      return false;
    },

    handleOutgoing(message) {
      if (!assembled) return [message];
      if (message.type === 'tool-request') {
        const routed = routeOutgoingToolRequest(message);
        return routed ?? [message];
      }
      if (message.type === 'result') {
        updateHistoryOnResult(message);
        requestSessions.delete(message.requestId);
        return [message];
      }
      if (message.type === 'error' || message.type === 'cancelled') {
        requestSessions.delete(message.requestId);
        return [message];
      }
      if (message.type === 'refresh-bootstrap-request') {
        deps.deliverToLoop({
          type: 'refresh-bootstrap-response',
          bootstrapRequestId: message.bootstrapRequestId,
          success: true,
          bootstrap: null,
        });
        return [];
      }
      if (message.type === 'commit-context-compaction') {
        const sessionId = message.request.intent.sessionId || sessionIdForRequest(message.chatRequestId);
        const mirror = getSession(sessionId);
        mirror.compactionGeneration += 1;
        deps.deliverToLoop({
          type: 'commit-context-compaction-response',
          requestId: message.request.requestId,
          success: true,
          generation: mirror.compactionGeneration,
          compactionId: `harness-compaction-${mirror.compactionGeneration}`,
        });
        return [];
      }
      return [message];
    },
  };
}
