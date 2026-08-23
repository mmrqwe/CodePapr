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
];

export interface ProjectRuleFile {
  /** 相对路径，用于在提示词中标注来源 */
  path: string;
  /** 文件内容 */
  content: string;
}

const EMPTY_LABELED_ITEM = /^\s*[-*]\s+[^:：]+[:：]\s*$/;
const HEADING_LINE = /^(#{1,6})\s+\S/;

/**
 * 发给模型前去掉未填的 `- 标签：` 占位，以及去掉因此变空的 `##` 小节。
 * 编辑器里仍保留这些空行，方便用户填写。
 */
export function stripEmptyRulePlaceholders(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const withoutEmptyItems = lines.filter((line) => !EMPTY_LABELED_ITEM.test(line));
  const kept: string[] = [];
  let index = 0;
  while (index < withoutEmptyItems.length) {
    const line = withoutEmptyItems[index]!;
    const heading = HEADING_LINE.exec(line);
    if (!heading || heading[1] === '#') {
      kept.push(line);
      index += 1;
      continue;
    }
    let cursor = index + 1;
    const body: string[] = [];
    while (cursor < withoutEmptyItems.length && !HEADING_LINE.test(withoutEmptyItems[cursor]!)) {
      body.push(withoutEmptyItems[cursor]!);
      cursor += 1;
    }
    if (body.some((item) => item.trim().length > 0)) {
      kept.push(line, ...body);
    }
    index = cursor;
  }
  return kept.join('\n').trim();
}

/**
 * 将多个规则文件拼装为单个系统提示词片段。
 * - 跳过内容为空白的文件
 * - 注入前去掉未填占位
 * - 若全部为空则返回空字符串（调用方据此决定是否注入）
 */
export function buildProjectRulesSection(files: ProjectRuleFile[]): string {
  const blocks: string[] = [];

  for (const file of files) {
    const trimmed = stripEmptyRulePlaceholders(file.content);
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

/**
 * 默认 `.CodePapr/AGENTS.md`：项目配置弹窗的初始内容；
 * 工作区尚无该文件时，也作为项目规则回退注入系统提示词。
 */
export function getDefaultAgentsTemplate(lang?: string): string {
  const tpl = lang === 'en' ? EN_TEMPLATE : lang === 'zh-TW' ? TW_TEMPLATE : CN_TEMPLATE;
  return tpl.trim() + '\n';
}

/** 没有可读的规则文件时，注入内置默认约定。已有文件（含空白）则按原文拼装。 */
export function resolveProjectRulesSection(files: ProjectRuleFile[], lang?: string): string {
  if (files.length === 0) {
    return buildProjectRulesSection([{ path: PROJECT_AGENTS_FILE, content: getDefaultAgentsTemplate(lang) }]);
  }
  return buildProjectRulesSection(files);
}

const CN_TEMPLATE = `# 项目规则

无此文件时使用这份默认约定。按项目填写「本项目」和「验证」，其余可改可删。

## 本项目
- 技术栈：
- 目录约定：

## 改代码
- 先读再改。沿用现有模式、命名和目录，不另起一套。
- 只改任务需要的代码。不顺手重构，不扩范围，不写没人要的文档或注释。
- 改共享状态、数据流或公共组件时，把其他读取面一并核对。
- 优先小范围修改，避免整文件重写。

## 完成
- 用「验证」里的命令拿到证据后再说完成。
- 界面和交互改动要实际走一遍，不能只看代码或截图。
- 验证没跑或工具失败，就明确说阻塞，不要假装完成。

## 验证
- 测试：
- Lint：
- 构建：

## 不要动
- 密钥、凭证、.env
- 未要求的 git 提交或推送
- 生成物；与任务无关的依赖和锁文件
`;

const TW_TEMPLATE = `# 專案規則

無此檔時使用這份預設約定。依專案填寫「本專案」和「驗證」，其餘可改可刪。

## 本專案
- 技術棧：
- 目錄約定：

## 改程式
- 先讀再改。沿用既有模式、命名和目錄，不另起一套。
- 只改任務需要的程式。不順手重構，不擴範圍，不寫沒人要的文件或註解。
- 改共享狀態、資料流或公共元件時，把其他讀取面一併核對。
- 優先小範圍修改，避免整檔重寫。

## 完成
- 用「驗證」裡的命令拿到證據後再說完成。
- 介面和互動改動要實際走一遍，不能只看程式或截圖。
- 驗證沒跑或工具失敗，就明確說阻塞，不要假裝完成。

## 驗證
- 測試：
- Lint：
- 建構：

## 不要動
- 密鑰、憑證、.env
- 未要求的 git 提交或推送
- 產生物；與任務無關的依賴和鎖檔
`;

const EN_TEMPLATE = `# Project Rules

Used when this file is missing. Fill in Project and Verify; edit or delete the rest.

## Project
- Stack:
- Layout:

## Editing
- Read existing code first. Follow current patterns, names, and folders; do not invent a parallel design.
- Change only what the task needs. No drive-by refactors, scope expansion, or unsolicited docs/comments.
- When changing shared state, data flow, or shared components, check the other surfaces that read them.
- Prefer small edits over rewriting whole files.

## Done
- Do not claim done until the Verify commands have produced evidence.
- For UI/interaction changes, actually walk through the flow; reading code or a screenshot is not enough.
- If verification did not run or a tool failed, say so. Do not pretend the work is finished.

## Verify
- Test:
- Lint:
- Build:

## Do not
- Secrets, credentials, .env
- Git commit or push unless asked
- Generated files; unrelated dependency or lockfile edits
`;
