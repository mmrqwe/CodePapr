import {
  AppendOnlyLog,
  buildSessionBootstrapPrompt,
  buildSkillsSection,
  DEFAULT_PROMPT_TOOL_NAMES,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  Serializer,
  type AgentDefinition,
  type SkillDefinition,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';
import type { IMessage } from '@codepapr/types';
import type { WorkMode } from '../../utils/agentPrompts';
import { buildProjectDiagnosticsPromptSection } from '../../utils/agentPrompts';
import type { ProjectDiagnosticsReport } from '../../utils/projectDiagnostics';
import { buildEffectiveContextMessages } from '../../utils/contextCompaction';
import { getActiveCharacterPrompt } from '../charactersStore';
import type { Settings, UIMessage } from './types';

export function toCoreMessages(messages: UIMessage[], sessionBootstrapPrompt?: string): IMessage[] {
  const restoredMessages = buildEffectiveContextMessages(messages);
  const normalizedBootstrapPrompt = sessionBootstrapPrompt?.trim();
  if (!normalizedBootstrapPrompt) {
    return restoredMessages;
  }

  return [
    {
      id: 'session-bootstrap',
      role: 'assistant',
      content: normalizedBootstrapPrompt,
      timestamp: 1,
      metadata: {
        sessionBootstrap: true,
      },
    },
    ...restoredMessages,
  ];
}

export function createLogFromMessages(
  sessionId: string,
  messages: UIMessage[],
  sessionBootstrapPrompt?: string
): AppendOnlyLog {
  const log = new AppendOnlyLog(sessionId);
  const restoredMessages = toCoreMessages(messages, sessionBootstrapPrompt);
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
  runtime?: { agentDefinitions?: AgentDefinition[] }
): string {
  const toolNames = [
    ...DEFAULT_PROMPT_TOOL_NAMES,
    ...((runtime?.agentDefinitions?.length ?? 0) > 0 ? ['task'] : []),
  ];

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
  projectGraphSummary?: string,
  memorySection?: string
): string {
  const characterPrompt = getActiveCharacterPrompt();
  const customPromptSection = [settings.systemPrompt, characterPrompt]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join('\n\n');
  return buildSessionBootstrapPrompt({
    workspacePath,
    lang: settings.lang ?? 'zh-CN',
    skillsSection: buildSkillsSection(skillDefinitions, settings.lang ?? 'zh-CN'),
    memorySection,
    customPromptSection,
    projectGraphSummary,
  });
}

export function buildAgentRuntimeUserPrompt(params: {
  settings: Settings;
  mode: WorkMode;
  workspacePath: string;
  input: string;
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null;
}): string {
  const diagnosticsSection =
    params.mode === 'ask'
      ? ''
      : buildProjectDiagnosticsPromptSection({
          lang: params.settings.lang ?? 'zh-CN',
          workspacePath: params.workspacePath,
          projectDiagnosticsReport: params.projectDiagnosticsReport,
        })
          .slice(1)
          .join('\n');

  return buildRuntimeUserPrompt({
    mode: params.mode,
    input: params.input,
    workspacePath: params.workspacePath,
    lang: params.settings.lang ?? 'zh-CN',
    diagnosticsSection,
  });
}
