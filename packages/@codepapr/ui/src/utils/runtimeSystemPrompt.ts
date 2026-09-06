/**
 * 纯函数版 runtime 系统提示词装配（与桌面 promptBuilders 同源）。
 *
 * 单独成文件的原因：sidecar/Node 侧的 headlessHarness 必须复用同一份装配
 * 逻辑，而 promptBuilders.ts 的其余导出（角色卡、发布目录）依赖 WebView
 * store 图谱，无法进 Node bundle。本文件只允许 import core/types 与纯
 * utils，由 promptBuilders.ts re-export 保持桌面侧引用不变。
 */
import {
  buildRuntimeSystemPrompt,
  DEFAULT_PROMPT_TOOL_NAMES,
  isMinimalAgentToolName,
  isPromptToolVisible,
  listDelegableAgents,
  resolveAgentDescription,
  type AgentDefinition,
} from '@codepapr/core';
import { hasEnabledMcpSearch } from './mcpTypes';
import { shouldExposeReadImage } from './visionRouting';
import type { WorkMode } from './agentPrompts';
import type { Settings } from '../store/internals/types';

export function buildAgentRuntimeSystemPrompt(
  settings: Settings,
  mode: WorkMode,
  workspacePath: string,
  rulesSection?: string,
  runtime?: { agentDefinitions?: AgentDefinition[]; model?: string }
): string {
  const effectiveModel = (runtime?.model ?? settings.model).trim();
  const multimodalEnabled = shouldExposeReadImage(settings, effectiveModel);
  const mcpSearchEnabled = hasEnabledMcpSearch(settings.mcp);
  // 与工具注册层（registerWorkspaceTools / FilteringToolRegistry）的可见性条件保持对齐，
  // 避免系统提示词提及模型实际不可用的工具。mode ∩ profile：极简工具面只列举 allowlist。
  const toolNames = DEFAULT_PROMPT_TOOL_NAMES.filter((name) =>
    isPromptToolVisible(name, mode, { multimodalEnabled, mcpSearchEnabled }))
    .filter((name) => settings.agentToolProfile !== 'minimal' || isMinimalAgentToolName(name));

  const delegableAgents = listDelegableAgents(runtime?.agentDefinitions ?? [])
    .filter((agent) => agent.model !== 'mentor' || settings.mentorEnabled)
    .map((agent) => ({
      name: agent.name,
      description: resolveAgentDescription(agent, settings.lang ?? 'zh-CN'),
    }));

  return buildRuntimeSystemPrompt({
    mode,
    workspacePath,
    lang: settings.lang ?? 'zh-CN',
    rulesSection,
    toolNames,
    mentorEnabled: settings.mentorEnabled,
    delegableAgents,
    toolProfile: settings.agentToolProfile,
  });
}
