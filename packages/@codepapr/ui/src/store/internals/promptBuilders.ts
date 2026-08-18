import {
  AppendOnlyLog,
  APP_ONLY_TOOL_NAMES,
  buildSessionBootstrapPrompt,
  buildSkillsSection,
  DEFAULT_PROMPT_TOOL_NAMES,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  isReadOnlyMode,
  MUTATING_TOOL_NAMES,
  PLAN_ONLY_TOOL_NAMES,
  Serializer,
  type AgentDefinition,
  type PruneOptions,
  type SkillDefinition,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';
import type { IMessage } from '@codepapr/types';
import type { WorkMode } from '../../utils/agentPrompts';
import { hasEnabledMcpSearch } from '../../utils/mcpTypes';
import { buildEffectiveContextMessages } from '../../utils/contextCompaction';
import { SESSION_BOOTSTRAP_MESSAGE_ID } from '../../utils/contextSurface';
import { resolveMultimodalEnabled } from './settingsNormalizer';
import type { Settings, UIMessage } from './types';
import { getActiveCharacterPrompt } from '../charactersStore';

export function toCoreMessages(
  messages: UIMessage[],
  sessionBootstrapPrompt?: string,
  pruneOptions?: PruneOptions
): IMessage[] {
  const restoredMessages = buildEffectiveContextMessages(messages, { pruneOptions });
  const normalizedBootstrapPrompt = sessionBootstrapPrompt?.trim();
  if (!normalizedBootstrapPrompt) {
    return restoredMessages;
  }

  return [
    {
      id: SESSION_BOOTSTRAP_MESSAGE_ID,
      role: 'assistant',
      content: normalizedBootstrapPrompt,
      timestamp: 1,
      metadata: {
        sessionBootstrap: true,
        isPrefixSystem: true,
      },
    },
    ...restoredMessages,
  ];
}

export function createLogFromMessages(
  sessionId: string,
  messages: UIMessage[],
  sessionBootstrapPrompt?: string,
  pruneOptions?: PruneOptions
): AppendOnlyLog {
  const log = new AppendOnlyLog(sessionId);
  const restoredMessages = toCoreMessages(messages, sessionBootstrapPrompt, pruneOptions);
  if (restoredMessages.length === 0) return log;

  log.loadFromSnapshot({
    messages: restoredMessages,
    lastMessageIndex: restoredMessages.length - 1,
    totalBytes: restoredMessages.reduce(
      (sum, message) => sum + Serializer.getByteLength(message),
      0
    ),
  });
  return log;
}

export function buildAgentRuntimeSystemPrompt(
  settings: Settings,
  mode: WorkMode,
  workspacePath: string,
  rulesSection?: string,
  runtime?: { agentDefinitions?: AgentDefinition[]; model?: string }
): string {
  const effectiveModel = (runtime?.model ?? settings.model).trim();
  const multimodalEnabled = resolveMultimodalEnabled(settings, effectiveModel);
  const mcpSearchEnabled = hasEnabledMcpSearch(settings.mcp);
  // 与工具注册层（registerWorkspaceTools / FilteringToolRegistry）的可见性条件保持对齐，
  // 避免系统提示词提及模型实际不可用的工具。
  const toolNames = DEFAULT_PROMPT_TOOL_NAMES.filter((name) => {
    if (name === 'read_image') return multimodalEnabled;
    if (APP_ONLY_TOOL_NAMES.has(name)) return mode === 'app';
    if (PLAN_ONLY_TOOL_NAMES.has(name)) return mode === 'plan';
    if (MUTATING_TOOL_NAMES.has(name)) return !isReadOnlyMode(mode);
    if (name === 'websearch' || name === 'webfetch') return !mcpSearchEnabled;
    return true;
  });

  return buildRuntimeSystemPrompt({
    mode,
    workspacePath,
    lang: settings.lang ?? 'zh-CN',
    rulesSection,
    toolNames,
    mentorEnabled: settings.mentorEnabled,
  });
}

export function buildProjectGraphBootstrapSummary(
  graph: WorkspaceProjectGraphResult,
  maxFilesPerDir: number = 12
): string {
  const filesByDir = new Map<string, WorkspaceProjectGraphResult['files']>();
  for (const file of graph.files ?? []) {
    const segments = file.path.split('/').filter(Boolean);
    const dir = segments.length > 1 ? segments.slice(0, -1).join('/') : '.';
    const existing = filesByDir.get(dir) ?? [];
    existing.push(file);
    filesByDir.set(dir, existing);
  }

  const symbolNodesByPath = new Map<string, string[]>();
  for (const node of graph.nodes ?? []) {
    if (node.kind !== 'symbol') continue;
    const existing = symbolNodesByPath.get(node.path) ?? [];
    existing.push(node.symbol?.signature?.split('(')[0]?.trim() || node.label);
    symbolNodesByPath.set(node.path, existing);
  }

  const lines: string[] = [];
  const sortedDirs = [...filesByDir.entries()].sort(([a], [b]) => {
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b);
  });

  for (const [dir, files] of sortedDirs) {
    const displayFiles = files.slice(0, maxFilesPerDir);
    lines.push(`- ${dir}/ (${files.length} file${files.length > 1 ? 's' : ''})`);
    for (const file of displayFiles) {
      const symbols = symbolNodesByPath.get(file.path) ?? [];
      const entry = file.entryPoint ? ' [entry]' : '';
      const symbolStr = symbols.length > 0 ? ` → ${symbols.slice(0, 5).join(', ')}` : '';
      lines.push(`  - ${file.path}${entry}${symbolStr}`);
    }
    if (files.length > maxFilesPerDir) {
      lines.push(`  ... +${files.length - maxFilesPerDir} more files`);
    }
  }

  if (graph.summary) {
    lines.push('');
    lines.push(`Summary: ${graph.summary.files} files, ${graph.summary.symbols} symbols, ${graph.summary.imports} imports, ${graph.summary.reexports} re-exports, ${graph.summary.entryPoints} entry points${graph.summary.truncated ? ' (truncated)' : ''}`);
  }

  return lines.join('\n');
}

export function buildAgentSessionBootstrapPrompt(
  settings: Settings,
  workspacePath: string,
  skillDefinitions: readonly SkillDefinition[] = [],
  memorySection?: string
): string {
  const customPromptSection = (settings.systemPrompt ?? '').trim();
  const bootstrap = buildSessionBootstrapPrompt({
    workspacePath,
    lang: settings.lang ?? 'zh-CN',
    skillsSection: buildSkillsSection(skillDefinitions, settings.lang ?? 'zh-CN'),
    memorySection,
    customPromptSection: customPromptSection || undefined,
  });
  const characterPrompt = getActiveCharacterPrompt();
  if (!characterPrompt) return bootstrap;

  const lang = settings.lang ?? 'zh-CN';
  const heading = lang === 'en' ? '## Character' : lang === 'zh-TW' ? '## 角色人設' : '## 角色人设';
  const hint =
    lang === 'en'
      ? 'The following is a personality overlay for replies to the user. It does not change tools or engineering duties.'
      : lang === 'zh-TW'
        ? '以下為回覆使用者時的人設疊加，不改變工具與工程職責。'
        : '以下为回复用户时的人设叠加，不改变工具与工程职责。';
  return [bootstrap, '', heading, hint, '', characterPrompt].join('\n');
}

export function buildAgentRuntimeUserPrompt(params: {
  settings: Settings;
  mode: WorkMode;
  workspacePath: string;
  input: string;
  todoDigest?: string;
}): string {
  // 项目结构概览与项目诊断不再注入每轮 user prompt（大项目下每轮数万 token
  // 且位于请求尾部无法命中前缀缓存）；由 agent 通过 graph / diagnostics 工具按需获取。
  return buildRuntimeUserPrompt({
    mode: params.mode,
    input: params.input,
    workspacePath: params.workspacePath,
    lang: params.settings.lang ?? 'zh-CN',
    todoDigest: params.todoDigest,
  });
}
