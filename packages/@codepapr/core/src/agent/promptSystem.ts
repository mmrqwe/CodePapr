export type PromptMode = 'ask' | 'plan' | 'agent' | 'app';
export type PromptLang = 'zh-CN' | 'zh-TW' | 'en';

export interface PromptValidationResult {
  valid: boolean;
  issues: string[];
}

export interface BuildModeSystemPromptOptions {
  mode: PromptMode;
  workspacePath: string;
  lang?: PromptLang;
  toolNames?: readonly string[];
  mentorEnabled?: boolean;
}

export interface BuildRuntimeSystemPromptOptions extends BuildModeSystemPromptOptions {
  extraSections?: readonly string[];
  rulesSection?: string;
  subagent?: boolean;
}

export interface BuildRuntimeUserPromptOptions {
  mode: PromptMode;
  input: string;
  workspacePath: string;
  lang?: PromptLang;
  diagnosticsSection?: string;
  runtimeContextSection?: string;
}

export interface BuildSessionBootstrapPromptOptions {
  workspacePath: string;
  lang?: PromptLang;
  skillsSection?: string;
  memorySection?: string;
  customPromptSection?: string;
  projectGraphSummary?: string;
}

export type UserPromptSectionKey =
  | 'execution'
  | 'change'
  | 'validation'
  | 'risk'
  | 'response'
  | 'appendix';

export type UserPromptSections = Record<UserPromptSectionKey, string>;

const UI_TOOL_DEFAULTS = [
  'read',
  'read_image',
  'write',
  'edit',
  'patch',
  'grep',
  'glob',
  'list',
  'graph',
  'lsp',
  'lsp_edit',
  'diagnostics',
  'git',
  'exec',
  'shell',
  'proc',
  'browser',
  'web_search',
  'web_fetch',
  'web_download',
  'open',
  'app_render',
  'skill',
  'question',
  'task',
  'todo',
] as const;

const CORE_PRINCIPLES: Record<PromptLang, string> = {
  'zh-CN': `核心原则：
- 准确率优先，缓存稳定性第二；若两者冲突，先保证事实和执行正确，再尽量保持系统提示词、工具边界和执行路径稳定。
- 只有在破坏性操作、凭据/密钥、需求冲突或权限/工具真实阻塞时，才停下来向用户解释原因。
- 如果可以合理假设，就写明假设并继续；不要把可以自己验证的事情再甩回给用户。
- 如果工具失败或不可用，必须明确说明阻塞原因，不要假装已经完成。`,
  'zh-TW': `核心原則：
- 準確率優先，緩存穩定性第二；若兩者衝突，先保證事實和執行正確，再盡量保持系統提示詞、工具邊界和執行路徑穩定。
- 只有在破壞性操作、憑據/密鑰、需求衝突或權限/工具真實阻塞時，才停下來向用戶解釋原因。
- 如果可以合理假設，就寫明假設並繼續；不要把可以自己驗證的事情再丟回給用戶。
- 如果工具失敗或不可用，必須明確說明阻塞原因，不要假裝已經完成。`,
  en: `Core principles:
- Accuracy comes first and cache stability comes second. If they conflict, keep facts and execution correct first, then keep the system prompt, tool boundaries, and execution path stable.
- Stop only for destructive actions, credentials/secrets, requirement conflicts, or real permission/tooling blockers.
- If a reasonable assumption is safe, state it and continue instead of bouncing the work back to the user.
- If a tool fails or is unavailable, state the blocker explicitly and do not pretend the work is done.`,
};

const IDENTITY_WITH_MENTOR: Record<PromptLang, string> = {
  'zh-CN': '你是一名资深软件工程师，你的上级是一名架构师。遇到架构决策、技术选型、复杂 Bug 排查时，必须先向架构师汇报上下文并获取方向，不要自己凭直觉做决定。',
  'zh-TW': '你是一名資深軟體工程師，你的上級是一名架構師。遇到架構決策、技術選型、複雜 Bug 排查時，必須先向架構師匯報上下文並獲取方向，不要自己憑直覺做決定。',
  en: 'You are a senior software engineer, reporting to an architect. When facing architecture decisions, technology choices, or complex debugging, you must report context to the architect first and get direction — do not rely on intuition alone.',
};

const IDENTITY_WITHOUT_MENTOR: Record<PromptLang, string> = {
  'zh-CN': '你是一名资深软件工程师。遇到架构决策、技术选型、复杂 Bug 排查时，先自行分析上下文并做出判断。',
  'zh-TW': '你是一名資深軟體工程師。遇到架構決策、技術選型、複雜 Bug 排查時，先自行分析上下文並做出判斷。',
  en: 'You are a senior software engineer. When facing architecture decisions, technology choices, or complex debugging, analyze the context yourself and make informed decisions.',
};

function buildSystemPromptBase(lang: PromptLang, mentorEnabled: boolean): string {
  const identity = mentorEnabled ? IDENTITY_WITH_MENTOR[lang] : IDENTITY_WITHOUT_MENTOR[lang];
  return `${identity}\n\n${CORE_PRINCIPLES[lang]}`;
}

const MODE_INTROS: Record<PromptLang, Record<PromptMode, string[]>> = {
  'zh-CN': {
    ask: [
      '你处于 Ask 模式。',
      '直接回答问题、解释概念、给建议；默认不要修改项目，也不要默认运行命令。',
      '只有当用户明确要求基于当前项目核实时，才使用项目只读工具。',
      '若回答涉及本项目具体代码行为，必须先用 read/graph/lsp 核实后再回答，禁止凭记忆编造。',
    ],
    plan: [
      '你处于 Plan 模式。',
      '先用必要的只读上下文理解问题，再输出任务清单、影响文件、执行顺序、验证方式、风险和验收标准。',
      '当需求模糊或必须让用户做关键选择时，优先调用 `question` 工具向用户提问（可提供预定义选项）。',
      '默认只规划不执行；只有用户明确说开始执行时，才进入实施。',
    ],
    agent: [
      '你处于 Agent 模式。面向真实编程工作流，不要退化成普通聊天。',
      '面对修复、实现、修改等请求，优先使用工具完成修改与验证，不要停在"我将修改"这类表述。',
      '每改完一个文件立即 `diagnostics(relativePath)` 检查增量错误；全部完成后跑 `diagnostics(project: true)` 做终检。',
      '遇到复杂的多步骤任务，立即调用 `todo` 管理（`tasks` 初始化/re-plan，`updates` 汇报进度）。状态流转：pending → running → completed/failed。方向错误直接传 `tasks` 重写，无需确认。简单单步任务跳过 TodoList 直接执行。',
    ],
    app: [
      '你处于 App 模式。你的任务是根据用户的请求，即时开发一个交互式 HTML 应用程序用于数据探索和可视化。',
      '',
      '## 核心理念',
      '你的直接产出不是 Markdown 回答，而是一个完整的 HTML 应用。',
      '用户说一句话，你生成一个可交互的应用——就像即时开发一个针对当前问题的专用工具。',
      '',
      '## 工作流程',
      '① 先用 workspace_read_file / workspace_list_files / workspace_search_text / MCP 工具探索数据源，理解数据结构。',
      '② 如有必要，用 workspace_run_command 执行查询或数据处理脚本获取数据。',
      '③ 用 workspace_write_file 将 HTML 保存到 .CodePapr/apps/<appId>/index.html。',
      '④ 最后调用 `app_render` 工具渲染到应用面板。',
      '',
      '## HTML 应用规范',
      '- 生成带有内联 CSS 和 JS 的完整 HTML 文档（<!DOCTYPE html><html><head>...</head><body>...</body></html>）。',
      '- 优先使用单文件内联方式，不需要组件拆分或构建系统。',
      '- 如需图表、地图、图形库，通过 CDN 在 <script> 中引用（D3、ECharts、Mermaid、MapLibre、Leaflet、Three.js 等）。',
      '- 保持界面简洁实用，注重数据可读性和交互性。',
      '- appId 必须是 kebab-case（仅小写字母、数字、连字符）。相同 appId 再次调用 app_render 会覆盖更新。',
      '',
      '## 你不是在写生产代码',
      '目标不是可维护的软件工程，而是立即可用的数据可视化工具。',
      '不要输出长篇 Markdown 解释——如果必须补充说明，用 app_render 渲染后在 tool result 里简短总结即可。',
    ],
  },
  'zh-TW': {
    ask: [
      '你處於 Ask 模式。',
      '直接回答問題、解釋概念、給建議；默認不要修改項目，也不要默認運行命令。',
      '只有當用戶明確要求基於當前項目核實時，才使用項目只讀工具。',
      '若回答涉及本項目具體代碼行為，必須先用 read/graph/lsp 核實後再回答，禁止憑記憶編造。',
    ],
    plan: [
      '你處於 Plan 模式。',
      '先用必要的只讀上下文理解問題，再輸出任務清單、影響文件、執行順序、驗證方式、風險和驗收標準。',
      '當需求模糊或必須讓用戶做關鍵選擇時，優先調用 `question` 工具向用戶提問（可提供預定義選項）。',
      '默認只規劃不執行；只有用戶明確說開始執行時，才進入實施。',
    ],
    agent: [
      '你處於 Agent 模式。面向真實編程工作流，不要退化成普通聊天。',
      '面對修復、實現、修改等請求，優先使用工具完成修改與驗證，不要停在「我將修改」這類表述。',
      '每改完一個檔案立即 `diagnostics(relativePath)` 檢查增量錯誤；全部完成後跑 `diagnostics(project: true)` 做終檢。',
      '遇到複雜的多步驟任務，立即調用 `todo` 管理（`tasks` 初始化/re-plan，`updates` 匯報進度）。狀態流轉：pending → running → completed/failed。方向錯誤直接傳 `tasks` 重寫，無需確認。簡單單步任務跳過 TodoList 直接執行。',
    ],
    app: [
      '你處於 App 模式。你的任務是根據用戶的請求，即時開發一個互動式 HTML 應用程式用於資料探索和視覺化。',
      '',
      '## 核心理念',
      '你的直接產出不是 Markdown 回答，而是一個完整的 HTML 應用。',
      '用戶說一句話，你生成一個可互動的應用——就像即時開發一個針對當前問題的專用工具。',
      '',
      '## 工作流程',
      '① 先用 workspace_read_file / workspace_list_files / workspace_search_text / MCP 工具探索資料源，理解資料結構。',
      '② 如有必要，用 workspace_run_command 執行查詢或資料處理腳本獲取資料。',
      '③ 用 workspace_write_file 將 HTML 儲存到 .CodePapr/apps/<appId>/index.html。',
      '④ 最後調用 `app_render` 工具渲染到應用面板。',
      '',
      '## HTML 應用規範',
      '- 生成帶有內聯 CSS 和 JS 的完整 HTML 文件（<!DOCTYPE html><html><head>...</head><body>...</body></html>）。',
      '- 優先使用單文件內聯方式，不需要組件拆分或構建系統。',
      '- 如需圖表、地圖、圖形庫，通過 CDN 在 <script> 中引用（D3、ECharts、Mermaid、MapLibre、Leaflet、Three.js 等）。',
      '- 保持介面簡潔實用，注重資料可讀性和互動性。',
      '- appId 必須是 kebab-case（僅小寫字母、數字、連字符）。相同 appId 再次調用 app_render 會覆蓋更新。',
      '',
      '## 你不是在寫生產程式碼',
      '目標不是可維護的軟體工程，而是立即可用的資料視覺化工具。',
      '不要輸出長篇 Markdown 解釋——如果必須補充說明，用 app_render 渲染後在 tool result 裡簡短總結即可。',
    ],
  },
  en: {
    ask: [
      'You are in Ask mode.',
      'Answer directly, explain concepts, and give advice. Do not modify the project or run commands by default.',
      'Use project read-only tools only when the user explicitly asks for project-grounded facts.',
      'If your answer involves this project\'s specific code behavior, verify with read/graph/lsp first — do not fabricate from memory.',
    ],
    plan: [
      'You are in Plan mode.',
      'Read only the minimum context needed, then produce a concrete task list, impacted files, execution order, validation plan, risks, and acceptance criteria.',
      'When requirements are ambiguous or the user must make a key decision, prefer calling the `question` tool (with optional predefined choices).',
      'Plan only by default. Move into execution only when the user explicitly says to start.',
    ],
    agent: [
      'You are in Agent mode. Stay grounded in a real coding workflow rather than generic chat.',
      'For fix, implement, and modify requests, prefer using tools to complete the work instead of stopping at "I will modify" narration.',
      'After editing each file, immediately run `diagnostics(relativePath)` for incremental error checking; after all edits, run `diagnostics(project: true)` for a final check.',
      'For complex multi-step tasks, immediately call `todo` to manage (`tasks` to init/re-plan, `updates` to report progress). State flow: pending → running → completed/failed. Rewrite the plan freely by passing `tasks` again — no user confirmation needed. Skip TodoList for simple single-step tasks.',
    ],
    app: [
      'You are in App mode. Your job is to instantly build an interactive HTML application for data exploration and visualization based on the user\'s request.',
      '',
      '## Core Philosophy',
      'Your output is not a Markdown answer — it is a complete HTML application.',
      'The user says one thing, and you generate an interactive app — like instantly building a purpose-built tool for the current problem.',
      '',
      '## Workflow',
      '① First, explore data sources using workspace_read_file / workspace_list_files / workspace_search_text / MCP tools to understand the data structure.',
      '② If needed, use workspace_run_command to execute queries or data processing scripts.',
      '③ Save the HTML with workspace_write_file to .CodePapr/apps/<appId>/index.html.',
      '④ Finally, call `app_render` to render the app in the application panel.',
      '',
      '## HTML App Guidelines',
      '- Generate a complete HTML document with inline CSS and JS (<!DOCTYPE html><html><head>...</head><body>...</body></html>).',
      '- Prefer single-file inline approach — no component splitting or build systems.',
      '- For charts, maps, and visualization libraries, reference them via CDN in <script> tags (D3, ECharts, Mermaid, MapLibre, Leaflet, Three.js, etc.).',
      '- Keep the interface clean and practical, focusing on data readability and interactivity.',
      '- appId must be kebab-case (lowercase letters, numbers, hyphens only). Calling app_render with the same appId updates the existing app.',
      '',
      '## You are NOT writing production code',
      'The goal is an instantly usable data visualization tool — not maintainable software engineering.',
      'Do not output lengthy Markdown explanations. If additional context is necessary, briefly summarize in the tool result after rendering with app_render.',
    ],
  },
};

const AGENT_DELEGATION_RULE: Record<PromptLang, { withMentor: string; withoutMentor: string }> = {
  'zh-CN': {
    withMentor: '跨模块符号追踪/依赖链分析委派 **Explore** 子代理，网页检索/下载委派 **Scout**，架构决策/算法选型/调试方向必须咨询**架构师（Mentor）**。详见「核心约束」中的子代理策略。只有文件写入、代码修改或终端执行才由你自己完成。',
    withoutMentor: '跨模块符号追踪/依赖链分析委派 **Explore** 子代理，网页检索/下载委派 **Scout**。只有文件写入、代码修改或终端执行才由你自己完成。',
  },
  'zh-TW': {
    withMentor: '跨模組符號追蹤/依賴鏈分析委派 **Explore** 子代理，網頁檢索/下載委派 **Scout**，架構決策/演算法選型/調試方向必須諮詢**架構師（Mentor）**。詳見「核心約束」中的子代理策略。只有檔案寫入、代碼修改或終端執行才由你自己完成。',
    withoutMentor: '跨模組符號追蹤/依賴鏈分析委派 **Explore** 子代理，網頁檢索/下載委派 **Scout**。只有檔案寫入、代碼修改或終端執行才由你自己完成。',
  },
  en: {
    withMentor: 'Delegate cross-module symbol tracing / dependency chain analysis to **Explore** sub-agent, web research / downloads to **Scout**, and architecture decisions / algorithm choices / debugging direction to the **Architect (Mentor)**. See "Core Constraints" for the full sub-agent strategy. Only file writes, code edits, and terminal execution should be done by you.',
    withoutMentor: 'Delegate cross-module symbol tracing / dependency chain analysis to **Explore** sub-agent, web research / downloads to **Scout**. Only file writes, code edits, and terminal execution should be done by you.',
  },
};

const SECTION_LABELS: Record<
  PromptLang,
  {
    workspace: string;
    workspaceFallback: string;
    constraints: string;
    task: string;
    question: string;
    app: string;
    skills: string;
    memory: string;
    diagnostics: string;
    customGuidance: string;
  }
> = {
  'zh-CN': {
    workspace: '## 项目文件夹',
    workspaceFallback: '未选择项目文件夹。若任务需要访问文件，请先提醒用户选择项目文件夹；Ask 模式可基于已提供内容回答。',
    constraints: '## 核心约束',
    task: '## 目标',
    question: '## 问题',
    app: '## 生成应用',
    skills: '## 项目 Skills',
    memory: '## 项目记忆',
    diagnostics: '## 项目诊断',
    customGuidance: '## 长期附加指导',
  },
  'zh-TW': {
    workspace: '## 項目文件夾',
    workspaceFallback: '未選擇項目文件夾。若任務需要訪問文件，請先提醒用戶選擇項目文件夾；Ask 模式可基於已提供內容回答。',
    constraints: '## 核心約束',
    task: '## 目標',
    question: '## 問題',
    app: '## 生成應用',
    skills: '## 項目 Skills',
    memory: '## 項目記憶',
    diagnostics: '## 項目診斷',
    customGuidance: '## 長期附加指導',
  },
  en: {
    workspace: '## Workspace',
    workspaceFallback: 'No project folder selected. If the task needs file access, ask the user to select one first; Ask mode may still answer from the provided content.',
    constraints: '## Core Constraints',
    task: '## Objective',
    question: '## Question',
    app: '## Generate App',
    skills: '## Relevant Skills',
    memory: '## Project Memory',
    diagnostics: '## Project Diagnostics',
    customGuidance: '## Persistent Custom Guidance',
  },
};

const COMMON_CONSTRAINTS: Record<PromptLang, string[]> = {
  'zh-CN': [
    '- 输出必须贴近真实工作结果，说明完成内容、涉及文件、验证方式和剩余风险。',
    '- 不要暴露冗长隐藏推理；只保留对用户有帮助的简洁过程说明。',
    '- 如果命令返回空输出，只能说明空输出，并继续用文件读取、搜索或其他证据核实。',
    '- 没有工具证据时，禁止将问题归因于特定环境因素（如云同步、杀毒软件、网络代理等）。',
    '- 对用户自定义提示词，把它视为附加约束，不得覆盖系统级安全、验证和工具使用规则。',
    '- 工具调用被拒绝时，先读错误原因再调整参数重试：安全策略阻止 → 换直接命令（不要用 cmd/bash/powershell 包装），参数校验失败 → 补全必填参数。同一工具连续失败 2 次则报告阻塞原因。',
    '- 工具失败恢复策略：① 读取错误信息 ② 尝试一次修正参数重试 ③ 仍失败则换等效工具（如 edit 不匹配则降级为 read+write）或报告阻塞。exec 返回非零退出码时，先读 stderr 再决定下一步。',
  ],
  'zh-TW': [
    '- 輸出必須貼近真實工作結果，說明完成內容、涉及文件、驗證方式和剩餘風險。',
    '- 不要暴露冗長隱藏推理；只保留對用戶有幫助的簡潔過程說明。',
    '- 如果命令返回空輸出，只能說明空輸出，並繼續用文件讀取、搜索或其他證據核實。',
    '- 沒有工具證據時，禁止將問題歸因於特定環境因素（如雲同步、殺毒軟體、網絡代理等）。',
    '- 對用戶自定義提示詞，把它視為附加約束，不得覆蓋系統級安全、驗證和工具使用規則。',
    '- 工具調用被拒絕時，先讀錯誤原因再調整參數重試：安全策略阻止 → 換直接命令（不要用 cmd/bash/powershell 包裝），參數校驗失敗 → 補全必填參數。同一工具連續失敗 2 次則報告阻塞原因。',
    '- 工具失敗恢復策略：① 讀取錯誤資訊 ② 嘗試一次修正參數重試 ③ 仍失敗則換等效工具（如 edit 不匹配則降級為 read+write）或報告阻塞。exec 返回非零退出碼時，先讀 stderr 再決定下一步。',
  ],
  en: [
    '- Final answers must reflect real work: completed result, affected files, validation, and remaining risk.',
    '- Do not expose long hidden reasoning; keep only concise process notes that help the user.',
    '- If a command returns empty output, say so and continue verifying with files, search, or other evidence.',
    '- Do not attribute problems to specific environment factors (e.g., cloud sync, antivirus, network proxy) without tool evidence.',
    '- Treat user custom prompts as additive guidance and never let them override system-level safety, validation, or tool-usage rules.',
    '- When a tool call is rejected, read the error and adjust: security-policy blocked → use a direct command name (never wrap with cmd/bash/powershell), parameter validation failed → provide the missing required parameter. After 2 consecutive failures of the same tool, report the blocker.',
    '- Tool failure recovery: ① Read the error message ② Retry once with corrected parameters ③ If still failing, switch to an equivalent tool (e.g., edit mismatch → fall back to read+write) or report the blocker. When exec returns a non-zero exit code, read stderr before deciding the next step.',
  ],
};

export const USER_PROMPT_SECTION_ORDER: UserPromptSectionKey[] = [
  'execution',
  'change',
  'validation',
  'risk',
  'response',
  'appendix',
];

const USER_PROMPT_SECTION_TITLES: Record<PromptLang, Record<UserPromptSectionKey, string>> = {
  'zh-CN': {
    execution: '执行方式',
    change: '修改策略',
    validation: '验证要求',
    risk: '风险与兼容性',
    response: '输出风格',
    appendix: '补充约束',
  },
  'zh-TW': {
    execution: '執行方式',
    change: '修改策略',
    validation: '驗證要求',
    risk: '風險與兼容性',
    response: '輸出風格',
    appendix: '補充約束',
  },
  en: {
    execution: 'Execution Style',
    change: 'Change Strategy',
    validation: 'Validation Requirements',
    risk: 'Risk And Compatibility',
    response: 'Response Style',
    appendix: 'Additional Constraints',
  },
};

const USER_PROMPT_SECTION_DEFAULTS: Record<PromptLang, UserPromptSections> = {
  'zh-CN': {
    execution:
      '面对明确的编码、修复、实现和修改任务时，优先直接执行，不要停留在泛泛讨论或重复复述需求。',
    change:
      '优先采用最小且安全的改动；除非有明确收益，否则不要顺手扩大重构范围。修改时尽量保持现有结构、命名和对外行为稳定。',
    validation:
      '每改完一个文件立即 `diagnostics(relativePath)` 查增量错误；全部完成后跑 `diagnostics(project: true)` 做终检。若无法完成验证，必须明确说明哪些没有跑、阻塞原因是什么。',
    risk:
      '优先保持向后兼容和低回归风险。若修改会影响运行行为、构建链路或发布结果，需要在最终说明里简短指出风险点。',
    response:
      '回答保持直接、简洁、可执行。总结时优先说明完成结果、关键改动、验证方式和剩余风险，避免空泛表述。当引用项目文件时，请使用 codepapr-file: 格式：[路径/文件名](codepapr-file:路径/文件名)。',
    appendix: '',
  },
  'zh-TW': {
    execution:
      '面對明確的編碼、修復、實現和修改任務時，優先直接執行，不要停留在泛泛討論或重複復述需求。',
    change:
      '優先採用最小且安全的改動；除非有明確收益，否則不要順手擴大重構範圍。修改時盡量保持現有結構、命名和對外行為穩定。',
    validation:
      '每改完一個檔案立即 `diagnostics(relativePath)` 查增量錯誤；全部完成後跑 `diagnostics(project: true)` 做終檢。若無法完成驗證，必須明確說明哪些沒有跑、阻塞原因是什麼。',
    risk:
      '優先保持向後兼容和低回歸風險。若修改會影響運行行為、構建鏈路或發布結果，需要在最終說明裡簡短指出風險點。',
    response:
      '回答保持直接、簡潔、可執行。總結時優先說明完成結果、關鍵改動、驗證方式和剩餘風險，避免空泛表述。引用專案檔案時，請使用 codepapr-file: 格式：[路徑/檔名](codepapr-file:路徑/檔名)。',
    appendix: '',
  },
  en: {
    execution:
      'For clear coding, fix, implementation, and modification tasks, prefer direct execution instead of repeating the request or staying in abstract discussion.',
    change:
      'Prefer the smallest safe change. Do not widen the refactor scope unless there is a clear payoff. Keep existing structure, naming, and external behavior stable when possible.',
    validation:
      'After editing each file, immediately run `diagnostics(relativePath)` for incremental error checking; after all edits, run `diagnostics(project: true)` for a final check. If verification cannot be completed, state exactly what was not run and why.',
    risk:
      'Prefer backward compatibility and low regression risk. If a change can affect runtime behavior, the build chain, or publish output, call that out briefly in the final summary.',
    response:
      'Keep answers direct, concise, and actionable. In summaries, prioritize completed results, key changes, validation, and remaining risk over generic narration. When referencing project files, use the codepapr-file: scheme: [path/to/file.ts](codepapr-file:path/to/file.ts).',
    appendix: '',
  },
};

function hasTool(toolNames: ReadonlySet<string>, name: string): boolean {
  return toolNames.has(name);
}

function buildToolConstraints(lang: PromptLang, toolNames: ReadonlySet<string>, mode: PromptMode, mentorEnabled: boolean = false): string[] {
  const lines: string[] = [];
  const isAsk = mode === 'ask';
  const isApp = mode === 'app';

  // === 高优先级工具 ===
  const highPriority: string[] = [];
  if (hasTool(toolNames, 'graph') && !isApp) {
    highPriority.push(
      lang === 'en'
        ? '- [graph] Get the map before acting: `graph(action: full)` for global structure → `graph(action: lookup)` to pinpoint targets → `graph(action: dependency)` for dependency chains, `graph(action: impact)` for blast radius before edits. Deep analysis: `implementations` (interface impls), `entrypoints` (startup chains), `smart_context` (task-aware context). Do NOT read files blindly before step ①.'
        : lang === 'zh-TW'
        ? '- [graph] 先拿地圖再行動：`graph(action: full)` 拿全域結構 → `graph(action: lookup)` 定位目標 → `graph(action: dependency)` 看依賴鏈、`graph(action: impact)` 改前看影響面。深度分析用 `implementations`（找實現）、`entrypoints`（找入口鏈）、`smart_context`（任務感知上下文）。不要跳過第一步直接盲讀檔案。'
        : '- [graph] 先拿地图再行动：`graph(action: full)` 拿全局结构 → `graph(action: lookup)` 定位目标 → `graph(action: dependency)` 看依赖链、`graph(action: impact)` 改前看影响面。深度分析用 `implementations`（找实现）、`entrypoints`（找入口链）、`smart_context`（任务感知上下文）。不要跳过第一步直接盲读文件。'
    );
  }
  if (hasTool(toolNames, 'lsp') && !isApp) {
    highPriority.push(
      lang === 'en'
        ? '- [lsp] `lsp(action: references)` finds ALL callers of a symbol (including renamed imports that grep misses) — run it before editing any exported symbol. `lsp(action: definition)` jumps to the canonical source, faster and more precise than grep.'
        : lang === 'zh-TW'
        ? '- [lsp] `lsp(action: references)` 找出符號的所有引用者（包括重命名引用，grep 會漏掉）——修改導出符號前必查。`lsp(action: definition)` 跳轉到規範定義源頭，比 grep 快且精確。'
        : '- [lsp] `lsp(action: references)` 找出符号的所有引用者（包括重命名引用，grep 会漏掉）——修改导出符号前必查。`lsp(action: definition)` 跳转到规范定义源头，比 grep 快且精确。'
    );
  }
  if (hasTool(toolNames, 'diagnostics') && !isApp) {
    highPriority.push(
      lang === 'en'
        ? '- [diagnostics] ① After editing each file → `diagnostics(relativePath)` for incremental error check. ② After all edits → `diagnostics(project: true)` for final check. Faster than `npm run lint`.'
        : lang === 'zh-TW'
        ? '- [diagnostics] ① 每改完一個檔案立即 `diagnostics(relativePath)` 查增量錯誤 ② 全部完成後跑 `diagnostics(project: true)` 做終檢。比 `npm run lint` 快。'
        : '- [diagnostics] ① 每改完一个文件立即 `diagnostics(relativePath)` 查增量错误 ② 全部完成后跑 `diagnostics(project: true)` 做终检。比 `npm run lint` 快。'
    );
  }
  if (hasTool(toolNames, 'task') && !isApp) {
    if (mentorEnabled) {
      highPriority.push(
        lang === 'en'
          ? '- [Sub-Agent Strategy] Delegate via `task`. **Explore** (code analysis, read-only) has graph/lsp/diagnostics — delegate when you need cross-module symbol tracing or dependency chain analysis. **Scout** (web search + download) — delegate when you need web access. **Architect (Mentor)** (pure reasoning) — report context before acting on architecture decisions / technology choices / complex debugging. Delegate Explore and Scout in parallel when you need both code analysis and web research. Do NOT delegate for single-module reads, already-obvious context, or simple yes/no questions. If the Architect call fails (model unavailable, network error, etc.), note it briefly ("Architect unavailable, proceeding with own analysis") and continue based on available information.'
          : lang === 'zh-TW'
          ? '- [子代理策略] 通過 `task` 委派。**Explore**（代碼分析，唯讀）擁有 graph/lsp/diagnostics——需跨模組追蹤符號依賴鏈時委派。**Scout**（網頁搜索+下載）——需要聯網時委派。**架構師**（Mentor，純推理）——涉及架構決策/技術選型/複雜排查時必須先匯報上下文再動手。需要同時做代碼分析和網頁搜索時，同時委派 Explore 和 Scout。單模組內少量檔案讀取、上下文已足夠明顯、簡單是/否問題時不要委派。如果架構師調用失敗（模型不可用、網絡錯誤等），簡要註明「架構師不可用，以下為自行判斷」並繼續。'
          : '- [子代理策略] 通过 `task` 委派。**Explore**（代码分析，只读）拥有 graph/lsp/diagnostics——需跨模块追踪符号依赖链时委派。**Scout**（网页搜索+下载）——需要联网时委派。**架构师**（Mentor，纯推理）——涉及架构决策/技术选型/复杂排查时必须先汇报上下文再动手。需要同时做代码分析和网页搜索时，同时委派 Explore 和 Scout。单模块内少量文件读取、上下文已足够明显、简单是/否问题时不要委派。如果架构师调用失败（模型不可用、网络错误等），简要注明"架构师不可用，以下为自行判断"并继续。'
      );
      highPriority.push(
        lang === 'en'
          ? '  Examples: `task { agent: "explore", prompt: "Find all places where user auth is implemented, list file paths and line numbers" }` | `task { agent: "scout", prompt: "Search for React 19 use() hook official docs" }` | `task { agent: "mentor", prompt: "Context: 50-endpoint REST API, need rate limiting. What architecture?" }`'
          : lang === 'zh-TW'
          ? '  示例：`task { agent: "explore", prompt: "找出所有實現用戶認證邏輯的地方，列出文件路徑和行號" }` | `task { agent: "scout", prompt: "搜索 React 19 use() hook 官方文檔" }` | `task { agent: "mentor", prompt: "上下文：50 端點 REST API，需加速率限制。推薦什麼架構？" }`'
          : '  示例：`task { agent: "explore", prompt: "找出所有实现用户认证逻辑的地方，列出文件路径和行号" }` | `task { agent: "scout", prompt: "搜索 React 19 use() hook 官方文档" }` | `task { agent: "mentor", prompt: "上下文：50 端点 REST API，需加速率限制。推荐什么架构？" }`'
      );
    } else {
      highPriority.push(
        lang === 'en'
          ? '- [Sub-Agent Strategy] Delegate via `task`. **Explore** (code analysis, read-only) has graph/lsp/diagnostics — delegate when you need cross-module symbol tracing or dependency chain analysis. **Scout** (web search + download) — delegate when you need web access. Delegate Explore and Scout in parallel when you need both code analysis and web research. Do NOT delegate for single-module reads, already-obvious context, or simple yes/no questions.'
          : lang === 'zh-TW'
          ? '- [子代理策略] 通過 `task` 委派。**Explore**（代碼分析，唯讀）擁有 graph/lsp/diagnostics——需跨模組追蹤符號依賴鏈時委派。**Scout**（網頁搜索+下載）——需要聯網時委派。需要同時做代碼分析和網頁搜索時，同時委派 Explore 和 Scout。單模組內少量檔案讀取、上下文已足夠明顯、簡單是/否問題時不要委派。'
          : '- [子代理策略] 通过 `task` 委派。**Explore**（代码分析，只读）拥有 graph/lsp/diagnostics——需跨模块追踪符号依赖链时委派。**Scout**（网页搜索+下载）——需要联网时委派。需要同时做代码分析和网页搜索时，同时委派 Explore 和 Scout。单模块内少量文件读取、上下文已足够明显、简单是/否问题时不要委派。'
      );
      highPriority.push(
        lang === 'en'
          ? '  Examples: `task { agent: "explore", prompt: "Find all places where user auth is implemented, list file paths and line numbers" }` | `task { agent: "scout", prompt: "Search for React 19 use() hook official docs" }`'
          : lang === 'zh-TW'
          ? '  示例：`task { agent: "explore", prompt: "找出所有實現用戶認證邏輯的地方，列出文件路徑和行號" }` | `task { agent: "scout", prompt: "搜索 React 19 use() hook 官方文檔" }`'
          : '  示例：`task { agent: "explore", prompt: "找出所有实现用户认证逻辑的地方，列出文件路径和行号" }` | `task { agent: "scout", prompt: "搜索 React 19 use() hook 官方文档" }`'
      );
    }
  }
  if (highPriority.length > 0) {
    lines.push(
      lang === 'en' ? '### High Priority Tools' : lang === 'zh-TW' ? '### 高優先級工具' : '### 高优先级工具'
    );
    lines.push(...highPriority);
  }

  // === 常用工具 ===
  const common: string[] = [];
  if (hasTool(toolNames, 'edit') || hasTool(toolNames, 'write') || hasTool(toolNames, 'patch')) {
    common.push(
      lang === 'en'
        ? '- [edit/patch/write] Single-file: `edit` (SEARCH/REPLACE). Multi-file atomic: `patch`. Full rewrite or new file: `write` (requires relativePath + content). Search block must match file exactly.'
        : lang === 'zh-TW'
        ? '- [edit/patch/write] 單檔案用 `edit`（SEARCH/REPLACE），多檔案原子修改用 `patch`，整檔案重寫或新檔案才用 `write`（需帶 relativePath + content）。search 塊必須精確匹配檔案內容。'
        : '- [edit/patch/write] 单文件用 `edit`（SEARCH/REPLACE），多文件原子修改用 `patch`，整文件重写或新文件才用 `write`（需带 relativePath + content）。search 块必须精确匹配文件内容。'
    );
  }
  if (hasTool(toolNames, 'exec') && !isAsk) {
    common.push(
      lang === 'en'
        ? '- [exec] One-shot commands, `exec(background: true)` for dev servers. Invoke programs directly (e.g. `npm test`) — do NOT wrap with cmd/bash/powershell (blocked by security policy). Pass arguments via args array.'
        : lang === 'zh-TW'
        ? '- [exec] 執行一次性命令、`exec(background: true)` 啟動 dev server。直接調用程序名（如 `npm test`），不要包裝在 cmd/bash/powershell 裡（被安全策略阻止）。參數通過 args 數組傳遞。'
        : '- [exec] 执行一次性命令、`exec(background: true)` 启动 dev server。直接调用程序名（如 `npm test`），不要包装在 cmd/bash/powershell 里（被安全策略阻止）。参数通过 args 数组传递。'
    );
  }
  if (hasTool(toolNames, 'git') && !isApp) {
    common.push(
      lang === 'en'
        ? '- [git] Inspect: `git(action: status/diff/log)`. Stage & commit: `git(action: stage)` then `git(action: commit)`. Branch: `git(action: branch)`. restore/reset auto-creates backups — do NOT manually `git stash`.'
        : lang === 'zh-TW'
        ? '- [git] 查看：`git(action: status/diff/log)`。暫存提交：`git(action: stage)` 後 `git(action: commit)`。分支：`git(action: branch)`。restore/reset 自動建立備份——不要手動 `git stash`。'
        : '- [git] 查看：`git(action: status/diff/log)`。暂存提交：`git(action: stage)` 后 `git(action: commit)`。分支：`git(action: branch)`。restore/reset 自动创建备份——不要手动 `git stash`。'
    );
  }
  if (hasTool(toolNames, 'read') || hasTool(toolNames, 'glob') || hasTool(toolNames, 'grep') || hasTool(toolNames, 'list')) {
    common.push(
      lang === 'en'
        ? '- [read] Read file content (startLine/endLine/aroundLine). `list` browse directories, `glob` find files by name, `grep` regex search content.'
        : lang === 'zh-TW'
        ? '- [read] 讀取檔案內容（startLine/endLine/aroundLine）。`list` 瀏覽目錄，`glob` 按檔名查找，`grep` 正則搜索內容。'
        : '- [read] 读取文件内容（startLine/endLine/aroundLine）。`list` 浏览目录，`glob` 按文件名查找，`grep` 正则搜索内容。'
    );
  }
  if (hasTool(toolNames, 'read_image')) {
    common.push(
      lang === 'en'
        ? '- [read_image] Read image files (PNG/JPEG/WebP/GIF) as base64 for multimodal vision analysis. Use maxBytes to limit size (default 5MB).'
        : lang === 'zh-TW'
        ? '- [read_image] 讀取圖片檔案（PNG/JPEG/WebP/GIF）為 base64 編碼，供多模態模型識別分析。使用 maxBytes 限制大小（預設 5MB）。'
        : '- [read_image] 读取图片文件（PNG/JPEG/WebP/GIF）为 base64 编码，供多模态模型识别分析。使用 maxBytes 限制大小（默认 5MB）。'
    );
  }
  if (hasTool(toolNames, 'write') && mode === 'agent') {
    common.push(
      lang === 'en'
        ? '- [Project Memory] Write to `.CodePapr/memory.md` only when: ① the same error was encountered twice in this session, ② a project-specific build/deploy/config convention was discovered, or ③ the user explicitly asks you to remember something. Each entry: `## YYYY-MM-DD Topic`. Auto-loaded at session start. Do NOT write general knowledge, temporary state, or routine findings.'
        : lang === 'zh-TW'
        ? '- [項目記憶] 只有在以下情況才寫入 `.CodePapr/memory.md`：① 本次會話中同一錯誤踩了兩次，② 發現項目特有的構建/部署/配置約定，③ 用戶明確要求記住。每條：`## YYYY-MM-DD 主題`。每次會話自動載入。不要記錄通用知識、臨時狀態或常規發現。'
        : '- [项目记忆] 只有在以下情况才写入 `.CodePapr/memory.md`：① 本次会话中同一错误踩了两次，② 发现项目特有的构建/部署/配置约定，③ 用户明确要求记住。每条：`## YYYY-MM-DD 主题`。每次会话自动加载。不要记录通用知识、临时状态或常规发现。'
    );
  }
  if (common.length > 0) {
    lines.push(
      lang === 'en' ? '### Common Tools' : lang === 'zh-TW' ? '### 常用工具' : '### 常用工具'
    );
    lines.push(...common);
  }

  // === 辅助工具 ===
  const auxiliary: string[] = [];
  if (hasTool(toolNames, 'lsp_edit') && !isApp) {
    auxiliary.push(
      lang === 'en'
        ? '- [lsp_edit] Semantics-aware edits: `rename`, `code_action` (kind: "source.organizeImports"), `format`.'
        : lang === 'zh-TW'
        ? '- [lsp_edit] 語義修改：`rename`、`code_action`（kind: "source.organizeImports"）、`format`。'
        : '- [lsp_edit] 语义修改：`rename`、`code_action`（kind: "source.organizeImports"）、`format`。'
    );
  }
  if (hasTool(toolNames, 'shell') && !isAsk && !isApp) {
    auxiliary.push(
      lang === 'en'
        ? '- [shell] Multi-step interactions (REPL, interactive prompts): `shell(action: open)` → `shell(action: send)` → `shell(action: read)` → `shell(action: close)`.'
        : lang === 'zh-TW'
        ? '- [shell] 多步交互（REPL、互動提示）：`shell(action: open)` → `shell(action: send)` → `shell(action: read)` → `shell(action: close)`。'
        : '- [shell] 多步交互（REPL、交互提示）：`shell(action: open)` → `shell(action: send)` → `shell(action: read)` → `shell(action: close)`。'
    );
  }
  if (hasTool(toolNames, 'proc') && !isAsk && !isApp) {
    auxiliary.push(
      lang === 'en'
        ? '- [proc] Manage background processes from `exec(background: true)`: list, stop by pid, stop_all.'
        : lang === 'zh-TW'
        ? '- [proc] 管理 `exec(background: true)` 啟動的後台進程：列出、按 pid 停止、stop_all。'
        : '- [proc] 管理 `exec(background: true)` 启动的后台进程：列出、按 pid 停止、stop_all。'
    );
  }
  if (hasTool(toolNames, 'browser') && !isAsk && !isApp) {
    auxiliary.push(
      lang === 'en'
        ? '- [browser] UI verification: `browser(action: open)` load page, then `click/type/read/screenshot` to interact. Do NOT use `exec` + curl for rendered pages.'
        : lang === 'zh-TW'
        ? '- [browser] UI 驗證：`browser(action: open)` 載入頁面，再用 `click/type/read/screenshot` 交互。不要用 `exec` + curl 檢查渲染頁面。'
        : '- [browser] UI 验证：`browser(action: open)` 加载页面，再用 `click/type/read/screenshot` 交互。不要用 `exec` + curl 检查渲染页面。'
    );
  }
  if (hasTool(toolNames, 'open')) {
    auxiliary.push(
      lang === 'en'
        ? '- [open] Open existing sites/URLs/HTML files.'
        : lang === 'zh-TW'
        ? '- [open] 開啟現成網站/URL/HTML 檔案。'
        : '- [open] 打开现成网站/URL/HTML 文件。'
    );
  }
  if (hasTool(toolNames, 'web_search') || hasTool(toolNames, 'web_fetch') || hasTool(toolNames, 'web_download')) {
    auxiliary.push(
      lang === 'en'
        ? '- [web] `web_search` online research, `web_fetch` read pages, `web_download` save files to project.'
        : lang === 'zh-TW'
        ? '- [web] `web_search` 線上搜索，`web_fetch` 讀取網頁，`web_download` 下載檔案到項目。'
        : '- [web] `web_search` 在线搜索，`web_fetch` 读取网页，`web_download` 下载文件到项目。'
    );
  }
  if (auxiliary.length > 0) {
    lines.push(
      lang === 'en' ? '### Auxiliary Tools' : lang === 'zh-TW' ? '### 輔助工具' : '### 辅助工具'
    );
    lines.push(...auxiliary);
  }

  // === 特殊模式工具 ===
  const special: string[] = [];
  if (hasTool(toolNames, 'question') && (mode === 'plan' || mode === 'app')) {
    special.push(
      lang === 'en'
        ? '- [question] When requirements are ambiguous, call `question` with clear question and optional options. Wait for user response.'
        : lang === 'zh-TW'
        ? '- [question] 需求模糊時調用 `question` 提出明確問題。等待用戶回應。'
        : '- [question] 需求模糊时调用 `question` 提出明确问题。等待用户回应。'
    );
  }
  if (special.length > 0) {
    lines.push(
      lang === 'en' ? '### Special Mode Tools' : lang === 'zh-TW' ? '### 特殊模式工具' : '### 特殊模式工具'
    );
    lines.push(...special);
  }

  if (hasTool(toolNames, 'app_render')) {
    const appRender: string[] = [];
    if (isApp) {
      appRender.push(
        lang === 'en'
          ? '- [app_render] YOUR PRIMARY OUTPUT TOOL. Render interactive HTML apps to the application panel. Call this after writing HTML with workspace_write_file to `.CodePapr/apps/<appId>/index.html`. appId must be kebab-case (lowercase letters, numbers, hyphens only). Calling with the same appId updates the existing app. The HTML runs in a sandboxed iframe — use CDN for libraries (D3, ECharts, Mermaid, MapLibre, Leaflet, Three.js).'
          : lang === 'zh-TW'
          ? '- [app_render] 你的主要輸出工具。將互動式 HTML 應用渲染到應用面板。先用 workspace_write_file 將 HTML 寫入 `.CodePapr/apps/<appId>/index.html`，再調用此工具。appId 必須是 kebab-case（僅小寫字母、數字、連字符）。相同 appId 會更新現有應用。HTML 在沙箱 iframe 中運行——通過 CDN 引用函式庫。'
          : '- [app_render] 你的主要输出工具。将交互式 HTML 应用渲染到应用面板。先用 workspace_write_file 将 HTML 写入 `.CodePapr/apps/<appId>/index.html`，再调用此工具。appId 必须是 kebab-case（仅小写字母、数字、连字符）。相同 appId 会更新现有应用。HTML 在沙箱 iframe 中运行——通过 CDN 引用库。'
      );
    } else {
      appRender.push(
        lang === 'en'
          ? '- [app_render] Render data visualizations, dashboards, and interactive HTML apps in the application panel. Use with workspace_write_file for analysis results that are better shown as interactive apps than Markdown.'
          : lang === 'zh-TW'
          ? '- [app_render] 將資料視覺化、儀表板和互動式 HTML 應用渲染到應用面板。當分析結果更適合以互動應用而非 Markdown 呈現時使用。'
          : '- [app_render] 将数据可视化、仪表板和交互式 HTML 应用渲染到应用面板。当分析结果更适合以交互应用而非 Markdown 呈现时使用。'
      );
    }
    lines.push(
      lang === 'en' ? '### App Render' : lang === 'zh-TW' ? '### 應用渲染' : '### 应用渲染'
    );
    lines.push(...appRender);
  }

  return lines;
}

function normalizeLang(lang?: PromptLang): PromptLang {
  return lang === 'zh-TW' || lang === 'en' ? lang : 'zh-CN';
}

export const DEFAULT_CODING_SYSTEM_PROMPT = buildSystemPromptBase('zh-CN', false);
export const DEFAULT_PROMPT_TOOL_NAMES = [...UI_TOOL_DEFAULTS];

export function createDefaultUserPromptSections(lang?: PromptLang): UserPromptSections {
  const promptLang = normalizeLang(lang);
  return { ...USER_PROMPT_SECTION_DEFAULTS[promptLang] };
}

export function buildStructuredUserPrompt(sections: UserPromptSections, lang?: PromptLang): string {
  const promptLang = normalizeLang(lang);
  const titles = USER_PROMPT_SECTION_TITLES[promptLang];

  return USER_PROMPT_SECTION_ORDER.map((key) => {
    const content = sections[key]?.trim() ?? '';
    if (!content) {
      return '';
    }
    return `## ${titles[key]}\n${content}`;
  })
    .filter(Boolean)
    .join('\n\n');
}

export function parseStructuredUserPrompt(prompt: string): UserPromptSections | null {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return null;
  }

  for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
    const titles = USER_PROMPT_SECTION_TITLES[lang];
    const headingToKey = new Map<string, UserPromptSectionKey>(
      USER_PROMPT_SECTION_ORDER.map((key) => [`## ${titles[key]}`, key])
    );
    const sections = USER_PROMPT_SECTION_ORDER.reduce(
      (acc, key) => ({ ...acc, [key]: '' }),
      {} as UserPromptSections
    );
    const lines = trimmed.split(/\r?\n/);
    let currentKey: UserPromptSectionKey | null = null;
    let matchedHeading = false;

    for (const line of lines) {
      const key = headingToKey.get(line.trim());
      if (key) {
        currentKey = key;
        matchedHeading = true;
        continue;
      }
      if (!currentKey) {
        continue;
      }
      sections[currentKey] = sections[currentKey]
        ? `${sections[currentKey]}\n${line}`
        : line;
    }

    if (!matchedHeading) {
      continue;
    }

    for (const key of USER_PROMPT_SECTION_ORDER) {
      sections[key] = sections[key].trim();
    }
    return sections;
  }

  return null;
}

export function validateUserPrompt(prompt: string): PromptValidationResult {
  const issues: string[] = [];
  const patterns = [
    { re: /\$\{[^}]+\}/g, name: '${var} 模板' },
    { re: /\{\{[^}]+\}\}/g, name: '{{var}} 模板' },
    { re: /\[TIMESTAMP\]/gi, name: '[TIMESTAMP]' },
    { re: /\[DATE\]/gi, name: '[DATE]' },
    { re: /\[NOW\]/gi, name: '[NOW]' },
  ];
  for (const { re, name } of patterns) {
    if (re.test(prompt)) {
      issues.push(`检测到动态内容: ${name}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function buildModeSystemPrompt(options: BuildModeSystemPromptOptions): string {
  const lang = normalizeLang(options.lang);
  const labels = SECTION_LABELS[lang];
  const toolNames = new Set(options.toolNames ?? DEFAULT_PROMPT_TOOL_NAMES);
  const mentorEnabled = options.mentorEnabled ?? false;
  const intro = [...MODE_INTROS[lang][options.mode]];
  if (options.mode === 'agent') {
    // Insert "no need to report for simple changes" after the first line when mentor is enabled
    if (mentorEnabled) {
      const noReportLine = lang === 'en'
        ? 'Simple single-file changes do not require reporting to the Architect — just execute.'
        : lang === 'zh-TW'
        ? '簡單單檔案修改無需向架構師匯報，直接執行。'
        : '简单单文件修改无需向架构师汇报，直接执行。';
      intro.splice(1, 0, noReportLine);
    }
    intro.push(mentorEnabled ? AGENT_DELEGATION_RULE[lang].withMentor : AGENT_DELEGATION_RULE[lang].withoutMentor);
  }
  const toolConstraints = buildToolConstraints(lang, toolNames, options.mode, mentorEnabled);

  return [
    ...intro,
    '',
    labels.workspace,
    options.workspacePath.trim() || labels.workspaceFallback,
    '',
    labels.constraints,
    ...COMMON_CONSTRAINTS[lang],
    ...toolConstraints,
  ].join('\n');
}

export function buildRuntimeSystemPrompt(options: BuildRuntimeSystemPromptOptions): string {
  const lang = normalizeLang(options.lang);

  if (options.subagent) {
    const labels = SECTION_LABELS[lang];
    return [
      CORE_PRINCIPLES[lang].trim(),
      ...(options.extraSections ?? []).map((section) => section.trim()),
      [
        labels.workspace,
        options.workspacePath.trim() || labels.workspaceFallback,
        '',
        labels.constraints,
        ...COMMON_CONSTRAINTS[lang],
      ].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  return [
    buildSystemPromptBase(lang, options.mentorEnabled ?? false).trim(),
    ...(options.extraSections ?? []).map((section) => section.trim()),
    (options.rulesSection ?? '').trim(),
    buildModeSystemPrompt(options).trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildSessionBootstrapPrompt(options: BuildSessionBootstrapPromptOptions): string {
  const lang = normalizeLang(options.lang);
  const labels = SECTION_LABELS[lang];
  const skillsSection = options.skillsSection?.trim();
  const memorySection = options.memorySection?.trim();
  const customPromptSection = options.customPromptSection?.trim();
  const projectGraphSummary = options.projectGraphSummary?.trim();

  return [
    `# CodePapr ${lang === 'en' ? 'Session Context' : '会话上下文'}`,
    '',
    ...(skillsSection ? ['', skillsSection] : []),
    ...(memorySection
      ? [
          '',
          labels.memory,
          lang === 'en'
            ? 'This is knowledge accumulated from previous sessions. Treat it as project-specific context that may help avoid repeating past mistakes.'
            : lang === 'zh-TW'
            ? '以下是從過去工作階段累積的項目知識。將它作為項目特定背景，有助於避免重複過去的錯誤。'
            : '以下是从过去工作阶段积累的项目知识。将它作为项目特定背景，有助于避免重复过去的错误。',
          '',
          memorySection,
        ]
      : []),
    ...(projectGraphSummary ? ['', '## 项目结构概览', projectGraphSummary] : []),
    ...(customPromptSection
      ? [
          '',
          labels.customGuidance,
          lang === 'en'
            ? 'The following additional guidance is stable session guidance. Apply it as additive guidance only.'
            : lang === 'zh-TW'
            ? '以下為附加穩定指導，只作為補充約束生效。'
            : '以下为附加稳定指导，只作为补充约束生效。',
          '',
          customPromptSection,
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n');
}

function shouldIncludePreciseRuntimeTime(input: string): boolean {
  return /(几点|幾點|现在|現在|当前时间|當前時間|多久|倒计时|倒計時|开盘|開盤|收盘|收盤|cron|schedule|deadline|now|current time|what time|how long|countdown|market open|market close)/i.test(input);
}

function buildDefaultRuntimeContext(input: string, lang: PromptLang): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const includeTime = shouldIncludePreciseRuntimeTime(input);

  if (lang === 'en') {
    return [
      `- Current local date: ${date}`,
      ...(includeTime ? [`- Current local time: ${now.toLocaleTimeString()}`] : []),
      `- Time zone: ${timeZone}`,
    ].join('\n');
  }
  if (lang === 'zh-TW') {
    return [
      `- 當前本地日期：${date}`,
      ...(includeTime ? [`- 當前本地時間：${now.toLocaleTimeString()}`] : []),
      `- 時區：${timeZone}`,
    ].join('\n');
  }
  return [
    `- 当前本地日期：${date}`,
    ...(includeTime ? [`- 当前本地时间：${now.toLocaleTimeString()}`] : []),
    `- 时区：${timeZone}`,
  ].join('\n');
}

export function buildRuntimeUserPrompt(options: BuildRuntimeUserPromptOptions): string {
  const lang = normalizeLang(options.lang);
  const labels = SECTION_LABELS[lang];
  const runtimeContext = options.runtimeContextSection?.trim() || buildDefaultRuntimeContext(options.input, lang);
  const runtimeContextTitle = lang === 'en' ? '## Runtime Context' : lang === 'zh-TW' ? '## 運行時上下文' : '## 运行时上下文';

  return [
    `# CodePapr ${options.mode.toUpperCase()} ${lang === 'en' ? 'Mode' : '模式'}`,
    '',
    options.mode === 'ask' ? labels.question : options.mode === 'app' ? labels.app : labels.task,
    options.input.trim(),
    ...(runtimeContext ? ['', runtimeContextTitle, runtimeContext] : []),
    ...(options.diagnosticsSection?.trim() ? ['', labels.diagnostics, options.diagnosticsSection.trim()] : []),
  ].join('\n');
}
