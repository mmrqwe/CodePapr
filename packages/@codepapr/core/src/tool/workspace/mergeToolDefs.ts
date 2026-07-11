/**
 * LLM 可见工具定义（JSON Schema）。
 * 每个工具职责单一，action 参数一律有 enum 约束，required 完整覆盖。
 */

import type { IToolDefinition } from '@codepapr/types';

export const NEW_TOOL_DEFINITIONS: IToolDefinition[] = [
  // ──── 1. read ────
  {
    name: 'read',
    description: '读取项目文件。支持行范围（startLine/endLine）、行窗口（aroundLine）、上下文行数（contextLines）、字节限制（maxBytes）。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '文件相对路径。' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 500000。超出截断，可用 startLine/endLine 分块读取。' },
        startLine: { type: 'number', description: '起始行号（1-based）。' },
        endLine: { type: 'number', description: '结束行号（1-based）。' },
        aroundLine: { type: 'number', description: '以指定行号为中心读取窗口。' },
        contextLines: { type: 'number', description: 'aroundLine 前后各保留多少行，默认 20。' },
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
    description: '按正则表达式搜索项目文件内容，返回匹配位置与上下文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '正则表达式。' },
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
    description: '按 glob 文件名模式搜索项目文件，如 **/*.test.ts。支持正则合并。',
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
    description: '浏览项目目录树结构。',
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
    description: '语言服务只读导航。action: definition(跳转定义)|references(查找引用)。需提供文件和行号。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['definition', 'references'] },
        relativePath: { type: 'string', description: '文件相对路径。' },
        line: { type: 'number', description: '行号，1-based。' },
        column: { type: 'number', description: '列号，默认 1。' },
        includeDeclaration: { type: 'boolean', description: 'references 时是否含声明位置。' },
      },
      required: ['action', 'relativePath', 'line'],
    },
  },
  // ──── 10. lsp_edit ────
  {
    name: 'lsp_edit',
    description: '语言服务语义修改。action: rename(重命名)|code_action(代码动作)|format(格式化)。',
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
    description: '代码诊断。传 relativePath 获取单文件 LSP 诊断；传 project: true 运行项目级 lint/typecheck。',
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
  // ──── 13. exec ────
  {
    name: 'exec',
    description: '运行命令。默认阻塞等待结果。设 background:true 后台运行并返回 pid；设 previewUrl 则启动后预览。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令名。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数。' },
        timeoutSeconds: { type: 'number', description: '超时秒数，默认 30，最大 600。' },
        background: { type: 'boolean', description: '设为 true 则后台运行。' },
        previewUrl: { type: 'string', description: '后台启动后预览的 URL。' },
        title: { type: 'string', description: '后台进程标题。' },
      },
      required: ['command'],
    },
  },
  // ──── 14. shell ────
  {
    name: 'shell',
    description: '持久 Shell 会话。action: open(启动)|send(发送命令)|read(读输出尾部)|close(关闭)|list(列出全部)。send 时传 command+args 或 input（仅交互提示用）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'send', 'read', 'close', 'list'] },
        shell: { type: 'string', description: 'open 时指定 shell 路径。' },
        sessionId: { type: 'string', description: 'send/read/close 时必填。会话 ID。' },
        command: { type: 'string', description: 'send 时发送的命令名。' },
        args: { type: 'array', items: { type: 'string' }, description: 'send 时命令参数。' },
        input: { type: 'string', description: 'send 时原始输入（仅用于回复交互提示）。' },
      },
      required: ['action'],
    },
  },
  // ──── 15. proc ────
  {
    name: 'proc',
    description: '后台进程管理（由 exec background:true 创建的进程）。不传 action 默认列出；action: stop(停止指定 pid)|stop_all(停止全部)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'stop', 'stop_all'], description: '操作；默认 list。' },
        pid: { type: 'number', description: 'stop 时必填。进程 ID。' },
      },
    },
  },
  // ──── 16. browser ────
  {
    name: 'browser',
    description: '内置浏览器交互。action: open(打开URL)|navigate(导航)|reload(刷新)|close(关闭)|click(点击元素)|type(输入文本)|read(读取DOM)|screenshot(截图)|get(读状态)。open/navigate 需 url；click/type 需 selector；type 需 text。',
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
  // ──── 17. web_fetch ────
  {
    name: 'web_fetch',
    description: '读取网页内容，自动提取正文并转为纯文本。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https URL。' },
        maxBytes: { type: 'number', description: '最大返回字符数，默认 20000。' },
      },
      required: ['url'],
    },
  },
  // ──── 18. web_download ────
  {
    name: 'web_download',
    description: '下载文件到项目。默认保存到 .CodePapr/downloads/，可指定 relativePath。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件下载地址。' },
        relativePath: { type: 'string', description: '保存的相对路径。' },
      },
      required: ['url'],
    },
  },
  // ──── 19. open ────
  {
    name: 'open',
    description: '在系统默认浏览器打开 URL 或项目内 HTML 文件。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 URL。' },
        relativePath: { type: 'string', description: '项目内 HTML 文件相对路径。' },
      },
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
  // ──── 21. question ────
  {
    name: 'question',
    description: '向用户提问（Plan 模式），可提供预定义选项和多选支持。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题内容。' },
        header: { type: 'string', description: '简短标题（最长 30 字符）。' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项标签。' },
              description: { type: 'string', description: '选项说明。' },
            },
            required: ['label'],
          },
        },
        multiple: { type: 'boolean', description: '是否允许多选。' },
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
