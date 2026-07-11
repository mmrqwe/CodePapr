import {
  forwardRef,
  useImperativeHandle,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  BUILTIN_PROMPT_COMMANDS,
  type CommandDefinition,
} from '@codepapr/core';
import { listCommandDefinitions } from '../utils/projectConfigLoader';

export interface SlashCommandDropdownHandle {
  navigateDown: () => void;
  navigateUp: () => void;
  selectCurrent: () => void;
}

interface SlashCommandDropdownProps {
  filter: string;
  workspacePath: string | null;
  onSelect: (name: string) => void;
  onDismiss: () => void;
}

const META_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'help',
    description: '显示所有可用命令及说明',
    template: '',
  },
  {
    name: 'commands',
    description: '列出所有可用命令',
    template: '',
  },
  {
    name: 'compact',
    description: '强制压缩当前会话上下文，生成检查点释放 token',
    template: '',
  },
  {
    name: 'goal',
    description: '自主循环：Worker 执行 + Verifier 验收，直到验证条件通过',
    template: '',
  },
];

const COMMAND_EXAMPLES: Record<string, string> = {
  review: '/review <文件或范围>',
  fix: '/fix <问题描述>',
  test: '/test <功能或文件>',
  explain: '/explain <文件、函数、符号或报错>',
  diagnose: '/diagnose <报错信息或异常症状>',
  refactor: '/refactor <代码或文件>',
  doc: '/doc <变更或功能>',
  search: '/search <搜索内容>',
  lint: '/lint <文件或目录>',
  clean: '/clean <文件或目录>',
  commit: '/commit',
  summary: '/summary <文件或模块>',
  build: '/build',
  new: '/new <功能描述>',
  optimize: '/optimize <文件或代码>',
  help: '/help',
  commands: '/commands',
  compact: '/compact',
  goal: '/goal exec:npm test',
};

const COMMAND_USAGE: Record<string, string> = {
  review: '对指定范围做严格代码审查。\n用法: /review <文件或范围>\n示例: /review src/auth/  或 /review 最近的改动',
  fix: '定位并修复指定问题，自动运行验证。\n用法: /fix <问题描述>\n示例: /fix 登录页按钮点击无响应  或 /fix API 返回 500',
  test: '为指定功能补充测试或运行已有测试。\n用法: /test <功能或文件>\n示例: /test src/utils/format.ts  或 /test 支付流程',
  explain: '解释文件、函数、符号或错误的实现思路。\n用法: /explain <目标>\n示例: /explain src/App.tsx  或 /explain handleSubmit 函数  或 /explain TypeError: x is not a function',
  diagnose: '诊断报错、慢操作或异常行为的根因。\n用法: /diagnose <症状>\n示例: /diagnose 列表页加载超过 5 秒  或 /diagnose 构建报错 ENOENT',
  refactor: '保持行为不变的前提下整理代码。\n用法: /refactor <文件或代码>\n示例: /refactor src/components/Modal.tsx  或 /refactor 提取重复的校验逻辑',
  doc: '为指定变更或功能更新文档。\n用法: /doc <变更内容>\n示例: /doc 新增的退款接口  或 /doc README 部署步骤',
  search: '搜索代码库中的模式、用法或定义。\n用法: /search <关键词>\n示例: /search auth middleware  或 /search getUserProfile 函数定义',
  lint: '运行 linter 并修复所有违规。\n用法: /lint <文件或目录>\n示例: /lint src/  或 /lint src/utils/format.ts',
  clean: '清理死代码、未用导入和调试语句。\n用法: /clean <文件或目录>\n示例: /clean src/  或 /clean src/components/Modal.tsx',
  commit: '暂存改动并生成规范的 commit message。\n用法: /commit\n（不带参数，自动分析整个工作区改动）',
  summary: '对文件或模块做高层概述。\n用法: /summary <文件或模块>\n示例: /summary src/core/  或 /summary 整个项目',
  build: '构建项目并诊断/修复构建错误。\n用法: /build\n（不带参数，自动运行项目构建命令）',
  new: '根据描述从零创建新代码。\n用法: /new <功能描述>\n示例: /new 创建一个基于 React 的商品列表组件  或 /new 添加用户重置密码的 REST API',
  optimize: '分析并修复性能瓶颈。\n用法: /optimize <文件或代码>\n示例: /optimize src/pages/Dashboard.tsx  或 /optimize 数据库查询',
  help: '显示所有可用命令及说明。\n用法: /help',
  commands: '列出所有可用命令。\n用法: /commands',
  compact: '强制压缩当前会话上下文，生成检查点释放 token。\n用法: /compact\n（不带参数，立即执行压缩）',
  goal: '启动 Goal 自主循环：Worker 执行 + Verifier 验收。\n客观验证: /goal exec:npm test\n主观验证: /goal 修复登录页样式\n复合: /goal 修测试 | exec:npm test',
};

const SlashCommandDropdown = forwardRef<SlashCommandDropdownHandle, SlashCommandDropdownProps>(
  ({ filter, workspacePath, onSelect, onDismiss }, ref) => {
    const [commands, setCommands] = useState<CommandDefinition[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    useEffect(() => {
      const loadCommands = async () => {
        let custom: CommandDefinition[] = [];
        if (workspacePath) {
          try {
            custom = await listCommandDefinitions(invoke, workspacePath);
          } catch {
            custom = [];
          }
        }
        setCommands([...META_COMMANDS, ...BUILTIN_PROMPT_COMMANDS, ...custom]);
      };
      void loadCommands();
    }, [workspacePath]);

    const filtered = useMemo(() => {
      const q = filter.trim().toLowerCase();
      if (!q) return commands;
      return commands.filter((cmd) => cmd.name.toLowerCase().includes(q));
    }, [commands, filter]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [filter]);

    useEffect(() => {
      const selectedEl = itemRefs.current.get(selectedIndex);
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }, [selectedIndex]);

    const navigateDown = useCallback(() => {
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    }, [filtered.length]);

    const navigateUp = useCallback(() => {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }, []);

    const selectCurrent = useCallback(() => {
      const cmd = filtered[selectedIndex];
      if (cmd) {
        onSelect(cmd.name);
      }
    }, [filtered, selectedIndex, onSelect]);

    useImperativeHandle(
      ref,
      () => ({
        navigateDown,
        navigateUp,
        selectCurrent,
      }),
      [navigateDown, navigateUp, selectCurrent]
    );

    useEffect(() => {
      const handler = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          onDismiss();
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [onDismiss]);

    if (filtered.length === 0) return null;

    const tooltipIndex = hoveredIndex ?? selectedIndex;

    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-0 right-0 flex mb-2 z-50"
      >
        <div className="flex-1 max-h-[240px] overflow-y-auto rounded-xl border border-[#2a2d3a] bg-[#1a1d27] shadow-lg shadow-black/30 py-1">
          {filtered.map((cmd, index) => (
            <div
              key={cmd.name}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(index, el);
                } else {
                  itemRefs.current.delete(index);
                }
              }}
              onMouseEnter={() => {
                setSelectedIndex(index);
                setHoveredIndex(index);
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
              }}
              onClick={() => onSelect(cmd.name)}
              className={`group/item relative flex items-center gap-3 px-4 py-2.5 text-sm cursor-pointer transition-colors ${
                index === selectedIndex
                  ? 'bg-indigo-600/20 text-white'
                  : 'text-slate-300 hover:bg-[#222639]'
              }`}
            >
              <span className="font-mono text-indigo-400 whitespace-nowrap">/{cmd.name}</span>
              {cmd.description && (
                <span className="text-slate-500 truncate flex-1 min-w-0">{cmd.description}</span>
              )}
              {COMMAND_EXAMPLES[cmd.name] && (
                <span className="hidden group-hover/item:inline text-[10px] text-slate-600 whitespace-nowrap ml-auto">
                  {COMMAND_EXAMPLES[cmd.name]}
                </span>
              )}
            </div>
          ))}
        </div>
        {tooltipIndex != null && filtered[tooltipIndex] && COMMAND_USAGE[filtered[tooltipIndex].name] && (
          <div className="ml-2 w-[320px] max-h-[240px] overflow-y-auto rounded-xl border border-[#2a2d3a] bg-[#161923] px-4 py-3 text-xs text-slate-400 shadow-lg shadow-black/30 flex-shrink-0">
            <div className="text-indigo-400 font-mono text-sm mb-1.5">
              /{filtered[tooltipIndex].name}
            </div>
            {COMMAND_USAGE[filtered[tooltipIndex].name].split('\n').map((line, i) => (
              <p key={i} className="leading-relaxed">{line}</p>
            ))}
            {filtered[tooltipIndex].agent && (
              <p className="mt-1.5 text-indigo-400/70">
                Agent: {filtered[tooltipIndex].agent}
              </p>
            )}
            {filtered[tooltipIndex].model && (
              <p className="text-indigo-400/70">Model: {filtered[tooltipIndex].model}</p>
            )}
          </div>
        )}
      </div>
    );
  }
);

SlashCommandDropdown.displayName = 'SlashCommandDropdown';

export default SlashCommandDropdown;
