import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Agent, ImmutablePrefix, Session, ToolRegistry } from '../packages/@codepapr/core/src/index';
import {
  CacheValidator,
  ClaudeProvider,
  DeepSeekProvider,
  OpenAIProvider,
  RequestBuilder,
  ResponseProvider,
} from '../packages/@codepapr/api/src/index';
import type { IMessage } from '../packages/@codepapr/types/src/index';
import { runProjectDiagnostics } from '../packages/@codepapr/core/src/tool/workspace/diagnostics';

interface SmokeListEntry { path: string; name: string; isDir: boolean; bytes: number }
interface SmokeProjectDiagEntry { path: string; name: string; isDir: boolean; bytes: number }
interface SmokeReadFileResult { path: string; content: string; bytes: number; startLine: number; endLine: number; totalLines: number; truncatedByRange: boolean; truncatedByBytes: boolean }
interface SmokeCmdResult { command: string; args: string[]; status: number | null; stdout: string; stderr: string; timedOut: boolean }

async function smokeListWorkspaceFiles(workspacePath: string, relativePath?: string, maxDepth?: number): Promise<{ root: string; entries: SmokeListEntry[]; truncated: boolean }> {
  const maxD = Math.min(6, Math.max(1, maxDepth ?? 2));
  const root = relativePath ? path.join(workspacePath, relativePath) : workspacePath;
  const entries: SmokeListEntry[] = [];
  const collect = async (current: string, depth: number): Promise<boolean> => {
    if (depth > maxD) return false;
    const children = await fsp.readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    let truncated = false;
    for (const child of children) {
      if (child.name === 'node_modules' || child.name === '.git') continue;
      const childPath = path.join(current, child.name);
      const stat = await fsp.stat(childPath);
      entries.push({ path: path.relative(workspacePath, childPath).replace(/\\/g, '/'), name: child.name, isDir: child.isDirectory(), bytes: child.isDirectory() ? 0 : stat.size });
      if (child.isDirectory() && depth < maxD) truncated = (await collect(childPath, depth + 1)) || truncated;
    }
    return truncated;
  };
  const truncated = await collect(root, 0);
  return { root: relativePath || '.', entries, truncated };
}

async function smokeReadWorkspaceFile(workspacePath: string, relativePath: string, maxBytes: number): Promise<SmokeReadFileResult> {
  const [parsedPath, lineColumn] = parsePathWithAnchor(relativePath);
  // Parity with the Rust host: accept workspace-relative paths AND absolute
  // paths that resolve inside the workspace (path.join would blindly
  // concatenate an absolute second segment and miss the file).
  const resolved = path.isAbsolute(parsedPath)
    ? path.normalize(parsedPath)
    : path.join(workspacePath, parsedPath);
  const inside = path.relative(workspacePath, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`路径不在工作区内: ${relativePath}`);
  }
  const fullPath = resolved;
  const content = await fsp.readFile(fullPath, 'utf8');
  const totalLines = content.split('\n').length;
  const sliced = content.slice(0, maxBytes);
  return {
    path: path.relative(workspacePath, fullPath).replace(/\\/g, '/'),
    content: sliced,
    bytes: Math.min(Buffer.byteLength(content, 'utf8'), maxBytes),
    startLine: 1, endLine: totalLines, totalLines,
    truncatedByRange: false, truncatedByBytes: Buffer.byteLength(content, 'utf8') > maxBytes,
    ...(lineColumn ? { locationLine: lineColumn.line, locationColumn: lineColumn.column } : {}),
  };
}

function parsePathWithAnchor(input: string): [string, { line?: number; column?: number } | null] {
  const hashIdx = input.lastIndexOf('#');
  if (hashIdx > 0) {
    const frag = input.slice(hashIdx + 1);
    const m = frag.match(/^L(\d+)(?:C(\d+))?/i);
    if (m) return [input.slice(0, hashIdx), { line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined }];
  }
  const colon = input.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (colon?.[1]) return [colon[1], { line: Number(colon[2]), column: colon[3] ? Number(colon[3]) : undefined }];
  return [input, null];
}

async function smokeRunWorkspaceCommand(workspacePath: string, command: string, args: string[], timeoutSeconds: number): Promise<SmokeCmdResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workspacePath, stdio: 'pipe', env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ command, args, status: null, stdout, stderr, timedOut: true }); }, timeoutSeconds * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ command, args, status: code, stdout, stderr, timedOut: false }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ command, args, status: -1, stdout: '', stderr: err.message, timedOut: false }); });
  });
}

interface ModelProfile {
  id?: string;
  apiMode?: 'deepseek' | 'custom';
  apiFormat?: 'openai' | 'claude' | 'response';
  baseURL?: string;
  model?: string;
  apiKey?: string;
}

interface AppSettings {
  apiMode?: 'deepseek' | 'custom';
  apiFormat?: 'openai' | 'claude' | 'response';
  baseURL?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  modelProfiles?: ModelProfile[];
}

interface WorkspaceEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

interface SmokeScenario {
  name: string;
  prompt: string;
  expected: string[];
  validate?: (result: SmokeResult) => string[];
}

interface SmokeResult {
  name: string;
  passed: boolean;
  missing: string[];
  issues: string[];
  toolCalls: string[];
  toolInvocations: SmokeToolInvocation[];
  reply: string;
}

interface SmokeToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  success?: boolean;
  result?: unknown;
  error?: string;
}

interface BrowserSessionPage {
  url: string;
  title: string;
  html?: string;
  query?: string;
  result?: string;
}

interface ShellSessionHandle {
  shell: string;
  child: ReturnType<typeof spawn>;
  getOutput: () => string;
}

const WORKSPACE_PATH = path.resolve(process.cwd());
const APP_DB_PATH = path.join(os.homedir(), '.codepapr', 'codepapr.sqlite');
const SMOKE_DIR = path.join(WORKSPACE_PATH, '.CodePapr', 'smoke');
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p3ioAAAAASUVORK5CYII=',
  'base64'
);

function logSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function trimTail(value: unknown, maxLength: number = 1200): string {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(text.length - maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStoredSettings(): AppSettings {
  const raw = execFileSync('sqlite3', [APP_DB_PATH, "select value from settings where key='ui.settings';"], {
    encoding: 'utf8',
  }).trim();

  if (!raw) {
    throw new Error(`未在 ${APP_DB_PATH} 找到 CodePapr 配置`);
  }

  const parsed = JSON.parse(raw) as AppSettings;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('CodePapr 配置不是合法 JSON 对象');
  }

  // Desktop keeps per-provider sub-configs (modelProfiles) and stores keys
  // there; the top-level fields are just the normalized active view. Mirror
  // the CLI's resolve_llm_config fallback so profile-based setups also work.
  if (!String(parsed.apiKey ?? '').trim()) {
    const mode = parsed.apiMode ?? 'custom';
    const profile = (parsed.modelProfiles ?? []).find((item) => item.apiMode === mode);
    if (profile) {
      parsed.apiKey = parsed.apiKey || profile.apiKey;
      parsed.baseURL = parsed.baseURL || profile.baseURL;
      parsed.model = parsed.model || profile.model;
      parsed.apiFormat = parsed.apiFormat || profile.apiFormat;
    }
  }

  return parsed;
}

function buildProvider(settings: AppSettings) {
  const providerName = settings.apiMode === 'custom' ? settings.apiFormat ?? 'openai' : 'deepseek';
  const apiKey = String(settings.apiKey ?? '').trim();

  if (!apiKey) {
    throw new Error('CodePapr 配置中的 apiKey 为空，无法执行真实 Agent 烟测（top-level 与 modelProfiles 均无 key）');
  }

  if (providerName === 'deepseek') {
    return {
      providerName,
      provider: new DeepSeekProvider({ apiKey }),
    };
  }

  if (providerName === 'openai') {
    return {
      providerName,
      provider: new OpenAIProvider({
        apiKey,
        ...(settings.baseURL ? { baseURL: settings.baseURL.trim() } : {}),
      }),
    };
  }

  if (providerName === 'response') {
    return {
      providerName,
      provider: new ResponseProvider({
        apiKey,
        ...(settings.baseURL ? { baseURL: settings.baseURL.trim() } : {}),
      }),
    };
  }

  return {
    providerName,
    provider: new ClaudeProvider({
      apiKey,
      ...(settings.baseURL ? { baseURL: settings.baseURL.trim() } : {}),
    }),
  };
}

async function walkWorkspace(
  rootPath: string,
  currentPath: string = '',
  depth: number = 0,
  maxDepth: number = 6,
  matches: WorkspaceEntry[] = []
): Promise<WorkspaceEntry[]> {
  if (depth > maxDepth) {
    return matches;
  }

  const absolutePath = currentPath ? path.join(rootPath, currentPath) : rootPath;
  const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const relativePath = currentPath ? path.posix.join(currentPath, entry.name) : entry.name;
    const fullPath = path.join(rootPath, relativePath);
    const stat = await fsp.stat(fullPath);

    matches.push({
      path: relativePath.replace(/\\/g, '/'),
      name: entry.name,
      isDir: entry.isDirectory(),
      bytes: stat.size,
    });

    if (entry.isDirectory()) {
      await walkWorkspace(rootPath, relativePath, depth + 1, maxDepth, matches);
    }
  }

  return matches;
}

function extractHtmlTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createSmokeBrowserPage(url: string): BrowserSessionPage {
  return {
    url,
    title: 'Smoke Form',
    html:
      '<!doctype html><html><head><title>Smoke Form</title></head><body><h1>Smoke Form</h1><input id="query" value="" /><button id="go">Go</button><div id="result">idle</div></body></html>',
    query: '',
    result: 'idle',
  };
}

function serializeSmokeBrowserPage(page: BrowserSessionPage): BrowserSessionPage {
  return {
    url: page.url,
    title: page.title,
    html: `<!doctype html><html><head><title>${page.title}</title></head><body><h1>Smoke Form</h1><input id="query" value="${(page.query ?? '').replace(/"/g, '&quot;')}" /><button id="go">Go</button><div id="result">${page.result ?? 'idle'}</div></body></html>`,
    query: page.query,
    result: page.result,
  };
}

function buildSystemPrompt(basePrompt: string | undefined): string {
  const trimmed = String(basePrompt ?? '').trim();
  const smokeRules = [
    '你正在执行 CodePapr 工具烟测，必须真实调用工具，不要只输出计划。',
    '如果任务要求按文件名或路径找文件，优先使用 workspace_search_files，而不是先列整棵树。',
    '如果任务要求静态错误、类型错误、lint/typecheck/build 诊断，优先使用 workspace_project_diagnostics。',
    '如果任务要求下载远程文件到项目目录，优先使用 web_download_file。',
    '如果任务要求打开页面后点击、输入、读 DOM 或截图，优先使用 browser_open_page、browser_input_text、browser_click、browser_read_dom、browser_take_screenshot、browser_close_page，不要退化成 workspace_open_in_browser。',
    '如果任务要求持续 shell 上下文或多步终端交互，优先使用 shell_open_session、shell_send_input、shell_read_output、shell_close_session，不要用一次性的 workspace_run_command 代替。',
    '最终回答要简短说明已完成什么。',
  ].join('\n');

  return trimmed ? `${trimmed}\n\n${smokeRules}` : smokeRules;
}

function createToolRegistry(workspacePath: string): {
  registry: ToolRegistry;
  shellSessions: Map<string, ShellSessionHandle>;
} {
  const registry = new ToolRegistry();
  const shellSessions = new Map<string, ShellSessionHandle>();
  const browserState: { page: BrowserSessionPage | null } = { page: null };

  registry.register(
    {
      name: 'workspace_list_files',
      description:
        '列出项目文件和目录。适合概览目录，但如果用户明确要按文件名或路径定位目标，请优先使用 workspace_search_files。',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'number' },
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const maxDepth = Number.isFinite(args.maxDepth) ? Number(args.maxDepth) : 3;
      const entries = await walkWorkspace(workspacePath, '', 0, maxDepth);
      return { root: workspacePath, entries, truncated: false };
    }
  );

  registry.register(
    {
      name: 'workspace_search_files',
      description:
        '按文件名或路径片段搜索工作区内的文件和目录。用户明确想按名字/路径定位目标时，优先使用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').trim().toLowerCase();
      if (!query) {
        throw new Error('query 不能为空');
      }
      const entries = await walkWorkspace(workspacePath, '', 0, 6);
      const matches = entries.filter(
        (entry) => entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)
      );
      return { query, matches: matches.slice(0, 50), truncated: matches.length > 50 };
    }
  );

  registry.register(
    {
      name: 'workspace_read_file',
      description: '读取项目中的文本文件内容。优先相对路径；也接受项目内绝对路径以及 #L10 / :10:2 这类定位后缀。',
      parameters: {
        type: 'object',
        properties: {
          relativePath: { type: 'string' },
          maxBytes: { type: 'number' },
        },
        required: ['relativePath'],
      },
    },
    async (args: Record<string, unknown>) => {
      const relativePath = String(args.relativePath ?? '').trim();
      if (!relativePath) {
        throw new Error('relativePath 不能为空');
      }
      const maxBytes = Number.isFinite(args.maxBytes) ? Number(args.maxBytes) : 50_000;
      return await smokeReadWorkspaceFile(workspacePath, relativePath, maxBytes);
    }
  );

  registry.register(
    {
      name: 'workspace_run_command',
      description:
        '在项目目录里执行一次性命令。适合单步命令；若任务需要持续 shell 上下文，请改用 shell_* 工具。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutSeconds: { type: 'number' },
        },
        required: ['command'],
      },
    },
    async (args: Record<string, unknown>) => {
      const command = String(args.command ?? '').trim();
      const commandArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
      const timeoutSeconds = Number.isFinite(args.timeoutSeconds) ? Number(args.timeoutSeconds) : 20;
      return await smokeRunWorkspaceCommand(workspacePath, command, commandArgs, timeoutSeconds);
    }
  );

  registry.register(
    {
      name: 'workspace_project_diagnostics',
      description:
        '运行项目级诊断，优先执行 lint 和 typecheck；若没有独立 typecheck 脚本，则回退到 build。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      return await runProjectDiagnostics(
        {
          workspacePath,
          async listFiles(options) {
            const result = await smokeListWorkspaceFiles(workspacePath, options.relativePath, options.maxDepth);
            return { root: result.root, entries: result.entries as SmokeProjectDiagEntry[], truncated: result.truncated };
          },
          async readTextFile(options) {
            const result = await smokeReadWorkspaceFile(workspacePath, options.relativePath, options.maxBytes ?? 300_000);
            return { path: result.path, content: result.content, bytes: result.bytes };
          },
          async runCommand(options) {
            return await smokeRunWorkspaceCommand(
              workspacePath,
              options.command,
              options.args ?? [],
              options.timeoutSeconds ?? 30
            );
          },
        },
      );
    }
  );

  registry.register(
    {
      name: 'web_download_file',
      description: '把远程文件下载到项目目录。适合保存在线图片、附件、robots.txt 或示例资源。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          relativePath: { type: 'string' },
        },
        required: ['url'],
      },
    },
    async (args: Record<string, unknown>) => {
      const url = String(args.url ?? '').trim();
      if (!url) {
        throw new Error('url 不能为空');
      }
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`下载失败: HTTP ${response.status}`);
      }
      const fileName = path.basename(new URL(url).pathname) || 'download.bin';
      const relativePath = String(args.relativePath ?? '').trim() || path.posix.join('.CodePapr', 'smoke', fileName);
      const filePath = path.join(workspacePath, relativePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(filePath, buffer);
      return {
        url,
        path: relativePath,
        bytes: buffer.length,
        fileName,
        contentType: response.headers.get('content-type'),
      };
    }
  );

  registry.register(
    {
      name: 'workspace_open_in_browser',
      description: '只是在外部浏览器里打开页面，不提供点击、输入、抓 DOM 或截图能力。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
      },
    },
    async (args: Record<string, unknown>) => ({
      target: String(args.url ?? ''),
      kind: 'url',
    })
  );

  registry.register(
    {
      name: 'browser_open_page',
      description: '打开一个可交互的浏览页会话。后续若需要点击、输入、抓 DOM 或截图，应从这里开始。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['url'],
      },
    },
    async (args: Record<string, unknown>) => {
      const url = String(args.url ?? '').trim();
      if (!url) {
        throw new Error('url 不能为空');
      }

      if (url === 'https://smoke.local/form') {
        browserState.page = createSmokeBrowserPage(url);
        return {
          url,
          title: browserState.page.title,
          workspacePath,
          startedAt: Date.now(),
          active: true,
        };
      }

      const response = await fetch(url);
      const html = await response.text();
      browserState.page = {
        url,
        title: extractHtmlTitle(html) || String(args.title ?? 'Browser Page'),
        html,
      };
      return {
        url,
        title: browserState.page.title,
        workspacePath,
        startedAt: Date.now(),
        active: true,
      };
    }
  );

  registry.register(
    {
      name: 'browser_input_text',
      description: '向当前浏览页中的输入元素填入文本。默认用于表单输入，而不是普通文件写入。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['selector', 'text'],
      },
    },
    async (args: Record<string, unknown>) => {
      if (!browserState.page) {
        throw new Error('当前没有可交互浏览页');
      }
      const selector = String(args.selector ?? '').trim();
      const text = String(args.text ?? '');
      if (browserState.page.url === 'https://smoke.local/form' && selector === '#query') {
        browserState.page.query = text;
      }
      return {
        action: 'input',
        url: browserState.page.url,
        title: browserState.page.title,
        selector,
        selectorType: 'css',
      };
    }
  );

  registry.register(
    {
      name: 'browser_click',
      description: '点击当前浏览页中的元素。若任务明确要求点击按钮或链接，应优先用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
        },
        required: ['selector'],
      },
    },
    async (args: Record<string, unknown>) => {
      if (!browserState.page) {
        throw new Error('当前没有可交互浏览页');
      }
      const selector = String(args.selector ?? '').trim();
      if (browserState.page.url === 'https://smoke.local/form' && selector === '#go') {
        browserState.page.result = `submitted:${browserState.page.query ?? ''}`;
      }
      return {
        action: 'click',
        url: browserState.page.url,
        title: browserState.page.title,
        selector,
        selectorType: 'css',
      };
    }
  );

  registry.register(
    {
      name: 'browser_read_dom',
      description: '读取当前浏览页的 DOM 内容；selector 为空时可读整页，适合抓取标题、文本或 HTML。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          contentType: { type: 'string' },
        },
      },
    },
    async (args: Record<string, unknown>) => {
      if (!browserState.page) {
        throw new Error('当前没有可交互浏览页');
      }
      const selector = String(args.selector ?? '').trim();
      const contentType = String(args.contentType ?? 'text').trim() || 'text';

      if (browserState.page.url === 'https://smoke.local/form') {
        const page = serializeSmokeBrowserPage(browserState.page);
        let content = contentType === 'html' ? page.html ?? '' : stripHtml(page.html ?? '');
        if (selector === '#result') {
          content = contentType === 'html' ? `<div id="result">${browserState.page.result ?? 'idle'}</div>` : browserState.page.result ?? 'idle';
        } else if (selector === '#query') {
          content = contentType === 'html' ? `<input id="query" value="${browserState.page.query ?? ''}" />` : browserState.page.query ?? '';
        }
        return {
          url: page.url,
          title: page.title,
          selector: selector || undefined,
          selectorType: selector ? 'css' : undefined,
          contentType,
          content,
          truncated: false,
        };
      }

      const html = String(browserState.page.html ?? '');
      return {
        url: browserState.page.url,
        title: browserState.page.title,
        selector: selector || undefined,
        selectorType: selector ? 'css' : undefined,
        contentType,
        content: contentType === 'html' ? html : stripHtml(html),
        truncated: false,
      };
    }
  );

  registry.register(
    {
      name: 'browser_take_screenshot',
      description: '为当前浏览页保存截图。适合把页面当前状态保存到项目目录作为证据。',
      parameters: {
        type: 'object',
        properties: {
          relativePath: { type: 'string' },
        },
      },
    },
    async (args: Record<string, unknown>) => {
      if (!browserState.page) {
        throw new Error('当前没有可交互浏览页');
      }
      const relativePath = String(args.relativePath ?? '').trim() || path.posix.join('.CodePapr', 'smoke', 'browser.png');
      const filePath = path.join(workspacePath, relativePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, TINY_PNG);
      return {
        url: browserState.page.url,
        title: browserState.page.title,
        path: relativePath,
        bytes: TINY_PNG.length,
        format: 'png',
      };
    }
  );

  registry.register(
    {
      name: 'browser_close_page',
      description: '关闭当前可交互浏览页会话。页面级任务结束后应主动调用，避免残留会话。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      browserState.page = null;
      return { workspacePath, closed: true };
    }
  );

  registry.register(
    {
      name: 'shell_open_session',
      description: '打开一个托管 Shell 会话，适合需要持续上下文的多步命令。',
      parameters: {
        type: 'object',
        properties: {
          shell: { type: 'string' },
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const shell = String(args.shell ?? 'zsh').trim() || 'zsh';
      const sessionId = randomUUID();
      const child = spawn(shell, ['-i'], {
        cwd: workspacePath,
        env: process.env,
        stdio: 'pipe',
      });
      let output = '';
      const appendOutput = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`;
        if (output.length > 8000) {
          output = output.slice(output.length - 8000);
        }
      };
      child.stdout.on('data', appendOutput);
      child.stderr.on('data', appendOutput);
      shellSessions.set(sessionId, {
        shell,
        child,
        getOutput: () => output,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      return {
        sessionId,
        shell,
        workspacePath,
        startedAt: Date.now(),
        outputTail: trimTail(output),
      };
    }
  );

  registry.register(
    {
      name: 'shell_send_input',
      description: '向托管 Shell 会话发送一行输入。每次只做一个动作，便于随后读取输出。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          input: { type: 'string' },
        },
        required: ['sessionId', 'input'],
      },
    },
    async (args: Record<string, unknown>) => {
      const sessionId = String(args.sessionId ?? '').trim();
      const input = String(args.input ?? '');
      const session = shellSessions.get(sessionId);
      if (!session) {
        throw new Error(`找不到 shell 会话: ${sessionId}`);
      }
      session.child.stdin.write(`${input}\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      return { sessionId, accepted: true };
    }
  );

  registry.register(
    {
      name: 'shell_read_output',
      description: '读取托管 Shell 会话当前的输出尾部。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    async (args: Record<string, unknown>) => {
      const sessionId = String(args.sessionId ?? '').trim();
      const session = shellSessions.get(sessionId);
      if (!session) {
        throw new Error(`找不到 shell 会话: ${sessionId}`);
      }
      return {
        sessionId,
        outputTail: trimTail(session.getOutput()),
        active: !session.child.killed,
      };
    }
  );

  registry.register(
    {
      name: 'shell_close_session',
      description: '关闭托管 Shell 会话。任务完成后应主动回收。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    async (args: Record<string, unknown>) => {
      const sessionId = String(args.sessionId ?? '').trim();
      const session = shellSessions.get(sessionId);
      if (!session) {
        return { sessionId, closed: true };
      }
      session.child.kill('SIGTERM');
      shellSessions.delete(sessionId);
      return { sessionId, closed: true };
    }
  );

  return { registry, shellSessions };
}

function extractToolCalls(messages: ReadonlyArray<IMessage>): string[] {
  const calls: string[] = [];
  for (const message of messages) {
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        calls.push(call.name);
      }
    }
  }
  return calls;
}

/** The Agent persists tool results as JSON strings; validators want objects. */
function parseToolResult(result: unknown): unknown {
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}

function extractToolInvocations(messages: ReadonlyArray<IMessage>): SmokeToolInvocation[] {  const invocations: SmokeToolInvocation[] = [];
  const byId = new Map<string, SmokeToolInvocation>();

  for (const message of messages) {
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        const invocation: SmokeToolInvocation = {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
        invocations.push(invocation);
        byId.set(call.id, invocation);
      }
      continue;
    }

    if (message.role === 'tool' && message.toolResult) {
      const invocation = byId.get(message.toolResult.toolCallId);
      if (invocation) {
        invocation.success = message.toolResult.success;
        invocation.result = parseToolResult(message.toolResult.result);
        invocation.error = message.toolResult.error;
      }
    }
  }

  return invocations;
}

async function runScenario(settings: AppSettings, scenario: SmokeScenario): Promise<SmokeResult> {
  const { providerName, provider } = buildProvider(settings);
  const { registry, shellSessions } = createToolRegistry(WORKSPACE_PATH);
  const prefix = new ImmutablePrefix({
    systemPrompt: buildSystemPrompt(settings.systemPrompt),
    tools: registry.getAll(),
    model: String(settings.model ?? 'deepseek-v4-pro').trim(),
    parameters: {
      temperature: 0.2,
      maxTokens: 393_216,
    },
  });
  const session = new Session({
    sessionId: `smoke-${scenario.name}-${randomUUID()}`,
    prefix,
    toolRegistry: registry,
  });
  const agent = new Agent({
    session,
    provider,
    providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: 10,
  });

  try {
    const response = await agent.chat(scenario.prompt);
    const messages = session.logStore.getAllMessages();
    const toolCalls = extractToolCalls(messages);
    const toolInvocations = extractToolInvocations(messages);
    const missing = scenario.expected.filter((toolName) => !toolCalls.includes(toolName));
    const issues = scenario.validate?.({
      name: scenario.name,
      passed: false,
      missing,
      issues: [],
      toolCalls,
      toolInvocations,
      reply: trimTail(response.content, 500),
    }) ?? [];
    const passed = missing.length === 0 && issues.length === 0;

    logSection(`Smoke ${scenario.name}`);
    console.log(`Prompt: ${scenario.prompt}`);
    console.log(`Tools: ${toolCalls.join(', ') || '(none)'}`);
    console.log(`Reply: ${trimTail(response.content, 500) || '(empty)'}`);
    console.log(
      `Result: ${passed ? 'PASS' : `FAIL (${[...missing.map((item) => `missing ${item}`), ...issues].join('; ')})`}`
    );

    return {
      name: scenario.name,
      passed,
      missing,
      issues,
      toolCalls,
      toolInvocations,
      reply: trimTail(response.content, 500),
    };
  } finally {
    for (const [sessionId, shellSession] of shellSessions.entries()) {
      shellSession.child.kill('SIGTERM');
      shellSessions.delete(sessionId);
    }
  }
}

describe('agent tool smoke', () => {
  it(
    'uses the expected search, download, browser, and shell tools with a real model',
    async () => {
      if (process.env.CODEPAPR_REAL_SMOKE !== '1') {
        console.log('skip: set CODEPAPR_REAL_SMOKE=1 to run the real-model smoke test');
        return;
      }

      await fsp.mkdir(SMOKE_DIR, { recursive: true });
      const settings = readStoredSettings();
      const absoluteAnchorRelativePath = path.posix.join('.CodePapr', 'smoke', 'absolute-anchor.txt');
      const absoluteAnchorFilePath = path.join(WORKSPACE_PATH, absoluteAnchorRelativePath);
      const absoluteAnchorReference = `${absoluteAnchorFilePath}#L1`;
      const absoluteAnchorContent = 'absolute anchor smoke line 1\nabsolute anchor smoke line 2\n';
      await fsp.writeFile(absoluteAnchorFilePath, absoluteAnchorContent, 'utf8');
      const scenarios: SmokeScenario[] = [
        {
          name: 'search',
          prompt:
            '你在 Agent 模式。不要展开整棵文件树。请按文件名或路径搜索 PreviewSessionPanel.tsx 在哪里，只告诉我相对路径。',
          expected: ['workspace_search_files'],
        },
        {
          name: 'download',
          prompt:
            '你在 Agent 模式。把 https://github.com/robots.txt 下载到 .scratch/smoke/robots.txt，然后告诉我保存路径。',
          expected: ['web_download_file'],
        },
        {
          name: 'browser',
          prompt:
            '你在 Agent 模式。打开 https://smoke.local/form，在输入框 #query 输入 browser smoke，点击 #go，读取 #result 的文本，再把当前页面截图保存到 .scratch/smoke/form.png，最后关闭页面。不要用普通打开浏览器替代页面交互工具。',
          expected: [
            'browser_open_page',
            'browser_input_text',
            'browser_click',
            'browser_read_dom',
            'browser_take_screenshot',
            'browser_close_page',
          ],
        },
        {
          name: 'shell',
          prompt:
            '你在 Agent 模式。这个任务需要持续 shell 上下文。请打开一个 shell 会话，先执行 pwd，再执行 ls packages/@codepapr/ui/src/components | head -n 3，读取输出尾部确认结果，然后关闭会话。不要用一次性的 workspace_run_command 代替。',
          expected: ['shell_open_session', 'shell_send_input', 'shell_read_output', 'shell_close_session'],
        },
        {
          name: 'diagnostics-and-anchored-read',
          prompt:
            `你在 Agent 模式。先调用 workspace_project_diagnostics 获取当前项目的项目级诊断摘要。然后必须直接调用 workspace_read_file 读取这个绝对路径锚点：${absoluteAnchorReference}。不要把这个路径改写成相对路径，不要先搜索文件，也不要省略锚点。最后告诉我 diagnostics 的 overallStatus，以及该文件第一行是否等于 absolute anchor smoke line 1。`,
          expected: ['workspace_project_diagnostics', 'workspace_read_file'],
          validate: (result) => {
            const issues: string[] = [];
            const diagnosticsCall = result.toolInvocations.find(
              (invocation) => invocation.name === 'workspace_project_diagnostics'
            );
            if (!diagnosticsCall) {
              return issues;
            }
            if (diagnosticsCall.success !== true) {
              issues.push('workspace_project_diagnostics 未成功返回结果');
            } else if (!isRecord(diagnosticsCall.result) || diagnosticsCall.result.available !== true) {
              issues.push('workspace_project_diagnostics 结果缺少 available=true');
            }

            const anchoredReadCall = result.toolInvocations.find(
              (invocation) =>
                invocation.name === 'workspace_read_file' &&
                invocation.arguments.relativePath === absoluteAnchorReference
            );
            if (!anchoredReadCall) {
              issues.push('workspace_read_file 没有使用指定的绝对路径锚点参数');
              return issues;
            }
            if (anchoredReadCall.success !== true) {
              issues.push('workspace_read_file 未成功读取绝对路径锚点文件');
              return issues;
            }
            if (!isRecord(anchoredReadCall.result)) {
              issues.push('workspace_read_file 结果不是对象');
              return issues;
            }
            if (anchoredReadCall.result.path !== absoluteAnchorRelativePath) {
              issues.push('workspace_read_file 返回的相对路径不符合预期');
            }
            if (typeof anchoredReadCall.result.content !== 'string') {
              issues.push('workspace_read_file 结果缺少文本内容');
            } else if (!anchoredReadCall.result.content.startsWith('absolute anchor smoke line 1')) {
              issues.push('workspace_read_file 读取内容没有命中锚点文件首行');
            }

            return issues;
          },
        },
      ];

      const results: SmokeResult[] = [];
      for (const scenario of scenarios) {
        results.push(await runScenario(settings, scenario));
      }

      logSection('Smoke Summary');
      for (const result of results) {
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${result.toolCalls.join(', ')}${result.issues.length ? ` | ${result.issues.join('; ')}` : ''}`
        );
      }

      const failed = results.filter((result) => !result.passed);
      expect(
        failed,
        failed
          .map((result) => {
            const failures = [...result.missing.map((item) => `missing ${item}`), ...result.issues];
            return `${result.name}: ${failures.join('; ')}`;
          })
          .join('\n')
      ).toEqual([]);
    },
    600_000
  );
});
