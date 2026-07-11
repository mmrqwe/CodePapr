/**
 * projectRules: 项目规则文件的自动注入（纯逻辑）
 *
 * 读取由调用方提供的规则文件内容，拼装成稳定的系统提示词片段。
 * 文件 IO 由各入口（CLI 用 Node fs，桌面端用 Tauri）注入，本模块保持纯函数以便缓存友好与测试。
 */

/** 默认按优先级查找的项目规则文件（相对项目根目录） */
export const PROJECT_AGENTS_FILE = '.CodePapr/AGENTS.md';

export const PROJECT_RULE_FILES: readonly string[] = [
  PROJECT_AGENTS_FILE,
  '.CodePapr/rules.md',
];

export interface ProjectRuleFile {
  /** 相对路径，用于在提示词中标注来源 */
  path: string;
  /** 文件内容 */
  content: string;
}

/**
 * 将多个规则文件拼装为单个系统提示词片段。
 * - 跳过内容为空白的文件
 * - 去除每个文件首尾空白，保留内部格式
 * - 若全部为空则返回空字符串（调用方据此决定是否注入）
 */
export function buildProjectRulesSection(files: ProjectRuleFile[]): string {
  const blocks: string[] = [];

  for (const file of files) {
    const trimmed = file.content.trim();
    if (!trimmed) {
      continue;
    }
    blocks.push(`### 规则来源：${file.path}\n${trimmed}`);
  }

  if (blocks.length === 0) {
    return '';
  }

  return ['## 项目规则', '以下规则来自当前项目，必须严格遵守：', '', ...blocks].join('\n');
}

/** 默认的 .CodePapr/AGENTS.md 脚手架内容，按语言返回，供 `codepapr init` 使用 */
export function getDefaultAgentsTemplate(lang?: string): string {
  const tpl = lang === 'en' ? EN_TEMPLATE : lang === 'zh-TW' ? TW_TEMPLATE : CN_TEMPLATE;
  return tpl.trim() + '\n';
}

const CN_TEMPLATE = `# 项目规则

> 按需填写。留空的章节会被忽略。
> 以下规则仅对主 Agent 生效，子代理（Explore/Scout/Mentor）不继承。

## 技术栈
<!-- 列出项目的语言、框架、关键依赖 -->

## 构建与验证
<!-- 构建命令、测试命令、lint 命令 -->
- 构建：
- 测试：
- Lint：

## 项目约定
<!-- 目录结构、命名规范、分支策略等 -->

## 禁止事项
<!-- 不要碰的文件、不要引入的依赖、不要做的操作 -->
`;

const TW_TEMPLATE = `# 專案規則

> 按需填寫。留空的章節會被忽略。
> 以下規則僅對主 Agent 生效，子代理（Explore/Scout/Mentor）不繼承。

## 技術棧
<!-- 列出專案的語言、框架、關鍵依賴 -->

## 建構與驗證
<!-- 建構命令、測試命令、lint 命令 -->
- 建構：
- 測試：
- Lint：

## 專案約定
<!-- 目錄結構、命名規範、分支策略等 -->

## 禁止事項
<!-- 不要碰的檔案、不要引入的依賴、不要做的操作 -->
`;

const EN_TEMPLATE = `# Project Rules

> Fill in as needed. Empty sections will be ignored.
> These rules apply to the main Agent only. Sub-agents (Explore/Scout/Mentor) do not inherit them.

## Tech Stack
<!-- List the project's language, framework, key dependencies -->

## Build & Verification
<!-- Build command, test command, lint command -->
- Build:
- Test:
- Lint:

## Project Conventions
<!-- Directory structure, naming conventions, branch strategy, etc. -->

## Prohibited Actions
<!-- Files not to touch, dependencies not to introduce, operations not to perform -->
`;
