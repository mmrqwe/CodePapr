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
        // 块标量内容只看缩进：缩进行即使形如 `key: value` 也属于块值，
        // 只有顶格（下一层键或块结束）才终止收集。
        if (indent > 0) {
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

/** skill_load / @mention 使用的可加载名：优先目录 id。 */
export function resolveSkillCatalogName(skill: SkillDefinition): string {
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

/**
 * Skill 目录的缓存签名输入：只覆盖影响 Bootstrap 渲染的字段
 * （目录名/展示名/描述/启用态/正文是否非空）。正文内容与 rootPath/sourcePath
 * 故意排除——正文经 skill_load 按需读取，编辑正文不应拆掉会话前缀缓存，
 * 绝对路径参与签名还会造成无谓的跨机器漂移。
 */
export function buildSkillCatalogSignature(skills: readonly SkillDefinition[]): string {
  return skills
    .map((skill) =>
      [
        resolveSkillCatalogName(skill),
        skill.name.trim(),
        skill.displayName?.trim() ?? '',
        skill.description.trim(),
        skill.enabled === false ? '0' : '1',
        skill.prompt.trim() ? '1' : '0',
      ].join('\u0000')
    )
    .join('\u0001');
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

  const matched = skills.filter((skill) => {
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

  if (matched.length === 0) {
    return true;
  }
  // 多个 Skill 共享 name/leaf 时，任一匹配项被停用即拒绝：
  // 不能因为先匹配到同名且启用的条目，就把停用的那份读出来。
  return matched.every((skill) => skill.enabled !== false);
}

/**
 * Skill 包根目录：`<root>/SKILL.md` 去掉文件名，扁平 `<name>.md` 去掉扩展名。
 * 与 Rust 侧 `skill_root_from_path` 保持一致（不能用两次正则 replace：
 * 目录名本身以 .md 结尾时会被多剥一层）。
 */
export function skillRootFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  if (lower.endsWith('/skill.md')) {
    return normalized.slice(0, -'/skill.md'.length);
  }
  if (lower.endsWith('.md')) {
    return normalized.slice(0, -'.md'.length);
  }
  return normalized;
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

const SEARCH_SKILL_TEMPLATE_ZH_CN = `---
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

const SEARCH_SKILL_TEMPLATE_ZH_TW = `---
name: search
description: 使用公開網頁、官方文件與社群資料進行可驗證搜尋
---
# 搜尋 Skill

當任務需要公開資料、當前事實、第三方 API 用法或報錯排查時，按以下順序搜尋和驗證：

## 優先資料源
- 官方文件：Microsoft Learn、OpenAI Docs、MDN、Node.js、npm、PyPI、Rust、Tauri、Vite、React。
- 程式碼與問題：GitHub repositories、GitHub issues、GitHub pull requests。
- 社群資料：Stack Overflow、套件管理器頁面、維護者部落格。

## 常用搜尋方法
- 精確報錯使用雙引號，例如 "Cannot find module"。
- 限定網站使用 site:，例如 site:learn.microsoft.com Azure OpenAI quota。
- 同時帶上套件名、版本號、執行環境和關鍵錯誤碼。
- 優先核對官方文件和倉庫 README，再參考 issue 或社群答案。
- 對時效性問題至少核對兩個來源，並在回答中說明來源的可信度。
`;

const SEARCH_SKILL_TEMPLATE_EN = `---
name: search
description: Verifiable research across public web pages, official docs, and community sources
---
# Search Skill

When the task needs public references, current facts, third-party API usage, or error triage, search and verify in this order:

## Preferred sources
- Official docs: Microsoft Learn, OpenAI Docs, MDN, Node.js, npm, PyPI, Rust, Tauri, Vite, React.
- Code and issues: GitHub repositories, GitHub issues, GitHub pull requests.
- Community: Stack Overflow, package registry pages, maintainer blogs.

## Common techniques
- Quote exact errors, for example "Cannot find module".
- Scope a site with site:, for example site:learn.microsoft.com Azure OpenAI quota.
- Include the library name, version, runtime environment, and the key error code together.
- Check official docs and repo READMEs first, then issues or community answers.
- For time-sensitive questions, verify at least two sources and state their reliability.
`;

export function getDefaultSearchSkillTemplate(lang?: string): string {
  if (lang === 'en') {
    return SEARCH_SKILL_TEMPLATE_EN;
  }
  if (lang === 'zh-TW') {
    return SEARCH_SKILL_TEMPLATE_ZH_TW;
  }
  return SEARCH_SKILL_TEMPLATE_ZH_CN;
}

export const DEFAULT_SEARCH_SKILL_TEMPLATE = getDefaultSearchSkillTemplate('zh-CN');
