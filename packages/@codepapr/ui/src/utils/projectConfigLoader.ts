/**
 * projectConfigLoader: UI 侧读取项目级配置（规则文件 / 子代理 / 聊天命令）。
 *
 * 纯解析逻辑全部来自 @codepapr/core；本模块只负责通过注入的 Tauri `invoke`
 * 进行文件 IO，因此可在测试中以 mock invoke 完整覆盖。
 */

import {
  buildProjectRulesSection,
  buildSkillsSection,
  parseInlineCommandLine,
  parseAgentMarkdown,
  parseCommandMarkdown,
  parseSkillMarkdown,
  PROJECT_RULE_FILES,
  type AgentDefinition,
  type CommandDefinition,
  type ProjectRuleFile,
  type RevertAction,
  type SkillDefinition,
} from '@codepapr/core';

/** 与 Tauri `invoke` 兼容的最小调用签名，便于测试注入。 */
export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}

interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ListFilesEntry {
  path: string;
  name?: string;
  kind?: string;
  isDir?: boolean;
}

interface ListFilesResult {
  root: string;
  entries: ListFilesEntry[];
  truncated: boolean;
}

interface SkillEntryRef {
  id: string;
  displayName: string;
  rootPath: string;
  relativePath: string;
}

const AGENTS_DIR = '.CodePapr/agents';
const COMMANDS_DIR = '.CodePapr/commands';
const SKILLS_DIR = '.CodePapr/skills';
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_SKILL_ID = /^[A-Za-z0-9._/-]+$/;

async function readFileSafe(
  invoke: InvokeFn,
  workspacePath: string,
  relativePath: string
): Promise<string | null> {
  try {
    const result = await invoke<ReadFileResult>('read_text_file', {
      workspacePath,
      relativePath,
    });
    return result.content;
  } catch {
    return null;
  }
}

/** 列出某目录下的 markdown 文件名（仅文件名，含 .md），按字典序排序；目录不存在返回空数组。 */
async function listMarkdownFileNames(
  invoke: InvokeFn,
  workspacePath: string,
  dir: string
): Promise<string[]> {
  let result: ListFilesResult;
  try {
    result = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath,
      relativePath: dir,
      maxDepth: 1,
    });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of result.entries) {
    if (entry.kind && entry.kind !== 'file') {
      continue;
    }
    const segments = entry.path.split(/[\\/]/);
    const fileName = entry.name ?? segments[segments.length - 1] ?? '';
    if (fileName.toLowerCase().endsWith('.md') && !fileName.includes('/')) {
      names.push(fileName);
    }
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function listSkillEntryRefs(
  invoke: InvokeFn,
  workspacePath: string
): Promise<SkillEntryRef[]> {
  let result: ListFilesResult;
  try {
    result = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath,
      relativePath: SKILLS_DIR,
      maxDepth: 10,
    });
  } catch {
    return [];
  }

  const entries = new Map<string, SkillEntryRef>();
  for (const entry of result.entries) {
    if (entry.kind === 'dir' || entry.isDir === true) {
      continue;
    }

    const normalizedPath = entry.path.replace(/\\/g, '/');
    const prefix = `${SKILLS_DIR}/`;
    if (!normalizedPath.startsWith(prefix)) {
      continue;
    }

    const rest = normalizedPath.slice(prefix.length);
    if (!rest || rest.endsWith('/')) {
      continue;
    }

    const nestedSkillMatch = rest.match(/^(.+)\/SKILL\.md$/i);
    if (nestedSkillMatch) {
      const skillId = nestedSkillMatch[1]!;
      const segments = skillId.split('/').filter(Boolean);
      entries.set(skillId, {
        id: skillId,
        displayName: segments[segments.length - 1] ?? skillId,
        rootPath: `${SKILLS_DIR}/${skillId}`,
        relativePath: normalizedPath,
      });
      continue;
    }

    if (!rest.includes('/') && rest.toLowerCase().endsWith('.md')) {
      const skillId = rest.replace(/\.md$/i, '');
      if (!entries.has(skillId)) {
        entries.set(skillId, {
          id: skillId,
          displayName: skillId,
          rootPath: `${SKILLS_DIR}/${skillId}`,
          relativePath: normalizedPath,
        });
      }
    }
  }

  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveSkillFilePath(
  invoke: InvokeFn,
  workspacePath: string,
  name: string
): Promise<string | null> {
  if (!SAFE_SKILL_ID.test(name) || name.includes('..')) {
    return null;
  }
  const skillEntries = await listSkillEntryRefs(invoke, workspacePath);
  const exact = skillEntries.find((entry) => entry.id === name);
  if (exact) {
    return exact.relativePath;
  }
  const matches = skillEntries.filter(
    (entry) => entry.displayName === name || entry.id.split('/').filter(Boolean).pop() === name
  );
  return matches.length === 1 ? matches[0]!.relativePath : null;
}

/** 读取并拼装项目规则系统提示词片段；无规则文件时返回空串。 */
export async function loadProjectRulesSection(
  invoke: InvokeFn,
  workspacePath: string
): Promise<string> {
  const files: ProjectRuleFile[] = [];
  for (const candidate of PROJECT_RULE_FILES) {
    const content = await readFileSafe(invoke, workspacePath, candidate);
    if (content !== null) {
      files.push({ path: candidate, content });
    }
  }
  return buildProjectRulesSection(files);
}

/** 加载 .CodePapr/agents/*.md 中声明的子代理定义。 */
export async function loadAgentDefinitions(
  invoke: InvokeFn,
  workspacePath: string
): Promise<AgentDefinition[]> {
  const fileNames = await listMarkdownFileNames(invoke, workspacePath, AGENTS_DIR);
  const definitions: AgentDefinition[] = [];
  for (const fileName of fileNames) {
    const content = await readFileSafe(invoke, workspacePath, `${AGENTS_DIR}/${fileName}`);
    if (content === null) {
      continue;
    }
    const name = fileName.replace(/\.md$/i, '');
    definitions.push(parseAgentMarkdown(name, content));
  }
  return definitions;
}

/** 加载 .CodePapr/skills 下的 Skill 并拼装为稳定会话使用的目录摘要。 */
export async function loadSkillsSection(
  invoke: InvokeFn,
  workspacePath: string
): Promise<string> {
  const definitions = await loadSkillDefinitions(invoke, workspacePath);
  return buildSkillsSection(definitions);
}

/** 加载 .CodePapr/skills 下的 Skill 定义，兼容 `<name>.md` 与 `<name>/SKILL.md`。 */
export async function loadSkillDefinitions(
  invoke: InvokeFn,
  workspacePath: string
): Promise<SkillDefinition[]> {
  const skillEntries = await listSkillEntryRefs(invoke, workspacePath);
  const definitions: SkillDefinition[] = [];
  for (const skillEntry of skillEntries) {
    const content = await readFileSafe(invoke, workspacePath, skillEntry.relativePath);
    if (content === null) {
      continue;
    }
    definitions.push({
      ...parseSkillMarkdown(skillEntry.displayName, content),
      id: skillEntry.id,
      displayName: skillEntry.displayName,
      rootPath: skillEntry.rootPath,
      sourcePath: skillEntry.relativePath,
    });
  }
  return definitions;
}

/** 列出所有可用聊天命令定义（用于 --help）。 */
export async function listCommandDefinitions(
  invoke: InvokeFn,
  workspacePath: string
): Promise<CommandDefinition[]> {
  const names = await listCommandNames(invoke, workspacePath);
  const definitions = await Promise.all(
    names.map(async (name) => loadCommandDefinition(invoke, workspacePath, name))
  );
  return definitions.filter((definition): definition is CommandDefinition => definition !== null);
}

/** 列出所有可用聊天命令名称。 */
export async function listCommandNames(
  invoke: InvokeFn,
  workspacePath: string
): Promise<string[]> {
  const fileNames = await listMarkdownFileNames(invoke, workspacePath, COMMANDS_DIR);
  return fileNames.map((fileName) => fileName.replace(/\.md$/i, ''));
}

/** 按名称加载单个聊天命令定义；不存在或名称非法时返回 null。 */
export async function loadCommandDefinition(
  invoke: InvokeFn,
  workspacePath: string,
  name: string
): Promise<CommandDefinition | null> {
  if (!SAFE_NAME.test(name)) {
    return null;
  }
  const content = await readFileSafe(invoke, workspacePath, `${COMMANDS_DIR}/${name}.md`);
  if (content === null) {
    return null;
  }
  return parseCommandMarkdown(name, content);
}

/** 读取相对工作区文件（用于命令模板 @path 内联）。 */
export async function readWorkspaceTextFile(
  invoke: InvokeFn,
  workspacePath: string,
  relativePath: string
): Promise<string> {
  const content = await readFileSafe(invoke, workspacePath, relativePath);
  if (content === null) {
    throw new Error(`文件不存在: ${relativePath}`);
  }
  return content;
}

/** 执行命令模板 !`cmd` 中的简单命令，并返回 stdout/stderr。 */
export async function runWorkspaceInlineCommand(
  invoke: InvokeFn,
  workspacePath: string,
  commandLine: string
): Promise<string> {
  const parsed = parseInlineCommandLine(commandLine);
  const result = await invoke<CommandResult>('run_workspace_command', {
    workspacePath,
    command: parsed.command,
    args: parsed.args,
    timeoutSeconds: 30,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.timedOut || result.status !== 0) {
    throw new Error(output || `命令退出码 ${result.status ?? 'unknown'}`);
  }
  return output;
}

/** 将一次回滚动作的目标状态写回磁盘（content 为 null 表示删除该文件）。 */
export async function applyRevertAction(
  invoke: InvokeFn,
  workspacePath: string,
  action: RevertAction,
  onWorkspaceMutated?: (paths: string[]) => void
): Promise<void> {
  if (action.content === null) {
    await invoke('delete_workspace_file', {
      workspacePath,
      relativePath: action.path,
    });
    onWorkspaceMutated?.([action.path]);
    return;
  }
  await invoke('write_text_file', {
    workspacePath,
    relativePath: action.path,
    content: action.content,
  });
  onWorkspaceMutated?.([action.path]);
}
