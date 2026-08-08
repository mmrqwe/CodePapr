/**
 * LLM 可见工具定义（JSON Schema）。
 * 每个工具职责单一，action 参数一律有 enum 约束，required 完整覆盖。
 */

import type { IToolDefinition } from '@codepapr/types';

export const NEW_TOOL_DEFINITIONS: IToolDefinition[] = [
  // ──── 1. read ────
  {
    name: 'read',
    description: '读取项目文件。支持行范围（startLine/endLine）、行窗口（aroundLine）、上下文行数（contextLines）、字节限制（maxBytes）。传 symbol 可按符号名（函数/类等）精确读取该符号代码（AST 定位，无 AST 时降级文本搜索）。整文件读取较大文件时会自动附带符号大纲。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '文件相对路径。' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 500000。超出截断，可用 startLine/endLine 分块读取。' },
        startLine: { type: 'number', description: '起始行号（1-based）。' },
        endLine: { type: 'number', description: '结束行号（1-based）。' },
        aroundLine: { type: 'number', description: '以指定行号为中心读取窗口。' },
        contextLines: { type: 'number', description: 'aroundLine 前后各保留多少行，默认 20。' },
        symbol: { type: 'string', description: '可选。按符号名（函数/类等）精确读取该符号代码片段（AST 定位）。传入后忽略 startLine/endLine/aroundLine。' },
      },
      required: ['relativePath'],
    },
  },
  // ──── 2. write ────
  {
    name: 'write',
    description: '创建或完整覆盖写入文件。局部修改请用 edit。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '文件相对路径。' },
        content: { type: 'string', description: '完整文件内容。' },
      },
      required: ['relativePath', 'content'],
    },
  },
  // ──── 3. edit ────
  {
    name: 'edit',
    description: '单文件精确 SEARCH/REPLACE 修改。search 必须精确匹配源文件内容；多文件原子修改请用 patch。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '文件相对路径。' },
        search: { type: 'string', description: '要精确匹配的原始文本块。' },
        replace: { type: 'string', description: '替换后的文本块。' },
        replaceAll: { type: 'boolean', description: '是否替换全部匹配。' },
        expectedOccurrences: { type: 'number', description: '预期匹配次数，用于安全校验。' },
      },
      required: ['relativePath', 'search', 'replace'],
    },
  },
  // ──── 4. patch ────
  {
    name: 'patch',
    description: '多文件原子 SEARCH/REPLACE。所有 patch 全部精确匹配成功后一起写入，任一失败即回滚。',
    parameters: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          description: '按应用顺序排列的补丁列表。',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string', description: '文件相对路径。' },
              search: { type: 'string', description: '要精确匹配的原始文本块。' },
              replace: { type: 'string', description: '替换后的文本块。' },
              replaceAll: { type: 'boolean' },
              expectedOccurrences: { type: 'number' },
            },
            required: ['relativePath', 'search', 'replace'],
          },
        },
      },
      required: ['patches'],
    },
  },
  // ──── 5. grep ────
  {
    name: 'grep',
    description: '按正则表达式搜索项目文件内容，返回匹配位置与上下文。正则无效时自动降级为字面量搜索并在 note 中说明。支持 UTF-8/UTF-16/GB18030 等编码。semantic:true 切换语义模式（LSP workspace symbol 检索），无 LSP 时降级正则并告知。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '正则表达式（默认模式）或符号名（语义模式）。' },
        semantic: { type: 'boolean', description: '设为 true 则使用 LSP workspace symbol 语义检索；无 LSP 时降级正则搜索。' },
        relativePath: { type: 'string', description: '语义模式下的锚点文件路径，用于确定语言服务器。' },
        caseSensitive: { type: 'boolean', description: '区分大小写；默认 smart-case。' },
        contextLines: { type: 'number', description: '匹配前后额外返回多少行上下文，默认 0，最大 8。' },
        maxResults: { type: 'number', description: '最多返回多少条匹配，默认 80。' },
        maxMatchesPerFile: { type: 'number', description: '单个文件最多返回多少条匹配，默认 5，最大 20。' },
      },
      required: ['query'],
    },
  },
  // ──── 6. glob ────
  {
    name: 'glob',
    description: '按 glob 文件名模式搜索项目文件，如 **/*.test.ts、src/**/*.ts、*.md。仅支持 glob 通配符（** 跨目录、* 单层、? 单字符），不支持正则/字符类/花括号展开；需要正则请按文件名特征拆分多次查询。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '文件名或路径 glob 模式。' },
        caseSensitive: { type: 'boolean', description: '区分大小写；默认 smart-case。' },
        maxResults: { type: 'number', description: '最多返回多少条结果，默认 120。' },
      },
      required: ['query'],
    },
  },
  // ──── 7. list ────
  {
    name: 'list',
    description: '浏览目录树，返回文件/目录列表。对代码文件会自动附带轻量符号大纲（顶层符号，AST 实现），便于快速了解各文件内容。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '子目录路径；省略则列出项目根目录。' },
        maxDepth: { type: 'number', description: '递归深度，默认 2，最大 6。' },
      },
    },
  },
  // ──── 8. graph ────
  {
    name: 'graph',
     description: '项目语义图分析。action: full(完整ProjectGraph)|overview(轻量概览)|lookup(符号查找)|implementations(接口/基类实现)|dependency(依赖子图)|entrypoints(入口点)|impact(影响分析)|smart_context(智能上下文，需传query)|dead_code(死代码)|circular_deps(循环依赖)|type_hierarchy(类型继承)|suggest_refactors(重构建议)|test_impact(测试影响)|generate_tests(生成测试骨架)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['full', 'overview', 'lookup', 'implementations', 'dependency', 'entrypoints', 'impact', 'smart_context', 'dead_code', 'circular_deps', 'type_hierarchy', 'suggest_refactors', 'test_impact', 'generate_tests'],
        },
        query: { type: 'string' },
        symbolId: { type: 'string' },
        relativePath: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'] },
        depth: { type: 'number' },
        maxDepth: { type: 'number' },
        maxFiles: { type: 'number' },
        maxNodes: { type: 'number' },
        maxEdges: { type: 'number' },
        maxBytes: { type: 'number' },
        maxTreeEntries: { type: 'number' },
        maxSymbolsPerFile: { type: 'number' },
        symbolKind: { type: 'string' },
        language: { type: 'string' },
        exported: { type: 'boolean' },
        symbolName: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['action'],
    },
  },
  // ──── 9. lsp ────
  {
    name: 'lsp',
    description: '语言服务只读导航与分析。action: goToDefinition(跳转定义)|findReferences(查找引用)|hover(类型/文档信息)|documentSymbol(文件符号大纲)|workspaceSymbol(工作区符号检索，需 query)|goToImplementation(跳转实现)|prepareCallHierarchy(准备调用层级)|incomingCalls(入调用)|outgoingCalls(出调用)。多数 action 需提供文件和行号；documentSymbol/workspaceSymbol 仅需文件。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls'] },
        relativePath: { type: 'string', description: '文件相对路径。workspaceSymbol 时作为确定语言服务器的锚点文件。' },
        line: { type: 'number', description: '行号，1-based。documentSymbol/workspaceSymbol 可省略。' },
        column: { type: 'number', description: '列号，默认 1。' },
        includeDeclaration: { type: 'boolean', description: 'findReferences 时是否含声明位置。' },
        query: { type: 'string', description: 'workspaceSymbol 的符号检索词，空字符串列出全部。' },
      },
      required: ['action', 'relativePath'],
    },
  },
  // ──── 10. lsp_edit ────
  {
    name: 'lsp_edit',
    description: '语言服务语义修改，与字面 edit/patch 互补：跨文件符号改名用 rename（优先于 edit/patch）、整理导入/快速修复用 code_action（kind 如 source.organizeImports / quickfix）、格式化用 format。action: rename|code_action|format。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['rename', 'code_action', 'format'] },
        relativePath: { type: 'string', description: '文件相对路径。' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'format 时指定多文件路径列表。' },
        line: { type: 'number', description: 'rename/code_action 行号。' },
        column: { type: 'number', description: 'rename/code_action 列号。' },
        newName: { type: 'string', description: 'rename 时的新名称。' },
        title: { type: 'string', description: 'code_action 时按标题选择动作。' },
        kind: { type: 'string', description: 'code_action 时按 kind 选择，如 quickfix、source.organizeImports。' },
        preferredOnly: { type: 'boolean', description: 'code_action 时只接受 preferred 动作。' },
        tabSize: { type: 'number', description: 'format 时 tab 大小，默认 2。' },
        insertSpaces: { type: 'boolean', description: 'format 时是否空格缩进，默认 true。' },
      },
      required: ['action', 'relativePath'],
    },
  },
  // ──── 11. diagnostics ────
  {
    name: 'diagnostics',
    description: '代码诊断。project:true 运行项目级 lint/typecheck（验证整体是否改坏；write/edit/patch 的自动反馈不含项目级）；传 relativePath 按需查单文件 LSP 诊断（不修改文件）。注意：write/edit/patch 改完已自动返回该单文件诊断，无需紧接着再调本工具复查同一文件。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '文件路径，查询单文件 LSP 诊断。' },
        project: { type: 'boolean', description: '设为 true 则运行项目级诊断（lint + typecheck）。' },
      },
    },
  },
  // ──── 12. git ────
  {
    name: 'git',
    description: 'Git 操作（CodePapr 独立版本空间，不影响用户自身 Git 仓库）。action: status(工作区状态)|diff(差异)|log(提交历史)|branch(切换/创建分支)|stage(暂存)|commit(提交)|restore(恢复改动)|reset(回退，自动创建备份分支)。commit 需 message；branch 需 branchName；reset 需 target。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log', 'branch', 'stage', 'commit', 'restore', 'reset'] },
        branchName: { type: 'string', description: 'branch 时必填。目标分支名。' },
        message: { type: 'string', description: 'commit 时必填。提交说明。' },
        target: { type: 'string', description: 'reset 时必填。回退目标引用。' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: '限定路径列表。' },
        staged: { type: 'boolean', description: 'diff 时是否查看暂存区。' },
        all: { type: 'boolean', description: 'stage 时暂存全部改动。' },
        stageAll: { type: 'boolean', description: 'commit 前先暂存全部改动。' },
        allowEmpty: { type: 'boolean', description: '允许空提交。' },
        startPoint: { type: 'string', description: '创建分支时的起点引用。' },
        create: { type: 'boolean', description: '显式创建新分支。' },
        source: { type: 'string', description: 'restore 时恢复内容来源，默认 HEAD。' },
        limit: { type: 'number', description: 'log 时最多返回条数，默认 20。' },
        snapshot: { type: 'boolean', description: 'restore/reset 前创建安全快照，默认 true。' },
        includeUntracked: { type: 'boolean', description: '快照时包含未跟踪文件，默认 true。' },
        backupBranchPrefix: { type: 'string', description: '备份分支前缀，默认 codepapr/backup。' },
      },
      required: ['action'],
    },
  },
  // ──── 13. bash ────
  {
    name: 'bash',
    description: '在项目环境中执行 shell 命令（穿过 shell 解释，支持管道、&&、变量展开等）。默认阻塞等待并返回完整输出；background:true 后台运行并返回 pid。action: run(默认，执行命令)|list(列出后台进程及日志尾部)|stop(停止指定 pid)|stop_all(停止全部后台进程)。长命令（dev server、构建、测试）建议用 background:true。更换工作目录请用 workdir 参数，不要在命令里 cd（不跨调用保留）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'list', 'stop', 'stop_all'], description: '操作，默认 run。' },
        command: { type: 'string', description: 'run 时必填。要执行的 shell 命令，如 npm install、git status、ls -la。搜索文件内容请用 grep 工具，不要用 bash grep/rg。' },
        workdir: { type: 'string', description: 'run 时可选。命令的工作目录（相对项目根或绝对路径），默认项目根。' },
        timeout: { type: 'number', description: 'run 阻塞执行的超时秒数，默认 30，最大 600。' },
        background: { type: 'boolean', description: 'run 时设为 true 则后台运行并返回 pid。' },
        previewUrl: { type: 'string', description: 'background 时可选。后台服务启动后预览的 URL。' },
        pid: { type: 'number', description: 'stop 时必填。要停止的进程 ID。' },
      },
    },
  },
  // ──── 16. browser ────
  {
    name: 'browser',
    description: '内置浏览器交互。action: open(打开URL)|navigate(导航)|reload(刷新)|close(关闭)|click(点击元素)|type(输入文本)|read(读取DOM)|screenshot(截图)|get(读状态)。open/navigate 需 url；click/type 需 selector；type 需 text。open/navigate/reload 会等待页面加载完成后才返回，之后无需再用 bash sleep 等待。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'navigate', 'reload', 'close', 'click', 'type', 'read', 'screenshot', 'get'] },
        url: { type: 'string', description: 'open/navigate 时必填。' },
        selector: { type: 'string', description: 'click/type 时必填。CSS 或 XPath 选择器。' },
        text: { type: 'string', description: 'type 时必填。' },
        format: { type: 'string', description: 'screenshot 格式，默认 png。' },
        waitForNavigation: { type: 'boolean', description: '操作后等待页面导航完成。' },
        timeoutSeconds: { type: 'number', description: '等待超时秒数。' },
      },
      required: ['action'],
    },
  },
  // ──── 17. webfetch ────
  {
    name: 'webfetch',
    description: '读取公开网页内容。默认提取页面正文文本返回；设 save:true 则把原始内容（含二进制，如图片/附件）下载到项目并返回路径，relativePath 可选（默认 .CodePapr/downloads/）。由本地后端请求，可绕过前端 CORS。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取/下载的 http/https URL。' },
        maxBytes: { type: 'number', description: '文本模式最大返回字符数，默认 20000。' },
        save: { type: 'boolean', description: '设为 true 则下载原始内容（二进制安全）到项目并返回路径。' },
        relativePath: { type: 'string', description: 'save 时可选，下载到的相对路径，默认 .CodePapr/downloads/。' },
      },
      required: ['url'],
    },
  },
  // ──── 20. skill ────
  {
    name: 'skill',
    description: '加载项目 .CodePapr/skills/ 下的 Skill 说明文件。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称。' },
      },
      required: ['name'],
    },
  },
  // ──── 21. read_image ────
  {
    name: 'read_image',
    description: '读取项目中的图片文件（PNG、JPEG、WebP、GIF），返回 base64 编码的图片数据供多模态模型识别分析。支持 maxBytes 限制。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '图片文件相对路径。' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 5000000（5MB）。' },
      },
      required: ['relativePath'],
    },
  },
  // ──── 22. app_list ────
  {
    name: 'app_list',
    description: '列出当前工作区中所有已注册的 .papr 应用。返回每个应用的 appId、标题、是否有后端、是否正在运行、端口号等信息。在创建新应用前调用此工具检查是否已存在同名应用。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  // ──── 23. app_start ────
  {
    name: 'app_start',
    description: '启动指定应用的后端服务。仅对有后端（command/port）的应用有效。启动后应用面板中该应用状态变为"运行中"，用户可点击"打开"查看。启动前会检查端口是否可用。',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: '要启动的应用 ID（kebab-case）。' },
      },
      required: ['appId'],
    },
  },
  // ──── 24. app_stop ────
  {
    name: 'app_stop',
    description: '停止指定应用的后端服务。仅对正在运行的后端应用有效。停止后应用状态恢复为"就绪"，后端进程被终止。',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: '要停止的应用 ID（kebab-case）。' },
      },
      required: ['appId'],
    },
  },
  // ──── 25. app_delete ────
  {
    name: 'app_delete',
    description: '删除指定的 .papr 应用。会同时停止后端进程（如果正在运行）、删除 .CodePapr/apps/<appId>/ 目录、清除应用存储数据、取消工作区注册。删除后不可恢复。',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: '要删除的应用 ID（kebab-case）。' },
      },
      required: ['appId'],
    },
  },
  // ──── 22. question ────
  {
    name: 'question',
    description: '向用户提出明确的问题以收集需求、确认决策或消除歧义。仅在 Plan 模式下使用，当需求不明确或需要用户做关键选择时调用。如果不需要用户选择，不传 options 则用户可自由输入文本回答。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题，清晰描述需要确认的内容。' },
        header: { type: 'string', description: '简短标题（最多30字符），用于在UI中标识此问题。' },
        options: {
          type: 'array',
          description: '可选的预定义选项。如果提供，用户只能从这些选项中选择（单选或多选）；如果不提供，用户可自由输入文本回答。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项的显示文字（1-5个词，简洁）。' },
              description: { type: 'string', description: '选项的详细说明。' },
            },
            required: ['label'],
          },
        },
        multiple: { type: 'boolean', description: '是否允许多选（仅在提供 options 时有效）。默认 false 为单选。' },
      },
      required: ['question', 'header'],
    },
  },
];

/** 兼容旧代码，保留导出名（逐步迁移到 NEW_TOOL_DEFINITIONS） */
export const MERGE_TOOL_DEFINITIONS = NEW_TOOL_DEFINITIONS;

/** @deprecated 仅列出被 rename/replace 的旧工具名；lsp/lsp_edit/browser 保留原名仅做优化 */
export const OLD_MERGE_TOOL_NAMES: readonly string[] = [
  'file_read', 'file_write', 'project_graph',
  'git_read', 'git_write', 'terminal', 'web_access',
];
