/**
 * 项目命令模板 /check：在项目配置里创建名为 check 的自定义命令时，预填此验证模板。
 */

export const DEFAULT_CHECK_COMMAND_NAME = 'check';

const FILE_MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'patch', 'lsp_edit']);

/** Agent 本轮改了文件、且用户没有自己跑 /check 时，提示补跑验证。 */
export function shouldSuggestCheckCommand(input: {
  mode: string;
  commandName?: string | null;
  toolNames: readonly string[];
}): boolean {
  if (input.mode !== 'agent') {
    return false;
  }
  if ((input.commandName ?? '').toLowerCase() === DEFAULT_CHECK_COMMAND_NAME) {
    return false;
  }
  return input.toolNames.some((name) => FILE_MUTATING_TOOL_NAMES.has(name));
}

export function getDefaultCheckCommandTemplate(lang?: string): string {
  const tpl = lang === 'en' ? EN_TEMPLATE : lang === 'zh-TW' ? TW_TEMPLATE : CN_TEMPLATE;
  return tpl.trim() + '\n';
}

/** 内置 /check 发给模型的正文（不含 frontmatter）。 */
export function getDefaultCheckCommandPrompt(lang?: string): string {
  const md = getDefaultCheckCommandTemplate(lang);
  const match = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  return (match?.[1] ?? md).trim();
}

const CN_TEMPLATE = `---
description: 按项目验证命令跑检查，只汇报证据，不改代码
---
请验证当前工作是否真的完成。范围：$ARGUMENTS

规则：
- 只跑检查，不改文件、不补测试、不修 lint。失败了只报告。
- 验证命令优先用 \`.CodePapr/AGENTS.md\` 里「验证」填写的测试 / Lint / 构建。没填再从 package.json、Makefile、cargo、go test 等现有脚本推断。找不到就说找不到，不要编命令。
- 每条命令都要真的执行。空输出只能当空输出，不能当成通过。
- 有界面或交互改动时，还要说明有没有实际走过操作；没走就写未验证。

输出：
1. 跑了哪些命令（原文）
2. 每条：通过 / 失败 / 没跑，附关键输出
3. 结论：可以算完成，或阻塞项列表
`;

const TW_TEMPLATE = `---
description: 依專案驗證命令跑檢查，只彙報證據，不改程式
---
請驗證目前工作是否真的完成。範圍：$ARGUMENTS

規則：
- 只跑檢查，不改檔案、不補測試、不修 lint。失敗了只報告。
- 驗證命令優先用 \`.CodePapr/AGENTS.md\` 裡「驗證」填寫的測試 / Lint / 建構。沒填再從 package.json、Makefile、cargo、go test 等既有腳本推斷。找不到就說找不到，不要編命令。
- 每條命令都要真的執行。空輸出只能當空輸出，不能當成通過。
- 有介面或互動改動時，還要說明有沒有實際走過操作；沒走就寫未驗證。

輸出：
1. 跑了哪些命令（原文）
2. 每條：通過 / 失敗 / 沒跑，附關鍵輸出
3. 結論：可以算完成，或阻塞項列表
`;

const EN_TEMPLATE = `---
description: Run the project's verify commands and report evidence only; do not change code
---
Verify whether the current work is actually done. Scope: $ARGUMENTS

Rules:
- Run checks only. Do not edit files, add tests, or fix lint. Report failures; do not patch them.
- Prefer the Test / Lint / Build commands written under Verify in \`.CodePapr/AGENTS.md\`. If those are empty, infer from existing scripts such as package.json, Makefile, cargo, or go test. If none exist, say so; do not invent commands.
- Actually run each command. Empty output is empty output, not a pass.
- For UI or interaction changes, say whether you walked through the flow; if not, mark it unverified.

Output:
1. Commands you ran (verbatim)
2. Each one: pass / fail / not run, with key output
3. Verdict: done, or a list of blockers
`;
