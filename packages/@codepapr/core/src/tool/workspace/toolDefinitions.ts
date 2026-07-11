import type { IToolDefinition } from '@codepapr/types';

export const WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS: IToolDefinition[] = [
  {
    name: 'workspace_project_graph',
    description:
      '【首要工具】生成统一 ProjectGraph。它同时包含目录树、代码结构骨架摘要以及文件/符号/依赖关系图，是默认的项目理解工具。应在直接读取大量文件前调用此工具。适合仓库理解、架构追踪、轻量概览、符号归属、跨文件影响和入口点定位。',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: '视图模式：`full` 返回完整语义图；`overview` 偏向轻量目录树与代码结构骨架概览。默认 `full`。',
        },
        relativePath: { type: 'string', description: '可选。只为某个子目录生成 ProjectGraph。' },
        maxDepth: { type: 'number', description: '目录树深度，默认 3，最大 6。' },
        maxFiles: { type: 'number', description: '抽取源码文件数量，默认 32，最大 80。' },
        maxTreeEntries: { type: 'number', description: '目录树最多展示的节点数，默认 120，最大 240。' },
        maxSymbolsPerFile: { type: 'number', description: '每个文件最多返回多少条符号，默认 12，最大 30。' },
        maxEdges: { type: 'number', description: '最多返回多少条图关系，默认 240，最大 600。' },
        maxBytes: { type: 'number', description: '单个源码文件最多读取多少字节，默认 120000，最大 300000。' },
      },
    },
  },
  {
    name: 'workspace_symbol_lookup',
    description: '【推荐工具】在当前项目 ProjectGraph 中查找符号，适合先拿到 symbolId、文件、行号、限定名，再做后续导航或影响分析。应在直接搜索文件或文本前优先使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选。符号名、限定名、路径或签名关键字。' },
        relativePath: { type: 'string', description: '可选。只在某个文件或目录下查找。' },
        symbolKind: { type: 'string', description: '可选。符号类型，例如 class、function、interface。' },
        language: { type: 'string', description: '可选。语言名，例如 TypeScript、C#、Python。' },
        exported: { type: 'boolean', description: '可选。是否只返回导出符号。' },
        limit: { type: 'number', description: '最多返回多少条匹配，默认 20，最大 100。' },
      },
    },
  },
  {
    name: 'workspace_dependency_subgraph',
    description: '围绕某个 symbolId 或文件路径提取依赖子图，可看 incoming/outgoing/both 三种方向。',
    parameters: {
      type: 'object',
      properties: {
        symbolId: { type: 'string', description: '可选。symbol_lookup 返回的 symbolId。' },
        relativePath: { type: 'string', description: '可选。文件路径；未传 symbolId 时作为子图起点。' },
        direction: { type: 'string', description: '方向：incoming、outgoing 或 both，默认 both。' },
        depth: { type: 'number', description: '遍历深度，默认 2，最大 6。' },
        maxNodes: { type: 'number', description: '最多返回多少个节点，默认 80，最大 400。' },
        maxEdges: { type: 'number', description: '最多返回多少条边，默认 240，最大 800。' },
      },
    },
  },
  {
    name: 'workspace_entrypoints',
    description: '返回当前项目最可能的入口点文件和入口符号，适合快速锁定启动链路。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少条入口点候选，默认 20，最大 100。' },
      },
    },
  },
  {
    name: 'workspace_change_impact',
    description: '基于 ProjectGraph 反向分析某个文件或符号的影响面，返回受影响文件、符号和关系边。',
    parameters: {
      type: 'object',
      properties: {
        symbolId: { type: 'string', description: '可选。symbol_lookup 返回的 symbolId。' },
        relativePath: { type: 'string', description: '可选。文件路径；未传 symbolId 时作为影响分析起点。' },
        depth: { type: 'number', description: '反向传播深度，默认 2，最大 6。' },
        maxNodes: { type: 'number', description: '最多返回多少个节点，默认 80，最大 400。' },
        maxEdges: { type: 'number', description: '最多返回多少条边，默认 240，最大 800。' },
      },
    },
  },
  {
    name: 'workspace_symbol_implementations',
    description: '查找某个接口或基类在 ProjectGraph 里的实现/派生符号。',
    parameters: {
      type: 'object',
      properties: {
        symbolId: { type: 'string', description: '可选。symbol_lookup 返回的 symbolId。' },
        relativePath: { type: 'string', description: '可选。缩小搜索范围的文件路径。' },
        symbolName: { type: 'string', description: '可选。目标符号名；未传 symbolId 时使用。' },
        limit: { type: 'number', description: '最多返回多少条实现，默认 20，最大 100。' },
      },
    },
  },
  {
    name: 'workspace_symbol_definition',
    description: '使用语言服务跳转到定义。若当前运行时没有可用 LSP，会明确返回 unavailable。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '当前文件的相对路径。' },
        line: { type: 'number', description: '符号所在行号，从 1 开始。' },
        column: { type: 'number', description: '可选。符号所在列号，从 1 开始。默认 1。' },
      },
      required: ['relativePath', 'line'],
    },
  },
  {
    name: 'workspace_symbol_references',
    description: '使用语言服务查找引用。若当前运行时没有可用 LSP，会明确返回 unavailable。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '当前文件的相对路径。' },
        line: { type: 'number', description: '符号所在行号，从 1 开始。' },
        column: { type: 'number', description: '可选。符号所在列号，从 1 开始。默认 1。' },
        includeDeclaration: { type: 'boolean', description: '是否包含声明/定义位置，默认 true。' },
      },
      required: ['relativePath', 'line'],
    },
  },
  {
    name: 'workspace_rename_symbol',
    description: '使用语言服务做语义化重命名并应用返回的 workspace edit。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '当前文件的相对路径。' },
        line: { type: 'number', description: '目标符号所在行号，从 1 开始。' },
        column: { type: 'number', description: '可选。目标符号所在列号，从 1 开始。默认 1。' },
        newName: { type: 'string', description: '新的符号名。' },
      },
      required: ['relativePath', 'line', 'newName'],
    },
  },
  {
    name: 'workspace_organize_imports',
    description: '调用语言服务的 organize imports 代码动作并应用编辑。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '目标文件路径。' },
        line: { type: 'number', description: '可选。触发位置行号，默认 1。' },
        column: { type: 'number', description: '可选。触发位置列号，默认 1。' },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_apply_code_action',
    description: '按标题或 kind 选择一个语言服务代码动作并应用其返回的编辑。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '目标文件路径。' },
        line: { type: 'number', description: '触发位置行号，从 1 开始。' },
        column: { type: 'number', description: '可选。触发位置列号，从 1 开始。默认 1。' },
        title: { type: 'string', description: '可选。代码动作标题。' },
        kind: { type: 'string', description: '可选。代码动作 kind，例如 quickfix 或 source.organizeImports。' },
        preferredOnly: { type: 'boolean', description: '是否只接受 preferred 动作。' },
      },
      required: ['relativePath', 'line'],
    },
  },
  {
    name: 'workspace_fix_diagnostics',
    description: '优先应用当前位置最合适的 quickfix 代码动作。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '目标文件路径。' },
        line: { type: 'number', description: '触发位置行号，从 1 开始。默认 1。' },
        column: { type: 'number', description: '可选。触发位置列号，从 1 开始。默认 1。' },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_lsp_diagnostics',
    description:
      '查询 Language Server 对指定文件或全项目的实时诊断信息（编译错误、代码警告、未使用导入、代码风格提示等）。不传 relativePath 则返回当前所有已打开文件的诊断摘要。LSP 诊断覆盖传统 lint 无法捕获的语义问题，例如多余的 using、未使用的变量、类型不匹配等。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '可选。要查询诊断的文件相对路径。省略则返回全项目各文件的诊断摘要（只返回有诊断的文件）。',
        },
      },
    },
  },
  {
    name: 'workspace_format_files',
    description: '使用语言服务批量格式化多个文件并应用文本编辑。',
    parameters: {
      type: 'object',
      properties: {
        relativePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '要格式化的文件相对路径列表。',
        },
        tabSize: { type: 'number', description: '可选。tab 大小，默认 2。' },
        insertSpaces: { type: 'boolean', description: '可选。是否使用空格缩进，默认 true。' },
      },
      required: ['relativePaths'],
    },
  },
  {
    name: 'workspace_project_diagnostics',
    description: '运行项目级 lint/typecheck/build 诊断，优先返回最 relevant 的静态检查结果。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_smart_context',
    description: '[RECOMMENDED] 根据任务描述智能获取最相关的项目上下文，自动整合 ProjectGraph、符号查找和依赖分析的结果。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '任务描述或关键词，用于定位相关符号和文件。' },
        relativePath: { type: 'string', description: '可选，聚焦于特定文件或目录。' },
        depth: { type: 'number', description: '可选，依赖分析深度，默认 2。' },
      },
      required: ['query'],
    },
  },
];
