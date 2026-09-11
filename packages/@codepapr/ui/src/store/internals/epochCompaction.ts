/**
 * epochCompaction（v5）：压缩 epoch 的统一提交（所有主线程入口共用）。
 *
 * 顺序（ADR-005 / ADR-015/016）：
 *   1. curator 落 MEMORY.md（pre-compact 卡点，写入发生在 Bootstrap 重渲染前）；
 *   2. rebuild 策略重读记忆重渲 Bootstrap → 写回 runtime config；
 *   3. 基座校验后插 checkpoint；
 *   4. rebuild：就地重建 agent；destroy：仅销毁旧 agent（/compact 在两回合之间，
 *      下一条消息按 sessionMessages 重建即可）；
 *   5. **await** 单事务 commit（失败在 commitCheckpointOrdered 内回滚 checkpoint）。
 *
 * 回合末、Goal 迭代间隙、/compact 全部走这一条路。Bootstrap 刷新失败非致命：
 * 沿用回合首冻结的 Bootstrap，绝不产出无记忆前缀的新 epoch。
 */

import type { CompactionTrigger, ICacheStatistics } from '@codepapr/types';
import type { SkillDefinition } from '@codepapr/core';
import type { AgentRuntimeHandle } from '../../agent/WorkerBackedAgent';
import { insertCheckpointAtRetainedBoundary } from '../../utils/contextCompaction';
import type { ContextCheckpointPayload } from '../../utils/contextCompaction';
import type { WorkMode } from '../../utils/agentPrompts';
import type { TaskModelRoute } from '../../utils/modelRouting';
import { loadMemorySectionForPrompt } from '../../utils/memoryFile';
import { createAgent, type AgentRuntimeConfig } from './agentFactory';
import { runPreCompactCurator } from './memoryTurnPipeline';
import { buildAgentSessionBootstrapPrompt } from './promptBuilders';
import { addConversationStats, getSessionConversationStats } from './stats';
import type { Settings, StoreGet, StoreSet, UIMessage } from './types';

/**
 * checkpoint 计划基于 base 消息数组计算（压缩模型调用期间 isLoading=false，
 * 用户可能 reset/清空/追加消息）。应用前校验当前数组是否仍是安全的插入基座：
 * 允许追加（长度增长且 insertIndex 之前的内容一致）；禁止删除/重排——旧
 * insertIndex 落到末尾会让已删除内容以摘要形式复活（#15）。
 */
export function isSafeCheckpointInsert(
  base: readonly UIMessage[] | undefined,
  current: readonly UIMessage[] | undefined,
  insertIndex: number
): boolean {
  if (base === current) return true;
  if (!base || !current) return false;
  if (current.length < base.length) return false;
  const checkLen = Math.min(Math.max(insertIndex, 0), base.length);
  for (let i = 0; i < checkLen; i += 1) {
    if (current[i] !== base[i]) return false;
  }
  return true;
}

/** maybeGenerateContextCheckpoint 成功分支的最小形状（避免模块间类型环）。 */
export interface EpochCheckpoint {
  message: UIMessage;
  cacheStats?: ICacheStatistics;
  modelTier: 'primary' | 'fast' | 'local';
  insertIndex: number;
}

export interface EpochCommitRequest {
  sessionId: string;
  workspace: string;
  messages: UIMessage[];
  trigger: CompactionTrigger;
  payload: ContextCheckpointPayload | null;
  checkpointMessageId: string;
}

/** 单事务提交回调（sendMessage 的 commitCheckpointOrdered；含失败回滚与 toast）。 */
export type EpochCommit = (request: EpochCommitRequest) => Promise<boolean>;

interface EpochCompactionCommon {
  checkpoint: EpochCheckpoint;
  baseMessages: readonly UIMessage[];
  trigger: CompactionTrigger;
  sessionId: string;
  /** curator 与 Bootstrap 都在这个工作区上读写记忆。 */
  workspacePath: string;
  settings: Settings;
  commit: EpochCommit;
}

/** rebuild 策略独有的运行时上下文（Goal 循环重建后要接管新句柄）。 */
export interface EpochRebuildContext {
  skillDefinitions: readonly SkillDefinition[];
  pluginsSection?: string;
  mode: WorkMode;
  route: TaskModelRoute;
  runtimeSystemPrompt: string;
  /** 回合首冻结的 Bootstrap：刷新失败时沿用，绝不产出无记忆前缀的 epoch。 */
  fallbackBootstrapPrompt?: string;
  runtimeAgentConfig: AgentRuntimeConfig;
}

export type EpochCompactionParams =
  | (EpochCompactionCommon & { strategy?: 'rebuild'; rebuild: EpochRebuildContext })
  | (EpochCompactionCommon & { strategy: 'destroy' });

export interface EpochCompactionResult {
  /** checkpoint 通过基座校验并已写入消息数组。 */
  applied: boolean;
  /** surface 单事务提交成功；false 时 commit 内部已回滚 checkpoint 消息。 */
  committed: boolean;
  /** rebuild 策略下就地重建的新 agent（Goal 循环据此替换在飞句柄）。 */
  rebuiltAgent: AgentRuntimeHandle | null;
}

export async function applyEpochCompaction(
  get: StoreGet,
  set: StoreSet,
  params: EpochCompactionParams
): Promise<EpochCompactionResult> {
  const {
    checkpoint,
    baseMessages,
    trigger,
    sessionId: sid,
    workspacePath,
    settings,
    commit,
  } = params;
  const strategy = params.strategy ?? 'rebuild';
  const rebuildContext = params.strategy === 'destroy' ? null : params.rebuild;

  // 卡点 2（pre-compact）：素材=本次将折叠的骨架；写入发生在 epoch 重渲染
  // Bootstrap 之前 → 新记忆随本 epoch 立即生效。无工作区（如未打开项目时的
  // /compact）没有记忆文件可维护，跳过。
  if (workspacePath.trim()) {
    const preCompactPayload = checkpoint.message.contextCheckpoint;
    await runPreCompactCurator({
      workspacePath,
      skeleton: preCompactPayload?.skeleton ?? [],
      activityText: preCompactPayload?.activityText,
      summaryBlock: preCompactPayload?.summaryBlock,
      settings,
    });
  }

  const prevAgent = get()._agent;
  const prevAgentOwner = get()._agentSessionId;

  let epochPromptKey: string | null = null;
  if (rebuildContext) {
    const {
      runtimeSystemPrompt,
      fallbackBootstrapPrompt,
      runtimeAgentConfig,
      skillDefinitions,
      pluginsSection,
      mode,
    } = rebuildContext;
    // 压缩 = epoch 变化：Bootstrap 随 epoch 刷新。重读记忆重渲染，写回 config
    // ——就地重建与之后任何 crash/换模型重建都拿到刷新版，而不是回合首冻结的
    // 旧快照。刷新失败非致命：沿用旧 Bootstrap。
    let epochBootstrap = fallbackBootstrapPrompt;
    try {
      const epochMemorySection = (await loadMemorySectionForPrompt(workspacePath)) ?? undefined;
      epochBootstrap = buildAgentSessionBootstrapPrompt(
        settings,
        workspacePath,
        skillDefinitions,
        epochMemorySection,
        pluginsSection,
        mode,
      );
    } catch {
      // keep frozen turn-start bootstrap
    }
    if (epochBootstrap && epochBootstrap !== runtimeAgentConfig.sessionBootstrapPrompt) {
      runtimeAgentConfig.sessionBootstrapPrompt = epochBootstrap;
    }
    epochPromptKey = [runtimeSystemPrompt, epochBootstrap]
      .filter(Boolean)
      .join('\n\n--- session-bootstrap ---\n\n');
  }

  let checkpointApplied = false;
  let turnNextMessages: UIMessage[] | null = null;
  let rebuiltAgent: AgentRuntimeHandle | null = null;
  set((s) => {
    const currentSessionMessages = s.sessionMessages[sid] ?? [];
    // 校验插入基座：reset/清空后旧 insertIndex 会把已删除内容以摘要形式
    // 插回末尾（复活）——整个 checkpoint 丢弃。
    if (!isSafeCheckpointInsert(baseMessages, currentSessionMessages, checkpoint.insertIndex)) {
      return {};
    }
    checkpointApplied = true;
    const nextSessionMessages = insertCheckpointAtRetainedBoundary(
      currentSessionMessages,
      checkpoint.message,
      checkpoint.insertIndex
    );
    turnNextMessages = nextSessionMessages;
    const isCurrentSession = s.activeSessionId === sid;
    const statsPatch = checkpoint.cacheStats
      ? {
          sessionConversationStats: {
            ...s.sessionConversationStats,
            [sid]: addConversationStats(
              getSessionConversationStats(s.sessionConversationStats, sid),
              checkpoint.modelTier === 'primary' ? 'primary' : 'fast',
              checkpoint.cacheStats
            ),
          },
        }
      : {};
    // checkpoint 生成期间用户可能已切走：只更新目标会话的消息与统计。
    // s._agent 属于当前查看的会话，绝不能清空/替换（旧实现会句柄泄漏）。
    if (!isCurrentSession) {
      return {
        sessionMessages: { ...s.sessionMessages, [sid]: nextSessionMessages },
        ...statsPatch,
      };
    }
    if (strategy === 'destroy') {
      const ownsAgent = s._agent !== null && s._agentSessionId === sid;
      return {
        messages: nextSessionMessages,
        sessionMessages: { ...s.sessionMessages, [sid]: nextSessionMessages },
        conversationStats: checkpoint.cacheStats
          ? addConversationStats(
              s.conversationStats,
              checkpoint.modelTier === 'primary' ? 'primary' : 'fast',
              checkpoint.cacheStats
            )
          : s.conversationStats,
        ...statsPatch,
        ...(ownsAgent
          ? { _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null }
          : {}),
      };
    }
    const { route, runtimeSystemPrompt, runtimeAgentConfig } = rebuildContext!;
    rebuiltAgent = createAgent(
      settings,
      sid,
      workspacePath,
      nextSessionMessages,
      {
        model: route.model,
        thinkingEnabled: route.thinkingEnabled,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        systemPrompt: runtimeSystemPrompt,
      },
      runtimeAgentConfig
    );
    return {
      messages: nextSessionMessages,
      sessionMessages: { ...s.sessionMessages, [sid]: nextSessionMessages },
      conversationStats: checkpoint.cacheStats
        ? addConversationStats(
            s.conversationStats,
            checkpoint.modelTier === 'primary' ? 'primary' : 'fast',
            checkpoint.cacheStats
          )
        : s.conversationStats,
      ...statsPatch,
      // 检查点压缩了上下文：旧 agent 的 logStore 已失效，句柄必须换成
      // 带新上下文的新实例，绝不保留旧上下文继续跑。
      _agent: rebuiltAgent,
      _agentModel: route.model,
      _agentPromptKey: epochPromptKey,
      _agentSessionId: sid,
    };
  });
  if (!checkpointApplied || !turnNextMessages) {
    return { applied: false, committed: false, rebuiltAgent: null };
  }
  // 被替换/失效的旧 agent 已空闲（回合结束/迭代间隙），销毁以回收 worker；
  // 仅当它仍属于本会话时才销毁，避免误伤竞态下新建的 agent。app-agent
  // （papr.agent.run）不占 isLoading：detach 等其结算完自毁。
  if (prevAgent && prevAgentOwner === sid && get()._agent !== prevAgent) {
    try {
      if (prevAgent.hasActiveAppAgentRequests?.()) {
        prevAgent.detachAndCleanupWhenIdle?.();
      } else {
        prevAgent.destroy();
      }
    } catch {
      // already torn down
    }
  }
  // ADR-005 单事务提交。必须 await：失败回滚不得与下一回合的 surface 读取
  // 竞态（旧 void commit 的「UI 有 checkpoint、surface 未提交」窗口在这里消失）。
  const committed = await commit({
    sessionId: sid,
    workspace: workspacePath,
    messages: turnNextMessages,
    trigger,
    payload: checkpoint.message.contextCheckpoint ?? null,
    checkpointMessageId: checkpoint.message.id,
  });
  return { applied: true, committed, rebuiltAgent };
}
