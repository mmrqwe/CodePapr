import {
  AppendOnlyLog,
  buildSessionBootstrapPrompt,
  buildMinimalToolSurfaceSection,
  buildSkillsSection,
  buildRuntimeUserPrompt,
  Serializer,
  type PruneOptions,
  type SkillDefinition,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';
import type { IMessage } from '@codepapr/types';
import type { WorkMode } from '../../utils/agentPrompts';
import { buildEffectiveContextMessages } from '../../utils/contextCompaction';
import { SESSION_BOOTSTRAP_MESSAGE_ID } from '../../utils/contextSurface';
export { buildAgentRuntimeSystemPrompt } from '../../utils/runtimeSystemPrompt';
import type { Lang, Settings, UIMessage } from './types';
import { getActiveCharacter } from '../charactersStore';
import {
  buildCharacterSystemPrompt,
  effectiveCharacterInteractionMode,
  expandCharacterMacros,
  sanitizeCachePrompt,
} from '../../utils/characterTypes';
import { useAppRuntimeStore } from '../appRuntimeStore';
import {
  buildPublishCatalogSection,
  collectPublishCatalogTargets,
} from '../../papr/pluginPublishCatalog';

export function toCoreMessages(
  messages: UIMessage[],
  sessionBootstrapPrompt?: string,
  pruneOptions?: PruneOptions,
  options?: { omitImages?: boolean }
): IMessage[] {
  const restoredMessages = buildEffectiveContextMessages(messages, { pruneOptions });
  const withoutImages = options?.omitImages
    ? restoredMessages.map((message) => {
        if (!message.images?.length) return message;
        const next = { ...message };
        delete next.images;
        return next;
      })
    : restoredMessages;
  const normalizedBootstrapPrompt = sessionBootstrapPrompt?.trim();
  if (!normalizedBootstrapPrompt) {
    return withoutImages;
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
    ...withoutImages,
  ];
}

export function createLogFromMessages(
  sessionId: string,
  messages: UIMessage[],
  sessionBootstrapPrompt?: string,
  pruneOptions?: PruneOptions,
  options?: { omitImages?: boolean }
): AppendOnlyLog {
  const log = new AppendOnlyLog(sessionId);
  const restoredMessages = toCoreMessages(messages, sessionBootstrapPrompt, pruneOptions, options);
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

/**
 * 目录树 + 符号摘要（供 explore/scout 子代理 Bootstrap 注入）。
 * per-dir 条数与总量都有上限：主会话已不再注入 project-graph，子代理
 * 每次 task 注入一份，超大仓库下不设总预算会把子代理上下文撑爆。
 */
export const PROJECT_GRAPH_SUMMARY_MAX_CHARS = 12_000;

export function buildProjectGraphBootstrapSummary(
  graph: WorkspaceProjectGraphResult,
  maxFilesPerDir: number = 12,
  maxTotalChars: number = PROJECT_GRAPH_SUMMARY_MAX_CHARS,
  lang: Lang = 'zh-CN'
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
  let usedChars = 0;
  const pushLine = (line: string): boolean => {
    if (usedChars + line.length + 1 > maxTotalChars) return false;
    lines.push(line);
    usedChars += line.length + 1;
    return true;
  };
  const sortedDirs = [...filesByDir.entries()].sort(([a], [b]) => {
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b);
  });
  let truncatedByBudget = false;

  for (const [dir, files] of sortedDirs) {
    if (!pushLine(`- ${dir}/ (${files.length} file${files.length > 1 ? 's' : ''})`)) {
      truncatedByBudget = true;
      break;
    }
    const displayFiles = files.slice(0, maxFilesPerDir);
    for (const file of displayFiles) {
      const symbols = symbolNodesByPath.get(file.path) ?? [];
      const entry = file.entryPoint ? ' [entry]' : '';
      const symbolStr = symbols.length > 0 ? ` → ${symbols.slice(0, 5).join(', ')}` : '';
      if (!pushLine(`  - ${file.path}${entry}${symbolStr}`)) {
        truncatedByBudget = true;
        break;
      }
    }
    if (truncatedByBudget) break;
    if (files.length > maxFilesPerDir) {
      if (!pushLine(`  ... +${files.length - maxFilesPerDir} more files`)) {
        truncatedByBudget = true;
        break;
      }
    }
  }

  if (truncatedByBudget) {
    // 提示行本身不参与预算（一行定长），否则恰好在预算边缘会被整体丢弃。
    lines.push(
      lang === 'en'
        ? '  ... (structure summary truncated by budget; use list / graph tools for the full layout)'
        : lang === 'zh-TW'
          ? '  ...（結構概覽超出預算，已截斷；完整結構請用 list / graph 工具按需獲取）'
          : '  ...（结构概览超出预算，已截断；完整结构请用 list / graph 工具按需获取）'
    );
  }

  if (graph.summary && !truncatedByBudget) {
    pushLine('');
    pushLine(`Summary: ${graph.summary.files} files, ${graph.summary.symbols} symbols, ${graph.summary.imports} imports, ${graph.summary.reexports} re-exports, ${graph.summary.entryPoints} entry points${graph.summary.truncated ? ' (truncated)' : ''}`);
  }

  return lines.join('\n');
}

export function buildAgentSessionBootstrapPrompt(
  settings: Settings,
  workspacePath: string,
  skillDefinitions: readonly SkillDefinition[] = [],
  memorySection?: string,
  pluginsSection?: string,
  workMode: WorkMode = 'agent',
): string {
  const lang = settings.lang ?? 'zh-CN';
  const customPromptSection = (settings.systemPrompt ?? '').trim();
  // 极简工具面：memory/skill/MCP/Git/LSP 等工具已被裁掉，Bootstrap 不再枚举
  // 「已启用插件 / 技能 / 记忆」大段，换成一句工具面说明，避免模型幻觉调用。
  const minimalSurface = settings.agentToolProfile === 'minimal';
  const resolvedPluginsSection = minimalSurface
    ? undefined
    : pluginsSection !== undefined
      ? pluginsSection
      : buildPublishCatalogSection(
          collectPublishCatalogTargets(useAppRuntimeStore.getState()),
          lang,
        );
  const bootstrap = buildSessionBootstrapPrompt({
    workspacePath,
    lang,
    skillsSection: minimalSurface ? '' : buildSkillsSection(skillDefinitions, lang),
    pluginsSection: resolvedPluginsSection || undefined,
    memorySection: minimalSurface ? undefined : memorySection,
    customPromptSection: customPromptSection || undefined,
    toolSurfaceSection: minimalSurface ? buildMinimalToolSurfaceSection(lang) : undefined,
  });
  const activeCharacter = settings.experimentalCharacters ? getActiveCharacter() : null;
  if (!activeCharacter) return bootstrap;
  const characterPrompt = buildCharacterSystemPrompt(activeCharacter, workMode);
  if (!characterPrompt) return bootstrap;

  const isRoleplay = effectiveCharacterInteractionMode(activeCharacter, workMode) === 'roleplay';
  const heading = lang === 'en' ? '## Character' : lang === 'zh-TW' ? '## 角色人設' : '## 角色人设';
  const hint = isRoleplay
    ? lang === 'en'
      ? 'The following character is enabled in roleplay format for this Agent session: replies follow its Roleplay Format convention (stage directions in *asterisks*, spoken lines as plain text). Code fences, tools, and engineering duties are unchanged.'
      : lang === 'zh-TW'
        ? '以下角色在 Agent 模式以角色扮演格式啟用：回覆遵循其 Roleplay Format 約定（*星号*為舞台指示，純文本為台詞）。程式碼、工具與工程職責不變。'
        : '以下角色在 Agent 模式以角色扮演格式启用：回复遵循其 Roleplay Format 约定（*星号*为舞台指示，纯文本为台词）。代码、工具与工程职责不变。'
    : lang === 'en'
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
  const userPrompt = buildRuntimeUserPrompt({
    mode: params.mode,
    input: params.input,
    workspacePath: params.workspacePath,
    lang: params.settings.lang ?? 'zh-CN',
    todoDigest: params.todoDigest,
  });
  const character = params.settings.experimentalCharacters ? getActiveCharacter() : null;
  const postHistory = character?.postHistoryInstructions.trim() ?? '';
  if (!character || !postHistory) return userPrompt;
  const expanded = sanitizeCachePrompt(
    expandCharacterMacros(postHistory, { char: character.name })
  );
  if (!expanded) return userPrompt;
  return `${userPrompt}\n\n## Post-History Instructions\n${expanded}`;
}
