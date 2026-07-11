import {
  memo,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
  KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { getSettingsError, UIMessage, UIToolInvocation, useAgentStore } from '../store/agentStore';
import { TaskChecklist } from './TaskChecklist';
import { GoalBanner } from './GoalBanner';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { IImageContent } from '@codepapr/types';
import type { QuestionData } from '@codepapr/types';
import { type WorkMode } from '../utils/agentPrompts';
import { getTranslation } from '../utils/i18n';
import { useTtsPlayer } from '../hooks/useTtsPlayer';
import { TtsStatusBadge } from './TtsPanel';
import { TtsInstaller } from './TtsInstaller';
import { useCharactersStore } from '../store/charactersStore';
import { isExecutionHeavyTask } from '../utils/modelRouting';
import {
  buildDecisionOptionAction,
  type PlanFollowUpAction,
  parseDecisionOptionCards,
  type DecisionOptionCard,
  type DecisionOptionItem,
} from '../utils/planMode';
import {
  getChatAutoScrollBehavior,
  isScrollContainerNearBottom,
  scrollContainerToBottom,
} from '../utils/chatScroll';
import SlashCommandDropdown, {
  type SlashCommandDropdownHandle,
} from './SlashCommandDropdown';
import AtMentionDropdown, {
  type AtMentionDropdownHandle,
  type MentionItem,
  buildMentionItems,
} from './AtMentionDropdown';
import { useShallow } from 'zustand/react/shallow';
import { subscribeSubagentProgress, getSubagentRuns, toggleSubagentCollapse, type SubAgentRun } from '../utils/subagentProgress';
import { ConversationRoundsIndicator } from './ConversationRoundsIndicator';
import { toast } from '../store/toastStore';

function truncateText(value: string, maxLength: number = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

interface ImagePreview extends IImageContent {
  id: string;
  /** 完整 data URI，仅用于本地预览 */
  dataUri: string;
}

interface TextFileAttachment {
  id: string;
  name: string;
  content: string;
  size: number;
}

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;
const MAX_PENDING_FILES = 20;

/** 把 File 读取为 base64 图片内容（剥离 data URI 前缀）。 */
function readFileAsImagePreview(file: File): Promise<ImagePreview | null> {
  return new Promise((resolve) => {
    if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const dataUri = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = dataUri.indexOf(',');
      const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : '';
      if (!data) {
        resolve(null);
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mediaType: file.type,
        data,
        dataUri,
      });
    };
    reader.readAsDataURL(file);
  });
}

function buildUserPromptWithFiles(userText: string, files: TextFileAttachment[]): string {
  if (files.length === 0) return userText;
  const parts: string[] = [];
  if (userText) {
    parts.push(userText);
  }
  for (let i = 0; i < files.length; i++) {
    const sep = parts.length > 0 ? '\n\n' : '';
    parts.push(`${sep}--- ${files[i].name} ---\n${files[i].content}`);
  }
  return parts.join('');
}

function generateUnifiedDiff(search: string, replace: string, filePath: string): string {
  const searchLines = search ? search.split('\n') : [];
  const replaceLines = replace ? replace.split('\n') : [];
  const parts: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${searchLines.length} +1,${replaceLines.length} @@`,
  ];
  for (const line of searchLines) {
    parts.push(`-${line}`);
  }
  for (const line of replaceLines) {
    parts.push(`+${line}`);
  }
  return parts.join('\n');
}

function getToolInvocationSummary(tool: UIToolInvocation): string {
  const args = tool.arguments ?? {};
  const name = tool.name;

  const a = (key: string) => (typeof args[key] === 'string' ? args[key] as string : '');
  const arr = (key: string): string[] => (Array.isArray(args[key]) ? args[key].filter((v: unknown): v is string => typeof v === 'string') : []);
  const path = a('relativePath') || a('path') || a('filePath');
  const query = a('query');
    const action = a('action');
    const prompt = a('prompt');
  const agent = a('agent');
  const url = a('url');
  const command = a('command');
  const commandArgs = arr('args');
  const message = a('message');
  const hasTasks = Array.isArray(args.tasks);
  const hasUpdates = Array.isArray(args.updates);

  // ── LLM 工具描述 ──
  if (name === 'read') {
    if (path) return `读取 ${path}`;
    return '读取文件';
  }
  if (name === 'write') {
    if (path) return `写入文件 ${path}`;
    return '写入文件';
  }
  if (name === 'edit') {
    if (path) return `修改 ${path}`;
    return '修改文件';
  }
  if (name === 'patch') {
    return '多文件原子补丁';
  }
  if (name === 'grep') {
    if (query) return `正则搜索 "${truncateText(query, 60)}"`;
    return '正则搜索';
  }
  if (name === 'glob') {
    if (query) return `搜索文件 ${query}`;
    return '搜索文件';
  }
  if (name === 'list') {
    if (path) return `列出目录 ${path}`;
    return '列出项目目录';
  }
  if (name === 'graph') {
    const actionMap: Record<string, string> = {
      full: '生成项目完整语义图', overview: '生成项目概览', lookup: '查找符号',
      dependency: '提取依赖关系', entrypoints: '查找入口点', impact: '影响分析',
      implementations: '查找实现', smart_context: '智能上下文分析',
      dead_code: '检测死代码', circular_deps: '检测循环依赖',
      type_hierarchy: '构建类型层次', suggest_refactors: '重构建议分析',
      test_impact: '测试影响分析', generate_tests: '生成测试骨架',
    };
    if (action && actionMap[action]) return actionMap[action];
    if (query) return `代码分析: ${truncateText(query, 50)}`;
    return '代码分析';
  }
  if (name === 'lsp') {
    if (action === 'definition' && path) return `跳转定义: ${path}`;
    if (action === 'references' && path) return `查找引用: ${path}`;
    return `LSP${action ? ` · ${action}` : ''}`;
  }
  if (name === 'lsp_edit') {
    if (action === 'rename') return '重命名符号';
    if (action === 'code_action') return '应用代码动作';
    if (action === 'format') return '格式化代码';
    return `LSP 编辑${action ? ` · ${action}` : ''}`;
  }
  if (name === 'diagnostics') {
    if (path) return `诊断 ${path}`;
    return '项目诊断';
  }
  if (name === 'git') {
    if (action === 'status') return '查看 Git 状态';
    if (action === 'diff') return '查看 Git 差异';
    if (action === 'log') return '查看 Git 历史';
    if (action === 'branch') return 'Git 分支操作';
    if (action === 'stage') return '暂存改动';
    if (action === 'commit' && message) return `提交: ${truncateText(message, 40)}`;
    if (action === 'commit') return '提交改动';
    if (action === 'restore') return '恢复文件';
    if (action === 'reset') return 'Git 重置';
    return `Git${action ? ` · ${action}` : ''}`;
  }
  if (name === 'exec') {
    if (command) {
      const cmd = [command, ...commandArgs].join(' ');
      return `执行 ${truncateText(cmd, 60)}`;
    }
    return '执行命令';
  }
  if (name === 'shell') {
    if (action === 'open') return '启动 Shell 会话';
    if (action === 'send' && command) return `Shell: ${command}`;
    if (action === 'read') return '读取 Shell 输出';
    if (action === 'close') return '关闭 Shell 会话';
    if (action === 'list') return '列出 Shell 会话';
    return 'Shell 操作';
  }
  if (name === 'proc') {
    if (action === 'stop') return '停止后台进程';
    if (action === 'stop_all') return '停止所有后台进程';
    return '列出后台进程';
  }
  if (name === 'browser') {
    if (action === 'open' && url) return `打开页面 ${truncateText(url, 50)}`;
    if (action === 'click') return '点击页面元素';
    if (action === 'type') return '输入文本';
    if (action === 'read') return '读取页面 DOM';
    if (action === 'screenshot') return '截取页面截图';
    return `浏览器${action ? ` · ${action}` : ''}`;
  }
  if (name === 'web_search') {
    if (query) return `网页搜索: ${truncateText(query, 50)}`;
    return '网页搜索';
  }
  if (name === 'web_fetch') {
    if (url) return `抓取网页: ${truncateText(url, 50)}`;
    return '抓取网页';
  }
  if (name === 'web_download') {
    if (url) return `下载文件: ${truncateText(url, 50)}`;
    return '下载文件';
  }
  if (name === 'open') {
    if (url) return `打开链接 ${truncateText(url, 50)}`;
    return '打开链接';
  }
  if (name === 'skill') return `加载 Skill`;
  if (name === 'time') return '获取当前时间';
  if (name === 'question') {
    const q = a('question');
    return q ? `提问: ${truncateText(q, 50)}` : '向用户提问';
  }
  if (name === 'task') {
    if (agent && prompt) return `委派 ${agent} 子代理执行任务: ${truncateText(prompt, 60)}`;
    if (agent) return `调用子代理 ${agent}`;
    return '委派子代理执行任务';
  }
  if (name === 'todo') {
    if (hasTasks && Array.isArray(args.tasks)) return `创建 TodoList (${args.tasks.length} 条任务)`;
    if (hasUpdates && Array.isArray(args.updates)) return `更新任务进度 (${args.updates.length} 条)`;
    return '更新 TodoList';
  }

  // ── 细粒度工具（兼容旧显示） ──
  if (name.startsWith('workspace_run_command')) {
    if (command) {
      const cmd = [command, ...commandArgs].join(' ');
      return `执行 ${truncateText(cmd, 60)}`;
    }
    return '执行命令';
  }
  if (name.startsWith('workspace')) {
    if (path) return `${name.replace('workspace_', '').replace('_', ' ')} ${truncateText(path, 40)}`;
    if (query) return `${name.replace('workspace_', '')}: ${truncateText(query, 50)}`;
    return name.replace('workspace_', '').replace(/_/g, ' ');
  }
  if (name.startsWith('browser_')) {
    if (url) return `浏览器: ${truncateText(url, 50)}`;
    return name.replace('browser_', '').replace(/_/g, ' ');
  }

  // ── 通用回退 ──
  if (path) return `${name}: ${truncateText(path, 50)}`;
  if (query) return `${name}: ${truncateText(query, 50)}`;
  if (command) {
    const cmd = [command, ...commandArgs].join(' ');
    return `${name}: ${truncateText(cmd, 50)}`;
  }
  const kv = Object.entries(args).filter(([, v]) => typeof v === 'string' && (v as string).trim()).slice(0, 1);
  if (kv.length > 0) return `${name}: ${truncateText(kv[0][1] as string, 50)}`;
  return name.replace(/_/g, ' ');
}

function diffLineClass(line: string): string {
  if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
    return 'bg-[#101520] text-slate-400';
  }
  if (line.startsWith('@@')) {
    return 'bg-sky-500/10 text-sky-200';
  }
  if (line.startsWith('+')) {
    return 'bg-emerald-500/10 text-emerald-200';
  }
  if (line.startsWith('-')) {
    return 'bg-rose-500/10 text-rose-200';
  }
  return 'text-slate-400';
}

interface DiffInfo {
  filePath: string;
  diff: string;
  added: number;
  deleted: number;
}

function extractDiffInfos(tool: UIToolInvocation): DiffInfo[] {
  const args = tool.arguments ?? {};
  const name = tool.name;
  const output = tool.output;

  if (!output || tool.status !== 'success') return [];

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  if (!parsed) return [];

  if (name === 'edit' || name === 'workspace_apply_patch') {
    if (typeof parsed.path !== 'string') return [];
    const filePath = parsed.path;
    const change = parsed.change as Record<string, unknown> | undefined;
    const search = typeof args.search === 'string' ? args.search : '';
    const replace = typeof args.replace === 'string' ? args.replace : '';
    const diff = generateUnifiedDiff(search, replace, filePath);
    return [{
      filePath,
      diff,
      added: typeof change?.added === 'number' ? change.added : 0,
      deleted: typeof change?.deleted === 'number' ? change.deleted : 0,
    }];
  }

  if (name === 'write' || name === 'workspace_write_file') {
    if (typeof parsed.path !== 'string') return [];
    const filePath = parsed.path;
    const change = parsed.change as Record<string, unknown> | undefined;
    const content = typeof args.content === 'string' ? args.content : '';
    const diff = generateUnifiedDiff('', content, filePath);
    return [{
      filePath,
      diff,
      added: typeof change?.added === 'number' ? change.added : 0,
      deleted: typeof change?.deleted === 'number' ? change.deleted : 0,
    }];
  }

  if (name === 'patch' || name === 'workspace_apply_diff') {
    const patches = Array.isArray(args.patches) ? args.patches : [];
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const results: DiffInfo[] = [];
    for (let i = 0; i < patches.length && i < files.length; i++) {
      const p = patches[i] as Record<string, unknown>;
      const f = files[i] as Record<string, unknown>;
      if (typeof p.search !== 'string' || typeof p.replace !== 'string') continue;
      const filePath = typeof f.path === 'string' ? f.path : (typeof p.relativePath === 'string' ? p.relativePath : '');
      if (!filePath) continue;
      const change = f.change as Record<string, unknown> | undefined;
      const diff = generateUnifiedDiff(p.search, p.replace, filePath);
      results.push({
        filePath,
        diff,
        added: typeof change?.added === 'number' ? change.added : 0,
        deleted: typeof change?.deleted === 'number' ? change.deleted : 0,
      });
    }
    return results;
  }

  return [];
}

function DiffCard({ info }: { info: DiffInfo }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => info.diff.split('\n'), [info.diff]);

  return (
    <div className="mt-1.5 ml-3.5 overflow-hidden rounded-lg border border-[#202432] bg-[#0b0d13]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[#10131e] transition-colors"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-indigo-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
        </svg>
        <span className="flex-1 truncate text-[10px] font-medium text-slate-300">{info.filePath}</span>
        <span className="flex-shrink-0 text-[10px]">
          {info.added > 0 && <span className="text-emerald-400">+{info.added}</span>}
          {info.added > 0 && info.deleted > 0 && <span className="text-slate-600 mx-0.5"> </span>}
          {info.deleted > 0 && <span className="text-rose-400">-{info.deleted}</span>}
        </span>
        <svg className={`w-3 h-3 flex-shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-[#202432] font-mono text-[10px] leading-5">
          {lines.map((line, i) => (
            <div
              key={`${i}:${line.slice(0, 16)}`}
              className={`whitespace-pre px-2.5 py-0.5 ${diffLineClass(line)}`}
            >
              {line || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildDiffCards(tool: UIToolInvocation): ReactNode {
  const infos = extractDiffInfos(tool);
  if (infos.length === 0) return null;
  return (
    <>
      {infos.map((info, i) => (
        <DiffCard key={`${info.filePath}-${i}`} info={info} />
      ))}
    </>
  );
}

function ToolInvocationsPanel({ msg, lang }: { msg: UIMessage; lang: 'zh-CN' | 'zh-TW' | 'en' }) {
  const t = getTranslation(lang);
  const bordered = useAgentStore((state) => state.settings.chatBordersEnabled);
  const toolInvocations = msg.toolInvocations ?? [];
  const anyRunning = toolInvocations.some((tool) => tool.status === 'running');
  const allCompleted = toolInvocations.length > 0 && toolInvocations.every((tool) => tool.status === 'success' || tool.status === 'error');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (anyRunning) {
      setIsOpen(true);
    } else if (allCompleted) {
      setIsOpen(false);
    }
  }, [toolInvocations, anyRunning, allCompleted]);

  if (toolInvocations.length === 0) {
    return null;
  }

  const first = toolInvocations[0];
  const rest = toolInvocations.length - 1;
  const firstSummary = getToolInvocationSummary(first);

  return (
    <div
      className={`mb-3 overflow-hidden ${bordered ? 'rounded-xl border border-emerald-500/20 bg-[#0b0d12]/60' : ''}`}
      data-tool-panel-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left ${bordered && isOpen ? 'border-b border-emerald-500/10' : ''}`}
      >
        <div className="min-w-0 flex-1">
          {anyRunning || !allCompleted ? (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-emerald-300">
              <span>{t.toolCalls}</span>
              <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[10px] text-slate-300">
                {toolInvocations.length}
              </span>
            </div>
          ) : (
            <span className="block truncate text-[11px] text-slate-400">
              <span className="font-mono text-emerald-300/80">{first.name}</span> · {firstSummary}{rest > 0 ? ` · ... +${rest}` : ''}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-slate-500">{isOpen ? t.collapse : t.expand}</span>
      </button>
      {isOpen && (
        <div className="max-h-64 divide-y divide-[#1f2430] overflow-y-auto">
          {toolInvocations.map((tool) => {
            const isRunning = tool.status === 'running';
            const isFailed = tool.status === 'error';
            const summary = getToolInvocationSummary(tool);
            const diffCards = buildDiffCards(tool);

            return (
              <div key={tool.id} className="px-3.5 py-2 text-[11px] text-slate-300">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    isRunning ? 'bg-amber-400 animate-pulse' : isFailed ? 'bg-red-400' : 'bg-emerald-400'
                  }`} />
                  <span className="flex-1 leading-snug text-slate-300">{summary}</span>
                  <span className={`flex-shrink-0 text-[10px] ${
                    isRunning ? 'text-amber-400' : isFailed ? 'text-red-400' : 'text-emerald-500'
                  }`}>
                    {isRunning ? t.toolRunning : isFailed ? t.toolFailed : t.toolCompleted}
                  </span>
                </div>
                {diffCards}
                {!diffCards && tool.name === 'task' && tool.output && (() => {
                  try {
                    const result = JSON.parse(tool.output);
                    if (result && Array.isArray(result.steps) && result.steps.length > 0) {
                      return (
                        <div className="mt-1.5 ml-3.5 space-y-0.5 border-l border-[#232734] pl-3">
                          {result.steps.map((step: { name: string; status: string; summary: string }, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 text-[10px]">
                              <span className={step.status === 'error' ? 'text-red-400' : 'text-emerald-400'}>{step.status === 'error' ? '✗' : '✓'}</span>
                              <span className="text-slate-500">{step.name}</span>
                              {step.summary && <span className="truncate text-slate-600">· {step.summary}</span>}
                            </div>
                          ))}
                        </div>
                      );
                    }
                  } catch { /* ignore */ }
                  return null;
                })()}
                {tool.error && (
                  <div className="mt-1 ml-3.5 text-[10px] text-red-400">{tool.error}</div>
                )}
                {tool.output && !diffCards && tool.name !== 'task' && (
                  <div className="mt-1 ml-3.5 max-h-24 overflow-y-auto rounded border border-[#1f2430] bg-[#06080c] px-2 py-1 font-mono text-[10px] leading-relaxed text-slate-500 whitespace-pre-wrap">
                    {tool.output}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MAX_STREAMING_MESSAGE_CHARS = 50_000;
const MAX_STREAMING_REASONING_CHARS = 12_000;

function getStreamingPreviewContent(content: string, maxChars: number): string {
  return content.length > maxChars ? content.slice(-maxChars) : content;
}

function ReasoningPanel({
  content,
  isStreaming,
  lang,
}: {
  content: string;
  isStreaming?: boolean;
  lang: 'zh-CN' | 'zh-TW' | 'en';
}) {
  const t = getTranslation(lang);
  const bordered = useAgentStore((state) => state.settings.chatBordersEnabled);
  const [isOpen, setIsOpen] = useState(Boolean(isStreaming));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const visibleContent = isStreaming
    ? getStreamingPreviewContent(content, MAX_STREAMING_REASONING_CHARS)
    : content;

  const collapsedText = content.replace(/\s+/g, ' ').trim();

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
      shouldStickToBottomRef.current = true;
      return;
    }

    setIsOpen(false);
  }, [isStreaming]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isOpen) {
      return;
    }

    if (isStreaming || shouldStickToBottomRef.current) {
      scrollContainerToBottom(container, 'auto');
    }
  }, [isOpen, isStreaming, visibleContent.length]);

  return (
    <div
      className={`mb-3 overflow-hidden ${bordered ? 'rounded-xl border border-indigo-500/20 bg-[#0b0d12]/50' : ''}`}
      data-reasoning-panel-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          {isOpen ? (
            <span className="text-xs font-semibold text-indigo-300">{t.thinkingProcess}</span>
          ) : (
            <span className="block truncate text-xs text-slate-400/80">
              <span className="font-semibold text-indigo-300/70">{t.thinkingProcess}</span> · {collapsedText}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">
          {isStreaming ? t.streamingStatus : isOpen ? t.collapse : t.expand}
        </span>
      </button>
      {isOpen && (
        <div
          ref={scrollContainerRef}
          data-reasoning-scroll="true"
          onScroll={(event) => {
            shouldStickToBottomRef.current = isScrollContainerNearBottom(event.currentTarget);
          }}
          className={`overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-3.5 py-2 text-xs leading-relaxed text-slate-400/90 ${
            bordered ? 'border-t border-indigo-500/10 ' : ''
          }${
            isStreaming ? 'max-h-[4.5rem]' : 'max-h-56'
          }`}
          style={{ overflowAnchor: 'none' }}
        >
          <p className="whitespace-pre-wrap text-slate-300/90 select-text">{visibleContent}</p>
        </div>
      )}
    </div>
  );
}

function RunningStatusIndicator({ label }: { label: string }) {
  return (
    <div className="mb-2 select-none">
      <p className="text-xs font-medium text-slate-400/90">{label}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#11151d]">
        <div className="status-indicator-bar h-full w-24 rounded-full bg-gradient-to-r from-indigo-500/10 via-indigo-300 to-cyan-300" />
      </div>
    </div>
  );
}

function getProcessGroupCopy(lang: 'zh-CN' | 'zh-TW' | 'en') {
  switch (lang) {
    case 'en':
      return {
        title: 'Execution Process',
        steps: (count: number) => `${count} steps`,
        duration: (value: string) => `Duration ${value}`,
      };
    case 'zh-TW':
      return {
        title: '執行過程',
        steps: (count: number) => `${count} 個步驟`,
        duration: (value: string) => `耗時 ${value}`,
      };
    default:
      return {
        title: '处理过程',
        steps: (count: number) => `${count} 个步骤`,
        duration: (value: string) => `耗时 ${value}`,
      };
  }
}

function formatProcessDuration(durationMs: number, lang: 'zh-CN' | 'zh-TW' | 'en'): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (lang === 'en') {
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

interface ExecutionProcessGroup {
  summaryMessageId: string;
  userMessageId: string;
  messages: UIMessage[];
  durationMs: number;
}

function buildTailExecutionProcessGroup(messages: UIMessage[]): ExecutionProcessGroup | null {
  if (messages.length < 3) {
    return null;
  }

  const summaryMessage = messages[messages.length - 1];
  if (
    !summaryMessage ||
    summaryMessage.role !== 'assistant' ||
    !summaryMessage.synthetic ||
    summaryMessage.isStreaming
  ) {
    return null;
  }

  const userIndex = [...messages]
    .slice(0, -1)
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === 'user')?.index;

  if (typeof userIndex !== 'number') {
    return null;
  }

  const userMessage = messages[userIndex];
  if (!userMessage) {
    return null;
  }

  const isExecutionRun =
    summaryMessage.workMode === 'agent' || isExecutionHeavyTask(userMessage.content);
  if (!isExecutionRun) {
    return null;
  }

  const processMessages = messages
    .slice(userIndex + 1, -1)
    .filter((message) => message.role !== 'user');
  if (processMessages.length === 0) {
    return null;
  }

  return {
    summaryMessageId: summaryMessage.id,
    userMessageId: userMessage.id,
    messages: processMessages,
    durationMs: Math.max(0, summaryMessage.timestamp - userMessage.timestamp),
  };
}

function ExecutionProcessPanel({
  group,
  lang,
  onOpenWorkspacePath,
}: {
  group: ExecutionProcessGroup;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const t = getTranslation(lang);
  const copy = getProcessGroupCopy(lang);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="mb-4 overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#0d1118]/88"
      data-process-group-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-200">{copy.title}</div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
            <span>{copy.steps(group.messages.length)}</span>
            <span>{copy.duration(formatProcessDuration(group.durationMs, lang))}</span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-slate-500">
          {isOpen ? t.collapse : t.expand}
        </span>
      </button>
      {isOpen && (
        <div className="max-h-[52vh] overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable border-t border-[#2a2d3a] px-4 py-3">
          {group.messages.map((message) => (
            <MessageBubble
              key={message.id}
              msg={message}
              lang={lang}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  lang,
  disabled,
  onAnswer,
}: {
  question: QuestionData;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  disabled: boolean;
  onAnswer: (action: PlanFollowUpAction) => void;
}) {
  const t = getTranslation(lang);
  const hasOptions = question.options && question.options.length > 0;

  const handleOptionClick = (option: { label: string; description?: string }) => {
    const isEn = lang === 'en';
    const answerText = isEn
      ? `Answer to "${question.header}": chose "${option.label}". Continue refining the final Plan; if another decision still materially changes implementation direction, ask again. Do not start execution.`
      : `用户对问题「${question.header}」的回答：选择了「${option.label}」。请基于这个选择继续收敛最终 Plan；如果仍存在会影响实施方向的关键分歧，再提出新的问题。不要开始执行。`;
    onAnswer({
      id: `question-${question.header}-${option.label}`,
      label: isEn ? `Chose "${option.label}"` : `选择了「${option.label}」`,
      prompt: answerText,
      mode: 'plan',
    });
  };

  return (
    <div className="mb-3">
      <div className="rounded-xl border border-cyan-500/20 bg-[#0b0d12]/55 px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-100">
            {t.planDecisionTag}
          </span>
          <h4 className="text-sm font-semibold text-slate-100">{question.question}</h4>
        </div>
        {hasOptions ? (
          <div className="space-y-2">
            {question.options!.map((option, index) => (
              <button
                key={`${question.header}-${index}`}
                type="button"
                disabled={disabled}
                onClick={() => handleOptionClick(option)}
                className="flex w-full items-start justify-between gap-3 rounded-xl border border-cyan-500/25 bg-cyan-500/8 px-3 py-2.5 text-left transition-colors hover:border-cyan-400/45 hover:bg-cyan-500/12 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-cyan-50">{option.label}</div>
                  {option.description && (
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                      {option.description}
                    </p>
                  )}
                </div>
                <span className="flex-shrink-0 text-[11px] font-medium text-cyan-200">
                  {t.planDecisionTag}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400">请在聊天框中输入你的回答，以继续规划。</p>
        )}
      </div>
    </div>
  );
}

function DecisionOptionCardsPanel({
  lang,
  cards,
  disabled,
  onAction,
  onOpenWorkspacePath,
}: {
  lang: 'zh-CN' | 'zh-TW' | 'en';
  cards: DecisionOptionCard[];
  disabled: boolean;
  onAction: (action: PlanFollowUpAction) => void;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const t = getTranslation(lang);

  return (
    <div className="mb-3 space-y-3">
      <p className="text-[11px] font-semibold text-cyan-200">{t.planOptionsLabel}</p>
      {cards.map((card) => {
        return (
          <div
            key={card.id}
            className="rounded-xl border border-cyan-500/20 bg-[#0b0d12]/55 px-3.5 py-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-100">
                {t.planDecisionTag}
              </span>
              <h4 className="text-sm font-semibold text-slate-100">{card.question}</h4>
            </div>
            {card.note && (
              <div className="mb-3 rounded-lg border border-[#243040] bg-[#101722] px-3 py-2">
                <MessageContent
                  content={card.note}
                  lang={lang}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                />
              </div>
            )}
            <div className="space-y-2">
              {card.options.map((option: DecisionOptionItem) => {
                const action = buildDecisionOptionAction({ card, option, lang });

                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onAction(action)}
                    className="flex w-full items-start justify-between gap-3 rounded-xl border border-cyan-500/25 bg-cyan-500/8 px-3 py-2.5 text-left transition-colors hover:border-cyan-400/45 hover:bg-cyan-500/12 disabled:cursor-not-allowed disabled:opacity-50"
                    title={action.prompt}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-cyan-50">{option.label}</div>
                      {option.description && (
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                          {option.description}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[11px] font-medium text-cyan-200">
                      {action.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RelatedFileLinks({
  paths,
  onOpenWorkspacePath,
}: {
  paths: string[];
  onOpenWorkspacePath?: (path: string) => void;
}) {
  if (!onOpenWorkspacePath || paths.length === 0) {
    return null;
  }

  const uniquePaths = Array.from(new Set(paths));

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {uniquePaths.map((path) => (
        <button
          key={path}
          type="button"
          onClick={() => onOpenWorkspacePath(path)}
          className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200 transition-colors hover:border-sky-400/50 hover:text-sky-100"
        >
          {path}
        </button>
      ))}
    </div>
  );
}

function MessageContent({
  content,
  lang,
  onOpenWorkspacePath,
  isStreaming,
}: {
  content: string;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  onOpenWorkspacePath?: (path: string) => void;
  isStreaming?: boolean;
}) {
  if (isStreaming) {
    const visibleContent = getStreamingPreviewContent(content, MAX_STREAMING_MESSAGE_CHARS);

    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-slate-200">
        {visibleContent}
      </p>
    );
  }

  const t = getTranslation(lang);

  return (
    <MarkdownRenderer
      content={content}
      copyLabel={t.copy}
      onOpenWorkspacePath={onOpenWorkspacePath}
    />
  );
}

interface MessageBubbleProps {
  msg: UIMessage;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  showPlanActions?: boolean;
  planActionsDisabled?: boolean;
  onPlanAction?: (action: PlanFollowUpAction) => void;
  onOpenWorkspacePath?: (path: string) => void;
  onPreviewImage?: (src: string) => void;
  characterAvatar?: string | null;
  characterName?: string;
}

function areMessageBubblePropsEqual(
  previous: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  return (
    previous.msg === next.msg &&
    previous.lang === next.lang &&
    previous.showPlanActions === next.showPlanActions &&
    previous.planActionsDisabled === next.planActionsDisabled &&
    previous.onOpenWorkspacePath === next.onOpenWorkspacePath &&
    previous.characterAvatar === next.characterAvatar &&
    previous.characterName === next.characterName &&
    (previous.showPlanActions || next.showPlanActions
      ? previous.onPlanAction === next.onPlanAction
      : true)
  );
}

const MessageBubble = memo(function MessageBubble({
  msg,
  lang,
  showPlanActions,
  planActionsDisabled,
  onPlanAction,
  onOpenWorkspacePath,
  onPreviewImage,
  characterAvatar,
  characterName,
}: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const isSyntheticSummary = !isUser && !isError && Boolean(msg.synthetic);
  const useBubbleFrame = isUser || isError || isSyntheticSummary;
  const t = getTranslation(lang);
  const parsedDecisionCards = showPlanActions && !msg.isStreaming
    ? parseDecisionOptionCards(msg.content)
    : null;
  const modelUsageLabel =
    !isUser && !isError && msg.modelTier === 'fast'
      ? t.fastModelTag
      : null;
  const showRunningStatusIndicator =
    !isUser &&
    !isError &&
    msg.isStreaming &&
    Boolean(msg.statusText) &&
    !msg.content &&
    !(msg.displayReasoningContent ?? msg.reasoningContent) &&
    (!msg.toolInvocations || msg.toolInvocations.length === 0);

  const frameClassName = isUser
    ? 'max-w-[80%] rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm leading-relaxed text-white'
    : isError
      ? 'max-w-[80%] rounded-2xl rounded-bl-sm border border-red-700/50 bg-red-900/60 px-4 py-2.5 text-sm leading-relaxed text-red-300'
      : isSyntheticSummary
        ? 'w-full rounded-2xl rounded-bl-sm border border-[#2a2d3a] bg-[#101722] px-4 py-3 text-sm leading-relaxed text-slate-200 shadow-[0_10px_30px_rgba(15,23,42,0.22)]'
        : 'w-full max-w-4xl px-0 py-0 text-sm leading-relaxed text-slate-200';

  const avatarElement = (() => {
    if (isError || isUser) return null;
    if (characterAvatar) {
      return (
        <div className="mr-2 flex-shrink-0 self-start" title={characterName}>
          <img
            src={characterAvatar}
            alt={characterName ?? ''}
            className="h-8 w-8 rounded-full border border-[#2a2d3a] object-cover"
          />
        </div>
      );
    }
    return (
      <div className="mr-2 flex-shrink-0 self-start">
        <div className="h-8 w-8 rounded-full bg-slate-700/50 border border-[#2a2d3a] flex items-center justify-center">
          <svg className="h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
      </div>
    );
  })();

  return (
    <div className={`mb-4 flex fade-in ${isUser ? 'justify-end' : 'justify-start'}`} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
      {!isUser && avatarElement}
      <div
        className={`min-w-0 ${frameClassName}`}
        data-message-role={msg.role}
        data-message-synthetic={msg.synthetic ? 'true' : 'false'}
        data-message-variant={useBubbleFrame ? 'bubble' : 'plain'}
      >
        {modelUsageLabel && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] select-none">
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/12 px-2 py-0.5 font-semibold text-amber-200">
              {modelUsageLabel}
            </span>
            {msg.modelName && <span className="text-slate-500">{msg.modelName}</span>}
          </div>
        )}
        {isUser && msg.images && msg.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {msg.images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.mediaType};base64,${image.data}`}
                alt="attachment"
                className="h-20 w-20 rounded-lg border border-white/20 object-cover cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => onPreviewImage?.(`data:${image.mediaType};base64,${image.data}`)}
              />
            ))}
          </div>
        )}
        {(msg.displayReasoningContent ?? msg.reasoningContent) && (
          <ReasoningPanel
            content={msg.displayReasoningContent ?? msg.reasoningContent ?? ''}
            isStreaming={msg.isStreaming}
            lang={lang}
          />
        )}
        <ToolInvocationsPanel msg={msg} lang={lang} />
        <RelatedFileLinks paths={msg.relatedFilePaths ?? []} onOpenWorkspacePath={onOpenWorkspacePath} />
        {showRunningStatusIndicator && msg.statusText && (
          <RunningStatusIndicator label={msg.statusText} />
        )}
        {!showRunningStatusIndicator && msg.statusText && !msg.content && !(msg.displayReasoningContent ?? msg.reasoningContent) && (!msg.toolInvocations || msg.toolInvocations.length === 0) && (
          <p className="mb-2 text-xs font-medium text-slate-400/90 select-none">{msg.statusText}</p>
        )}
        <div className="select-text">
          <MessageContent
            content={
              !msg.isStreaming && showPlanActions && parsedDecisionCards && parsedDecisionCards.cards.length > 0
                ? parsedDecisionCards.remainderContent
                : msg.content
            }
            lang={lang}
            onOpenWorkspacePath={onOpenWorkspacePath}
            isStreaming={msg.isStreaming}
          />
        </div>
        {showPlanActions &&
          onPlanAction &&
          parsedDecisionCards &&
          parsedDecisionCards.cards.length > 0 && (
          <DecisionOptionCardsPanel
            lang={lang}
            cards={parsedDecisionCards.cards}
            disabled={Boolean(planActionsDisabled)}
            onAction={onPlanAction}
            onOpenWorkspacePath={onOpenWorkspacePath}
          />
        )}
        {showPlanActions && onPlanAction && msg.question && (
          <QuestionCard
            question={msg.question}
            lang={lang}
            disabled={Boolean(planActionsDisabled)}
            onAnswer={onPlanAction}
          />
        )}
        {typeof msg.agentStep !== 'number' && (
          <p className={`text-[10px] mt-1.5 select-none ${isUser ? 'text-indigo-300' : 'text-slate-500'}`}>
            {new Date(msg.timestamp).toLocaleTimeString(lang === 'en' ? 'en-US' : lang)}
          </p>
        )}
      </div>
    </div>
  );
}, areMessageBubblePropsEqual);

interface ModeSelectorProps {
  mode: WorkMode;
  setMode: (mode: WorkMode) => void;
  isLoading: boolean;
  lang: 'zh-CN' | 'zh-TW' | 'en';
}

function ModeSelector({ mode, setMode, isLoading, lang }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const modes: { id: WorkMode; label: string }[] = [
    { id: 'ask', label: lang === 'en' ? 'Ask' : lang === 'zh-TW' ? 'Ask' : 'Ask' },
    { id: 'plan', label: lang === 'en' ? 'Plan' : lang === 'zh-TW' ? 'Plan' : 'Plan' },
    { id: 'agent', label: lang === 'en' ? 'Agent' : lang === 'zh-TW' ? 'Agent' : 'Agent' },
  ];
  const active = modes.find((m) => m.id === mode) ?? modes[2];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={isLoading}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-50"
      >
        {active.label}
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-28 bg-[#1a1d27] border border-[#2a2d3a] rounded-xl shadow-xl overflow-hidden z-20">
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs transition-colors hover:bg-slate-700/50 ${
                mode === m.id ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatPanelProps {
  onOpenWorkspacePath?: (path: string) => void;
}

export function ChatPanel({ onOpenWorkspacePath }: ChatPanelProps) {
  const {
    messages,
    isLoading,
    sendMessage,
    cancelMessage,
    activeSessionId,
    settings,
    setShowSettings,
    workspacePath,
    refreshProjectDiagnostics,
    _taskChecklists,
    resetToMessage,
    messageCheckpoints,
    gitReady,
    gitReadyError,
    _agentDefinitions,
    _skillDefinitions,
    mentorEnabled,
  } = useAgentStore(
    useShallow((state) => ({
      messages: state.messages,
      isLoading: state.isLoading,
      sendMessage: state.sendMessage,
      cancelMessage: state.cancelMessage,
      activeSessionId: state.activeSessionId,
      settings: state.settings,
      setShowSettings: state.setShowSettings,
      workspacePath: state.workspacePath,
      refreshProjectDiagnostics: state.refreshProjectDiagnostics,
      _taskChecklists: state._taskChecklists,
      resetToMessage: state.resetToMessage,
      messageCheckpoints: state._messageCheckpoints,
      gitReady: state._gitReady,
      gitReadyError: state._gitReadyError,
      _agentDefinitions: state._agentDefinitions,
      _skillDefinitions: state._skillDefinitions,
      mentorEnabled: state.settings.mentorEnabled ?? true,
    }))
  );
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<ImagePreview[]>([]);
  const [pendingFiles, setPendingFiles] = useState<TextFileAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const onPreviewImage = useCallback((src: string) => setPreviewImage(src), []);
  const [mode, setMode] = useState<WorkMode>('agent');
  const [subagentRuns, setSubagentRuns] = useState<SubAgentRun[]>([]);
  useEffect(() => subscribeSubagentProgress(() => {
    setSubagentRuns(getSubagentRuns());
  }), []);
  const [resetConfirmMsgId, setResetConfirmMsgId] = useState<string | null>(null);
  const [resetInFlight, setResetInFlight] = useState(false);
  const [resetBanner, setResetBanner] = useState<{ kind: 'success' | 'warn' | 'error'; text: string } | null>(null);
  const [hoveredActionMsgId, setHoveredActionMsgId] = useState<string | null>(null);
  useEffect(() => {
    if (!resetBanner) return;
    const timer = window.setTimeout(() => setResetBanner(null), 3000);
    return () => window.clearTimeout(timer);
  }, [resetBanner]);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const slashDropdownRef = useRef<SlashCommandDropdownHandle | null>(null);
  const [atFilter, setAtFilter] = useState<string | null>(null);
  const atTriggerIndexRef = useRef<number>(-1);
  const atDropdownRef = useRef<AtMentionDropdownHandle | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListContentRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleMessageIdRef = useRef<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const isComposingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsError = getSettingsError(settings);
  const isConfigured = !settingsError;
  const canSubmit = (!!input.trim() || pendingImages.length > 0 || pendingFiles.length > 0) && !isLoading;
  const visibleMessages = useMemo(
    () => messages.filter((message) => !message.hidden),
    [messages]
  );
  const tailExecutionProcessGroup = useMemo(
    () => buildTailExecutionProcessGroup(visibleMessages),
    [visibleMessages]
  );
  const hasStreamingMessage = useMemo(
    () => visibleMessages.some(
      (message) => message.role === 'assistant' && message.isStreaming
    ),
    [visibleMessages]
  );
  const tailMessageId = useMemo(
    () => visibleMessages[visibleMessages.length - 1]?.id ?? null,
    [visibleMessages]
  );
  const streamingMessage = useMemo(
    () => visibleMessages.find(
      (message) => message.role === 'assistant' && message.isStreaming
    ),
    [visibleMessages]
  );
  const streamingUpdateKey = useMemo(
    () => streamingMessage
      ? [
          streamingMessage.id,
          streamingMessage.content.length,
          (streamingMessage.displayReasoningContent ?? streamingMessage.reasoningContent ?? '').length,
          streamingMessage.toolInvocations?.length ?? 0,
          streamingMessage.statusText ?? '',
        ].join(':')
      : '',
    [streamingMessage]
  );
  const t = getTranslation(settings.lang);
  const { feedStream: ttsFeedStream, stop: ttsStop, isPlaying: ttsIsPlaying, lastError: ttsError, clearError: ttsClearError, serverStatus: ttsServerStatus, serverModelVersion: ttsServerModelVersion, serverHalfPrecision: ttsServerHalfPrecision, serverDevice: ttsServerDevice, installed: ttsInstalled, refreshInstalled: ttsRefreshInstalled, startServer: ttsStartServer, replayText: ttsReplayText, setVoiceConfig: ttsSetVoiceConfig, setTextLanguage: ttsSetTextLanguage, setVoiceModel: ttsSetVoiceModel, setFineTunedModel: ttsSetFineTunedModel, preloadModel: ttsPreloadModel, setPlaybackMode: ttsSetPlaybackMode, setSampleSteps: ttsSetSampleSteps, setSpeed: ttsSetSpeed, setSentencesPerChunk: ttsSetSentencesPerChunk, serverLog: ttsServerLog, clearServerLog: ttsClearServerLog } = useTtsPlayer();
  const [showInstaller, setShowInstaller] = useState(false);
  const [ttsStarting, setTtsStarting] = useState(false);
  const [showTtsLog, setShowTtsLog] = useState(false);
  const prevFtPathRef = useRef('');

  const handleTtsClick = useCallback(async () => {
    // If a start is already in progress, do nothing — the backend has its
    // own re-entrancy guard and clicking again would just be wasted noise.
    if (ttsServerStatus === 'starting' || ttsStarting) {
      return;
    }
    if (ttsServerStatus === 'running') {
      // Toggle server log panel.
      setShowTtsLog(!showTtsLog);
      return;
    }

    // Re-check installation; if missing, open the installer instead.
    const status = await ttsRefreshInstalled();
    const isInstalled = status?.installed === true;
    if (!isInstalled) {
      setShowInstaller(true);
      return;
    }

    // Installed and not currently starting → kick off a start.
    setTtsStarting(true);
    const ftPath = activeCharacter?.voice?.useFineTuned !== false && activeCharacter?.voice?.fineTunedModelPath
      ? activeCharacter.voice.fineTunedModelPath
      : '';
    ttsStartServer('v4', ftPath);
    // Safety: clear the "starting" UI flag eventually so the button isn't
    // permanently disabled if events get lost. The `starting` server status
    // owned by the hook is the source of truth for status display.
    setTimeout(() => setTtsStarting(false), 120_000);
  }, [ttsRefreshInstalled, ttsServerStatus, ttsStartServer, ttsStarting, showTtsLog]);

  // Clear the local "starting" flag whenever the hook reports a terminal state.
  useEffect(() => {
    if (ttsServerStatus === 'running' || ttsServerStatus === 'error' || ttsServerStatus === 'stopped') {
      setTtsStarting(false);
    }
  }, [ttsServerStatus]);

  // Warn the user when the server is running with suboptimal settings:
  // - Not v4 model (v1 is extremely slow for Japanese/mixed text)
  // - Not MPS on Apple Silicon (CPU is 5-10x slower)
  // - Not using half precision (2x slower)
  const ttsWarningShownRef = useRef(false);
  useEffect(() => {
    if (ttsServerStatus !== 'running') {
      ttsWarningShownRef.current = false;
      return;
    }
    if (ttsWarningShownRef.current) return;
    ttsWarningShownRef.current = true;

    const warnings: string[] = [];
    if (ttsServerModelVersion && ttsServerModelVersion !== 'v4') {
      warnings.push(`模型版本为 ${ttsServerModelVersion}（建议 v4，v1 对日语极慢）`);
    }
    if (ttsServerDevice === 'cpu') {
      warnings.push('运行在 CPU 模式（MPS GPU 加速未生效，合成速度慢 5-10 倍）');
    }
    if (!ttsServerHalfPrecision) {
      warnings.push('未启用半精度（合成速度慢约 2 倍）');
    }
    if (warnings.length > 0) {
      toast.warning(`TTS 性能警告：${warnings.join('；')}`, { durationMs: 10000 });
    }
  }, [ttsServerStatus, ttsServerModelVersion, ttsServerDevice, ttsServerHalfPrecision]);

  const activeCharacter = useCharactersStore((s) =>
    s.characters.find((c) => c.id === s.activeCharacterId) ?? null
  );

  const characterAvatar = (activeCharacter?.showAvatar ?? true)
    ? (activeCharacter?.avatarDataUrl ?? null)
    : null;
  const characterName = activeCharacter?.name;

  // Auto-speak only when the active character has voice enabled.
  const voiceEnabled = activeCharacter?.voice?.enabled ?? false;

  // Sync voice config (ref audio path, prompt text) to the TTS hook.
  useEffect(() => {
    const vc = activeCharacter?.voice;
    if (vc?.engine === 'gpt-sovits' && vc.referenceSamplePath) {
      const promptLang = vc.referenceTextLanguage || 'zh';
      const textLang = vc.textLanguage || promptLang;
      ttsSetVoiceConfig(vc.referenceSamplePath, vc.referenceText ?? '', promptLang);
      ttsSetTextLanguage(textLang);
      ttsSetPlaybackMode(vc.playbackMode ?? 'ws-batch');
      ttsSetSampleSteps(vc.sampleSteps ?? 8);
      ttsSetSpeed(vc.speed ?? 1.0);
      ttsSetVoiceModel(vc.modelName ?? '');
      const ftPath = vc.useFineTuned !== false && vc.fineTunedModelPath ? vc.fineTunedModelPath : '';
      ttsSetFineTunedModel(ftPath);
      ttsSetSentencesPerChunk(vc.sentencesPerChunk ?? 3);
      // Only preload/reset the model when the path actually changes
      // (avoiding an HTTP round-trip on every character save).
      if (ftPath !== prevFtPathRef.current && ttsServerStatus === 'running') {
        prevFtPathRef.current = ftPath;
        ttsPreloadModel(ftPath).catch(() => {});
      }
    } else {
      ttsSetVoiceConfig('', '', 'zh');
      ttsSetTextLanguage('zh');
      ttsSetVoiceModel('');
      ttsSetFineTunedModel('');
    }
  }, [activeCharacter?.voice?.referenceSamplePath, activeCharacter?.voice?.referenceText, activeCharacter?.voice?.referenceTextLanguage, activeCharacter?.voice?.textLanguage, activeCharacter?.voice?.engine, activeCharacter?.voice?.playbackMode, activeCharacter?.voice?.sampleSteps, activeCharacter?.voice?.speed, activeCharacter?.voice?.modelName, activeCharacter?.voice?.fineTunedModelPath, activeCharacter?.voice?.useFineTuned, activeCharacter?.voice?.sentencesPerChunk, ttsSetVoiceConfig, ttsSetTextLanguage, ttsSetVoiceModel, ttsSetFineTunedModel, ttsSetPlaybackMode, ttsSetSampleSteps, ttsSetSpeed, ttsSetSentencesPerChunk, ttsServerStatus]);

  const prevHasStreamingRef = useRef(hasStreamingMessage);
  const lastStreamingMsgIdRef = useRef<string | null>(null);
  // We read `visibleMessages` from a ref inside the TTS effects so that the
  // effects do NOT re-run on every render (visibleMessages is an inline
  // `messages.filter(...)` result and gets a fresh reference each render).
  // Re-running the effects unnecessarily was a major contributor to the
  // "the character keeps repeating the same sentence" bug.
  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;

  // Streaming feed: sends new content chunks to TTS.
  // Also detects agent-round transitions (message ID changes) and force-completes
  // the previous round's text so buffered text isn't stranded.
  useEffect(() => {
    if (!voiceEnabled) return;
    if (ttsServerStatus !== 'running') return;

    const streaming = streamingMessage;

    // Round transition: streaming switched to a new message.
    // Force-complete the previous message's content first.
    if (lastStreamingMsgIdRef.current
        && streaming?.id
        && lastStreamingMsgIdRef.current !== streaming.id) {
      const prevMsg = visibleMessagesRef.current.find(
        (m) => m.id === lastStreamingMsgIdRef.current,
      );
      if (prevMsg?.content && prevMsg.role === 'assistant' && !prevMsg.synthetic) {
        ttsFeedStream(prevMsg.content, true, prevMsg.id);
      }
    }

    if (!streaming?.content) return;
    if ((streaming.toolInvocations?.length ?? 0) > 0) return;

    ttsFeedStream(streaming.content, false, streaming.id);
    lastStreamingMsgIdRef.current = streaming.id;
    // NOTE: deliberately NOT depending on `visibleMessages` (it changes
    // reference every render). We read it via `visibleMessagesRef`.
  }, [streamingMessage?.content, streamingMessage?.id, streamingMessage?.toolInvocations?.length, voiceEnabled, ttsServerStatus, ttsFeedStream]);

  // Finalization: when all streaming stops, force-complete the last message.
  // The "previous had streaming" tracking is updated INSIDE this same effect
  // (top of the body) so there is no window where another render can
  // re-trigger finalize between two separate effects. Together with the
  // `lastFinalizedIdRef` idempotence guard inside `feedStream`, this makes
  // finalize fire exactly once per assistant message.
  useEffect(() => {
    const wasStreaming = prevHasStreamingRef.current;
    prevHasStreamingRef.current = hasStreamingMessage;

    if (!voiceEnabled) return;
    if (ttsServerStatus !== 'running') return;
    if (!wasStreaming || hasStreamingMessage) return;

    const msgs = visibleMessagesRef.current;
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.synthetic) return;
    if ((lastMsg.toolInvocations?.length ?? 0) > 0) return;
    if (!lastMsg.content) return;

    // forceComplete=true flushes any tail buffered behind unclosed markers.
    // `feedStream` is itself idempotent on (messageId, forceComplete), so
    // even if this effect ever runs twice for the same transition, the TTS
    // hook silently no-ops on the second call.
    ttsFeedStream(lastMsg.content, true, lastMsg.id);
    lastStreamingMsgIdRef.current = null;
  }, [hasStreamingMessage, voiceEnabled, ttsServerStatus, ttsFeedStream]);

  // `prevHasStreamingRef` is now updated synchronously at the top of the
  // finalize effect above. We intentionally do NOT update it in a separate
  // effect — doing so created a window where `visibleMessages` re-renders
  // could re-trigger the finalize effect before this updater ran, causing
  // duplicate playback of the same finalize.

  const latestPlanAssistantMessageId = useMemo(
    () =>
      [...visibleMessages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.workMode === 'plan' &&
            !message.synthetic &&
            !message.isStreaming
        )?.id ?? null,
    [visibleMessages]
  );
  const renderedMessages = useMemo(() => {
    if (!tailExecutionProcessGroup) {
      return visibleMessages;
    }
    return visibleMessages.filter((message) => {
      if (message.id === tailExecutionProcessGroup.summaryMessageId) {
        return true;
      }
      if (message.id === tailExecutionProcessGroup.userMessageId) {
        return true;
      }
      return !tailExecutionProcessGroup.messages.some(
        (processMessage) => processMessage.id === message.id
      );
    });
  }, [visibleMessages, tailExecutionProcessGroup]);

  useLayoutEffect(() => {
    const container = messageListRef.current;
    if (!container) {
      lastVisibleMessageIdRef.current = tailMessageId;
      return;
    }

    const behavior = getChatAutoScrollBehavior({
      previousTailMessageId: lastVisibleMessageIdRef.current,
      nextTailMessageId: tailMessageId,
      hasStreamingMessage,
    });

    if (shouldStickToBottomRef.current || lastVisibleMessageIdRef.current === null) {
      scrollContainerToBottom(container, behavior);
    }

    lastVisibleMessageIdRef.current = tailMessageId;
  }, [tailMessageId, hasStreamingMessage, streamingUpdateKey]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
  }, [input]);

  useLayoutEffect(() => {
    const container = messageListRef.current;
    const content = messageListContentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (hasStreamingMessage || shouldStickToBottomRef.current) {
        scrollContainerToBottom(container, hasStreamingMessage ? 'auto' : 'smooth');
      }
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [hasStreamingMessage]);

  const submitMessage = useCallback(async (
    taskText: string,
    displayText: string,
    nextMode: WorkMode,
    images?: IImageContent[]
  ) => {
    if (workspacePath && nextMode !== 'ask') {
      refreshProjectDiagnostics().catch(() => {});
    }

    await sendMessage(taskText, displayText, nextMode, null, images);
  }, [
    refreshProjectDiagnostics,
    sendMessage,
    workspacePath,
  ]);

  const handleSend = async () => {
    const userText = input.trim();
    const images = pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
    if ((!userText && images.length === 0 && pendingFiles.length === 0) || isLoading || !isConfigured) return;
    ttsStop();
    setInput('');
    setPendingImages([]);
    const files = pendingFiles;
    setPendingFiles([]);
    const promptText = buildUserPromptWithFiles(userText, files);
    const displayText = userText || files.map((f) => f.name).join(', ') || (images.length ? '🖼️' : '');
    await submitMessage(promptText, displayText, mode, images.length ? images : undefined);
  };

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const previews = (await Promise.all(files.map(readFileAsImagePreview))).filter(
      (item): item is ImagePreview => item !== null
    );
    if (previews.length > 0) {
      setPendingImages((current) => [...current, ...previews]);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const allFiles = Array.from(event.clipboardData.files ?? []);
    if (allFiles.length === 0) return;
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const textFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0 || textFiles.length > 0) {
      event.preventDefault();
      void handleIncomingFiles(imageFiles, textFiles);
    }
  };

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const allFiles = Array.from(event.dataTransfer.files ?? []);
    if (allFiles.length === 0) return;
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const textFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0 || textFiles.length > 0) {
      event.preventDefault();
      void handleIncomingFiles(imageFiles, textFiles);
    }
  };

  const handleIncomingFiles = async (imageFiles: File[], textFiles: File[]) => {
    if (imageFiles.length > 0) {
      await addImageFiles(imageFiles);
    }
    if (textFiles.length > 0) {
      await addTextFiles(textFiles);
    }
  };

  const removePendingImage = (id: string) => {
    setPendingImages((current) => current.filter((image) => image.id !== id));
  };

  const removePendingFile = (id: string) => {
    setPendingFiles((current) => current.filter((file) => file.id !== id));
  };

  const handlePrimaryAction = async () => {
    if (!canSubmit) return;
    if (!isConfigured) {
      setShowSettings(true);
      return;
    }
    await handleSend();
  };

  const handleSlashSelect = (name: string) => {
    setInput(`/${name} `);
    setSlashFilter(null);
  };

  const mentionItems = useMemo(
    () => buildMentionItems(_agentDefinitions, _skillDefinitions, settings.lang, mentorEnabled),
    [_agentDefinitions, _skillDefinitions, settings.lang, mentorEnabled]
  );

  const handleAtSelect = useCallback((item: MentionItem) => {
    const triggerIndex = atTriggerIndexRef.current;
    if (triggerIndex < 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    setInput((prev) => {
      const before = prev.slice(0, triggerIndex);
      const after = prev.slice(cursorPos);
      return `${before}@${item.name} ${after}`;
    });
    setAtFilter(null);
    atTriggerIndexRef.current = -1;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        const newPos = triggerIndex + item.name.length + 2;
        el.focus();
        el.setSelectionRange(newPos, newPos);
      }
    });
  }, []);

  const handleAtDismiss = useCallback(() => {
    setAtFilter(null);
    atTriggerIndexRef.current = -1;
  }, []);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.currentTarget.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      await addImageFiles(imageFiles);
    }

    const textFiles = files.filter((f) => !f.type.startsWith('image/'));
    if (textFiles.length > 0) {
      await addTextFiles(textFiles);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addTextFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const oversizedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const attachments: TextFileAttachment[] = [];

    for (const file of files) {
      if (file.size > MAX_TEXT_FILE_BYTES) {
        oversizedFiles.push(`${file.name} (${(file.size / 1024).toFixed(0)}KB)`);
        continue;
      }
      try {
        const text = await file.text();
        attachments.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`,
          name: file.name,
          content: text,
          size: file.size,
        });
      } catch {
        skippedFiles.push(file.name);
      }
    }

    let droppedCount = 0;
    setPendingFiles((current) => {
      const combined = [...current, ...attachments];
      if (combined.length > MAX_PENDING_FILES) {
        droppedCount = combined.length - MAX_PENDING_FILES;
        return combined.slice(combined.length - MAX_PENDING_FILES);
      }
      return combined;
    });

    if (droppedCount > 0) {
      toast.warning(
        t.toastAttachmentLimitExceeded
          .replace('{max}', String(MAX_PENDING_FILES))
          .replace('{dropped}', String(droppedCount)),
      );
    }

    if (oversizedFiles.length > 0) {
      toast.error(
        t.toastAttachmentTooLarge
          .replace('{max}', String(MAX_TEXT_FILE_BYTES / 1024 / 1024))
          .replace('{names}', oversizedFiles.join('\n')),
      );
    }

    if (skippedFiles.length > 0) {
      toast.warning(
        t.toastAttachmentBinarySkipped.replace('{names}', skippedFiles.join('\n')),
      );
    }
  };

  const handlePlanAction = useCallback(async (action: PlanFollowUpAction) => {
    if (isLoading || !isConfigured) {
      return;
    }

    setMode(action.mode);
    await submitMessage(action.prompt, action.label, action.mode);
  }, [isConfigured, isLoading, submitMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent;
    const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;

    if (isComposing) {
      return;
    }

    if (slashFilter !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashDropdownRef.current?.navigateDown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashDropdownRef.current?.navigateUp();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        slashDropdownRef.current?.selectCurrent();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashFilter(null);
        return;
      }
    }

    if (atFilter !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atDropdownRef.current?.navigateDown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atDropdownRef.current?.navigateUp();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        atDropdownRef.current?.selectCurrent();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleAtDismiss();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handlePrimaryAction();
    }
  };

  return (
    <div className="relative flex flex-col h-full">
      {resetBanner && (
        <div
          role="status"
          className={
            'pointer-events-none absolute inset-x-0 top-2 z-40 mx-auto w-fit max-w-[90%] rounded-full border px-4 py-1.5 text-xs shadow-lg backdrop-blur-sm fade-in ' +
            (resetBanner.kind === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200'
              : resetBanner.kind === 'warn'
              ? 'border-amber-500/30 bg-amber-500/15 text-amber-200'
              : 'border-red-500/30 bg-red-500/15 text-red-200')
          }
        >
          {resetBanner.text}
        </div>
      )}
      {gitReadyError && !gitReady && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit max-w-[90%] rounded-full border border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-200 shadow-lg backdrop-blur-sm"
        >
          {settings.lang === 'en'
            ? `Code reset disabled: ${gitReadyError}`
            : settings.lang === 'zh-TW'
            ? `程式碼重設不可用：${gitReadyError}`
            : `代码重置不可用：${gitReadyError}`}
        </div>
      )}
      <GoalBanner />
      {/* 消息列表 */}
      <div className="relative flex-1 min-h-0">
        <div
        ref={messageListRef}
        data-chat-scroll="true"
        onScroll={(event) => {
          shouldStickToBottomRef.current = isScrollContainerNearBottom(event.currentTarget);
        }}
        className="h-full overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-4 py-4"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={messageListContentRef}>
          {visibleMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-600 select-none">
              <div className="text-4xl mb-3">⌘</div>
              <p className="text-sm">CodePapr</p>
              <p className="text-xs mt-1">
                {isConfigured ? t.welcomeDescConfigured : t.confirmSettings}
              </p>
              {!isConfigured && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                >
                  {t.toSettings}
                </button>
              )}
            </div>
          )}
          {subagentRuns.map((run, idx) => (
            <div key={idx} className="mx-3 mb-3 rounded-xl border border-cyan-500/20 bg-[#0b0d12]/60 overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-[#0f141d]/50"
                onClick={() => toggleSubagentCollapse(idx)}
              >
                <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${run.state === 'running' ? 'animate-pulse bg-cyan-400' : 'bg-emerald-400'}`} />
                <span className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-cyan-300">
                    {run.agent === 'explore' ? (run.state === 'running' ? 'Explore 正在分析代码...' : 'Explore 分析完成') :
                     run.agent === 'scout' ? (run.state === 'running' ? 'Scout 正在搜索网络...' : 'Scout 搜索完成') :
                     run.agent === 'mentor' ? (run.state === 'running' ? 'Mentor 正在思考...' : 'Mentor 思考完成') :
                     (run.state === 'running' ? `${run.agent} 正在执行...` : `${run.agent} 执行完成`)}
                  </span>
                  {run.prompt && (
                    <span className="block mt-0.5 text-[11px] text-slate-500 truncate">{run.prompt}</span>
                  )}
                </span>
                <span className="text-[9px] text-slate-600 transition-transform flex-shrink-0" style={{ transform: run.collapsed ? 'rotate(-90deg)' : 'none' }}>
                  ▼
                </span>
              </button>
              {!run.collapsed && (
                <div className="border-t border-cyan-500/10 px-3.5 py-2.5">
                  {run.content && run.state === 'completed' && (
                    <div className="mb-2 max-h-32 overflow-y-auto rounded-lg bg-[#0d1118] px-3 py-2 text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap">
                      {run.content.length > 600 ? `${run.content.slice(0, 600)}...` : run.content}
                    </div>
                  )}
                  {run.steps.length > 0 && (
                    <div className="space-y-0.5">
                      {run.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className={step.status === 'error' ? 'text-red-400' : 'text-emerald-400'}>
                            {step.status === 'error' ? '✗' : '✓'}
                          </span>
                          <span className="font-mono text-slate-400">{step.name}</span>
                          {step.summary && step.summary !== step.name && (
                            <span className="truncate text-slate-500">· {step.summary}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {renderedMessages.map((m) => {
            const isUserMsg = m.role === 'user';
            const canShowActions = isUserMsg && !isLoading;

            const bubble = m.id === tailExecutionProcessGroup?.summaryMessageId ? (
              <div key={`process-group:${tailExecutionProcessGroup.summaryMessageId}`}>
                <ExecutionProcessPanel
                  group={tailExecutionProcessGroup}
                  lang={settings.lang ?? 'zh-CN'}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                />
                <MessageBubble
                  msg={m}
                  lang={settings.lang ?? 'zh-CN'}
                  showPlanActions={m.id === latestPlanAssistantMessageId && m.id === tailMessageId}
                  planActionsDisabled={isLoading}
                  onPlanAction={handlePlanAction}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                  onPreviewImage={onPreviewImage}
                  characterAvatar={characterAvatar}
                  characterName={characterName}
                />
              </div>
            ) : (
              <MessageBubble
                key={m.id}
                msg={m}
                lang={settings.lang ?? 'zh-CN'}
                showPlanActions={m.id === latestPlanAssistantMessageId && m.id === tailMessageId}
                planActionsDisabled={isLoading}
                onPlanAction={handlePlanAction}
                onOpenWorkspacePath={onOpenWorkspacePath}
                onPreviewImage={onPreviewImage}
                characterAvatar={characterAvatar}
                characterName={characterName}
              />
            );

            if (!canShowActions) return bubble;

            const hasCheckpoint = Boolean(messageCheckpoints[m.id]);
            const canReset = hasCheckpoint && gitReady;
            const isHover = hoveredActionMsgId === m.id;
            const resetLabel = settings.lang === 'en' ? 'Reset to here' : settings.lang === 'zh-TW' ? '重設到此' : '重置到此点';
            const copyLabel = settings.lang === 'en' ? 'Copy' : '复制';
            const noCheckpointTip = !gitReady
              ? (settings.lang === 'en'
                  ? 'Code reset is initializing or unavailable for this workspace.'
                  : settings.lang === 'zh-TW'
                  ? '程式碼重設正在初始化，或目前工作區不可用。'
                  : '代码重置正在初始化，或当前工作区不可用。')
              : (settings.lang === 'en'
                  ? 'No code snapshot for this message; cannot reset code.'
                  : settings.lang === 'zh-TW'
                  ? '此訊息沒有程式碼快照，無法重置程式碼。'
                  : '此消息没有代码快照，无法重置代码。');

            return (
              <div key={m.id} data-message-id={m.id}>
                {bubble}
                <div
                  className="mb-4 flex justify-end"
                  onMouseEnter={() => setHoveredActionMsgId(m.id)}
                  onMouseLeave={() => setHoveredActionMsgId((prev) => (prev === m.id ? null : prev))}
                >
                  <div
                    className="flex items-center gap-1 mr-1 transition-opacity duration-150"
                    style={{ opacity: isHover ? 1 : 0, pointerEvents: isHover ? 'auto' : 'none' }}
                  >
                    {m.role === 'assistant' && !m.synthetic && m.content && (
                      <button
                        className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-300"
                        onClick={() => ttsReplayText(m.content)}
                        title={settings.lang === 'en' ? 'Replay' : settings.lang === 'zh-TW' ? '重播' : '重播'}
                      >
                        {settings.lang === 'en' ? 'Replay' : settings.lang === 'zh-TW' ? '重播' : '重播'}
                      </button>
                    )}
                    <button
                      className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors enabled:hover:border-indigo-500/40 enabled:hover:bg-indigo-500/10 enabled:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canReset}
                      title={canReset ? undefined : noCheckpointTip}
                      onClick={() => setResetConfirmMsgId(m.id)}
                    >
                      {resetLabel}
                    </button>
                    <button
                      className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-slate-500/40 hover:bg-slate-500/10 hover:text-slate-300"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(m.content);
                        } catch {
                          // 复制失败静默忽略
                        }
                      }}
                    >
                      {copyLabel}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {activeSessionId && _taskChecklists[activeSessionId] ? (
            <div className="mx-3 mb-4 rounded-2xl border-2 border-indigo-500/50 bg-[#10131b]">{/* debug-visible wrapper */}
              <TaskChecklist
                checklist={_taskChecklists[activeSessionId]!}
                lang={settings.lang ?? 'zh-CN'}
                isLoading={isLoading}
              />
            </div>
          ) : null}
          {isLoading && !hasStreamingMessage && (
            <div className="mb-4 flex justify-start fade-in">
              <div className="flex items-center gap-1.5 px-1 py-2">
                <div className="flex gap-1.5 items-center">
                  <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

        {/* 重置到此点确认对话框 */}
        {resetConfirmMsgId !== null && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => { if (!resetInFlight) setResetConfirmMsgId(null); }}
          >
            <div className="mx-4 w-full max-w-sm rounded-2xl border border-[#2a2d3a] bg-[#121722] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <p className="mb-3 text-sm text-slate-200">
                {settings.lang === 'en'
                  ? 'Revert code and conversation to this point? Subsequent messages and code changes will be lost.'
                  : settings.lang === 'zh-TW'
                  ? '要將程式碼和對話重設到此位置嗎？後續的訊息和程式碼變更將會遺失。'
                  : '要将代码和对话重置到此位置吗？后续的消息和代码变更将会丢失。'}
              </p>
              <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
                {settings.lang === 'en'
                  ? 'Tip: any unsaved edits in open files will be overwritten when files are reloaded. Files matched by .gitignore (e.g. node_modules/, dist/, downloaded assets) and CodePapr\u2019s own .codepapr/ data are not affected.'
                  : settings.lang === 'zh-TW'
                  ? '提示：開啟的檔案中尚未儲存的修改會在檔案重載時被覆蓋。命中 .gitignore 的檔案（如 node_modules/、dist/、下載的素材）以及 CodePapr 自身的 .codepapr/ 資料不會受到影響。'
                  : '提示：已打开文件中尚未保存的修改会在文件重载时被覆盖。命中 .gitignore 的文件（如 node_modules/、dist/、下载的素材）以及 CodePapr 自身的 .codepapr/ 数据不会受影响。'}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  className="rounded-lg border border-[#2a2d3a] px-4 py-2 text-xs text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={resetInFlight}
                  onClick={() => setResetConfirmMsgId(null)}
                >
                  {settings.lang === 'en' ? 'Cancel' : '取消'}
                </button>
                <button
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={resetInFlight}
                  onClick={async () => {
                    const msgId = resetConfirmMsgId;
                    if (!msgId) return;
                    setResetInFlight(true);
                    try {
                      const result = await resetToMessage(msgId);
                      if (result.ok) {
                        const lang = settings.lang;
                        // 把被截掉的用户消息内容回填到输入框，方便用户修改后重发
                        if (result.restoredInput) {
                          setInput(result.restoredInput);
                        }
                        let text: string;
                        if (result.codeReset === 'none') {
                          text = lang === 'en'
                            ? `Conversation reset (${result.messagesRemoved} messages removed); no code changes detected.`
                            : lang === 'zh-TW'
                            ? `對話已重設（移除 ${result.messagesRemoved} 條訊息），未偵測到程式碼變更。`
                            : `对话已重置（移除 ${result.messagesRemoved} 条消息），未检测到代码变更。`;
                          setResetBanner({ kind: 'warn', text });
                        } else {
                          text = lang === 'en'
                            ? `Reset done · ${result.messagesRemoved} messages removed · ${result.filesChanged} files reverted (ignored files kept).`
                            : lang === 'zh-TW'
                            ? `重設完成 · 移除 ${result.messagesRemoved} 條訊息 · 回滾 ${result.filesChanged} 個檔案（被忽略的檔案保持不變）。`
                            : `重置完成 · 移除 ${result.messagesRemoved} 条消息 · 回滚 ${result.filesChanged} 个文件（被忽略的文件保持不变）。`;
                          setResetBanner({ kind: 'success', text });
                        }
                      } else {
                        const lang = settings.lang;
                        let text: string;
                        if (result.reason === 'no-checkpoint') {
                          text = lang === 'en'
                            ? 'No code snapshot for this message; nothing to reset.'
                            : lang === 'zh-TW'
                            ? '此訊息沒有程式碼快照，無法重設。'
                            : '此消息没有代码快照，无法重置。';
                        } else if (result.reason === 'message-not-found') {
                          text = lang === 'en' ? 'Message not found.' : lang === 'zh-TW' ? '找不到訊息。' : '找不到消息。';
                        } else {
                          const detail = result.error ? ` (${result.error})` : '';
                          text = lang === 'en'
                            ? `Code reset failed${detail}; conversation unchanged.`
                            : lang === 'zh-TW'
                            ? `程式碼重設失敗${detail}，對話未變更。`
                            : `代码重置失败${detail}，对话未变更。`;
                        }
                        setResetBanner({ kind: 'error', text });
                      }
                    } finally {
                      setResetInFlight(false);
                      setResetConfirmMsgId(null);
                    }
                  }}
                >
                  {resetInFlight
                    ? (settings.lang === 'en' ? 'Resetting…' : settings.lang === 'zh-TW' ? '重設中…' : '重置中…')
                    : (settings.lang === 'en' ? 'Reset' : settings.lang === 'zh-TW' ? '重設' : '重置')}
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
        </div>
        <ConversationRoundsIndicator
          messages={visibleMessages}
          scrollContainerRef={messageListRef}
        />
      </div>

      {/* 输入区 */}
      <div className="px-4 py-3 border-t border-[#2a2d3a] bg-[#10131b]">
        {!isConfigured && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <span>{settingsError === 'Please configure model settings' ? t.errorConfigModel : settingsError}</span>
            <button
              onClick={() => setShowSettings(true)}
              className="flex-shrink-0 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:border-amber-300 hover:text-white"
            >
              {t.toSettings}
            </button>
          </div>
        )}
          <div className="relative" ref={inputWrapperRef}>
            {slashFilter !== null && (
              <SlashCommandDropdown
                ref={slashDropdownRef}
                filter={slashFilter}
                workspacePath={workspacePath}
                onSelect={handleSlashSelect}
                onDismiss={() => setSlashFilter(null)}
              />
            )}
            {atFilter !== null && (
              <AtMentionDropdown
                ref={atDropdownRef}
                filter={atFilter}
                items={mentionItems}
                onSelect={handleAtSelect}
                onDismiss={handleAtDismiss}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.html,.css,.yaml,.yml,.toml,.xml,.csv,.log,.env,.sh,.bash,.zsh,.rb,.swift,.kt,.dart,.vue,.svelte,.graphql,.sql,.prisma,.proto,.cmake,.dockerfile,.editorconfig,.gitignore,image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {pendingFiles.map((file) => (
                  <div key={file.id} className="group flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1">
                    <svg className="w-3.5 h-3.5 flex-shrink-0 text-indigo-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
                    </svg>
                    <span className="text-xs font-medium text-indigo-200 max-w-[140px] truncate" title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removePendingFile(file.id)}
                      title={t.cancel}
                      className="flex-shrink-0 ml-0.5 rounded-full p-0.5 text-indigo-400 hover:bg-indigo-500/30 hover:text-white transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-1.5">
                {pendingImages.map((image) => (
                  <div key={image.id} className="relative group">
                    <img
                      src={image.dataUri}
                      alt="pending"
                      className="h-10 w-10 rounded-lg border border-[#2a2d3a] object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(image.id)}
                      title={t.cancel}
                      className="absolute -right-1 -top-1 h-4 w-4 rounded-full border border-[#2a2d3a] bg-[#1a1d27]
                                 text-[9px] leading-none text-slate-300 hover:text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`chat-input-box relative flex flex-col rounded-2xl border bg-[#1a1d27] px-3 pt-3 pb-2 transition-all duration-200 ${isLoading ? 'border-[#2a2d3a]' : 'border-[#2a2d3a] focus-within:border-indigo-500/60'}`}>
              <textarea
                ref={textareaRef}
                className="w-full bg-[#1a1d27] text-slate-200 placeholder-slate-600 outline-none resize-none text-[15px] leading-relaxed overflow-y-auto min-h-[44px] max-h-[80px]"
                placeholder={
                  isConfigured
                    ? t.chatPlaceholderConfigured
                    : t.chatPlaceholderUnconfigured
                }
                value={input}
                onChange={(e) => {
                  const value = e.target.value;
                  setInput(value);

                  let atDetected = false;
                  let slashDetected = false;

                  if (!isComposingRef.current) {
                    const textarea = textareaRef.current;
                    const cursorPos = textarea?.selectionStart ?? value.length;
                    const textBeforeCursor = value.slice(0, cursorPos);
                    const lastAtIndex = (() => {
                      for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
                        if (textBeforeCursor[i] === '@') {
                          if (i === 0 || (/\s|[^\w]/.test(textBeforeCursor[i - 1]) && textBeforeCursor[i - 1] !== '@')) {
                            return i;
                          }
                        }
                      }
                      return -1;
                    })();

                    if (lastAtIndex >= 0) {
                      const filterText = textBeforeCursor.slice(lastAtIndex + 1);
                      if (!filterText.includes(' ') && !filterText.includes('\n')) {
                        atTriggerIndexRef.current = lastAtIndex;
                        setAtFilter(filterText);
                        atDetected = true;
                      }
                    }

                    if (value.startsWith('/')) {
                      const afterSlash = value.slice(1);
                      if (!afterSlash.includes('\n')) {
                        slashDetected = true;
                      }
                    }
                  }

                  if (atDetected) {
                    setSlashFilter(null);
                  } else {
                    setAtFilter(null);
                    atTriggerIndexRef.current = -1;
                  }

                  if (slashDetected) {
                    setSlashFilter(value.slice(1));
                  } else if (atDetected) {
                    setSlashFilter(null);
                  } else {
                    setSlashFilter(null);
                  }
                }}
                onCompositionStart={() => { isComposingRef.current = true; }}
                onCompositionEnd={() => { isComposingRef.current = false; }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onDrop={handleDrop}
              />
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                    title="上传文件或图片"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                  </button>
                  {activeCharacter && (
                  <div className="relative flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handleTtsClick()}
                      disabled={ttsStarting || ttsServerStatus === 'starting'}
                      title={
                        ttsError
                          ? `TTS error: ${ttsError}`
                          : ttsServerStatus === 'starting' || ttsStarting
                            ? 'TTS 服务器启动中（首次加载模型可能需要 30-90 秒，请耐心等待，不要重复点击）'
                            : ttsInstalled === false
                              ? 'TTS not installed. Click to install.'
                              : ttsServerStatus === 'running'
                                ? `${showTtsLog ? '关闭' : '查看'} TTS 服务器日志 (${ttsServerLog.length} 行)`
                                : ttsServerStatus === 'error'
                                  ? `TTS server error${ttsError ? `: ${ttsError}` : ''}`
                                  : 'Click to start TTS server'
                      }
                      className={`p-1.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait ${
                        ttsServerStatus === 'running'
                          ? 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
                          : ttsServerStatus === 'error'
                            ? 'text-red-400 hover:bg-red-500/10'
                            : ttsServerStatus === 'starting' || ttsStarting
                              ? 'text-blue-400 hover:bg-blue-500/10'
                              : ttsInstalled === false
                                ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                : 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10'
                      } ${ttsIsPlaying || ttsStarting || ttsServerStatus === 'starting' ? 'animate-pulse' : ''} ${showTtsLog ? 'ring-1 ring-emerald-400/50' : ''}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                      </svg>
                    </button>
                    <TtsStatusBadge status={ttsServerStatus} />
                    {showTtsLog && (
                      <div className="absolute bottom-full left-0 mb-1 w-[52rem] max-w-[calc(100vw-3rem)] rounded-xl border border-slate-600/40 bg-slate-900/95 backdrop-blur px-3 py-2.5 text-xs text-slate-200 z-40 max-h-[420px] overflow-y-auto select-text whitespace-pre-wrap break-words font-mono shadow-xl">
                        <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-slate-700/50 sticky top-0 bg-slate-900/95 z-10">
                          <span className="text-[11px] font-semibold text-slate-400 select-none">
                            TTS 服务器日志 ({ttsServerLog.length} 行)
                          </span>
                          <div className="flex items-center gap-1.5 select-none">
                            <button
                              type="button"
                              onClick={() => ttsClearServerLog()}
                              className="text-[10px] text-slate-500 hover:text-slate-300 px-1.5 py-0.5 rounded transition-colors"
                              title="清空日志"
                            >
                              清空
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowTtsLog(false)}
                              className="text-slate-500 hover:text-slate-300 px-1"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        {ttsServerLog.length === 0 ? (
                          <div className="text-slate-600 italic text-[11px]">暂无日志</div>
                        ) : (
                          ttsServerLog.map((entry, i) => (
                            <div
                              key={i}
                              className={`text-[10px] leading-snug ${
                                entry.stream === 'stderr'
                                  ? 'text-amber-200'
                                  : entry.stream === 'system'
                                    ? 'text-cyan-200'
                                    : 'text-slate-400'
                              }`}
                            >
                              {entry.line}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {ttsError && (
                      <div className="absolute bottom-full left-0 mb-1 w-96 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 z-30 max-h-[480px] overflow-auto whitespace-pre-wrap break-words">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0 font-mono text-[11px] leading-relaxed">{ttsError}</div>
                          <button
                            type="button"
                            onClick={ttsClearError}
                            className="shrink-0 text-red-400 hover:text-red-200"
                          >
                            ×
                          </button>
                        </div>
                        {ttsServerLog.length > 0 && (
                          <details className="mt-2 border-t border-red-500/20 pt-2">
                            <summary className="cursor-pointer text-[11px] font-semibold text-red-300 hover:text-red-200">
                              查看完整 TTS 服务器日志 ({ttsServerLog.length} 行)
                            </summary>
                            <div className="mt-2 font-mono text-[10px] leading-snug">
                              {ttsServerLog.map((entry, i) => (
                                <div
                                  key={i}
                                  className={
                                    entry.stream === 'stderr'
                                      ? 'text-amber-200'
                                      : entry.stream === 'system'
                                        ? 'text-cyan-200'
                                        : 'text-slate-300'
                                  }
                                >
                                  {entry.line}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                    {!ttsError && (ttsServerStatus === 'starting' || ttsStarting) && ttsServerLog.length > 0 && (
                      <div className="absolute bottom-full left-0 mb-1 w-80 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[11px] text-blue-100 z-30 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                        <div className="text-blue-300 mb-1 font-semibold">TTS 启动日志（实时）</div>
                        {ttsServerLog.slice(-6).map((entry, i) => (
                          <div key={i} className={entry.stream === 'stderr' ? 'text-amber-200' : entry.stream === 'system' ? 'text-cyan-200' : 'text-blue-100'}>
                            {entry.line}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )}
                  <ModeSelector
                    mode={mode}
                    setMode={setMode}
                    isLoading={isLoading}
                    lang={settings.lang ?? 'zh-CN'}
                  />
                </div>
                {isLoading ? (
                  <button
                    onClick={() => cancelMessage()}
                    className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                      <rect x="2" y="2" width="12" height="12" rx="1" />
                    </svg>
                    {t.cancel}
                  </button>
                ) : (
                  <button
                    onClick={() => { void handlePrimaryAction(); }}
                    disabled={!canSubmit}
                    className={`p-1.5 rounded-lg transition-all shadow-sm flex items-center justify-center
                      ${canSubmit
                        ? 'bg-slate-200 text-slate-900 hover:bg-white'
                        : 'bg-[#2b2d35] text-slate-500'}
                      disabled:cursor-not-allowed`}
                  >
                    <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M12 19V5m-7 7l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      {/* 图片预览灯箱 */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="preview"
            className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain"
          />
        </div>
      )}

      {showInstaller && (
        <TtsInstaller
          onClose={() => {
            setShowInstaller(false);
            void ttsRefreshInstalled();
          }}
        />
      )}
    </div>
  );
}
