/**
 * projectConfig: CLI 侧读取项目级配置（规则文件 / 子代理 / 聊天命令）
 *
 * 纯解析逻辑在 @codepapr/core，本模块只负责 Node 文件 IO 并调用纯函数。
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applySkillEnablement,
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
import { DSDatabase } from '@codepapr/db';
import { runWorkspaceCommand } from './workspaceFs';

interface ConfigEntryRef {
  id: string;
  displayName: string;
  rootPath: string;
  path: string;
}

function parseSkillEnabledById(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
    )
  );
}

async function loadPersistedSkillEnablement(workspacePath: string): Promise<Record<string, boolean>> {
  const dbPath = join(workspacePath, '.CodePapr', 'project.sqlite');
  try {
    await fs.stat(dbPath);
  } catch {
    return {};
  }

  let db: DSDatabase | null = null;
  try {
    db = new DSDatabase(dbPath);
    const row = db
      .getRaw()
      .prepare('SELECT value FROM project_state WHERE key = ?')
      .get('project.state') as { value?: string } | undefined;
    if (!row?.value) {
      return {};
    }

    const parsed = JSON.parse(row.value) as { skillEnabledById?: unknown };
    return parseSkillEnabledById(parsed.skillEnabledById);
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** 读取并拼装项目规则系统提示词片段；无规则文件时返回空串。 */
export async function loadProjectRulesSection(workspacePath: string): Promise<string> {
  const files: ProjectRuleFile[] = [];
  for (const candidate of PROJECT_RULE_FILES) {
    const content = await readFileSafe(join(workspacePath, candidate));
    if (content !== null) {
      files.push({ path: candidate, content });
    }
  }
  return buildProjectRulesSection(files);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function walkSkillEntries(
  dir: string,
  relativeDir: string
): Promise<ConfigEntryRef[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const refs: ConfigEntryRef[] = [];
  const hasSkillManifest = entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
  if (hasSkillManifest && relativeDir) {
    const segments = relativeDir.split('/').filter(Boolean);
    refs.push({
      id: relativeDir,
      displayName: segments[segments.length - 1] ?? relativeDir,
      rootPath: join('.CodePapr', 'skills', relativeDir).replace(/\\/g, '/'),
      path: join(dir, 'SKILL.md'),
    });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const nestedRelativeDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    refs.push(...(await walkSkillEntries(join(dir, entry.name), nestedRelativeDir)));
  }

  return refs;
}

async function listSkillEntryRefs(workspacePath: string): Promise<ConfigEntryRef[]> {
  const dir = join(workspacePath, '.CodePapr', 'skills');
  const refs = new Map<string, ConfigEntryRef>();
  const rootEntries = await listMarkdownFiles(dir);
  for (const fileName of rootEntries) {
    const skillId = fileName.replace(/\.md$/i, '');
    refs.set(skillId, {
      id: skillId,
      displayName: skillId,
      rootPath: join('.CodePapr', 'skills', skillId).replace(/\\/g, '/'),
      path: join(dir, fileName),
    });
  }

  for (const ref of await walkSkillEntries(dir, '')) {
    if (!refs.has(ref.id)) {
      refs.set(ref.id, ref);
    }
  }

  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveSkillFilePath(workspacePath: string, name: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('..')) {
    return null;
  }
  const skillEntries = await listSkillEntryRefs(workspacePath);
  const exact = skillEntries.find((entry) => entry.id === name);
  if (exact) {
    return exact.path;
  }
  const matches = skillEntries.filter(
    (entry) => entry.displayName === name || entry.id.split('/').filter(Boolean).pop() === name
  );
  return matches.length === 1 ? matches[0]!.path : null;
}

/** 加载 .CodePapr/agents/*.md 中定义的子代理。 */
export async function loadAgentDefinitions(workspacePath: string): Promise<AgentDefinition[]> {
  const dir = join(workspacePath, '.CodePapr', 'agents');
  const files = await listMarkdownFiles(dir);
  const definitions: AgentDefinition[] = [];
  for (const file of files) {
    const content = await readFileSafe(join(dir, file));
    if (content === null) {
      continue;
    }
    const name = file.replace(/\.md$/i, '');
    definitions.push(parseAgentMarkdown(name, content));
  }
  return definitions;
}

/** 加载 .CodePapr/skills 下的 Skill 并拼装为稳定会话使用的目录摘要。 */
export async function loadSkillsSection(workspacePath: string): Promise<string> {
  const definitions = await loadSkillDefinitions(workspacePath);
  return buildSkillsSection(definitions);
}

/** 加载 .CodePapr/skills 下的 Skill 定义，兼容 `<name>.md` 与 `<name>/SKILL.md`。 */
export async function loadSkillDefinitions(workspacePath: string): Promise<SkillDefinition[]> {
  const skillEntries = await listSkillEntryRefs(workspacePath);
  const enabledById = await loadPersistedSkillEnablement(workspacePath);
  const definitions: SkillDefinition[] = [];
  for (const skillEntry of skillEntries) {
    const content = await readFileSafe(skillEntry.path);
    if (content === null) {
      continue;
    }
    definitions.push({
      ...parseSkillMarkdown(skillEntry.displayName, content),
      id: skillEntry.id,
      displayName: skillEntry.displayName,
      rootPath: skillEntry.rootPath,
      sourcePath: skillEntry.path,
    });
  }
  return applySkillEnablement(definitions, enabledById);
}

/** 按名称加载单个聊天命令定义；不存在时返回 null。 */
export async function loadCommandDefinition(
  workspacePath: string,
  name: string
): Promise<CommandDefinition | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return null;
  }
  const path = join(workspacePath, '.CodePapr', 'commands', `${name}.md`);
  const content = await readFileSafe(path);
  if (content === null) {
    return null;
  }
  return parseCommandMarkdown(name, content);
}

/** 列出所有可用聊天命令名称。 */
export async function listCommandNames(workspacePath: string): Promise<string[]> {
  const dir = join(workspacePath, '.CodePapr', 'commands');
  const files = await listMarkdownFiles(dir);
  return files.map((file) => file.replace(/\.md$/i, ''));
}

/** 列出所有可用聊天命令定义（用于 --help）。 */
export async function listCommandDefinitions(workspacePath: string): Promise<CommandDefinition[]> {
  const names = await listCommandNames(workspacePath);
  const definitions = await Promise.all(names.map((name) => loadCommandDefinition(workspacePath, name)));
  return definitions.filter((definition): definition is CommandDefinition => definition !== null);
}

/** 读取相对工作区文件（用于命令模板 @path 内联）。 */
export async function readWorkspaceTextFile(workspacePath: string, relativePath: string): Promise<string> {
  const target = resolve(workspacePath, relativePath);
  if (!target.startsWith(resolve(workspacePath))) {
    throw new Error('路径超出工作区范围');
  }
  const content = await readFileSafe(target);
  if (content === null) {
    throw new Error(`文件不存在: ${relativePath}`);
  }
  return content;
}

/** 执行命令模板 !`cmd` 中的简单命令，并返回 stdout/stderr。 */
export async function runWorkspaceInlineCommand(workspacePath: string, commandLine: string): Promise<string> {
  const parsed = parseInlineCommandLine(commandLine);
  const result = await runWorkspaceCommand(workspacePath, parsed.command, parsed.args, 30);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.timedOut || result.status !== 0) {
    throw new Error(output || `命令退出码 ${result.status ?? 'unknown'}`);
  }
  return output;
}

/** 将一次回滚动作的目标状态写回磁盘（content 为 null 表示删除文件）。 */
export async function applyRevertAction(workspacePath: string, action: RevertAction): Promise<void> {
  const target = resolve(workspacePath, action.path);
  if (!target.startsWith(resolve(workspacePath))) {
    throw new Error('路径超出工作区范围');
  }
  if (action.content === null) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.writeFile(target, action.content, 'utf8');
}
