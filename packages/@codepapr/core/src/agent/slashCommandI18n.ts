/** 内置 slash 命令的 UI 文案（模板本身仍用中文，发给模型）。 */

export type CommandUiLang = 'zh-CN' | 'zh-TW' | 'en';

export interface CommandUiCopy {
  description: Record<CommandUiLang, string>;
  usage: Record<CommandUiLang, string>;
}

export const BUILTIN_COMMAND_UI: Record<string, CommandUiCopy> = {
  review: {
    description: {
      'zh-CN': '审查当前改动或指定范围，优先报告 bug、回归风险和缺失验证',
      'zh-TW': '審查當前改動或指定範圍，優先報告 bug、回歸風險和缺失驗證',
      en: 'Review current changes or a given scope; report bugs, regressions, and missing tests first',
    },
    usage: {
      'zh-CN': '对指定范围做严格代码审查。\n用法: /review <文件或范围>\n示例: /review src/auth/  或 /review 最近的改动',
      'zh-TW': '對指定範圍做嚴格程式碼審查。\n用法: /review <檔案或範圍>\n示例: /review src/auth/  或 /review 最近的改動',
      en: 'Strict code review of the given scope.\nUsage: /review <file or range>\nExample: /review src/auth/  or /review recent changes',
    },
  },
  fix: {
    description: {
      'zh-CN': '定位并修复指定问题，然后运行相关验证',
      'zh-TW': '定位並修復指定問題，然後執行相關驗證',
      en: 'Locate and fix the given issue, then run related verification',
    },
    usage: {
      'zh-CN': '定位并修复指定问题，自动运行验证。\n用法: /fix <问题描述>\n示例: /fix 登录页按钮点击无响应  或 /fix API 返回 500',
      'zh-TW': '定位並修復指定問題，自動執行驗證。\n用法: /fix <問題描述>\n示例: /fix 登入頁按鈕點擊無反應  或 /fix API 回傳 500',
      en: 'Locate and fix the issue, then verify.\nUsage: /fix <problem>\nExample: /fix login button does nothing  or /fix API returns 500',
    },
  },
  test: {
    description: {
      'zh-CN': '为指定功能补测试或运行相关测试',
      'zh-TW': '為指定功能補測試或執行相關測試',
      en: 'Add or run tests for the given feature or file',
    },
    usage: {
      'zh-CN': '为指定功能补充测试或运行已有测试。\n用法: /test <功能或文件>\n示例: /test src/utils/format.ts  或 /test 支付流程',
      'zh-TW': '為指定功能補充測試或執行既有測試。\n用法: /test <功能或檔案>\n示例: /test src/utils/format.ts  或 /test 支付流程',
      en: 'Add or run tests.\nUsage: /test <feature or file>\nExample: /test src/utils/format.ts  or /test checkout flow',
    },
  },
  explain: {
    description: {
      'zh-CN': '解释指定文件、符号、错误或实现思路',
      'zh-TW': '解釋指定檔案、符號、錯誤或實作思路',
      en: 'Explain a file, symbol, error, or implementation',
    },
    usage: {
      'zh-CN': '解释文件、函数、符号或错误的实现思路。\n用法: /explain <目标>\n示例: /explain src/App.tsx  或 /explain handleSubmit 函数',
      'zh-TW': '解釋檔案、函式、符號或錯誤的實作思路。\n用法: /explain <目標>\n示例: /explain src/App.tsx  或 /explain handleSubmit 函式',
      en: 'Explain a file, function, symbol, or error.\nUsage: /explain <target>\nExample: /explain src/App.tsx  or /explain handleSubmit',
    },
  },
  diagnose: {
    description: {
      'zh-CN': '诊断报错、慢操作或异常行为的根因',
      'zh-TW': '診斷報錯、慢操作或異常行為的根因',
      en: 'Diagnose the root cause of an error, slowness, or unexpected behavior',
    },
    usage: {
      'zh-CN': '诊断报错、慢操作或异常行为的根因。\n用法: /diagnose <症状>\n示例: /diagnose 列表页加载超过 5 秒',
      'zh-TW': '診斷報錯、慢操作或異常行為的根因。\n用法: /diagnose <症狀>\n示例: /diagnose 列表頁載入超過 5 秒',
      en: 'Diagnose the symptom.\nUsage: /diagnose <symptom>\nExample: /diagnose list page takes over 5s',
    },
  },
  refactor: {
    description: {
      'zh-CN': '在保持行为不变的前提下整理指定代码',
      'zh-TW': '在保持行為不變的前提下整理指定程式碼',
      en: 'Refactor the given code without changing behavior',
    },
    usage: {
      'zh-CN': '保持行为不变的前提下整理代码。\n用法: /refactor <文件或代码>\n示例: /refactor src/components/Modal.tsx',
      'zh-TW': '保持行為不變的前提下整理程式碼。\n用法: /refactor <檔案或程式碼>\n示例: /refactor src/components/Modal.tsx',
      en: 'Refactor without changing behavior.\nUsage: /refactor <file or code>\nExample: /refactor src/components/Modal.tsx',
    },
  },
  doc: {
    description: {
      'zh-CN': '为指定变更或功能更新文档',
      'zh-TW': '為指定變更或功能更新文件',
      en: 'Write or update docs for a change or feature',
    },
    usage: {
      'zh-CN': '为指定变更或功能更新文档。\n用法: /doc <变更内容>\n示例: /doc 新增的退款接口',
      'zh-TW': '為指定變更或功能更新文件。\n用法: /doc <變更內容>\n示例: /doc 新增的退款介面',
      en: 'Update project docs.\nUsage: /doc <change>\nExample: /doc new refund API',
    },
  },
  search: {
    description: {
      'zh-CN': '在代码库中搜索模式、用法、定义或引用',
      'zh-TW': '在程式庫中搜尋模式、用法、定義或引用',
      en: 'Search the repo for patterns, usages, definitions, or references',
    },
    usage: {
      'zh-CN': '搜索代码库中的模式、用法或定义。\n用法: /search <关键词>\n示例: /search auth middleware',
      'zh-TW': '搜尋程式庫中的模式、用法或定義。\n用法: /search <關鍵詞>\n示例: /search auth middleware',
      en: 'Search the codebase.\nUsage: /search <query>\nExample: /search auth middleware',
    },
  },
  lint: {
    description: {
      'zh-CN': '运行 linter 并修复违规，确保代码通过风格检查',
      'zh-TW': '執行 linter 並修復違規，確保程式碼通過風格檢查',
      en: 'Run the linter and fix style violations',
    },
    usage: {
      'zh-CN': '运行 linter 并修复所有违规。\n用法: /lint <文件或目录>\n示例: /lint src/',
      'zh-TW': '執行 linter 並修復所有違規。\n用法: /lint <檔案或目錄>\n示例: /lint src/',
      en: 'Lint and fix violations.\nUsage: /lint <file or dir>\nExample: /lint src/',
    },
  },
  clean: {
    description: {
      'zh-CN': '清理死代码、未用导入、注释掉的代码和遗留调试语句',
      'zh-TW': '清理死程式碼、未用導入、註解掉的程式碼和遺留除錯語句',
      en: 'Remove dead code, unused imports, and leftover debug statements',
    },
    usage: {
      'zh-CN': '清理死代码、未用导入和调试语句。\n用法: /clean <文件或目录>\n示例: /clean src/',
      'zh-TW': '清理死程式碼、未用導入和除錯語句。\n用法: /clean <檔案或目錄>\n示例: /clean src/',
      en: 'Clean dead code and debug leftovers.\nUsage: /clean <file or dir>\nExample: /clean src/',
    },
  },
  commit: {
    description: {
      'zh-CN': '生成规范的 commit message（不自动提交）',
      'zh-TW': '產生規範的 commit message（不自動提交）',
      en: 'Generate a conventional commit message (does not run git commit)',
    },
    usage: {
      'zh-CN': '查看工作区改动并生成 commit message，不执行 git commit。\n用法: /commit',
      'zh-TW': '查看工作區改動並產生 commit message，不執行 git commit。\n用法: /commit',
      en: 'Inspect the working tree and propose a commit message. Does not run git commit.\nUsage: /commit',
    },
  },
  summary: {
    description: {
      'zh-CN': '对文件、模块或整个项目做高层概述',
      'zh-TW': '對檔案、模組或整個專案做高層概述',
      en: 'High-level overview of a file, module, or the whole project',
    },
    usage: {
      'zh-CN': '对文件或模块做高层概述。\n用法: /summary <文件或模块>\n示例: /summary src/core/',
      'zh-TW': '對檔案或模組做高層概述。\n用法: /summary <檔案或模組>\n示例: /summary src/core/',
      en: 'High-level overview.\nUsage: /summary <file or module>\nExample: /summary src/core/',
    },
  },
  build: {
    description: {
      'zh-CN': '构建项目并诊断/修复构建错误',
      'zh-TW': '建置專案並診斷/修復建置錯誤',
      en: 'Build the project and diagnose or fix build errors',
    },
    usage: {
      'zh-CN': '构建项目并诊断/修复构建错误。\n用法: /build',
      'zh-TW': '建置專案並診斷/修復建置錯誤。\n用法: /build',
      en: 'Build the project and fix errors.\nUsage: /build',
    },
  },
  new: {
    description: {
      'zh-CN': '根据描述创建新文件、组件、模块或功能',
      'zh-TW': '根據描述建立新檔案、元件、模組或功能',
      en: 'Create new files, components, or features from a description',
    },
    usage: {
      'zh-CN': '根据描述从零创建新代码。\n用法: /new <功能描述>\n示例: /new 创建一个基于 React 的商品列表组件',
      'zh-TW': '根據描述從零建立新程式碼。\n用法: /new <功能描述>\n示例: /new 建立一個基於 React 的商品列表元件',
      en: 'Create new code from a description.\nUsage: /new <feature>\nExample: /new a React product list component',
    },
  },
  optimize: {
    description: {
      'zh-CN': '分析并修复性能瓶颈，降低复杂度或资源消耗',
      'zh-TW': '分析並修復效能瓶頸，降低複雜度或資源消耗',
      en: 'Analyze and fix performance bottlenecks',
    },
    usage: {
      'zh-CN': '分析并修复性能瓶颈。\n用法: /optimize <文件或代码>\n示例: /optimize src/pages/Dashboard.tsx',
      'zh-TW': '分析並修復效能瓶頸。\n用法: /optimize <檔案或程式碼>\n示例: /optimize src/pages/Dashboard.tsx',
      en: 'Analyze and fix performance issues.\nUsage: /optimize <file or code>\nExample: /optimize src/pages/Dashboard.tsx',
    },
  },
};

export const META_COMMAND_UI: Record<string, CommandUiCopy> = {
  help: {
    description: {
      'zh-CN': '显示所有可用命令及说明',
      'zh-TW': '顯示所有可用命令及說明',
      en: 'Show all available commands and their descriptions',
    },
    usage: {
      'zh-CN': '显示所有可用命令及说明。\n用法: /help',
      'zh-TW': '顯示所有可用命令及說明。\n用法: /help',
      en: 'Show all available commands.\nUsage: /help',
    },
  },
  commands: {
    description: {
      'zh-CN': '列出所有可用命令（同 /help）',
      'zh-TW': '列出所有可用命令（同 /help）',
      en: 'List all available commands (same as /help)',
    },
    usage: {
      'zh-CN': '列出所有可用命令（同 /help）。\n用法: /commands',
      'zh-TW': '列出所有可用命令（同 /help）。\n用法: /commands',
      en: 'List all available commands (same as /help).\nUsage: /commands',
    },
  },
  compact: {
    description: {
      'zh-CN': '强制压缩当前会话上下文，生成检查点释放 token',
      'zh-TW': '強制壓縮當前會話上下文，產生檢查點釋放 token',
      en: 'Force-compact this session to free context tokens',
    },
    usage: {
      'zh-CN': '强制压缩当前会话上下文，生成检查点释放 token。\n用法: /compact',
      'zh-TW': '強制壓縮當前會話上下文，產生檢查點釋放 token。\n用法: /compact',
      en: 'Force-compact the conversation context.\nUsage: /compact',
    },
  },
  undo: {
    description: {
      'zh-CN': '撤销上一次对话重置（恢复被截断的对话与代码快照）',
      'zh-TW': '撤銷上一次對話重設（恢復被截斷的對話與程式碼快照）',
      en: 'Undo the last conversation reset (restore truncated messages and code snapshot)',
    },
    usage: {
      'zh-CN': '撤销上一次对话重置。\n用法: /undo',
      'zh-TW': '撤銷上一次對話重設。\n用法: /undo',
      en: 'Undo the last conversation reset.\nUsage: /undo',
    },
  },
  goal: {
    description: {
      'zh-CN': '自主循环：Worker 执行 + Verifier 验收，直到验证条件通过',
      'zh-TW': '自主迴圈：Worker 執行 + Verifier 驗收，直到驗證條件通過',
      en: 'Autonomous loop: Worker executes, Verifier checks, until the condition passes',
    },
    usage: {
      'zh-CN': '启动 Goal 自主循环。\n客观验证: /goal exec:npm test\n主观验证: /goal 修复登录页样式\n严格模式: /goal --strict exec:npm test',
      'zh-TW': '啟動 Goal 自主迴圈。\n客觀驗證: /goal exec:npm test\n主觀驗證: /goal 修復登入頁樣式\n嚴格模式: /goal --strict exec:npm test',
      en: 'Start the Goal loop.\nObjective: /goal exec:npm test\nSubjective: /goal fix login styles\nStrict: /goal --strict exec:npm test',
    },
  },
};
