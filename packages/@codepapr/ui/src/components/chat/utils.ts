import type {
  ImagePreview,
  SessionInputState,
  TextFileAttachment,
  UIMessage,
  UIToolInvocation,
} from '../../store/agentStore';
import { isExecutionHeavyTask } from '../../utils/modelRouting';

export const MAX_STREAMING_MESSAGE_CHARS = 50_000;
export const MAX_STREAMING_REASONING_CHARS = 12_000;

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_TEXT_FILE_BYTES = 1_000_000;
export const MAX_PENDING_FILES = 20;

export const DEFAULT_SESSION_INPUT: SessionInputState = { mode: 'agent', draft: '', images: [], files: [] };
export const NO_PENDING_IMAGES: ImagePreview[] = [];
export const NO_PENDING_FILES: TextFileAttachment[] = [];

export function truncateText(value: string, maxLength: number = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** 把 File 读取为 base64 图片内容（剥离 data URI 前缀）。 */
export function readFileAsImagePreview(file: File): Promise<ImagePreview | null> {
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

/**
 * 仅在用户还在输入命令名（`/` 或 `--` 后无空白、无换行）时返回过滤串。
 * 已开始写参数则返回 null，调用方应关闭 slash 下拉，让 Enter 发送。
 */
export function slashCommandNameFilter(value: string): string | null {
  let rest: string | null = null;
  if (value.startsWith('/')) {
    rest = value.slice(1);
  } else if (value.startsWith('--')) {
    rest = value.slice(2);
  }
  if (rest === null) {
    return null;
  }
  if (rest.includes('\n') || /\s/.test(rest)) {
    return null;
  }
  return rest;
}

export function buildUserPromptWithFiles(userText: string, files: TextFileAttachment[]): string {
  if (files.length === 0) return userText;
  const parts: string[] = [];
  if (userText) {
    parts.push(userText);
  }
  for (let i = 0; i < files.length; i++) {
    const sep = parts.length > 0 ? '\n\n' : '';
    const safeName = files[i].name.replace(/---/g, '\\-\\-\\-').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    parts.push(`${sep}--- ${safeName} ---\n${files[i].content}`);
  }
  return parts.join('');
}

export function getToolInvocationSummary(tool: UIToolInvocation): string {
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

export function diffLineClass(line: string): string {
  if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
    return 'bg-base text-fg-muted';
  }
  if (line.startsWith('@@')) {
    return 'bg-info-bg text-info';
  }
  if (line.startsWith('+')) {
    return 'bg-ok-bg text-ok';
  }
  if (line.startsWith('-')) {
    return 'bg-danger-bg text-danger';
  }
  return 'text-fg-muted';
}

export interface DiffInfo {
  filePath: string;
  diff: string;
  added: number;
  deleted: number;
}

export function generateUnifiedDiff(search: string, replace: string, filePath: string): string {
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

export function extractDiffInfos(tool: UIToolInvocation): DiffInfo[] {
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

export function getStreamingPreviewContent(content: string, maxChars: number): string {
  return content.length > maxChars ? content.slice(-maxChars) : content;
}

export function getProcessGroupCopy(lang: 'zh-CN' | 'zh-TW' | 'en') {
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

export function formatProcessDuration(durationMs: number, lang: 'zh-CN' | 'zh-TW' | 'en'): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (lang === 'en') {
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

export interface ExecutionProcessGroup {
  summaryMessageId: string;
  userMessageId: string;
  messages: UIMessage[];
  durationMs: number;
}

export function buildTailExecutionProcessGroup(messages: UIMessage[]): ExecutionProcessGroup | null {
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

export type Lang = 'zh-CN' | 'zh-TW' | 'en';
