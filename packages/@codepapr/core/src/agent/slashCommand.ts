/**
 * slashCommand: 聊天命令解析与模板展开（纯逻辑）
 *
 * 约定：在项目 `.CodePapr/commands/<name>.md` 中用 YAML frontmatter + Markdown 正文定义命令。
 * frontmatter 支持：
 *   description: 命令描述（可选）
 *   agent: 指定运行该命令的子代理（可选）
 *   model: 覆盖模型（可选）
 * 正文为提示词模板，支持占位符：
 *   $ARGUMENTS  -> 全部参数（空格连接）
 *   $1 $2 ...    -> 第 N 个参数
 *   @path        -> 内联读取文件内容
 *   !`cmd`       -> 内联执行简单命令行并嵌入其输出
 */

export interface CommandDefinition {
  name: string;
  description?: string;
  usage?: string;
  example?: string;
  agent?: string;
  model?: string;
  template: string;
}

export const BUILTIN_PROMPT_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'review',
    description: '审查当前改动或指定范围，优先报告 bug、回归风险和缺失验证',
    usage: '对指定范围做严格代码审查。\n用法: /review <文件或范围>\n示例: /review src/auth/  或 /review 最近的改动',
    example: '/review <文件或范围>',
    template:
      '请以严格代码审查方式检查 $ARGUMENTS。先收集最小必要上下文，再优先报告真实 bug、行为回归、边界条件遗漏和缺失验证。输出按严重程度排序；每条包含定位、风险、建议修复与验证命令。若无阻塞项，明确写"未发现阻塞问题"，并补充残余风险或测试缺口。',
  },
  {
    name: 'fix',
    description: '定位并修复指定问题，然后运行相关验证',
    usage: '定位并修复指定问题，自动运行验证。\n用法: /fix <问题描述>\n示例: /fix 登录页按钮点击无响应  或 /fix API 返回 500',
    example: '/fix <问题描述>',
    template:
      '请定位并修复这个问题：$ARGUMENTS。先读文件确认根因，不要猜；修改前确认目标文件路径正确、文件存在。保持修改范围最小。完成后运行最相关的验证命令，并输出根因、修改文件列表、验证结果和剩余风险。',
  },
  {
    name: 'test',
    description: '为指定功能补测试或运行相关测试',
    usage: '为指定功能补充测试或运行已有测试。\n用法: /test <功能或文件>\n示例: /test src/utils/format.ts  或 /test 支付流程',
    example: '/test <功能或文件>',
    template:
      '请围绕 $ARGUMENTS 补充、修正或运行测试。优先覆盖真实风险路径和回归点。测试文件命名遵循项目已有约定（先查看已有测试文件的命名方式，不要自己发明）。若现有测试结构不足，先最小化整理再补测。完成后运行测试并说明覆盖了什么、还剩哪些风险。',
  },
  {
    name: 'explain',
    description: '解释指定文件、符号、错误或实现思路',
    usage: '解释文件、函数、符号或错误的实现思路。\n用法: /explain <目标>\n示例: /explain src/App.tsx  或 /explain handleSubmit 函数  或 /explain TypeError: x is not a function',
    example: '/explain <文件、函数、符号或报错>',
    template:
      '请解释 $ARGUMENTS。说明它在项目中的职责、关键流程、依赖关系、可能的风险点，并给出必要的文件引用。',
  },
  {
    name: 'diagnose',
    description: '诊断报错、慢操作或异常行为的根因',
    usage: '诊断报错、慢操作或异常行为的根因。\n用法: /diagnose <症状>\n示例: /diagnose 列表页加载超过 5 秒  或 /diagnose 构建报错 ENOENT',
    example: '/diagnose <报错信息或异常症状>',
    template:
      '请诊断这个问题：$ARGUMENTS。先收集最小必要证据，不要直接猜结论。输出应包含：现象、证据、最可能根因、排除项、便宜的验证步骤，以及最小修复方案。',
  },
  {
    name: 'refactor',
    description: '在保持行为不变的前提下整理指定代码',
    usage: '保持行为不变的前提下整理代码。\n用法: /refactor <文件或代码>\n示例: /refactor src/components/Modal.tsx  或 /refactor 提取重复的校验逻辑',
    example: '/refactor <代码或文件>',
    template:
      '请在保持外部行为不变的前提下重构 $ARGUMENTS。修改前先确认目标文件路径正确、文件存在。减少重复、降低复杂度、澄清边界，遵循现有代码风格。不要顺手改变无关行为；完成后运行相关验证并说明为何这次重构是安全的。',
  },
  {
    name: 'doc',
    description: '为指定变更或功能更新文档',
    usage: '为指定变更或功能更新文档。\n用法: /doc <变更内容>\n示例: /doc 新增的退款接口  或 /doc README 部署步骤',
    example: '/doc <变更或功能>',
    template:
      '请为 $ARGUMENTS 编写或更新项目文档。\n\n'
      + '硬性约束:\n'
      + '- 文件只能用 .md 扩展名，禁止使用 .txt、.md.txt、.markdown、.rst 或任何双扩展名\n'
      + '- 文件名必须匹配已有项目文档的命名风格，写之前先用搜索工具查找项目中已有的相关文档或相似文件名，禁止自己生造名字\n'
      + '- 文档放在项目根目录或已有的 docs/ 文件夹下，禁止写入 .CodePapr/、node_modules/、.git/ 等内部或构建产物目录\n\n'
      + '内容要求:\n'
      + '- 只记录当前真实行为、命令、版本号、文件结构、API 端点、配置方式、验证命令、已知限制和边界\n'
      + '- 禁止写历史背景、未来计划、营销式描述、推测性内容或主观评价\n'
      + '- 写完后必须用读取工具回读一遍刚写的文件，确认文件名拼写正确、扩展名是 .md、内容无误',
  },
  {
    name: 'search',
    description: '在代码库中搜索模式、用法、定义或引用',
    usage: '搜索代码库中的模式、用法或定义。\n用法: /search <关键词>\n示例: /search auth middleware  或 /search getUserProfile 函数定义',
    example: '/search <搜索内容>',
    model: 'fast',
    template:
      '请在代码库中搜索：$ARGUMENTS。先使用搜索工具组合（grep 精确搜索 + glob 文件名匹配）找到所有相关位置，再按文件分组整理结果。输出：匹配统计、关键发现的文件路径+行号、对搜索结果的简要解读。若结果过多，优先展示核心定义、API 入口和最近的修改文件。',
  },
  {
    name: 'lint',
    description: '运行 linter 并修复违规，确保代码通过风格检查',
    usage: '运行 linter 并修复所有违规。\n用法: /lint <文件或目录>\n示例: /lint src/  或 /lint src/utils/format.ts',
    example: '/lint <文件或目录>',
    model: 'fast',
    template:
      '请对 $ARGUMENTS 运行 lint 检查并修复所有违规。先运行 lint 命令获取违规列表，然后逐项修复。修复时只改代码格式和风格问题，不要改变业务逻辑或 API 行为。每类违规修完后重新运行 lint 验证修复有效。完成后汇报：修复了多少项、哪些文件被修改、最终 lint 是否通过。',
  },
  {
    name: 'clean',
    description: '清理死代码、未用导入、注释掉的代码和遗留调试语句',
    usage: '清理死代码、未用导入和调试语句。\n用法: /clean <文件或目录>\n示例: /clean src/  或 /clean src/components/Modal.tsx',
    example: '/clean <文件或目录>',
    model: 'fast',
    template:
      '请清理 $ARGUMENTS 中的死代码和冗余内容。依次检查并移除：未使用的导入、声明但未被引用的变量/函数/类型、被注释掉的代码块、遗留的 console.log/debugger 等调试语句。每项移除前确认它确实不再被使用。完成后运行 lint 和编译验证，输出清理清单和被修改的文件列表。',
  },
  {
    name: 'commit',
    description: '暂存当前改动并生成规范的 commit message',
    usage: '暂存改动并生成规范的 commit message。\n用法: /commit\n（不带参数，自动分析整个工作区改动）',
    example: '/commit',
    model: 'fast',
    template:
      '请为当前工作区改动提交代码。先运行 git status 和 git diff 查看完整改动，然后按约定生成 commit message（遵循 Conventional Commits 格式，如 feat:/fix:/refactor:/docs:/chore: 开头，简洁概述 + 必要细节）。输出建议的提交命令和最终的 commit message。不要自动执行 git commit，让用户确认后再提交。',
  },
  {
    name: 'summary',
    description: '对文件、模块或整个项目做高层概述',
    usage: '对文件或模块做高层概述。\n用法: /summary <文件或模块>\n示例: /summary src/core/  或 /summary 整个项目',
    example: '/summary <文件或模块>',
    model: 'fast',
    template:
      '请为 $ARGUMENTS 提供高层概述。先收集项目结构、入口文件、核心模块和关键依赖信息，然后输出：项目概览（是什么、做什么）、目录结构要点、核心模块列表及职责、技术栈简介、主要入口和构建命令。输出应简洁，控制在 20 行以内，适合新成员快速上手。',
  },
  {
    name: 'build',
    description: '构建项目并诊断/修复构建错误',
    usage: '构建项目并诊断/修复构建错误。\n用法: /build\n（不带参数，自动运行项目构建命令）',
    example: '/build',
    template:
      '请构建项目并处理构建错误。先运行构建命令，若成功则输出构建结果摘要。若失败，逐个分析每个构建错误，定位相关文件，按从简到繁的顺序修复。每轮修复后重新构建验证。完成后汇报：构建是否通过、修复了多少个错误、修改了哪些文件。',
  },
  {
    name: 'new',
    description: '根据描述创建新文件、组件、模块或功能',
    usage: '根据描述从零创建新代码。\n用法: /new <功能描述>\n示例: /new 创建一个基于 React 的商品列表组件  或 /new 添加用户重置密码的 REST API',
    example: '/new <功能描述>',
    template:
      '请根据描述创建新代码：$ARGUMENTS。先分析描述，明确功能边界、输入输出、依赖关系。然后查看项目现有代码风格、命名约定、目录结构和使用的框架，确保新代码风格一致。先创建最小可运行版本，然后补充边界处理和错误路径。完成后运行相关验证（lint、编译、测试），输出创建的文件列表和使用说明。',
  },
  {
    name: 'optimize',
    description: '分析并修复性能瓶颈，降低复杂度或资源消耗',
    usage: '分析并修复性能瓶颈。\n用法: /optimize <文件或代码>\n示例: /optimize src/pages/Dashboard.tsx  或 /optimize 数据库查询',
    example: '/optimize <文件或代码>',
    template:
      '请分析并优化 $ARGUMENTS 的性能。先收集性能基线证据（不要凭空猜测瓶颈），然后识别最耗时的操作或内存热点。对每个瓶颈提出优化方案，从收益最高、风险最低的开始实施。每次优化后验证行为未被改变（运行已有测试）。完成后汇报：优化了哪些瓶颈、性能改善数据、修改了哪些文件、是否存在剩余性能风险。',
  },
];

export function getBuiltinPromptCommand(name: string): CommandDefinition | null {
  const normalized = name.trim().toLowerCase();
  return BUILTIN_PROMPT_COMMANDS.find((command) => command.name === normalized) ?? null;
}

export function listBuiltinPromptCommandNames(): string[] {
  return BUILTIN_PROMPT_COMMANDS.map((command) => command.name);
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

/** 解析单个命令 markdown 定义；name 通常取自文件名（不含扩展名）。 */
export function parseCommandMarkdown(name: string, raw: string): CommandDefinition {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('命令名称不能为空');
  }

  const match = raw.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { name: trimmedName, template: raw.trim() };
  }

  const [, header, body] = match;
  const fields: Record<string, string> = {};
  for (const rawLine of header.split('\n')) {
    const line = rawLine.trim();
    const sep = line.indexOf(':');
    if (sep <= 0) {
      continue;
    }
    fields[line.slice(0, sep).trim()] = stripQuotes(line.slice(sep + 1).trim());
  }

  return {
    name: trimmedName,
    description: fields.description || undefined,
    usage: fields.usage || undefined,
    example: fields.example || undefined,
    agent: fields.agent || undefined,
    model: fields.model || undefined,
    template: body.trim(),
  };
}

export interface ParsedSlashInput {
  name: string;
  args: string[];
  prefix: '--' | '/';
}

/**
 * 解析用户输入中的聊天命令。
 * 当前主入口为 `--name args`，同时兼容历史 `/name args`。
 */
export function parseSlashInput(input: string): ParsedSlashInput | null {
  const trimmed = input.trim();
  const prefix = trimmed.startsWith('--') ? '--' : trimmed.startsWith('/') ? '/' : null;
  if (!prefix || trimmed.length <= prefix.length) {
    return null;
  }

  const withoutPrefix = trimmed.slice(prefix.length);
  const parts = withoutPrefix.split(/\s+/);
  const name = parts[0];
  if (!name) {
    return null;
  }

  return { name, args: parts.slice(1), prefix };
}

/**
 * Slash 解析用「用户键入的命令行」，不要用拼过附件后的 prompt。
 * ChatPanel 把附件拼进 `input`，`displayContent` 仍是 textarea 原文。
 */
export function resolveSlashCommandLine(input: string, displayContent?: string): string {
  const display = displayContent?.trim();
  if (display && parseSlashInput(display)) {
    return display;
  }
  return input;
}

/** 从拼过附件的 input 里取出命令行之后的附件块。 */
export function splitSlashAttachmentBlock(input: string, commandLine: string): string {
  if (!commandLine || input === commandLine) {
    return '';
  }
  if (input.startsWith(commandLine)) {
    return input.slice(commandLine.length).replace(/^\n+/, '');
  }
  return '';
}

export interface CommandExpandContext {
  /** 执行简单命令行并返回输出（用于 !`cmd`） */
  runShell?: (command: string) => Promise<string>;
  /** 读取文件内容（用于 @path） */
  readFile?: (path: string) => Promise<string>;
}

export interface ParsedInlineCommandLine {
  command: string;
  args: string[];
}

const DISALLOWED_INLINE_SHELL_OPERATORS = new Set(['|', '&', ';', '(', ')', '<', '>']);

/**
 * 将 !`cmd` 中的简单命令行拆成 command + args。
 * 这里故意不支持管道、重定向或复合 shell 语法，入口层会复用现有受控命令执行能力。
 */
export function parseInlineCommandLine(input: string): ParsedInlineCommandLine {
  const source = input.trim();
  if (!source) {
    throw new Error('内联命令不能为空');
  }

  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    tokens.push(current);
    current = '';
  };

  for (const ch of source) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote === null) {
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (DISALLOWED_INLINE_SHELL_OPERATORS.has(ch)) {
      throw new Error('内联命令只支持 command + args，不支持管道、重定向或复合 shell 操作符');
    }

    current += ch;
  }

  if (escaped) {
    current += '\\';
  }

  if (quote) {
    throw new Error('内联命令存在未闭合的引号');
  }

  pushCurrent();
  const [command, ...args] = tokens;
  if (!command) {
    throw new Error('内联命令不能为空');
  }

  return { command, args };
}

const SHELL_PATTERN = /!`([^`]+)`/g;
const FILE_PATTERN = /(^|\s)@([^\s]+)/g;

/**
 * 展开命令模板：替换参数占位符，并按需内联执行 shell、读取文件。
 */
export async function expandCommandTemplate(
  template: string,
  args: string[],
  context: CommandExpandContext = {}
): Promise<string> {
  let result = template;

  // 参数占位符：$ARGUMENTS 与 $N 单遍展开。函数形式的替换保证用户输入里的
  // $& / $' / $` / $$ 按字面量处理（旧实现把输入当替换串，$ 序列被展开）；
  // 单遍保证插入的参数文本不会被 $N 规则二次扫描（$1 被再次替换）。
  result = result.replace(/\$ARGUMENTS\b|\$(\d+)/g, (_match, index?: string) => {
    if (index === undefined) {
      return args.join(' ');
    }
    const value = args[Number(index) - 1];
    return value ?? '';
  });

  // 内联命令：!`cmd`
  if (context.runShell) {
    const runShell = context.runShell;
    const shellMatches = [...result.matchAll(SHELL_PATTERN)];
    for (let i = shellMatches.length - 1; i >= 0; i--) {
      const match = shellMatches[i];
      const [token, command] = match;
      const start = match.index!;
      let replacement: string;
      try {
        const output = await runShell(command.trim());
        replacement = output.trim();
      } catch (error) {
        replacement = `[命令执行失败: ${(error as Error).message}]`;
      }
      result = result.slice(0, start) + replacement + result.slice(start + token.length);
    }
  }

  // 内联文件：@path
  if (context.readFile) {
    const readFile = context.readFile;
    const fileMatches = [...result.matchAll(FILE_PATTERN)];
    for (let i = fileMatches.length - 1; i >= 0; i--) {
      const match = fileMatches[i];
      const [token, lead, path] = match;
      const start = match.index!;
      let replacement: string;
      try {
        const content = await readFile(path);
        replacement = `${lead}\n\`\`\`\n${content.trim()}\n\`\`\``;
      } catch (error) {
        replacement = `${lead}[文件读取失败: ${(error as Error).message}]`;
      }
      result = result.slice(0, start) + replacement + result.slice(start + token.length);
    }
  }

  return result.trim();
}
