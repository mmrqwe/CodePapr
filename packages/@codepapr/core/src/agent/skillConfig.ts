/**
 * skillConfig: 项目级 Skill 定义解析与摘要提示词注入（纯逻辑）。
 *
 * Skill 是轻量操作手册，不是子代理。主 Agent 在稳定上下文里只看到
 * 用户启用的 Skill 名称与描述，是否使用以及使用哪个 Skill 由模型自行判断；
 * 完整说明通过 skill_load 按需读取。
 */

export const SKILLS_DIR = '.CodePapr/skills';
export const DEFAULT_SEARCH_SKILL_NAME = 'search';
export type SkillPromptLang = 'zh-CN' | 'zh-TW' | 'en';
export type SkillEnablementMap = Record<string, boolean>;

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  enabled?: boolean;
  id?: string;
  displayName?: string;
  rootPath?: string;
  sourcePath?: string;
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatterLine(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  const colonMatch = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
  if (colonMatch) {
    const key = colonMatch[1]!.trim().toLowerCase();
    const val = colonMatch[2]!.trim();
    // YAML block scalar indicators: |, |-, >, >-
    if (val === '|' || val === '|-' || val === '>' || val === '>-') {
      return { key, value: val };
    }
    return { key, value: stripQuotes(val) };
  }

  const spaceMatch = line.match(/^([A-Za-z][\w-]*)\s+(.+)$/);
  if (spaceMatch) {
    return {
      key: spaceMatch[1]!.trim().toLowerCase(),
      value: stripQuotes(spaceMatch[2]!.trim()),
    };
  }

  return null;
}

function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { fields: {}, body: raw.trim() };
  }

  const [, header, body] = match;
  const fields: Record<string, string> = {};
  const lines = header.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const field = parseFrontmatterLine(rawLine);
    if (!field) {
      continue;
    }
    // Check if this is a block scalar indicator (|, >, etc.)
    if (field.value === '|' || field.value === '|-' || field.value === '>' || field.value === '>-') {
      const isFolded = field.value.startsWith('>');
      // Collect subsequent indented lines as the block value
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (nextLine.trim() === '') { j++; continue; }
        const indent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent > 0 && !nextLine.match(/^[A-Za-z][\w-]*\s*:\s/)) {
          blockLines.push(nextLine.trim());
          j++;
        } else {
          break;
        }
      }
      i = j - 1; // Skip consumed block lines
      fields[field.key] = isFolded
        ? blockLines.join(' ').trim()
        : blockLines.join('\n').trim();
      continue;
    }
    fields[field.key] = field.value;
  }
  return { fields, body: body.trim() };
}

function resolveSkillCatalogName(skill: SkillDefinition): string {
  const loadName = skill.id?.trim() || skill.displayName?.trim() || skill.name.trim();
  return loadName || skill.name.trim();
}

function resolveSkillLeafName(skill: SkillDefinition): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const leafFromId = skill.id?.split('/').filter(Boolean).pop()?.trim();
  return leafFromId || skill.name.trim();
}

function formatSkillCatalogLabel(skill: SkillDefinition): string {
  const catalogName = resolveSkillCatalogName(skill);
  const displayName = skill.name.trim();
  return displayName && displayName !== resolveSkillLeafName(skill)
    ? `\`${catalogName}\` (${displayName})`
    : `\`${catalogName}\``;
}

export function parseSkillMarkdown(name: string, raw: string): SkillDefinition {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('skill 名称不能为空');
  }

  const { fields, body } = parseFrontmatter(raw);
  const resolvedName = fields.name?.trim() || trimmedName;
  return {
    name: resolvedName,
    description: fields.description?.trim() || `项目 Skill ${resolvedName}`,
    prompt: body,
  };
}

export function applySkillEnablement(
  skills: readonly SkillDefinition[],
  enabledById: SkillEnablementMap = {}
): SkillDefinition[] {
  return skills.map((skill) => {
    const key = resolveSkillCatalogName(skill);
    const enabled = enabledById[key];
    return {
      ...skill,
      enabled: enabled !== false,
    };
  });
}

/** skill_load 是否允许读取：目录里停用的 Skill 不能靠路径再把全文读出来。 */
export function isSkillAvailableToLoad(
  requestedName: string,
  skills: readonly SkillDefinition[]
): boolean {
  const needle = requestedName.trim();
  if (!needle) {
    return false;
  }

  const matched = skills.find((skill) => {
    const catalog = resolveSkillCatalogName(skill);
    const leaf = resolveSkillLeafName(skill);
    return (
      catalog === needle ||
      leaf === needle ||
      skill.id === needle ||
      skill.displayName === needle ||
      skill.name === needle ||
      skill.sourcePath === needle
    );
  });

  if (!matched) {
    return true;
  }
  return matched.enabled !== false;
}

export function buildSkillsSection(
  skills: readonly SkillDefinition[],
  lang: SkillPromptLang = 'zh-CN'
): string {
  const availableSkills = skills.filter(
    (skill) =>
      skill.enabled !== false &&
      resolveSkillCatalogName(skill).trim() &&
      skill.description.trim() &&
      skill.prompt.trim()
  );
  if (availableSkills.length === 0) {
    return '';
  }

  const title =
    lang === 'en'
      ? '## Project Skills'
      : lang === 'zh-TW'
      ? '## 項目 Skills'
      : '## 项目 Skills';
  const intro =
    lang === 'en'
      ? 'These are the user-enabled project skills. Decide yourself whether any skill is needed for the current task. Only call `skill_load` after you have chosen a specific skill, and never bulk-load all skills just in case.'
      : lang === 'zh-TW'
      ? '以下是用戶啟用的項目 Skill 摘要。你要自行判斷當前任務是否需要某個 Skill；只有在已經選定具體 Skill 後，才調用 `skill_load` 讀取完整內容，不要為了保險批量加載。'
      : '以下是用户启用的项目 Skill 摘要。你要自行判断当前任务是否需要某个 Skill；只有在已经选定具体 Skill 后，才调用 `skill_load` 读取完整内容，不要为了保险批量加载。';
  const lines = availableSkills.map((skill) => `- ${formatSkillCatalogLabel(skill)}: ${skill.description.trim()}`);

  return [title, intro, '', ...lines].join('\n');
}

export const DEFAULT_SEARCH_SKILL_TEMPLATE = `---
name: search
description: 使用公开网页、官方文档和社区资料进行可验证搜索
---
# 搜索 Skill

当任务需要公开资料、当前事实、第三方 API 用法或报错排查时，按以下顺序搜索和验证：

## 优先资料源
- 官方文档：Microsoft Learn、OpenAI Docs、MDN、Node.js、npm、PyPI、Rust、Tauri、Vite、React。
- 代码与问题：GitHub repositories、GitHub issues、GitHub pull requests。
- 社区资料：Stack Overflow、包管理器页面、维护者博客。

## 常用搜索方法
- 精确报错使用双引号，例如 "Cannot find module"。
- 限定站点使用 site:，例如 site:learn.microsoft.com Azure OpenAI quota。
- 同时带上库名、版本号、运行环境和关键错误码。
- 优先核对官方文档和仓库 README，再参考 issue 或社区答案。
- 对时效性问题至少核对两个来源，并在回答中说明来源的可信度。
`;
