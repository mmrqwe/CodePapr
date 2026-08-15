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
    usage: '显示所有可用命令及说明。\n用法: /help',
    example: '/help',
    template: '',
  },
  {
    name: 'commands',
    description: '列出所有可用命令（同 /help）',
    usage: '列出所有可用命令（同 /help）。\n用法: /commands',
    example: '/commands',
    template: '',
  },
  {
    name: 'compact',
    description: '强制压缩当前会话上下文，生成检查点释放 token',
    usage: '强制压缩当前会话上下文，生成检查点释放 token。\n用法: /compact\n（不带参数，立即执行压缩）',
    example: '/compact',
    template: '',
  },
  {
    name: 'goal',
    description: '自主循环：Worker 执行 + Verifier 验收，直到验证条件通过',
    usage: '启动 Goal 自主循环：Worker 执行 + Verifier 验收。\n客观验证: /goal exec:npm test\n主观验证: /goal 修复登录页样式\n严格模式: /goal --strict exec:npm test\n宽松模式: /goal --loose 美化页面\n首轮规划: /goal --plan-first 重构auth模块\n复合: /goal 修测试 | exec:npm test',
    example: '/goal exec:npm test',
    template: '',
  },
];

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
        <div className="flex-1 max-h-[240px] overflow-y-auto rounded-xl border border-line bg-raised shadow-lg shadow-black/30 py-1">
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
                  ? 'bg-accent-soft text-fg'
                  : 'text-fg-soft hover:bg-raised'
              }`}
            >
              <span className="font-mono text-accent whitespace-nowrap">/{cmd.name}</span>
              {cmd.description && (
                <span className="text-fg-muted truncate flex-1 min-w-0">{cmd.description}</span>
              )}
              {cmd.example && (
                <span className="hidden group-hover/item:inline text-[10px] text-fg-dim whitespace-nowrap ml-auto">
                  {cmd.example}
                </span>
              )}
            </div>
          ))}
        </div>
        {tooltipIndex != null && filtered[tooltipIndex] && filtered[tooltipIndex].usage && (
          <div className="ml-2 w-[320px] max-h-[240px] overflow-y-auto rounded-xl border border-line bg-base px-4 py-3 text-xs text-fg-muted shadow-lg shadow-black/30 flex-shrink-0">
            <div className="text-accent font-mono text-sm mb-1.5">
              /{filtered[tooltipIndex].name}
            </div>
            {filtered[tooltipIndex].usage!.split('\n').map((line, i) => (
              <p key={i} className="leading-relaxed">{line}</p>
            ))}
            {filtered[tooltipIndex].agent && (
              <p className="mt-1.5 text-accent">
                Agent: {filtered[tooltipIndex].agent}
              </p>
            )}
            {filtered[tooltipIndex].model && (
              <p className="text-accent">Model: {filtered[tooltipIndex].model}</p>
            )}
          </div>
        )}
      </div>
    );
  }
);

SlashCommandDropdown.displayName = 'SlashCommandDropdown';

export default SlashCommandDropdown;
