import {
  ToolRegistry,
  WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS,
  MERGE_TOOL_DEFINITIONS,
  registerSharedMergeToolDispatchers,
  analyzeWorkspaceChangeImpact,
  buildTypeHierarchy,
  buildWorkspaceDependencySubgraph,
  detectCircularDependencies,
  detectDeadCode,
  findWorkspaceEntrypoints,
  findWorkspaceSymbolImplementations,
  generateTestSkeletons,
  getWorkspaceSmartContext,
  lookupWorkspaceSymbols,
  performWorkspaceApplyCodeAction,
  performWorkspaceFixDiagnostics,
  performWorkspaceFormatFiles,
  performWorkspaceOrganizeImports,
  performWorkspaceRename,
  requestWorkspaceSymbolDefinition,
  requestWorkspaceSymbolReferences,
  selectTestsByChangeImpact,
  suggestRefactorings,
  stripGraphNoise,
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asOptionalStringArray,
  asPatchArray,
  asSafeSkillName,
  asPositiveInteger,
  boundedNumber,
} from '@codepapr/core';
import type { EditHistory } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import {
  applyWorkspaceDiff,
  applyWorkspacePatch,
  buildWorkspaceProjectGraphSummary,
  buildWorkspaceGitDiff,
  buildWorkspaceGitHistory,
  buildWorkspaceGitStatus,
  gitCheckoutWorkspaceBranch,
  gitCommitWorkspaceChanges,
  gitResetWorkspaceToCommit,
  gitRestoreWorkspaceChanges,
  gitStageWorkspaceChanges,
  listWorkspaceFiles,
  readWorkspaceFile,
  runWorkspaceCommand,
  searchWorkspaceFiles,
  searchWorkspaceText,
  writeWorkspaceFile,
} from './workspaceFs';
import { runProjectDiagnostics } from './projectDiagnostics';
import {
  closeShellSession,
  listBackgroundProcesses,
  listShellSessions,
  openShellSession,
  readShellOutput,
  sendShellCommand,
  sendShellInput,
  startBackgroundCommand,
  stopAllBackgroundProcesses,
  stopBackgroundProcess,
} from './processManager';
import { resolveSkillFilePath } from './projectConfig';
import { createCliWorkspaceHost } from './workspaceHost';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 CodePapr/0.1';
const MAX_WEB_FETCH_BYTES = 2_000_000;
const MAX_DOWNLOAD_BYTES = 25_000_000;
const SEARCH_CACHE_TTL_MS = 300_000;
const SEARCH_RETRY_MAX = 2;

const searchCache = new Map<string, { timestamp: number; results: WebSearchEntry[] }>();

const lastRequestTime = new Map<string, number>();

async function rateLimit(domain: string, minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const last = lastRequestTime.get(domain);
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
  }
  lastRequestTime.set(domain, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit & { minIntervalMs?: number; domain?: string },
  retries = SEARCH_RETRY_MAX,
): Promise<Response> {
  const domain = options.domain ?? new URL(url).hostname;
  const minIntervalMs = options.minIntervalMs ?? 1500;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit(domain, minIntervalMs);
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status === 403) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        if (attempt < retries) {
          await sleep(delay * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      if (attempt < retries && !(err instanceof Error && err.message.startsWith('HTTP'))) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error('达到最大重试次数');
}

async function searchDuckDuckGoLite(query: string): Promise<WebSearchEntry[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
      domain: 'lite.duckduckgo.com',
      minIntervalMs: 1500,
    },
    SEARCH_RETRY_MAX,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseDuckDuckGoLiteResults(html, query);
}

async function searchDuckDuckGoHtml(query: string): Promise<WebSearchEntry[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
      domain: 'html.duckduckgo.com',
      minIntervalMs: 1500,
    },
    SEARCH_RETRY_MAX,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseDuckDuckGoHtmlResults(html);
}

interface WikipediaSearchItem {
  title: string;
  snippet: string;
  pageid: number;
  wordcount: number;
}

async function searchWikipedia(query: string, maxResults: number): Promise<WebSearchEntry[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(maxResults, 10)}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CodePapr/0.1 (research bot)',
      },
      signal: AbortSignal.timeout(10_000),
      domain: 'en.wikipedia.org',
      minIntervalMs: 500,
    },
    1,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json() as { query?: { search?: WikipediaSearchItem[] } };
  const items: WikipediaSearchItem[] = data?.query?.search ?? [];
  return items.slice(0, maxResults).map((item: WikipediaSearchItem) => ({
    title: item.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    snippet: item.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  }));
}

function isAcademicQuery(query: string): boolean {
  const lower = query.toLowerCase();
  const keywords = [
    'paper', 'research', 'study', 'journal', 'conference', 'algorithm',
    'deep learning', 'machine learning', 'neural network', 'survey', 'review',
    'arxiv', 'doi', 'citation', 'dataset', 'benchmark', 'state of the art',
    'transformer', 'attention mechanism', 'reinforcement learning',
    'natural language processing', 'nlp', 'computer vision', 'diffusion model',
    'large language model', 'llm', 'fine tuning', 'pretraining',
    '论文', '研究', '学术', '文献', '期刊', '会议', '算法',
    '深度学习', '机器学习', '神经网络', '综述', '模型', '实验', '训练',
    '推理', '预训练', '微调', '数据集', '基准', 'transformer',
    '注意力机制', '强化学习', '自然语言处理', '计算机视觉', '大语言模型', '扩散模型',
  ];
  return keywords.some((keyword) => lower.includes(keyword));
}

async function searchArxiv(query: string, maxResults: number): Promise<WebSearchEntry[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${Math.min(maxResults, 10)}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: { Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(15_000),
      domain: 'export.arxiv.org',
      minIntervalMs: 3000,
    },
    1,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.text();
  const results: WebSearchEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i;
  const summaryRegex = /<summary[^>]*>([\s\S]*?)<\/summary>/i;
  const idRegex = /<id[^>]*>([\s\S]*?)<\/id>/i;

  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(body)) !== null) {
    if (results.length >= maxResults) break;
    const entryText = entryMatch[1];

    const titleMatch = titleRegex.exec(entryText);
    const summaryMatch = summaryRegex.exec(entryText);
    const idMatch = idRegex.exec(entryText);

    const title = titleMatch?.[1]?.trim() ?? '';
    if (!title || title.startsWith('ArXiv Query:')) continue;

    const idUrl = idMatch?.[1]?.trim() ?? '';
    const urlAbs = idUrl.replace('://arxiv.org/abs/', '://arxiv.org/abs/');
    const snippet = summaryMatch?.[1]?.trim().replace(/\s+/g, ' ') ?? '';

    if (idUrl) {
      results.push({ title, url: urlAbs, snippet });
    }
  }
  return results;
}

async function searchOpenAlex(query: string, maxResults: number): Promise<WebSearchEntry[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${Math.min(maxResults, 10)}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'mailto:dev@codepapr.dev',
      },
      signal: AbortSignal.timeout(10_000),
      domain: 'api.openalex.org',
      minIntervalMs: 1000,
    },
    1,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json() as { results?: Array<{ title: string; id: string; doi?: string }> };
  const items = data?.results ?? [];
  return items.slice(0, maxResults).map((item) => {
    const doiUrl = item.doi
      ? (item.doi.startsWith('http') ? item.doi : `https://doi.org/${item.doi}`)
      : null;
    return {
      title: item.title,
      url: doiUrl ?? item.id,
      snippet: '',
    };
  });
}

async function searchSearxng(
  baseUrl: string,
  query: string,
  maxResults: number,
  categories?: string,
  timeRange?: string,
  language?: string,
  safeSearch?: number,
  engines?: string,
): Promise<WebSearchEntry[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
  });
  if (categories) {
    params.set('categories', categories);
  }
  if (timeRange) params.set('time_range', timeRange);
  if (language) params.set('language', language);
  if (safeSearch !== undefined && safeSearch !== 1 && safeSearch <= 2) params.set('safesearch', String(safeSearch));
  if (engines) params.set('engines', engines);

  const url = `${base}/search?${params.toString()}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      domain: new URL(base).hostname,
      minIntervalMs: 1000,
    },
    SEARCH_RETRY_MAX,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json() as {
    results?: Array<{ title: string; url: string; content?: string }>;
    answers?: string[];
  };
  const items = data?.results ?? [];
  return items.slice(0, maxResults).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: (item.content ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

function getCachedSearch(query: string): WebSearchEntry[] | null {
  const key = query.trim().toLowerCase();
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.timestamp < SEARCH_CACHE_TTL_MS) {
    return entry.results;
  }
  return null;
}

function setCachedSearch(query: string, results: WebSearchEntry[]): void {
  const key = query.trim().toLowerCase();
  searchCache.set(key, { timestamp: Date.now(), results });
}

function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&[a-z]+;/gi, '');
  return withoutTags.replace(/\s+/g, ' ').trim();
}

function sanitizeFileName(name: string): string {
  const forbidden = /[<>:"/\\|?*]/g;
  const sanitized = name.replace(forbidden, '_');
  const chars: string[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    const code = sanitized.charCodeAt(i);
    chars.push(code < 0x20 ? '_' : sanitized[i]);
  }
  return chars.join('');
}

function cliLanguageIdFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'c': case 'cc': case 'cpp': case 'cxx': case 'h': case 'hh': case 'hpp': case 'hxx': return 'cpp';
    case 'swift': return 'swift';
    case 'json': return 'json';
    case 'md': case 'mdx': return 'markdown';
    case 'css': return 'css';
    case 'html': case 'htm': return 'html';
    default: return 'unknown';
  }
}

interface WebSearchEntry {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoLiteResults(html: string, _query: string): WebSearchEntry[] {
  const results: WebSearchEntry[] = [];
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class="result-link"[^>]*>([^<]*)<\/a>/gi;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const raw = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    if (raw.startsWith('/l/?kh=-1&uddg=')) {
      const decoded = decodeURIComponent(raw.slice(raw.indexOf('uddg=') + 5));
      if (decoded) {
        links.push({ url: decoded, title });
      }
    } else if (raw.startsWith('http')) {
      links.push({ url: raw, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }

  for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] });
  }
  return results;
}

function parseDuckDuckGoHtmlResults(html: string): WebSearchEntry[] {
  const results: WebSearchEntry[] = [];
  const bodyRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result__body|$)/gi;
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex = /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i;

  let bodyMatch: RegExpExecArray | null;
  while ((bodyMatch = bodyRegex.exec(html)) !== null) {
    const body = bodyMatch[1];
    const linkMatch = linkRegex.exec(body);
    if (!linkMatch) continue;
    const rawHref = linkMatch[1];
    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();

    let url = rawHref;
    if (rawHref.startsWith('//')) {
      url = `https:${rawHref}`;
    }
    const parsed = new URL(url, 'https://html.duckduckgo.com');
    if (
      parsed.hostname.includes('duckduckgo.com') &&
      parsed.pathname === '/l/'
    ) {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) url = uddg;
    }

    const snippetMatch = snippetRegex.exec(body);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    if (title && url && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function toolByName(name: string): IToolDefinition {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具定义不存在: ${name}`);
  }
  return tool;
}

const EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS = WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS.filter(
  (tool) =>
    tool.name !== 'workspace_project_graph' &&
    tool.name !== 'workspace_project_diagnostics' &&
    tool.name !== 'workspace_smart_context'
);

const TOOL_DEFINITIONS: IToolDefinition[] = [
  {
    name: 'workspace_list_files',
    description: '列出当前项目文件夹内的文件树。用于理解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '相对于项目文件夹的目录路径。' },
        maxDepth: { type: 'number', description: '递归深度，默认 2，最大 6。' },
      },
    },
  },
  {
    name: 'workspace_read_file',
    description:
      '读取当前项目文件夹内的 UTF-8 文本文件。支持 startLine/endLine 范围读取，也支持 aroundLine/contextLines 窗口读取；优先传相对路径，也接受项目内绝对路径以及末尾附带的 #L10 或 :10:2 这类定位后缀。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要读取的文件路径。优先相对路径；也接受项目内绝对路径或带行号锚点的路径。',
        },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 500000，最大 20000000。超过上限返回截断内容，可用 startLine/endLine 分段续读。' },
        startLine: { type: 'number', description: '可选。起始行号，从 1 开始。' },
        endLine: { type: 'number', description: '可选。结束行号，从 1 开始且必须不小于 startLine。' },
        aroundLine: { type: 'number', description: '可选。以指定行号为中心读取一个小窗口。' },
        contextLines: { type: 'number', description: '可选。aroundLine 或路径锚点前后各保留多少行，默认 20，最大 200。' },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_write_file',
    description: '写入当前项目文件夹内的 UTF-8 文本文件。适合创建或整文件替换源码文件。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '要写入的相对文件路径。' },
        content: { type: 'string', description: '完整文件内容。' },
      },
      required: ['relativePath', 'content'],
    },
  },
  {
    name: 'workspace_run_command',
    description: '在当前项目文件夹内运行短时开发命令，例如测试、构建、lint、格式检查。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令名。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组。' },
        timeoutSeconds: { type: 'number', description: '超时时间秒数，默认 30，最大 600。' },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_search_text',
    description: '在当前项目文件夹内搜索文本内容，返回文件路径、行号、列号、上下文和匹配预览。默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本关键词，至少 2 个字符。' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写；默认按 smart-case 处理。' },
        isRegexp: { type: 'boolean', description: '是否把 query 当作正则表达式。' },
        contextLines: { type: 'number', description: '每个匹配前后额外返回多少行上下文，默认 0，最大 8。' },
        maxResults: { type: 'number', description: '最多返回多少条匹配，默认 80。' },
        maxMatchesPerFile: { type: 'number', description: '单个文件最多返回多少条匹配，默认 5，最大 20。' },
        maxBytesPerFile: { type: 'number', description: '搜索时单个文件最大读取字节数，默认 500000，最大 1000000。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'workspace_search_files',
    description: '按文件名或路径片段搜索当前项目内的文件和目录。支持正则、smart-case，并默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文件名或路径关键词。' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写；默认按 smart-case 处理。' },
        isRegexp: { type: 'boolean', description: '是否把 query 当作正则表达式。' },
        maxResults: { type: 'number', description: '最多返回多少条匹配，默认 120。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_load',
    description: '加载当前项目 .CodePapr/skills 下某个 Skill 包的 Markdown 说明。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称或嵌套 id，例如 search 或 suite/article-illustrator。' },
      },
      required: ['name'],
    },
  },
  {
    name: 'workspace_start_background_command',
    description: '在当前项目文件夹启动一个长驻后台命令，例如 dev server、watcher 或调试器。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令名。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组。' },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_list_background_processes',
    description: '列出当前项目文件夹的托管后台进程。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_stop_background_process',
    description: '停止某个托管后台进程。',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: '进程 pid。' },
      },
      required: ['pid'],
    },
  },
  {
    name: 'workspace_stop_all_background_processes',
    description: '停止当前项目文件夹的全部托管后台进程。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shell_open_session',
    description: '在当前项目文件夹启动一个托管 Shell 会话，用于多步命令和持续上下文。注意：后续输入会原样交给真实 shell 解析。',
    parameters: {
      type: 'object',
      properties: {
        shell: { type: 'string', description: '可选。指定 shell 路径。' },
      },
    },
  },
  {
    name: 'shell_list_sessions',
    description: '列出当前项目文件夹的托管 Shell 会话。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shell_read_output',
    description: '读取某个托管 Shell 会话的最近输出尾部。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Shell 会话 ID。' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'shell_send_input',
    description:
      '向某个托管 Shell 会话发送一行输入。优先传 command 和 args，让系统按当前 shell 自动完成安全转义；只有在回复交互式提示、发送单个确认字符或继续 REPL 时才传原始 input。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Shell 会话 ID。' },
        command: { type: 'string', description: '可选。要在当前 Shell 会话中执行的命令名。优先使用此字段。' },
        args: { type: 'array', items: { type: 'string' }, description: '可选。命令参数数组；和 command 配合使用。' },
        input: { type: 'string', description: '可选。要原样发送到 Shell 的输入内容，仅用于回复交互提示或继续 REPL。' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'shell_close_session',
    description: '关闭某个托管 Shell 会话。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Shell 会话 ID。' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'workspace_project_graph',
    description: '【首要工具】生成统一 ProjectGraph，同时返回目录树、代码结构骨架摘要和文件/符号关系图。这是理解项目的首选工具，应在直接读取大量文件前调用。`view=overview` 偏向轻量概览，默认 `view=full` 返回完整语义图。',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', description: '视图模式：`full` 或 `overview`。默认 `full`。' },
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
    name: 'workspace_git_status',
    description: '读取当前工作区的 Git 状态，返回分支信息以及已改动文件列表。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_git_diff',
    description: '读取当前工作区的 Git diff，返回 diff --stat 和补丁正文。',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '是否读取暂存区 diff，默认 false。' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: '只查看这些相对路径的 diff。' },
      },
    },
  },
  {
    name: 'workspace_git_history',
    description: '读取当前工作区最近的 Git 提交历史，适合为回退、审查和上下文决策选择目标提交。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少条提交记录，默认 20，最大 100。' },
      },
    },
  },
  {
    name: 'workspace_git_branch_checkout',
    description: '切换到指定 Git 分支，也可按需创建新分支，用于隔离沙盒工作流。',
    parameters: {
      type: 'object',
      properties: {
        branchName: { type: 'string', description: '目标分支名。' },
        startPoint: { type: 'string', description: '可选。创建新分支时的起点引用，如 main、HEAD 或某个提交。' },
        create: { type: 'boolean', description: '是否显式创建新分支。' },
        createIfMissing: { type: 'boolean', description: '若分支不存在则自动创建，默认 true。' },
      },
      required: ['branchName'],
    },
  },
  {
    name: 'workspace_git_stage',
    description: '暂存 Git 改动，可暂存全部或指定路径，为原子提交做准备。',
    parameters: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '是否暂存全部改动。默认当 pathspecs 为空时为 true。' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: '要暂存的相对路径列表。' },
      },
    },
  },
  {
    name: 'workspace_git_commit',
    description: '创建本地 Git 提交。可选先自动暂存全部或指定路径，再执行原子提交。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交说明。' },
        stageAll: { type: 'boolean', description: '提交前是否先暂存全部改动。' },
        pathspecs: { type: 'array', items: { type: 'string' }, description: '提交前只暂存这些相对路径。' },
        allowEmpty: { type: 'boolean', description: '是否允许空提交。' },
      },
      required: ['message'],
    },
  },
  {
    name: 'workspace_git_restore',
    description: '恢复工作区改动到干净状态。默认先创建安全 stash 快照，避免误伤。',
    parameters: {
      type: 'object',
      properties: {
        pathspecs: { type: 'array', items: { type: 'string' }, description: '只恢复这些相对路径；留空表示整个工作区。' },
        snapshot: { type: 'boolean', description: '恢复前是否先创建安全快照，默认 true。' },
        includeUntracked: { type: 'boolean', description: '创建快照时是否包含未跟踪文件，默认 true。' },
        source: { type: 'string', description: '可选。恢复内容来源，默认 HEAD。' },
      },
    },
  },
  {
    name: 'workspace_git_reset',
    description: '安全回退到指定提交。会先创建备份分支，并可选生成安全 stash 快照。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要回退到的提交、标签或其他 Git 引用。' },
        snapshot: { type: 'boolean', description: '回退前是否先创建安全快照，默认 true。' },
        includeUntracked: { type: 'boolean', description: '创建快照时是否包含未跟踪文件，默认 true。' },
        backupBranchPrefix: { type: 'string', description: '备份分支前缀，默认 codepapr/backup。' },
      },
      required: ['target'],
    },
  },
  {
    name: 'workspace_apply_patch',
    description: '对项目内现有文本文件做局部 SEARCH/REPLACE 补丁修改。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '要修改的相对文件路径。' },
        search: { type: 'string', description: '要精确匹配的原始文本块。' },
        replace: { type: 'string', description: '替换后的文本块。' },
        replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false。' },
        expectedOccurrences: { type: 'number', description: '要求 search 恰好匹配多少次。' },
      },
      required: ['relativePath', 'search', 'replace'],
    },
  },
  {
    name: 'workspace_project_diagnostics',
    description:
      '运行项目级诊断，优先执行 lint 和 typecheck；若没有独立 typecheck 脚本，则回退到 build 作为类型检查近似验证。返回每个阶段的命令、退出码和输出摘要。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_apply_diff',
    description:
      '按顺序应用多文件、多块 SEARCH/REPLACE Diff。会先读取并校验所有 patch，全部能精确匹配后才写入文件；任意一块失败则不写入。适合 YOLO 模式下一次提交多个局部修改。',
    parameters: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          description: '按应用顺序排列的 patch 列表。',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string', description: '要修改的相对文件路径。' },
              search: { type: 'string', description: '要精确匹配的原始文本块。' },
              replace: { type: 'string', description: '替换后的文本块。' },
              replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false。' },
              expectedOccurrences: { type: 'number', description: '要求 search 恰好匹配多少次。' },
            },
            required: ['relativePath', 'search', 'replace'],
          },
        },
      },
      required: ['patches'],
    },
  },
  {
    name: 'workspace_smart_context',
    description: '[推荐] 根据任务描述智能获取最相关的项目上下文，自动整合 ProjectGraph、符号查找和依赖分析的结果。',
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
  {
    name: 'web_search',
    description: '在线搜索网页，返回标题、URL 和摘要列表。来源包括 DuckDuckGo 等多个搜索引擎。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch_url',
    description: '读取指定 URL 的网页内容，自动提取正文并转为纯文本。只接受 http:// 或 https:// 开头的 URL。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取内容的完整 URL。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_download_file',
    description: '从 URL 下载文件到项目 .CodePapr/downloads/ 文件夹。relativePath 可选，省略则默认保存到 .CodePapr/downloads/ 目录。最大 25 MB。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件下载地址。' },
        relativePath: { type: 'string', description: '可选。保存的相对路径；不填则默认保存到 .CodePapr/downloads/ 目录，自动用 URL 文件名。' },
      },
      required: ['url'],
    },
  },
  ...EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS,
  ...MERGE_TOOL_DEFINITIONS,
];

export function registerCliWorkspaceTools(
  registry: ToolRegistry,
  workspacePath: string,
  editHistory?: EditHistory
): IToolDefinition[] {
  const recordEdit = editHistory ? (record: { path: string; before: string | null; after: string | null }) => editHistory.record(record) : undefined;
  const workspaceHost = createCliWorkspaceHost({
    workspacePath,
    onEdit: recordEdit,
  });
  const buildIntelligenceGraph = async (args: Record<string, unknown>) => {
    return await buildWorkspaceProjectGraphSummary(
      workspacePath,
      asOptionalString(args.relativePath),
      boundedNumber(asOptionalNumber(args.maxDepth), 4, 1, 6),
      boundedNumber(asOptionalNumber(args.maxFiles), 48, 1, 120),
      boundedNumber(asOptionalNumber(args.maxTreeEntries), 160, 20, 320),
      boundedNumber(asOptionalNumber(args.maxSymbolsPerFile), 16, 1, 40),
      boundedNumber(asOptionalNumber(args.maxEdges), 360, 1, 960),
      boundedNumber(asOptionalNumber(args.maxBytes), 120_000, 10_000, 300_000)
    );
  };
  registry.register(toolByName('workspace_list_files'), async (args) => {
    return await listWorkspaceFiles(
      workspacePath,
      asOptionalString(args.relativePath),
      boundedNumber(asOptionalNumber(args.maxDepth), 2, 1, 6)
    );
  });

  registry.register(toolByName('workspace_read_file'), async (args) => {
    return await readWorkspaceFile(
      workspacePath,
      asString(args.relativePath, 'relativePath'),
      {
        maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), 500_000, 1_000, 20_000_000),
        startLine: asOptionalNumber(args.startLine),
        endLine: asOptionalNumber(args.endLine),
        aroundLine: asOptionalNumber(args.aroundLine),
        contextLines: asOptionalNumber(args.contextLines),
      }
    );
  });

  registry.register(toolByName('workspace_write_file'), async (args) => {
    return await writeWorkspaceFile(
      workspacePath,
      asString(args.relativePath, 'relativePath'),
      asString(args.content, 'content'),
      recordEdit
    );
  });

  registry.register(toolByName('workspace_run_command'), async (args) => {
    return await runWorkspaceCommand(
      workspacePath,
      asString(args.command, 'command'),
      asOptionalStringArray(args.args),
      boundedNumber(asOptionalNumber(args.timeoutSeconds), 30, 1, 600)
    );
  });

  registry.register(toolByName('workspace_search_text'), async (args) => {
    return await searchWorkspaceText(workspacePath, asString(args.query, 'query'), {
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      contextLines: asOptionalNumber(args.contextLines),
      maxResults: asOptionalNumber(args.maxResults),
      maxMatchesPerFile: asOptionalNumber(args.maxMatchesPerFile),
      maxBytesPerFile: asOptionalNumber(args.maxBytesPerFile),
    });
  });

  registry.register(toolByName('workspace_search_files'), async (args) => {
    return await searchWorkspaceFiles(workspacePath, asString(args.query, 'query'), {
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      maxResults: asOptionalNumber(args.maxResults),
    });
  });

  registry.register(toolByName('skill_load'), async (args) => {
    const name = asSafeSkillName(args.name, 'name');
    const skillPath = await resolveSkillFilePath(workspacePath, name);
    if (!skillPath) {
      throw new Error(`Skill 不存在: ${name}`);
    }
    const relativePath = skillPath
      .slice(workspacePath.length)
      .replace(/^[/\\]+/, '')
      .replace(/\\/g, '/');
    const result = await readWorkspaceFile(workspacePath, relativePath, 500_000);
    return {
      ...result,
      skillPath: relativePath,
      skillRoot: relativePath.replace(/\/SKILL\.md$/i, '').replace(/\.md$/i, ''),
    };
  });

  registry.register(toolByName('workspace_start_background_command'), async (args) => {
    return await startBackgroundCommand(
      workspacePath,
      asString(args.command, 'command'),
      asOptionalStringArray(args.args)
    );
  });

  registry.register(toolByName('workspace_list_background_processes'), async () => {
    return await listBackgroundProcesses(workspacePath);
  });

  registry.register(toolByName('workspace_stop_background_process'), async (args) => {
    const pid = asOptionalNumber(args.pid);
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('pid 必须是正整数');
    }
    return await stopBackgroundProcess(pid);
  });

  registry.register(toolByName('workspace_stop_all_background_processes'), async () => {
    return await stopAllBackgroundProcesses(workspacePath);
  });

  registry.register(toolByName('shell_open_session'), async (args) => {
    return await openShellSession(workspacePath, asOptionalString(args.shell));
  });

  registry.register(toolByName('shell_list_sessions'), async () => {
    return await listShellSessions(workspacePath);
  });

  registry.register(toolByName('shell_read_output'), async (args) => {
    return readShellOutput(asString(args.sessionId, 'sessionId'));
  });

  registry.register(toolByName('shell_send_input'), async (args) => {
    const sessionId = asString(args.sessionId, 'sessionId');
    const input = asOptionalString(args.input);
    const command = asOptionalString(args.command);
    const commandArgs = asOptionalStringArray(args.args);

    if (command && input) {
      throw new Error('shell_send_input 不能同时传 input 和 command');
    }
    if (command) {
      return await sendShellCommand(sessionId, command, commandArgs);
    }
    if (input) {
      return await sendShellInput(sessionId, input);
    }

    throw new Error('shell_send_input 必须提供 input 或 command');
  });

  registry.register(toolByName('shell_close_session'), async (args) => {
    return await closeShellSession(asString(args.sessionId, 'sessionId'));
  });

  registry.register(toolByName('workspace_project_graph'), async (args) => {
    const view = asOptionalString(args.view) === 'overview' ? 'overview' : 'full';
    const graph = await buildWorkspaceProjectGraphSummary(
      workspacePath,
      asOptionalString(args.relativePath),
      boundedNumber(asOptionalNumber(args.maxDepth), view === 'overview' ? 2 : 3, 1, 6),
      boundedNumber(asOptionalNumber(args.maxFiles), view === 'overview' ? 24 : 32, 1, 80),
      boundedNumber(asOptionalNumber(args.maxTreeEntries), 120, 20, 240),
      boundedNumber(asOptionalNumber(args.maxSymbolsPerFile), view === 'overview' ? 8 : 12, 1, 30),
      boundedNumber(asOptionalNumber(args.maxEdges), view === 'overview' ? 120 : 240, 1, 600),
      boundedNumber(asOptionalNumber(args.maxBytes), 120_000, 10_000, 300_000)
    );
    return stripGraphNoise(graph);
  });

  registry.register(toolByName('workspace_symbol_lookup'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    return lookupWorkspaceSymbols(graph, {
      query: asOptionalString(args.query),
      relativePath: asOptionalString(args.relativePath),
      symbolKind: asOptionalString(args.symbolKind),
      language: asOptionalString(args.language),
      exported: asOptionalBoolean(args.exported, 'exported'),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_dependency_subgraph'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    const direction = asOptionalString(args.direction);
    return buildWorkspaceDependencySubgraph(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      direction:
        direction === 'incoming' || direction === 'outgoing' || direction === 'both'
          ? direction
          : undefined,
      depth: asOptionalNumber(args.depth),
      maxNodes: asOptionalNumber(args.maxNodes),
      maxEdges: asOptionalNumber(args.maxEdges),
    });
  });

  registry.register(toolByName('workspace_entrypoints'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    return findWorkspaceEntrypoints(graph, asOptionalNumber(args.limit));
  });

  registry.register(toolByName('workspace_change_impact'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    return analyzeWorkspaceChangeImpact(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
      maxNodes: asOptionalNumber(args.maxNodes),
      maxEdges: asOptionalNumber(args.maxEdges),
    });
  });

  registry.register(toolByName('workspace_symbol_implementations'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    return findWorkspaceSymbolImplementations(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      symbolName: asOptionalString(args.symbolName),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_symbol_definition'), async (args) => {
    return await requestWorkspaceSymbolDefinition(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
    });
  });

  registry.register(toolByName('workspace_symbol_references'), async (args) => {
    return await requestWorkspaceSymbolReferences(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      includeDeclaration: asOptionalBoolean(args.includeDeclaration, 'includeDeclaration'),
    });
  });

  registry.register(toolByName('workspace_rename_symbol'), async (args) => {
    return await performWorkspaceRename(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      newName: asString(args.newName, 'newName'),
    });
  });

  registry.register(toolByName('workspace_organize_imports'), async (args) => {
    return await performWorkspaceOrganizeImports(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_apply_code_action'), async (args) => {
    return await performWorkspaceApplyCodeAction(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      title: asOptionalString(args.title),
      kind: asOptionalString(args.kind),
      preferredOnly: asOptionalBoolean(args.preferredOnly, 'preferredOnly'),
    });
  });

  registry.register(toolByName('workspace_fix_diagnostics'), async (args) => {
    return await performWorkspaceFixDiagnostics(workspaceHost, {
      relativePath: asString(args.relativePath, 'relativePath'),
      languageId: 'plaintext',
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_format_files'), async (args) => {
    const relativePaths = asOptionalStringArray(args.relativePaths);
    if (!relativePaths || relativePaths.length === 0) {
      throw new Error('relativePaths 必须是非空字符串数组');
    }
    return await performWorkspaceFormatFiles(
      workspaceHost,
      relativePaths.map((relativePath) => ({
        relativePath,
        languageId: 'plaintext',
      })),
      {
        tabSize: asOptionalNumber(args.tabSize),
        insertSpaces: asOptionalBoolean(args.insertSpaces, 'insertSpaces'),
      }
    );
  });

  registry.register(toolByName('workspace_git_status'), async () => {
    return await buildWorkspaceGitStatus(workspacePath);
  });

  registry.register(toolByName('workspace_git_diff'), async (args) => {
    return await buildWorkspaceGitDiff(
      workspacePath,
      asOptionalBoolean(args.staged, 'staged') ?? false,
      asOptionalStringArray(args.pathspecs) ?? []
    );
  });

  registry.register(toolByName('workspace_git_history'), async (args) => {
    return await buildWorkspaceGitHistory(
      workspacePath,
      boundedNumber(asOptionalNumber(args.limit), 20, 1, 100)
    );
  });

  registry.register(toolByName('workspace_git_branch_checkout'), async (args) => {
    return await gitCheckoutWorkspaceBranch(workspacePath, {
      branchName: asString(args.branchName, 'branchName'),
      startPoint: asOptionalString(args.startPoint),
      create: asOptionalBoolean(args.create, 'create'),
      createIfMissing: asOptionalBoolean(args.createIfMissing, 'createIfMissing'),
    });
  });

  registry.register(toolByName('workspace_git_stage'), async (args) => {
    return await gitStageWorkspaceChanges(workspacePath, {
      all: asOptionalBoolean(args.all, 'all'),
      pathspecs: asOptionalStringArray(args.pathspecs),
    });
  });

  registry.register(toolByName('workspace_git_commit'), async (args) => {
    return await gitCommitWorkspaceChanges(workspacePath, {
      message: asString(args.message, 'message'),
      stageAll: asOptionalBoolean(args.stageAll, 'stageAll'),
      pathspecs: asOptionalStringArray(args.pathspecs),
      allowEmpty: asOptionalBoolean(args.allowEmpty, 'allowEmpty'),
    });
  });

  registry.register(toolByName('workspace_git_restore'), async (args) => {
    return await gitRestoreWorkspaceChanges(workspacePath, {
      pathspecs: asOptionalStringArray(args.pathspecs),
      snapshot: asOptionalBoolean(args.snapshot, 'snapshot'),
      includeUntracked: asOptionalBoolean(args.includeUntracked, 'includeUntracked'),
      source: asOptionalString(args.source),
    });
  });

  registry.register(toolByName('workspace_git_reset'), async (args) => {
    return await gitResetWorkspaceToCommit(workspacePath, {
      target: asString(args.target, 'target'),
      snapshot: asOptionalBoolean(args.snapshot, 'snapshot'),
      includeUntracked: asOptionalBoolean(args.includeUntracked, 'includeUntracked'),
      backupBranchPrefix: asOptionalString(args.backupBranchPrefix),
    });
  });

  registry.register(toolByName('workspace_apply_patch'), async (args) => {
    return await applyWorkspacePatch(workspacePath, {
      relativePath: asString(args.relativePath, 'relativePath'),
      search: asString(args.search, 'search'),
      replace: asString(args.replace, 'replace'),
      replaceAll: asOptionalBoolean(args.replaceAll, 'replaceAll'),
      expectedOccurrences: asOptionalNumber(args.expectedOccurrences),
    }, recordEdit);
  });

  registry.register(toolByName('workspace_apply_diff'), async (args) => {
    return await applyWorkspaceDiff(workspacePath, {
      patches: asPatchArray(args.patches).map((patch) => ({
        relativePath: asString(patch.relativePath, 'relativePath'),
        search: asString(patch.search, 'search'),
        replace: asString(patch.replace, 'replace'),
        replaceAll: asOptionalBoolean(patch.replaceAll, 'replaceAll'),
        expectedOccurrences: asOptionalNumber(patch.expectedOccurrences),
      })),
    }, recordEdit);
  });

  registry.register(toolByName('workspace_project_diagnostics'), async () => {
    return await runProjectDiagnostics(workspacePath, async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return await listWorkspaceFiles(
          workspacePath,
          typeof args?.relativePath === 'string' ? args.relativePath : undefined,
          boundedNumber(
            typeof args?.maxDepth === 'number' && Number.isFinite(args.maxDepth) ? args.maxDepth : undefined,
            2,
            1,
            6
          )
        ) as T;
      }

      if (command === 'read_text_file') {
        return await readWorkspaceFile(
          workspacePath,
          asString(args?.relativePath, 'relativePath'),
          {
            maxBytes: boundedNumber(
              typeof args?.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined,
              500_000,
              1_000,
              5_000_000
            ),
            startLine: typeof args?.startLine === 'number' && Number.isFinite(args.startLine) ? args.startLine : undefined,
            endLine: typeof args?.endLine === 'number' && Number.isFinite(args.endLine) ? args.endLine : undefined,
            aroundLine: typeof args?.aroundLine === 'number' && Number.isFinite(args.aroundLine) ? args.aroundLine : undefined,
            contextLines: typeof args?.contextLines === 'number' && Number.isFinite(args.contextLines) ? args.contextLines : undefined,
          }
        ) as T;
      }

      if (command === 'run_workspace_command') {
        return await runWorkspaceCommand(
          workspacePath,
          asString(args?.command, 'command'),
          asOptionalStringArray(args?.args),
          boundedNumber(
            typeof args?.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
              ? args.timeoutSeconds
              : undefined,
            30,
            1,
            120
          )
        ) as T;
      }

      throw new Error(`不支持的诊断命令: ${command}`);
    });
  });

  registry.register(toolByName('workspace_smart_context'), async (args) => {
    const graph = await buildIntelligenceGraph(args);
    return getWorkspaceSmartContext(graph, {
      query: asString(args.query, 'query'),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
    });
  });

  // ── Web tools ──

  registry.register(toolByName('web_search'), async (args) => {
    const query = asString(args.query, 'query');

    const cached = getCachedSearch(query);
    if (cached) {
      return { query, results: cached.slice(0, 15) };
    }

    const searxngEnabled = typeof args.searxngEnabled === 'boolean' ? args.searxngEnabled : false;
    const searxngBaseUrl = typeof args.searxngBaseUrl === 'string' ? args.searxngBaseUrl.trim() : '';
    if (searxngEnabled && searxngBaseUrl) {
      try {
        const category = typeof args.searxngCategory === 'string' ? args.searxngCategory : '';
        const timeRange = typeof args.searxngTimeRange === 'string' ? args.searxngTimeRange : undefined;
        const language = typeof args.searxngLanguage === 'string' ? args.searxngLanguage : undefined;
        const safeSearch = typeof args.searxngSafeSearch === 'number' ? args.searxngSafeSearch : 1;
        const engines = typeof args.searxngEngines === 'string' ? args.searxngEngines : undefined;
        const results = await searchSearxng(
          searxngBaseUrl,
          query,
          15,
          category,
          timeRange,
          language,
          safeSearch,
          engines,
        );
        setCachedSearch(query, results);
        return { query, results };
      } catch (err) {
        return { query, results: [], error: `SearXNG 搜索失败: ${(err as Error).message}` };
      }
    }

    const sources: WebSearchEntry[] = [];

    const addResults = (entries: WebSearchEntry[]) => {
      for (const entry of entries) {
        if (
          !sources.some(
            (existing) => existing.url === entry.url || existing.title === entry.title,
          )
        ) {
          if (entry.title && entry.url && entry.url.startsWith('http')) {
            sources.push(entry);
          }
        }
      }
    };

    const errors: string[] = [];

    try {
      const results = await searchDuckDuckGoHtml(query);
      addResults(results);
    } catch (err) {
      errors.push(`DuckDuckGo HTML: ${(err as Error).message}`);
    }

    try {
      const results = await searchDuckDuckGoLite(query);
      addResults(results);
    } catch (err) {
      errors.push(`DuckDuckGo Lite: ${(err as Error).message}`);
    }

    if (sources.length < 3) {
      try {
        const results = await searchWikipedia(query, 5);
        addResults(results);
      } catch (err) {
        errors.push(`Wikipedia: ${(err as Error).message}`);
      }
    }

    if (isAcademicQuery(query) && sources.length < 5) {
      try {
        const results = await searchArxiv(query, 5);
        addResults(results);
      } catch (err) {
        errors.push(`arXiv: ${(err as Error).message}`);
      }
      try {
        const results = await searchOpenAlex(query, 5);
        addResults(results);
      } catch (err) {
        errors.push(`OpenAlex: ${(err as Error).message}`);
      }
    }

    const finalResults = sources.slice(0, 15);
    setCachedSearch(query, finalResults);

    if (finalResults.length === 0 && errors.length > 0) {
      return { query, results: [], error: `搜索失败: ${errors.join('; ')}` };
    }

    return { query, results: finalResults };
  });

  registry.register(toolByName('web_fetch_url'), async (args) => {
    const url = asString(args.url, 'url');
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('URL 必须以 http:// 或 https:// 开头');
    }
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('application/xml')) {
      throw new Error(`不支持的内容类型: ${contentType}`);
    }
    let content = await response.text();
    const truncated = content.length > MAX_WEB_FETCH_BYTES;
    if (truncated) {
      const chars = [...content];
      content = chars.slice(0, MAX_WEB_FETCH_BYTES).join('');
    }
    const text = htmlToText(content);
    return { url, content: text, truncated, contentType };
  });

  registry.register(toolByName('web_download_file'), async (args) => {
    const url = asString(args.url, 'url');
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('URL 必须以 http:// 或 https:// 开头');
    }
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(60_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件过大 (${buffer.byteLength} bytes)，超过 ${MAX_DOWNLOAD_BYTES} bytes 上限`);
    }
    const fileName = args.relativePath
      ? asOptionalString(args.relativePath) ?? url.split('/').pop()?.split('?')[0] ?? 'download'
      : `.CodePapr/downloads/${url.split('/').pop()?.split('?')[0] ?? 'download'}`;
    const safeName = sanitizeFileName(fileName);
    const targetPath = join(workspacePath, safeName);
    const dir = join(targetPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(targetPath, new Uint8Array(buffer));
    return { url, path: safeName, bytes: buffer.byteLength, fileName: safeName };
  });

  // ── Merge tool dispatchers (shared, with CLI-specific overrides) ──

  const cliLspHandler = async (args: Record<string, unknown>) => {
    const action = asString(args.action, 'action');
    const relPath = asString(args.relativePath, 'relativePath');
    const langId = cliLanguageIdFromPath(relPath);
    const lspHost = createCliWorkspaceHost({ workspacePath });
    if (action === 'definition') return await requestWorkspaceSymbolDefinition(lspHost, { languageId: langId, relativePath: relPath, line: asOptionalNumber(args.line) ?? 1, column: asOptionalNumber(args.column) ?? 1 });
    if (action === 'references') return await requestWorkspaceSymbolReferences(lspHost, { languageId: langId, relativePath: relPath, line: asOptionalNumber(args.line) ?? 1, column: asOptionalNumber(args.column) ?? 1, includeDeclaration: asOptionalBoolean(args.includeDeclaration, 'includeDeclaration') ?? true });
    if (action === 'diagnostics') return await registry.execute('workspace_lsp_diagnostics', { relativePath: asOptionalString(args.relativePath) });
    throw new Error(`未知的 lsp action: ${action}`);
  };

  registerSharedMergeToolDispatchers({
    registry,
    terminalActionName: 'terminal',
    lspHandler: cliLspHandler,
    projectGraphHandler: async (args) => {
      const action = asString(args.action, 'action');
      const graph = await buildIntelligenceGraph(args);
      if (action === 'full' || action === 'overview') return graph;
      if (action === 'lookup') return await lookupWorkspaceSymbols(graph, { query: asString(args.query ?? args.symbolName ?? '', 'query'), relativePath: asOptionalString(args.relativePath), symbolKind: asOptionalString(args.symbolKind), language: asOptionalString(args.language), exported: asOptionalBoolean(args.exported, 'exported'), limit: asOptionalNumber(args.limit) ?? asOptionalNumber(args.maxNodes) ?? 20 });
      if (action === 'dependency') return await buildWorkspaceDependencySubgraph(graph, { symbolId: asOptionalString(args.symbolId), relativePath: asOptionalString(args.relativePath), direction: (asOptionalString(args.direction) ?? 'both') as 'incoming' | 'outgoing' | 'both', depth: asOptionalNumber(args.depth) ?? asOptionalNumber(args.maxDepth) ?? 2, maxNodes: asOptionalNumber(args.maxNodes), maxEdges: asOptionalNumber(args.maxEdges) });
      if (action === 'entrypoints') return await findWorkspaceEntrypoints(graph, asOptionalNumber(args.maxFiles) ?? 20);
      if (action === 'impact') return await analyzeWorkspaceChangeImpact(graph, { symbolId: asOptionalString(args.symbolId), relativePath: asOptionalString(args.relativePath), depth: asOptionalNumber(args.depth) ?? 3 });
      if (action === 'implementations') return await findWorkspaceSymbolImplementations(graph, { symbolId: asOptionalString(args.symbolId), relativePath: asOptionalString(args.relativePath) });
      if (action === 'smart_context') return await getWorkspaceSmartContext(graph, { query: asString(args.query, 'query'), relativePath: asOptionalString(args.relativePath), depth: asOptionalNumber(args.depth) ?? 2 });
      if (action === 'dead_code') return await detectDeadCode(graph);
      if (action === 'circular_deps') return await detectCircularDependencies(graph);
      if (action === 'type_hierarchy') return await buildTypeHierarchy(graph);
      if (action === 'suggest_refactors') return await suggestRefactorings(graph);
      if (action === 'test_impact') return await selectTestsByChangeImpact(graph, asOptionalStringArray(args.paths) ?? []);
      if (action === 'generate_tests') return await generateTestSkeletons(graph);
      throw new Error(`未知的 project_graph action: ${action}`);
    },
    browserHandler: async (args) => {
      const a = asString(args.action, 'action');
      if (a === 'open' || a === 'navigate' || a === 'reload') {
        const url = asString(args.url, 'url');
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('URL 必须以 http:// 或 https:// 开头');
        }
        return { url, title: '', active: true, note: 'CLI 模式下浏览器工具降级为系统浏览器打开' };
      }
      throw new Error(`CLI 模式不支持 browser action: ${a}。仅 open/navigate/reload 可用，click/type/read/screenshot 等交互操作需要桌面客户端。`);
    },
    openHandler: async (args) => {
      const url = asString(args.url, 'url');
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('URL 必须以 http:// 或 https:// 开头');
      }
      const { execSync } = await import('node:child_process');
      if (process.platform === 'darwin') {
        execSync(`open ${JSON.stringify(url)}`);
      } else if (process.platform === 'win32') {
        execSync(`start "" ${JSON.stringify(url)}`);
      } else {
        execSync(`xdg-open ${JSON.stringify(url)}`);
      }
      return { target: url, kind: 'browser' };
    },
    questionHandler: async () => {
      throw new Error('question 工具仅在桌面客户端 Plan 模式下可用，CLI 模式不支持交互式提问。请直接输出选项列表供用户选择。');
    },
  });

  for (const name of FINE_GRAINED_TOOL_NAMES) {
    registry.hideFromLlm(name);
  }

  return [...TOOL_DEFINITIONS];
}

const FINE_GRAINED_TOOL_NAMES = [
  'workspace_list_files', 'workspace_read_file', 'workspace_write_file',
  'workspace_search_text', 'workspace_search_files',
  'workspace_apply_patch', 'workspace_apply_diff',
  'workspace_project_graph', 'workspace_symbol_lookup', 'workspace_dependency_subgraph',
  'workspace_entrypoints', 'workspace_change_impact', 'workspace_symbol_implementations',
  'workspace_smart_context',
  'workspace_symbol_definition', 'workspace_symbol_references', 'workspace_lsp_diagnostics',
  'workspace_rename_symbol', 'workspace_organize_imports', 'workspace_apply_code_action',
  'workspace_fix_diagnostics', 'workspace_format_files',
  'workspace_git_status', 'workspace_git_diff', 'workspace_git_history',
  'workspace_git_branch_checkout', 'workspace_git_stage', 'workspace_git_commit',
  'workspace_git_restore', 'workspace_git_reset',
  'workspace_run_command', 'workspace_project_diagnostics',
  'workspace_start_background_command', 'workspace_start_preview_session',
  'workspace_list_background_processes', 'workspace_stop_background_process',
  'workspace_stop_all_background_processes',
  'shell_open_session', 'shell_list_sessions', 'shell_read_output',
  'shell_send_input', 'shell_close_session',
  'browser_open_preview', 'browser_get_preview_session', 'browser_navigate_preview',
  'browser_reload_preview', 'browser_close_preview',
  'browser_open_page', 'browser_navigate_page', 'browser_reload_page',
  'browser_click', 'browser_input_text', 'browser_read_dom',
  'browser_take_screenshot', 'browser_close_page',
  'workspace_open_in_browser',
  'web_fetch_url', 'web_download_file',
  'skill_load', 'local_time_now',
];
