import { invoke } from '@tauri-apps/api/core';
import { type GitHistorySummary } from '@codepapr/common';
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
  asOptionalPositiveInteger,
  asOptionalBoolean,
  asOptionalStringArray,
  asPatchArray,
  asSafeSkillName,
  asPositiveInteger,
  boundedNumber,
} from '@codepapr/core';
import type { EditHistory } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import type { IImageContent } from '@codepapr/types';
import { usePreviewStore, type PreviewSession } from '../store/previewStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { usePermissionStore, isAbsolutePath } from '../store/permissionStore';
import {
  applySearchReplaceDiff,
  applySearchReplacePatch,
  buildWorkspaceProjectGraph,
  enrichWorkspaceProjectGraph,
  buildGitUnavailableDiff,
  buildGitUnavailableStatus,
  buildWorkspaceProjectMap,
  filterWorkspaceInsightEntries,
  selectProjectMapFiles,
  type GitDiffSummary,
  type GitStatusSummary,
  type WorkspaceListEntry,
  type WorkspaceProjectGraphResult,
} from './workspaceToolUtils';
import { resolveProjectMapSymbolOverrides } from './workspaceProjectMapLsp';
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { resolveSkillFilePath } from '../utils/projectConfigLoader';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { createUiWorkspaceHost } from './workspaceHost';

interface ListFilesArgs {
  relativePath?: string;
  maxDepth?: number;
}

interface ListFilesResult {
  root: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
}

interface ReadFileArgs {
  relativePath: string;
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
  aroundLine?: number;
  contextLines?: number;
}

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByRange: boolean;
  truncatedByBytes: boolean;
  locationLine?: number;
  locationColumn?: number;
}

interface ReadImageFileArgs {
  relativePath: string;
  maxBytes?: number;
}

interface ReadImageFileResult {
  path: string;
  mediaType: string;
  data: string;
  bytes: number;
}

interface WriteFileArgs {
  relativePath: string;
  content: string;
}

interface WriteTextFileResult {
  path: string;
  bytes: number;
  change: WriteFileChangeSummary;
}

interface WriteFileChangeSummary {
  kind: 'created' | 'updated';
  added: number;
  deleted: number;
  beforeLines: number;
  afterLines: number;
}

interface RunCommandArgs {
  command: string;
  args?: string[];
  timeoutSeconds?: number;
}

interface _CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface BackgroundCommandArgs {
  command: string;
  args?: string[];
  previewUrl?: string;
}

interface PreviewSessionArgs {
  command: string;
  args?: string[];
  previewUrl: string;
  title?: string;
}

interface StopBackgroundProcessArgs {
  pid: number;
}

interface OpenInBrowserArgs {
  url?: string;
  relativePath?: string;
}

interface SearchTextArgs {
  query: string;
  caseSensitive?: boolean;
  isRegexp?: boolean;
  contextLines?: number;
  maxResults?: number;
  maxMatchesPerFile?: number;
  maxBytesPerFile?: number;
}

interface SearchFilesArgs {
  query: string;
  caseSensitive?: boolean;
  isRegexp?: boolean;
  maxResults?: number;
}


interface SkillLoadArgs {
  name: string;
}


interface WebSearchArgs {
  query: string;
  maxResults?: number;
  searxngCategory?: string;
  searxngTimeRange?: string;
  searxngLanguage?: string;
  searxngSafeSearch?: number;
}

interface WebFetchArgs {
  url: string;
  maxBytes?: number;
}

interface WebDownloadArgs {
  url: string;
  relativePath?: string;
}

interface BrowserOpenPreviewArgs {
  url: string;
  title?: string;
  linkedPid?: number;
}

interface BrowserNavigatePreviewArgs {
  url: string;
  title?: string;
}

interface BrowserClosePreviewArgs {
  stopLinkedProcess?: boolean;
}

interface BrowserOpenPageArgs {
  url: string;
  title?: string;
}

interface BrowserNavigatePageArgs {
  url: string;
  title?: string;
}

interface BrowserClickArgs {
  selector: string;
  selectorType?: string;
  waitForNavigation?: boolean;
  timeoutSeconds?: number;
}

interface BrowserInputArgs {
  selector: string;
  text: string;
  selectorType?: string;
  clear?: boolean;
  submit?: boolean;
  waitForNavigation?: boolean;
  timeoutSeconds?: number;
}

interface BrowserReadDomArgs {
  selector?: string;
  selectorType?: string;
  contentType?: string;
  timeoutSeconds?: number;
}

interface BrowserScreenshotArgs {
  relativePath?: string;
  selector?: string;
  selectorType?: string;
  format?: string;
  timeoutSeconds?: number;
}

interface BrowserClosePageArgs {
  stopLinkedProcess?: boolean;
}

interface ShellOpenSessionArgs {
  shell?: string;
}

interface ShellSessionIdArgs {
  sessionId: string;
}

interface ShellSendInputArgs {
  sessionId: string;
  input?: string;
  command?: string;
  args?: string[];
}

interface ProjectGraphArgs {
  view?: string;
  relativePath?: string;
  maxDepth?: number;
  maxFiles?: number;
  maxTreeEntries?: number;
  maxSymbolsPerFile?: number;
  maxEdges?: number;
  maxBytes?: number;
}

interface _GitOperationResult {
  available: boolean;
  isRepo: boolean;
  ok: boolean;
  action: 'branch_checkout' | 'stage' | 'commit' | 'restore' | 'reset';
  message: string;
  raw: string;
  branch?: string;
  changedFiles?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  backupBranch?: string;
  stashRef?: string;
  target?: string;
}

interface ApplyPatchArgs {
  relativePath: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
  expectedOccurrences?: number;
}

interface ApplyPatchResult extends WriteTextFileResult {
  replacements: number;
}

interface ApplyDiffPatchArgs extends ApplyPatchArgs {
  relativePath: string;
}

interface ApplyDiffArgs {
  patches: ApplyDiffPatchArgs[];
}

interface ApplyDiffFileResult extends WriteTextFileResult {
  patches: number;
  replacements: number;
}

interface ApplyDiffResult {
  files: ApplyDiffFileResult[];
  totalFiles: number;
  totalPatches: number;
  totalReplacements: number;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchResponse {
  query: string;
  abstract: string;
  abstractUrl: string;
  results: WebSearchResult[];
}

interface WebFetchUrlResult {
  url: string;
  status: number;
  content: string;
  truncated: boolean;
  contentType?: string | null;
}

interface LocalTimeNowResult {
  iso: string;
  local: string;
  date: string;
  time: string;
  weekday: string;
  timeZone: string;
  offsetMinutes: number;
  unixMs: number;
}

interface PathSearchMatch {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

interface SearchMatch {
  path: string;
  line: number;
  preview: string;
  column?: number;
  contextBefore?: string[];
  contextAfter?: string[];
}

interface SearchResult {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
}

interface PathSearchResult {
  query: string;
  matches: PathSearchMatch[];
  truncated: boolean;
}

interface DownloadFileResult {
  url: string;
  path: string;
  bytes: number;
  fileName: string;
  contentType?: string | null;
}

interface OpenInBrowserResult {
  target: string;
  kind: 'url' | 'file';
}

interface BackgroundCommandResult {
  command: string;
  args: string[];
  pid: number | null;
  started: boolean;
  previewUrl?: string | null;
}

export type WorkspaceMutationListener = (paths: string[]) => void;

interface BackgroundProcessEntry {
  pid: number;
  command: string;
  args: string[];
  workspacePath: string;
  startedAt: number;
  previewUrl?: string | null;
  logTail: string;
}

interface StopBackgroundProcessResult {
  pid: number;
  stopped: boolean;
}

interface StopAllBackgroundProcessesResult {
  stopped: number;
}

interface BrowserPreviewStateResult {
  session: PreviewSession | null;
}

interface BrowserClosePreviewResult {
  closed: boolean;
  stoppedLinkedProcess: boolean;
}

interface BrowserPageSessionResult {
  url: string;
  title: string;
  workspacePath: string;
  startedAt: number;
  active: boolean;
}

interface BrowserPageActionResult {
  action: string;
  url: string;
  title: string;
  selector?: string;
  selectorType?: string;
}

interface BrowserPageDomResult {
  url: string;
  title: string;
  selector?: string;
  selectorType?: string;
  contentType: string;
  content: string;
  truncated: boolean;
}

interface BrowserPageScreenshotResult {
  url: string;
  title: string;
  path: string;
  bytes: number;
  format: string;
  selector?: string;
  selectorType?: string;
}

interface BrowserPageCloseResult {
  workspacePath: string;
  closed: boolean;
}

interface ShellSessionResult {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
}

interface ShellSessionEntry {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
  active: boolean;
}

interface ShellReadOutputResult {
  sessionId: string;
  outputTail: string;
  active: boolean;
}

interface ShellSendInputResult {
  sessionId: string;
  accepted: boolean;
}

interface ShellCloseSessionResult {
  sessionId: string;
  closed: boolean;
}

function requireWorkspace(workspacePath: string): string {
  if (!workspacePath.trim()) {
    throw new Error('请先在工作台选择项目文件夹');
  }
  return workspacePath;
}

function toolByName(name: string): IToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具定义不存在: ${name}`);
  }
  return tool;
}

function syncPreviewWithPage(
  workspacePath: string,
  page: Pick<BrowserPageSessionResult | BrowserPageActionResult | BrowserPageDomResult | BrowserPageScreenshotResult, 'url' | 'title'>,
  titleOverride?: string
): PreviewSession {
  return {
    pid: null,
    url: page.url,
    title: titleOverride ?? page.title,
    workspacePath,
    openedAt: Date.now(),
  };
}

function asHttpOrHttpsUrl(value: unknown, name: string): string {
  const raw = asString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} 必须是有效 URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} 只允许 http:// 或 https:// URL`);
  }

  return parsed.toString();
}

const EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS = WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS.filter(
  (tool) =>
    tool.name !== 'workspace_project_graph' &&
    tool.name !== 'workspace_project_diagnostics'
);

const tools: IToolDefinition[] = [
  {
    name: 'workspace_list_files',
    description:
      '列出当前项目文件夹内的文件树。用于理解项目结构。路径必须是相对于项目文件夹的路径，不能使用绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '相对于项目文件夹的目录路径；省略或空字符串表示项目根目录。',
        },
        maxDepth: {
          type: 'number',
          description: '递归深度，默认 2，最大 6。',
        },
      },
    },
  },
  {
    name: 'workspace_read_file',
    description:
      '读取当前项目文件夹内的 UTF-8 文本文件。支持 startLine/endLine 范围读取，也支持 aroundLine/contextLines 窗口读取；优先传相对路径，也接受项目内绝对路径，以及末尾附带的 #L10 或 :10:2 这类定位后缀。路径不能跳出项目文件夹。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要读取的文件路径。优先相对路径；也接受项目内绝对路径或带行号锚点的路径。',
        },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数，默认 500000，最大 20000000。超出截断，可用 startLine/endLine 分块读取。',
        },
        startLine: {
          type: 'number',
          description: '可选。起始行号，从 1 开始。',
        },
        endLine: {
          type: 'number',
          description: '可选。结束行号，从 1 开始且必须不小于 startLine。',
        },
        aroundLine: {
          type: 'number',
          description: '可选。以指定行号为中心读取一个小窗口。',
        },
        contextLines: {
          type: 'number',
          description: '可选。aroundLine 或路径锚点前后各保留多少行，默认 20，最大 200。',
        },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_read_image',
    description:
      '读取项目中的图片文件（PNG、JPEG、WebP、GIF），返回 base64 编码的图片数据供多模态模型识别分析。支持 maxBytes 限制大小。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '图片文件相对路径。',
        },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数，默认 5000000（5MB）。',
        },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_write_file',
    description:
      '写入当前项目文件夹内的 UTF-8 文本文件。适合创建或替换源码文件。路径必须是相对于项目文件夹的路径，不能使用绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要写入的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
        },
        content: {
          type: 'string',
          description: '完整文件内容；该工具会替换目标文件内容。',
        },
      },
      required: ['relativePath', 'content'],
    },
  },
  {
    name: 'workspace_run_command',
    description:
      '在当前项目文件夹内运行短时开发命令或一次性脚本，例如测试、构建、lint、格式检查。默认允许绝大多数项目内开发命令；仅阻止明显的 shell 包装器、提权入口和远程登录命令。不要传 shell 字符串；必须把命令和参数分开，例如 command=npm, args=["test"]。如果目标是启动 dev server、watcher、调试器或其他长驻进程，请改用 workspace_start_background_command。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令名或项目内脚本路径。会在当前项目文件夹作为 cwd 执行；仅阻止 bash/sh/zsh/powershell/sudo/ssh 等明显危险入口。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '超时时间秒数，默认 30，最大 600。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_search_text',
    description:
      '在当前项目文件夹内搜索文本内容，返回文件路径、行号、列号、上下文和匹配预览。支持 smart-case、正则，并默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的文本关键词，至少 2 个字符。',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写；默认按 smart-case 处理。',
        },
        isRegexp: {
          type: 'boolean',
          description: '是否把 query 当作正则表达式。',
        },
        contextLines: {
          type: 'number',
          description: '每个匹配前后额外返回多少行上下文，默认 0，最大 8。',
        },
        maxResults: {
          type: 'number',
          description: '最多返回多少条匹配，默认 80。',
        },
        maxMatchesPerFile: {
          type: 'number',
          description: '单个文件最多返回多少条匹配，默认 5，最大 20。',
        },
        maxBytesPerFile: {
          type: 'number',
          description: '搜索时单个文件最大读取字节数，默认 500000，最大 1000000。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'workspace_search_files',
    description:
      '按文件名或路径片段搜索当前项目内的文件和目录，返回匹配路径、名称、类型和字节数。支持 smart-case、正则，并默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的文件名或路径关键词。',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写；默认按 smart-case 处理。',
        },
        isRegexp: {
          type: 'boolean',
          description: '是否把 query 当作正则表达式。',
        },
        maxResults: {
          type: 'number',
          description: '最多返回多少条匹配，默认 120。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'workspace_open_in_browser',
    description:
      '在系统默认浏览器中打开一个网页 URL，或打开项目内的 HTML/文本页面文件。适合打开现成网站、localhost 地址、dist/index.html 或项目中的静态页面。不要用它启动开发服务器。url 和 relativePath 至少传一个。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的 http/https URL，例如 http://localhost:5173 或 https://example.com。',
        },
        relativePath: {
          type: 'string',
          description: '项目内相对路径，例如 index.html、dist/index.html。',
        },
      },
    },
  },
  {
    name: 'skill_load',
    description:
      '加载当前项目 .CodePapr/skills 下某个 Skill 包的 Markdown 说明。适合在看到 Skill 目录摘要后，按需读取某个项目专属工作流、规范、角色或工具说明。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称或嵌套 id，例如 search 或 suite/article-illustrator。',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'web_search',
    description:
      '在线搜索公开网页，用于收集资料、查找文档或验证事实。聚合多源搜索结果；支持指定搜索分类（通用网页、图片、视频、新闻、科学论文等）、时间范围、语言过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。',
        },
        maxResults: {
          type: 'number',
          description: '返回结果数量，默认 5，最大 10。',
        },
        searxngCategory: {
          type: 'string',
          description:
            '搜索分类，留空则使用 SearXNG 默认分类（通常为通用网页）。可选：general(通用网页)、images(图片)、videos(视频)、' +
            'news(新闻)、science(科学论文)、map(地图)、it(IT技术)、music(音乐)、' +
            'files(文件)、social media(社交媒体)。用逗号组合，如 "news,images"。',
        },
        searxngTimeRange: {
          type: 'string',
          description:
            '时间范围，默认不限。可选：day(一天内)、week(一周内)、month(一月内)、year(一年内)。需要最新信息时使用。',
        },
        searxngLanguage: {
          type: 'string',
          description: '搜索语言，默认自动检测。可选：zh-CN(中文)、en(英文)、ja(日文)等。',
        },
        searxngSafeSearch: {
          type: 'number',
          description: '安全搜索等级，默认 1（与 SearXNG 内置默认一致）。0=关闭过滤，1=中等过滤，2=严格过滤。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch_url',
    description:
      '读取公开网页文本内容。适合在 web_search 找到链接后获取页面正文或文档片段。由本地后端请求，可绕过前端 CORS 限制；HTML 页面会尽量提取正文文本。支持 http 和 https URL。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要读取的 https URL。',
        },
        maxBytes: {
          type: 'number',
          description: '最大返回字符数，默认 20000，最大 100000。',
        },
      },
      required: ['url'],
    },
  },
  {
name: 'web_download_file',
      description:
        '把一个 http/https 网络文件下载到项目 .CodePapr/downloads/ 文件夹，适合下载在线图片、附件、示例文件或网页资源。relativePath 可选；省略时默认保存到 .CodePapr/downloads/ 目录并自动使用 URL 文件名。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要下载的 http/https URL。',
        },
        relativePath: {
          type: 'string',
          description: '可选。下载到项目内的相对路径，例如 assets/logo.png。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'workspace_start_background_command',
    description:
      '在当前项目文件夹内后台启动长驻命令，例如 npm run dev、vite dev、next dev、cargo tauri dev、文件 watcher 或调试器。调用后立即返回，不等待命令退出；后台日志会被托管，若提供 previewUrl，工作台会显示可打开的预览地址。同一工作区内相同 command + args 若已运行，会直接返回现有 PID，避免重复启动累积。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令名或项目内脚本路径。会在当前项目文件夹作为 cwd 启动。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        previewUrl: {
          type: 'string',
          description: '可选。若该后台服务对应可打开的网页地址，可传入 http://localhost:3000 这类 URL，供工作台展示预览入口。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_start_preview_session',
    description:
      '在当前项目文件夹内启动一个需要长驻 server 的网页预览会话，并把指定 previewUrl 打开到应用内预览页。关闭内置预览页时，会自动停止关联后台进程。适合 npm run dev 后在应用内预览 http://localhost:3000。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '用于启动预览服务的命令名或项目内脚本路径。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        previewUrl: {
          type: 'string',
          description: '应用内预览要加载的 http/https URL，通常是 localhost 地址。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题；默认使用 command + args。',
        },
      },
      required: ['command', 'previewUrl'],
    },
  },
  {
    name: 'workspace_list_background_processes',
    description:
      '列出当前项目文件夹内由 CodePapr 托管的后台进程，例如之前启动的 dev server、watcher 或调试器。适合在关闭、清理或排查重复启动前先查看当前列表。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_stop_background_process',
    description:
      '停止当前项目文件夹内某个已托管的后台进程。通常先通过 workspace_list_background_processes 取得 PID，再调用本工具关闭指定进程。',
    parameters: {
      type: 'object',
      properties: {
        pid: {
          type: 'number',
          description: '要停止的后台进程 PID。',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'workspace_stop_all_background_processes',
    description:
      '停止当前项目文件夹内所有由 CodePapr 托管的后台进程。适合清空重复启动的 dev server、watcher 或调试器。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_open_preview',
    description:
      '在应用内预览页打开一个 URL。可选 linkedPid，用于把预览页和某个后台进程绑定；关闭预览时可顺带停掉这个 PID。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要在应用内预览中打开的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题。',
        },
        linkedPid: {
          type: 'number',
          description: '可选。与预览绑定的后台进程 PID。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_get_preview_session',
    description:
      '读取当前应用内预览页状态，包括 URL、标题和是否绑定后台进程。适合在导航或关闭前先确认当前浏览会话。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_navigate_preview',
    description:
      '把当前应用内预览页导航到新的 URL，并保留当前绑定的后台进程 PID。若当前没有预览，则会新建一个。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '新的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。新的预览标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_reload_preview',
    description:
      '重新加载当前应用内预览页。适合在 dev server 热更新异常、样式未刷新或页面卡住时手动刷新。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_close_preview',
    description:
      '关闭当前应用内预览页。默认会一并停止它绑定的后台进程；如果 stopLinkedProcess=false，则只关闭预览不停止服务。',
    parameters: {
      type: 'object',
      properties: {
        stopLinkedProcess: {
          type: 'boolean',
          description: '是否同时停止已绑定的后台进程，默认 true。',
        },
      },
    },
  },
  {
    name: 'shell_open_session',
    description:
      '在当前项目文件夹启动一个托管 Shell 会话，用于多步命令、原始 shell 字符串或需要持续上下文的终端操作。注意：后续输入会原样交给真实 shell 解析。',
    parameters: {
      type: 'object',
      properties: {
        shell: {
          type: 'string',
          description: '可选。指定 shell 路径；省略时使用系统默认 shell。',
        },
      },
    },
  },
  {
    name: 'shell_list_sessions',
    description:
      '列出当前项目文件夹的托管 Shell 会话，返回会话 ID、shell、启动时间和最近输出尾部。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shell_read_output',
    description:
      '读取某个托管 Shell 会话的最近输出尾部，适合在发送命令后检查执行结果。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
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
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
        command: {
          type: 'string',
          description: '可选。要在当前 Shell 会话中执行的命令名。优先使用此字段。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。命令参数数组；和 command 配合使用。',
        },
        input: {
          type: 'string',
          description: '可选。要原样发送到 Shell 的输入内容，仅用于回复交互提示或继续 REPL。若末尾没有换行，系统会自动补一行结束。',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'shell_close_session',
    description:
      '关闭某个托管 Shell 会话。适合在终端任务完成后回收会话，避免后台残留。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_open_page',
    description:
      '打开一个可交互的浏览页会话，并把同一 URL 同步到应用内预览。适合后续需要点击、输入、抓 DOM 或截图的网页任务。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_navigate_page',
    description:
      '把当前可交互浏览页导航到新的 URL，并同步刷新应用内预览。若当前没有浏览页会话，会自动创建一个。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '新的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。新的预览标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_reload_page',
    description:
      '刷新当前可交互浏览页，并同步刷新应用内预览。适合页面脚本、热更新或重定向后手动重载。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_click',
    description:
      '在当前可交互浏览页点击一个元素。默认使用 CSS 选择器，也支持 xpath。若点击后页面会跳转，可设置 waitForNavigation=true。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '要点击的元素选择器。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        waitForNavigation: {
          type: 'boolean',
          description: '可选。点击后是否等待页面跳转完成。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现或跳转的超时秒数，默认 10，最大 30。',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_input_text',
    description:
      '在当前可交互浏览页中向某个输入元素填入文本。默认会先清空原值；若 submit=true，会在输入后按 Enter。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '输入元素选择器。',
        },
        text: {
          type: 'string',
          description: '要输入的文本。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        clear: {
          type: 'boolean',
          description: '可选。输入前是否清空元素现有值，默认 true。',
        },
        submit: {
          type: 'boolean',
          description: '可选。输入后是否按 Enter。',
        },
        waitForNavigation: {
          type: 'boolean',
          description: '可选。提交后是否等待页面跳转完成。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现或跳转的超时秒数，默认 10，最大 30。',
        },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_read_dom',
    description:
      '抓取当前可交互浏览页的 DOM 内容。selector 为空时读取整页；contentType 可选 html 或 text。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '可选。只读取某个元素；省略时读取整页。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        contentType: {
          type: 'string',
          description: '可选。html 或 text，默认 html。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现的超时秒数，默认 10，最大 30。',
        },
      },
    },
  },
  {
    name: 'browser_take_screenshot',
    description:
      '对当前可交互浏览页截图，可截整页或某个元素。默认把图片保存到项目内 .CodePapr/browser 目录。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '可选。项目内保存路径。',
        },
        selector: {
          type: 'string',
          description: '可选。若提供，只截该元素。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        format: {
          type: 'string',
          description: '可选。png 或 jpeg，默认 png。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现的超时秒数，默认 10，最大 30。',
        },
      },
    },
  },
  {
    name: 'browser_close_page',
    description:
      '关闭当前可交互浏览页会话，并关闭应用内预览。若 stopLinkedProcess=true，则会一并停止当前预览绑定的后台进程。',
    parameters: {
      type: 'object',
      properties: {
        stopLinkedProcess: {
          type: 'boolean',
          description: '是否同时停止当前预览绑定的后台进程，默认 false。',
        },
      },
    },
  },
  {
    name: 'workspace_project_graph',
    description:
      '生成统一 ProjectGraph。它同时返回目录树、代码结构骨架摘要和文件/符号关系图，是默认的项目理解工具；`view=overview` 偏向轻量概览，默认 `view=full` 返回完整语义图。桌面端会优先复用真实 LSP documentSymbol 结果。',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: '视图模式：`full` 或 `overview`。默认 `full`。full 默认深度10/文件数120/符号24/关系边960；overview 默认深度6/文件数48/符号12/关系边240。',
        },
        relativePath: {
          type: 'string',
          description: '可选。只为某个子目录生成 ProjectGraph。',
        },
        maxDepth: {
          type: 'number',
          description: '目录树深度，默认 full=10、overview=6。0 表示不限制。',
        },
        maxFiles: {
          type: 'number',
          description: '抽取源码文件数量，默认 120。0 表示不限制。',
        },
        maxTreeEntries: {
          type: 'number',
          description: '目录树最多展示的节点数，默认 320。0 表示不限制。',
        },
        maxSymbolsPerFile: {
          type: 'number',
          description: '每个文件最多返回多少条符号，默认 24。0 表示不限制。',
        },
        maxEdges: {
          type: 'number',
          description: '最多返回多少条图关系，默认 960。0 表示不限制。',
        },
        maxBytes: {
          type: 'number',
          description: '单个源码文件最多读取多少字节用于建图，默认 180000。0 表示不限制。',
        },
      },
    },
  },
  {
    name: 'workspace_git_status',
    description:
      '读取当前工作区的 Git 状态，返回分支信息以及已暂存、未暂存、未跟踪或重命名的文件列表。适合把最近改动作为高优先级上下文。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_git_diff',
    description:
      '读取当前工作区的 Git diff，返回 diff --stat 和精简补丁正文。可选 staged=true 查看暂存区，也可传 pathspecs 只看部分路径。',
    parameters: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: '是否读取暂存区 diff，默认 false。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。只查看这些相对路径的 diff。',
        },
      },
    },
  },
  {
    name: 'workspace_git_history',
    description: '读取当前工作区最近的 Git 提交历史，适合选择审查、回退或恢复目标。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '最多返回多少条提交记录，默认 20，最大 100。',
        },
      },
    },
  },
  {
    name: 'workspace_git_branch_checkout',
    description: '切换到指定 Git 分支，也可按需创建新分支，用于隔离沙盒式改动。',
    parameters: {
      type: 'object',
      properties: {
        branchName: {
          type: 'string',
          description: '目标分支名。',
        },
        startPoint: {
          type: 'string',
          description: '可选。创建分支时的起点引用，如 main、HEAD 或某个提交。',
        },
        create: {
          type: 'boolean',
          description: '是否显式创建新分支。',
        },
        createIfMissing: {
          type: 'boolean',
          description: '分支不存在时是否自动创建，默认 true。',
        },
      },
      required: ['branchName'],
    },
  },
  {
    name: 'workspace_git_stage',
    description: '暂存 Git 改动，可暂存全部或指定路径，为原子提交准备内容。',
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: '是否暂存全部改动。默认当 pathspecs 为空时为 true。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '要暂存的相对路径列表。',
        },
      },
    },
  },
  {
    name: 'workspace_git_commit',
    description: '创建本地 Git 提交。可选先自动暂存全部或指定路径，再执行原子提交。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '提交说明。',
        },
        stageAll: {
          type: 'boolean',
          description: '提交前是否先暂存全部改动。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '提交前只暂存这些相对路径。',
        },
        allowEmpty: {
          type: 'boolean',
          description: '是否允许空提交。',
        },
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
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '只恢复这些相对路径；留空表示整个工作区。',
        },
        snapshot: {
          type: 'boolean',
          description: '恢复前是否先创建安全快照，默认 true。',
        },
        includeUntracked: {
          type: 'boolean',
          description: '创建快照时是否包含未跟踪文件，默认 true。',
        },
        source: {
          type: 'string',
          description: '可选。恢复内容来源，默认 HEAD。',
        },
      },
    },
  },
  {
    name: 'workspace_git_reset',
    description: '安全回退到指定提交。会先创建备份引用和自动安全快照，可通过 workspace_restore_undo 撤销。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要回退到的提交 SHA 或其他 Git 引用。',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'workspace_restore_undo',
    description: '撤销上一次 workspace_git_reset 或恢复操作，通过备份引用恢复。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_apply_patch',
    description:
      '对项目内现有文本文件做局部 SEARCH/REPLACE 补丁修改。适合只改一个代码块，不必整文件重写。若 search 匹配多处，默认报错，除非设置 replaceAll=true。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要修改的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
        },
        search: {
          type: 'string',
          description: '要精确匹配的原始文本块。',
        },
        replace: {
          type: 'string',
          description: '替换后的文本块。',
        },
        replaceAll: {
          type: 'boolean',
          description: '是否替换全部匹配，默认 false。',
        },
        expectedOccurrences: {
          type: 'number',
          description: '可选。要求 search 恰好匹配多少次，否则报错。',
        },
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
    name: 'local_time_now',
    description:
      '读取当前设备的本地时间、日期和时区。适合股票、基金、汇率、市场开闭盘、财报日期、活动截止时间等时效问题。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'question',
    description:
      '向用户提出明确的问题以收集需求、确认决策或消除歧义。仅在 Plan 模式下使用，当需求不明确或需要用户做关键选择时调用。如果不需要用户选择，不传 options 则用户可自由输入文本回答。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，清晰描述需要确认的内容。',
        },
        header: {
          type: 'string',
          description: '简短标题（最多30字符），用于在UI中标识此问题。',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: '选项的显示文字（1-5个词，简洁）。',
              },
              description: {
                type: 'string',
                description: '选项的详细说明。',
              },
            },
            required: ['label'],
          },
          description: '可选的预定义选项。如果提供，用户只能从这些选项中选择（单选或多选）；如果不提供，用户可自由输入文本回答。',
        },
        multiple: {
          type: 'boolean',
          description: '是否允许多选（仅在提供options时有效）。默认 false 为单选。',
        },
      },
      required: ['question', 'header'],
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
              relativePath: {
                type: 'string',
                description: '要修改的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
              },
              search: {
                type: 'string',
                description: '要精确匹配的原始文本块。',
              },
              replace: {
                type: 'string',
                description: '替换后的文本块。',
              },
              replaceAll: {
                type: 'boolean',
                description: '是否替换全部匹配，默认 false。',
              },
              expectedOccurrences: {
                type: 'number',
                description: '可选。要求 search 恰好匹配多少次，否则报错。',
              },
            },
            required: ['relativePath', 'search', 'replace'],
          },
        },
      },
      required: ['patches'],
    },
  },
  {
    name: 'app_render',
    description:
      '生成一个交互式 HTML 应用到应用面板。用于数据分析可视化、仪表盘、关系图等。生成的文件写入 .CodePapr/apps/<appId>/ 目录，并自动注册到应用管理面板。相同 appId 会覆盖已有应用。\n\n📦 Papr SDK 可用：生成的 HTML 可通过 window.papr 调用 CodePapr 能力：\n  • papr.db.get(key) / papr.db.set(key, value) — 键值持久化存储\n  • papr.agent.run({agent, task}) — 调用 AI Agent\n  • papr.http.get(url) / papr.http.post(url, body) — HTTP 请求\n  • papr.fs.readFile(path) / papr.fs.writeFile(path, content) — 文件读写（限定 app data 目录）\n  • papr.app.info() — 获取应用信息\n⚠️ 使用前必须在 permissions 参数中声明对应权限（storage:read, storage:write, http:get, http:post, fs:read, fs:write, agent:run:<name>）。',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: '应用唯一标识符，kebab-case（仅小写字母、数字、连字符）。相同 appId 会覆盖已有应用。例如：history-explorer、stock-dashboard。',
        },
        title: {
          type: 'string',
          description: '应用标题，显示在应用标签上。',
        },
        html: {
          type: 'string',
          description: '前端 HTML 文档内容（index.html）。可以内联 CSS/JS，可以引用 CDN（D3、ECharts、Mermaid、MapLibre、Leaflet、Three.js）。可使用 window.papr SDK 调用 CodePapr 能力（需声明 permissions）。',
        },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。应用需要的权限列表。可选值：storage:read, storage:write, http:get, http:post, fs:read, fs:write, llm:chat, agent:run:<agentName>。例如 ["storage:read", "storage:write", "agent:run:assistant"]。',
        },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Agent 名称（如 assistant）' },
              model: { type: 'string', description: '模型：main（默认，使用用户主模型）、fast（快速模型）、mentor（Mentor 模型）、或具体模型 ID' },
              systemPrompt: { type: 'string', description: '系统提示词' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Agent 可用的工具白名单。可选：read, grep, list, graph, web_search, web_fetch, write, edit, exec。高危工具（write/edit/exec）需 permissions 中声明 workspace:write/exec。',
              },
              maxToolRounds: {
                type: 'number',
                description: '最大工具调用轮数，默认 20，上限 50',
              },
            },
            required: ['name'],
          },
          description: '可选。应用可调用的 Agent 定义列表。每个 Agent 可在 HTML 中通过 papr.agent.run({agent: name, task}) 调用。',
        },
        icon: {
          type: 'string',
          description: '可选。应用图标，支持 emoji 或 1-2 个字符。例如：📊、📈、🗺️。',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string', description: '相对于 .CodePapr/apps/<appId>/ 的文件路径。例如：server.js、package.json。' },
              content: { type: 'string', description: '文件完整内容。' },
            },
            required: ['relativePath', 'content'],
          },
          description: '可选。额外的后端文件列表（server.js、package.json 等）。每个文件包含 relativePath 和 content。',
        },
        command: {
          type: 'string',
          description: '可选。后端启动命令名。例如：node。如果提供，应用将具有后端服务，用户可点击"运行"启动。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。后端启动命令参数。例如：["server.js"]。仅在提供 command 时有效。',
        },
        port: {
          type: 'number',
          description: '可选。后端服务端口号。例如：3456。如果提供 command，必须同时提供 port。',
        },
      },
      required: ['appId', 'title', 'html'],
    },
  },
  ...EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS,
  ...MERGE_TOOL_DEFINITIONS,
];

export interface RegisterWorkspaceToolsOptions {
  disableWebSearchTools?: boolean;
  multimodalEnabled?: boolean;
}

export function registerWorkspaceTools(
  registry: ToolRegistry,
  workspacePath: string,
  editHistory?: EditHistory,
  onWorkspaceMutated?: WorkspaceMutationListener,
  options: RegisterWorkspaceToolsOptions = {}
): void {
  const workspace = () => requireWorkspace(workspacePath);
  const notifyWorkspaceMutation = (paths: string[]): void => {
    if (paths.length === 0) {
      return;
    }
    onWorkspaceMutated?.(paths);
  };

  const readBeforeContent = async (relativePath: string): Promise<string | null> => {
    if (!editHistory) {
      return null;
    }
    try {
      const previous = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath,
        maxBytes: 20_000_000,
      });
      return previous.content;
    } catch {
      return null;
    }
  };

  const getWorkspaceHost = () =>
    createUiWorkspaceHost({
      workspacePath: workspace(),
      editHistory,
      notifyWorkspaceMutation,
    });

  const resolveLanguageId = (relativePath: string): string => {
    const languageId = lspLanguageFromPath(relativePath);
    if (!languageId) {
      throw new Error(`当前文件暂不支持语言服务操作: ${relativePath}`);
    }
    return languageId;
  };

  const ensureExternalPathAllowed = async (relativePath: string | undefined, operation: 'read' | 'list'): Promise<void> => {
    if (!relativePath || !isAbsolutePath(relativePath)) return;
    if (isWithinWorkspace(relativePath, workspace())) return;
    const { isExternalPathAllowed, requestExternalAccess } = usePermissionStore.getState();
    if (isExternalPathAllowed(relativePath)) return;
    const result = await requestExternalAccess(relativePath, operation);
    if (!result.approved) {
      throw new Error('用户拒绝访问外部路径');
    }
  };

  function isWithinWorkspace(absPath: string, ws: string): boolean {
    if (!absPath.startsWith(ws)) return false;
    if (absPath.length === ws.length) return true;
    return absPath[ws.length] === '/';
  }

  const buildIntelligenceProjectGraph = async (args: Record<string, unknown>): Promise<WorkspaceProjectGraphResult> => {
    const view = asOptionalString(args.view) === 'overview' ? 'overview' : 'full';
    const parsed: ProjectGraphArgs = {
      view,
      relativePath: asOptionalString(args.relativePath),
      maxDepth: boundedNumber(asOptionalNumber(args.maxDepth), 16, 1, Number.MAX_SAFE_INTEGER),
      maxFiles: boundedNumber(asOptionalNumber(args.maxFiles), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxTreeEntries: boundedNumber(asOptionalNumber(args.maxTreeEntries), 320, 20, Number.MAX_SAFE_INTEGER),
      maxSymbolsPerFile: boundedNumber(asOptionalNumber(args.maxSymbolsPerFile), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxEdges: boundedNumber(asOptionalNumber(args.maxEdges), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), Number.MAX_SAFE_INTEGER, 10_000, Number.MAX_SAFE_INTEGER),
    };

    const listResult = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxDepth: parsed.maxDepth,
    });

    const insightEntries = filterWorkspaceInsightEntries(listResult.entries);
    const selectedFiles = selectProjectMapFiles(insightEntries, parsed.maxFiles);
    const fileReads = await Promise.all(
      selectedFiles.map(async (entry) => {
        try {
          const file = await invoke<ReadFileResult>('read_text_file', {
            workspacePath: workspace(),
            relativePath: entry.path,
            maxBytes: parsed.maxBytes,
          });
          return [entry.path, { content: file.content, bytes: file.bytes }] as const;
        } catch {
          return null;
        }
      })
    );

    const fileContents = Object.fromEntries(
      fileReads.filter(
        (
          entry
        ): entry is readonly [string, { content: string; bytes: number }] => entry !== null
      )
    );
    const maxSymbolsPerFile = parsed.maxSymbolsPerFile ?? 24;

    const symbolOverrides = await resolveProjectMapSymbolOverrides(
      workspace(),
      fileContents,
      maxSymbolsPerFile
    );

    let projectMap: Awaited<ReturnType<typeof buildWorkspaceProjectMap>>;
    try {
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents,
        symbolOverrides,
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    } catch (mapError) {
      console.warn('buildWorkspaceProjectMap failed, falling back to tree-only map:', mapError);
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents: {},
        symbolOverrides: {},
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    }

    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: insightEntries,
      fileContents,
      symbolOverrides,
      maxEdges: parsed.maxEdges,
    });

    try {
      return await enrichWorkspaceProjectGraph(graph, fileContents, 3);
    } catch {
      return graph;
    }
  };

  const readGitStatus = async (): Promise<GitStatusSummary> => {
    try {
      const result = await invoke<import('../utils/snapshot').GitStatusResult>('git_status', {
        workspacePath: workspace(),
      });
      return {
        available: result.available,
        isRepo: result.isRepo,
        files: result.entries.map((e) => ({
          path: e.path,
          originalPath: e.oldPath ?? undefined,
          indexStatus: e.indexStatus,
          worktreeStatus: e.worktreeStatus,
        })),
        raw: '',
        ...(result.branch ? { branch: result.branch } : {}),
        ...(result.headShort ? { headShort: result.headShort } : {}),
        ...(result.message ? { message: result.message } : {}),
      } satisfies GitStatusSummary;
    } catch (error) {
      return buildGitUnavailableStatus((error as Error).message) satisfies GitStatusSummary;
    }
  };

  registry.register(toolByName('workspace_list_files'), async (args: Record<string, unknown>) => {
    const parsed: ListFilesArgs = {
      relativePath: asOptionalString(args.relativePath),
      maxDepth: asOptionalNumber(args.maxDepth),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'list');
    return await invoke('list_workspace_files', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxDepth: parsed.maxDepth,
    });
  });

  registry.register(toolByName('workspace_read_file'), async (args: Record<string, unknown>) => {
    const parsed: ReadFileArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      maxBytes: asOptionalNumber(args.maxBytes),
      startLine: asOptionalNumber(args.startLine),
      endLine: asOptionalNumber(args.endLine),
      aroundLine: asOptionalNumber(args.aroundLine),
      contextLines: asOptionalNumber(args.contextLines),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'read');
    return await invoke('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: parsed.maxBytes,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      aroundLine: parsed.aroundLine,
      contextLines: parsed.contextLines,
    });
  });

  if (options.multimodalEnabled) {
    registry.register(toolByName('workspace_read_image'), async (args: Record<string, unknown>) => {
      const parsed: ReadImageFileArgs = {
        relativePath: asString(args.relativePath, 'relativePath'),
        maxBytes: asOptionalNumber(args.maxBytes),
      };
      await ensureExternalPathAllowed(parsed.relativePath, 'read');
      const result = await invoke<ReadImageFileResult>('read_image_file', {
        workspacePath: workspace(),
        relativePath: parsed.relativePath,
        maxBytes: parsed.maxBytes,
      });
      const images: IImageContent[] = [{
        mediaType: result.mediaType,
        data: result.data,
      }];
      return {
        path: result.path,
        mediaType: result.mediaType,
        bytes: result.bytes,
        __images: images,
      };
    });
  }

  registry.register(toolByName('workspace_write_file'), async (args: Record<string, unknown>) => {
    const parsed: WriteFileArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      content: asString(args.content, 'content'),
    };
    const before = await readBeforeContent(parsed.relativePath);
    const result = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      content: parsed.content,
    });
    editHistory?.record({
      path: result.path,
      before,
      after: parsed.content,
    });
    notifyWorkspaceMutation([result.path]);
    return result;
  });

  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const rawAppId = asString(args.appId, 'appId');
    const title = asString(args.title, 'title');
    const html = asString(args.html, 'html');
    const icon = asOptionalString(args.icon);
    const command = asOptionalString(args.command);
    const cmdArgs = asOptionalStringArray(args.args);
    const port = asOptionalNumber(args.port);
    const rawFiles = args.files as Array<{ relativePath: string; content: string }> | undefined;
    const permissions = (args.permissions as string[] | undefined) ?? [];
    const agents = (args.agents as Array<{name: string; model?: string; systemPrompt?: string; tools?: string[]; maxToolRounds?: number}> | undefined) ?? [];

    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(
        `appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`
      );
    }

    if (html.length > 2_000_000) {
      throw new Error(`HTML 内容超过 2MB 上限（当前 ${html.length} 字节），请精简后重试。`);
    }

    if (command && (typeof port !== 'number' || port < 1024 || port > 65535)) {
      throw new Error(`提供 command 时必须同时提供有效 port（1024-65535）`);
    }

    const manifest = {
      spec: 'papr/0.1',
      name: title,
      version: '0.1.0',
      entry: 'index.html',
      permissions,
      agents: agents.map((a) => ({
        name: a.name,
        model: a.model ?? 'main',
        systemPrompt: a.systemPrompt,
        ...(a.tools ? { tools: a.tools } : {}),
        ...(a.maxToolRounds ? { maxToolRounds: a.maxToolRounds } : {}),
      })),
      ...(command ? { command } : {}),
      ...(cmdArgs && cmdArgs.length > 0 ? { args: cmdArgs } : {}),
      ...(port ? { port } : {}),
    };

    const manifestPath = `.CodePapr/apps/${rawAppId}/manifest.json`;
    await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: manifestPath,
      content: JSON.stringify(manifest, null, 2),
    });

    const indexRelativePath = `.CodePapr/apps/${rawAppId}/index.html`;

    await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: indexRelativePath,
      content: html,
    });

    let totalBytes = html.length;

    if (rawFiles && rawFiles.length > 0) {
      for (const file of rawFiles) {
        if (!file.relativePath || typeof file.relativePath !== 'string') {
          throw new Error('files 每个元素必须包含 relativePath');
        }
        if (!file.content || typeof file.content !== 'string') {
          throw new Error('files 每个元素必须包含 content');
        }
        const filePath = `.CodePapr/apps/${rawAppId}/${file.relativePath}`;
        if (filePath.includes('..')) {
          throw new Error(`文件路径不能包含 .. : ${file.relativePath}`);
        }
        const writeResult = await invoke<WriteTextFileResult>('write_text_file', {
          workspacePath: workspace(),
          relativePath: filePath,
          content: file.content,
        });
        totalBytes += writeResult.bytes;
      }
    }

    await invoke('register_app_workspace', {
      appId: rawAppId,
      workspacePath: workspace(),
    });

    useAppRuntimeStore.getState().mountApp({
      appId: rawAppId,
      title,
      icon,
      html,
      filePath: indexRelativePath,
      command: command ?? undefined,
      args: cmdArgs ?? undefined,
      port: port ?? undefined,
      manifestJson: JSON.stringify(manifest),
    });

    const hasBackend = !!command;
    return {
      appId: rawAppId,
      title,
      icon: icon ?? null,
      filePath: indexRelativePath,
      bytes: totalBytes,
      mounted: true,
      hasBackend,
      ...(hasBackend ? { command, args: cmdArgs, port, hint: '应用已生成并注册后端服务。用户点击"运行"启动后端后，可在管理面板点"打开"查看。后端进程运行在工作区目录下，可直接读写项目文件（如数据库）。' } : { hint: '应用已渲染到应用管理面板。用户可点击"打开"查看。如需修改应用，用相同 appId 再次调用 app_render 即可覆盖更新。' }),
    };
  });

  registry.register(toolByName('workspace_run_command'), async (args: Record<string, unknown>) => {
    const parsed: RunCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };
    return await invoke('run_workspace_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      timeoutSeconds: parsed.timeoutSeconds,
    });
  });

  registry.register(toolByName('workspace_search_text'), async (args: Record<string, unknown>) => {
    const parsed: SearchTextArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      contextLines: asOptionalNumber(args.contextLines),
      maxResults: asOptionalNumber(args.maxResults),
      maxMatchesPerFile: asOptionalNumber(args.maxMatchesPerFile),
      maxBytesPerFile: asOptionalNumber(args.maxBytesPerFile),
    };
    return await invoke<SearchResult>('search_workspace_text', {
      workspacePath: workspace(),
      query: parsed.query,
      caseSensitive: parsed.caseSensitive,
      isRegexp: parsed.isRegexp,
      contextLines: parsed.contextLines,
      maxResults: parsed.maxResults,
      maxMatchesPerFile: parsed.maxMatchesPerFile,
      maxBytesPerFile: parsed.maxBytesPerFile,
    });
  });

  registry.register(toolByName('workspace_search_files'), async (args: Record<string, unknown>) => {
    const parsed: SearchFilesArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      maxResults: asOptionalNumber(args.maxResults),
    };
    return await invoke<PathSearchResult>('search_workspace_paths', {
      workspacePath: workspace(),
      query: parsed.query,
      caseSensitive: parsed.caseSensitive,
      isRegexp: parsed.isRegexp,
      maxResults: parsed.maxResults,
    });
  });

  registry.register(toolByName('workspace_open_in_browser'), async (args: Record<string, unknown>) => {
    const parsed: OpenInBrowserArgs = {
      url: asOptionalString(args.url),
      relativePath: asOptionalString(args.relativePath),
    };
    if (!parsed.url && !parsed.relativePath) {
      throw new Error('url 和 relativePath 至少需要提供一个');
    }

    return await invoke<OpenInBrowserResult>('open_browser_target', {
      workspacePath: workspace(),
      url: parsed.url,
      relativePath: parsed.relativePath,
    });
  });

  registry.register(toolByName('skill_load'), async (args: Record<string, unknown>) => {
    const parsed: SkillLoadArgs = {
      name: asSafeSkillName(args.name, 'name'),
    };
    const relativePath = await resolveSkillFilePath(invoke, workspace(), parsed.name);
    if (!relativePath) {
      throw new Error(`Skill 不存在: ${parsed.name}`);
    }
    const result = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath,
      maxBytes: 500_000,
    });
    return {
      ...result,
      skillPath: relativePath,
      skillRoot: relativePath.replace(/\/SKILL\.md$/i, '').replace(/\.md$/i, ''),
    };
  });

  if (!options.disableWebSearchTools) {
    registry.register(toolByName('web_search'), async (args: Record<string, unknown>) => {
      const storeSettings = useAgentStore.getState().settings;
      const parsed: WebSearchArgs = {
        query: asString(args.query, 'query'),
        maxResults: boundedNumber(asOptionalNumber(args.maxResults), 5, 1, 10),
        searxngCategory: asOptionalString(args.searxngCategory),
        searxngTimeRange: asOptionalString(args.searxngTimeRange),
        searxngLanguage: asOptionalString(args.searxngLanguage),
        searxngSafeSearch: asOptionalNumber(args.searxngSafeSearch),
      };

      const category =
        parsed.searxngCategory || storeSettings.searxngCategories || '';
      const timeRange =
        parsed.searxngTimeRange || (storeSettings.searxngTimeRange || undefined);
      const language =
        parsed.searxngLanguage || (storeSettings.searxngLanguage || undefined);
      const safeSearch =
        parsed.searxngSafeSearch ?? storeSettings.searxngSafeSearch ?? 1;

      return await invoke<WebSearchResponse>('search_web', {
        query: parsed.query,
        maxResults: parsed.maxResults,
        searxngEnabled: storeSettings.searxngEnabled || false,
        searxngBaseUrl: storeSettings.searxngBaseUrl || '',
        searxngCategories: category,
        searxngTimeRange: timeRange || '',
        searxngLanguage: language || '',
        searxngSafeSearch: safeSearch,
        searxngEngines: storeSettings.searxngEngines || '',
      });
    });

    registry.register(toolByName('web_fetch_url'), async (args: Record<string, unknown>) => {
      const parsed: WebFetchArgs = {
        url: asHttpOrHttpsUrl(args.url, 'url'),
        maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), 20_000, 1_000, 100_000),
      };

      return await invoke<WebFetchUrlResult>('fetch_web_url', {
        url: parsed.url,
        maxBytes: parsed.maxBytes,
      });
    });

    registry.register(toolByName('web_download_file'), async (args: Record<string, unknown>) => {
      const parsed: WebDownloadArgs = {
        url: asHttpOrHttpsUrl(args.url, 'url'),
        relativePath: asOptionalString(args.relativePath),
      };

      const result = await invoke<DownloadFileResult>('download_web_file', {
        workspacePath: workspace(),
        url: parsed.url,
        relativePath: parsed.relativePath,
      });
      notifyWorkspaceMutation([result.path]);
      return result;
    });
  }

  registry.register(toolByName('workspace_start_background_command'), async (args: Record<string, unknown>) => {
    const parsed: BackgroundCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asOptionalString(args.previewUrl),
    };

    return await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
    });
  });

  registry.register(toolByName('workspace_start_preview_session'), async (args: Record<string, unknown>) => {
    const parsed: PreviewSessionArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asHttpOrHttpsUrl(args.previewUrl, 'previewUrl'),
      title: asOptionalString(args.title),
    };

    const result = await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
    });

    const previewUrl = result.previewUrl ?? parsed.previewUrl;
    if (typeof result.pid === 'number' && previewUrl) {
      // 不再自动弹出预览覆盖层；用户可从后台进程面板手动打开
    }

    return result;
  });

  registry.register(toolByName('workspace_list_background_processes'), async () => {
    return await invoke<BackgroundProcessEntry[]>('list_background_processes', {
      workspacePath: workspace(),
    });
  });

  registry.register(toolByName('workspace_stop_background_process'), async (args: Record<string, unknown>) => {
    const parsed: StopBackgroundProcessArgs = {
      pid: asPositiveInteger(args.pid, 'pid'),
    };

    return await invoke<StopBackgroundProcessResult>('stop_background_process', {
      pid: parsed.pid,
    });
  });

  registry.register(toolByName('workspace_stop_all_background_processes'), async () => {
    return await invoke<StopAllBackgroundProcessesResult>('stop_all_background_processes', {
      workspacePath: workspace(),
    });
  });

  registry.register(toolByName('browser_open_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserOpenPreviewArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
      linkedPid: asOptionalPositiveInteger(args.linkedPid, 'linkedPid'),
    };

    const session: PreviewSession = {
      pid: parsed.linkedPid ?? null,
      url: parsed.url,
      title: parsed.title ?? parsed.url,
      workspacePath: workspace(),
      openedAt: Date.now(),
    };
    return { session } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_get_preview_session'), async () => {
    const session = usePreviewStore.getState().activePreviewSession;
    return {
      session: session && session.workspacePath === workspace() ? session : null,
    } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_navigate_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserNavigatePreviewArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };
    const current = usePreviewStore.getState().activePreviewSession;
    const session: PreviewSession = {
      pid: current?.workspacePath === workspace() ? current.pid : null,
      url: parsed.url,
      title: parsed.title ?? current?.title ?? parsed.url,
      workspacePath: workspace(),
      openedAt: Date.now(),
    };
    return { session } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_reload_preview'), async () => {
    const current = usePreviewStore.getState().activePreviewSession;
    if (current && current.workspacePath === workspace()) {
      usePreviewStore.getState().reloadPreviewSession();
      return {
        session: usePreviewStore.getState().activePreviewSession,
      } satisfies BrowserPreviewStateResult;
    }

    return { session: null } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_close_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClosePreviewArgs = {
      stopLinkedProcess: asOptionalBoolean(args.stopLinkedProcess, 'stopLinkedProcess'),
    };
    const session = usePreviewStore.getState().activePreviewSession;
    if (!session || session.workspacePath !== workspace()) {
      return {
        closed: false,
        stoppedLinkedProcess: false,
      } satisfies BrowserClosePreviewResult;
    }

    let stoppedLinkedProcess = false;
    if ((parsed.stopLinkedProcess ?? true) && typeof session.pid === 'number') {
      const result = await invoke<StopBackgroundProcessResult>('stop_background_process', {
        pid: session.pid,
      });
      stoppedLinkedProcess = result.stopped;
    }

    await invoke<BrowserPageCloseResult>('close_browser_page', {
      workspacePath: workspace(),
    });

    usePreviewStore.getState().closePreviewSession();
    return {
      closed: true,
      stoppedLinkedProcess,
    } satisfies BrowserClosePreviewResult;
  });

  registry.register(toolByName('shell_open_session'), async (args: Record<string, unknown>) => {
    const parsed: ShellOpenSessionArgs = {
      shell: asOptionalString(args.shell),
    };

    return await invoke<ShellSessionResult>('open_shell_session', {
      workspacePath: workspace(),
      shell: parsed.shell,
    });
  });

  registry.register(toolByName('shell_list_sessions'), async () => {
    return await invoke<ShellSessionEntry[]>('list_shell_sessions', {
      workspacePath: workspace(),
    });
  });

  registry.register(toolByName('shell_read_output'), async (args: Record<string, unknown>) => {
    const parsed: ShellSessionIdArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
    };

    return await invoke<ShellReadOutputResult>('read_shell_output', {
      sessionId: parsed.sessionId,
    });
  });

  registry.register(toolByName('shell_send_input'), async (args: Record<string, unknown>) => {
    const parsed: ShellSendInputArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
      input: asOptionalString(args.input),
      command: asOptionalString(args.command),
      args: asOptionalStringArray(args.args),
    };

    if (parsed.command && parsed.input) {
      throw new Error('shell_send_input 不能同时传 input 和 command');
    }
    if (parsed.command) {
      return await invoke<ShellSendInputResult>('send_shell_command', {
        sessionId: parsed.sessionId,
        command: parsed.command,
        args: parsed.args,
      });
    }
    if (!parsed.input) {
      throw new Error('shell_send_input 必须提供 input 或 command');
    }

    return await invoke<ShellSendInputResult>('send_shell_input', {
      sessionId: parsed.sessionId,
      input: parsed.input,
    });
  });

  registry.register(toolByName('shell_close_session'), async (args: Record<string, unknown>) => {
    const parsed: ShellSessionIdArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
    };

    return await invoke<ShellCloseSessionResult>('close_shell_session', {
      sessionId: parsed.sessionId,
    });
  });

  registry.register(toolByName('browser_open_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserOpenPageArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };

    const result = await invoke<BrowserPageSessionResult>('open_browser_page', {
      workspacePath: workspace(),
      url: parsed.url,
    });
    const session = syncPreviewWithPage(workspace(), result, parsed.title ?? result.title);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_navigate_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserNavigatePageArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };

    const result = await invoke<BrowserPageSessionResult>('navigate_browser_page', {
      workspacePath: workspace(),
      url: parsed.url,
    });
    const session = syncPreviewWithPage(workspace(), result, parsed.title ?? result.title);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_reload_page'), async () => {
    const result = await invoke<BrowserPageSessionResult>('reload_browser_page', {
      workspacePath: workspace(),
    });
    const session = syncPreviewWithPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_click'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClickArgs = {
      selector: asString(args.selector, 'selector'),
      selectorType: asOptionalString(args.selectorType),
      waitForNavigation: asOptionalBoolean(args.waitForNavigation, 'waitForNavigation'),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageActionResult>('click_browser_page_element', {
      workspacePath: workspace(),
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      waitForNavigation: parsed.waitForNavigation,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    const session = syncPreviewWithPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_input_text'), async (args: Record<string, unknown>) => {
    const parsed: BrowserInputArgs = {
      selector: asString(args.selector, 'selector'),
      text: asString(args.text, 'text'),
      selectorType: asOptionalString(args.selectorType),
      clear: asOptionalBoolean(args.clear, 'clear'),
      submit: asOptionalBoolean(args.submit, 'submit'),
      waitForNavigation: asOptionalBoolean(args.waitForNavigation, 'waitForNavigation'),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageActionResult>('input_browser_page_text', {
      workspacePath: workspace(),
      selector: parsed.selector,
      text: parsed.text,
      selectorType: parsed.selectorType,
      clear: parsed.clear,
      submit: parsed.submit,
      waitForNavigation: parsed.waitForNavigation,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    const session = syncPreviewWithPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_read_dom'), async (args: Record<string, unknown>) => {
    const parsed: BrowserReadDomArgs = {
      selector: asOptionalString(args.selector),
      selectorType: asOptionalString(args.selectorType),
      contentType: asOptionalString(args.contentType),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    return await invoke<BrowserPageDomResult>('read_browser_page_dom', {
      workspacePath: workspace(),
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      contentType: parsed.contentType,
      timeoutSeconds: parsed.timeoutSeconds,
    });
  });

  registry.register(toolByName('browser_take_screenshot'), async (args: Record<string, unknown>) => {
    const parsed: BrowserScreenshotArgs = {
      relativePath: asOptionalString(args.relativePath),
      selector: asOptionalString(args.selector),
      selectorType: asOptionalString(args.selectorType),
      format: asOptionalString(args.format),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageScreenshotResult>('screenshot_browser_page', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      format: parsed.format,
      timeoutSeconds: parsed.timeoutSeconds,
    });

    return result;
  });

  registry.register(toolByName('browser_close_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClosePageArgs = {
      stopLinkedProcess: asOptionalBoolean(args.stopLinkedProcess, 'stopLinkedProcess'),
    };
    const current = usePreviewStore.getState().activePreviewSession;
    let stoppedLinkedProcess = false;

    if (
      (parsed.stopLinkedProcess ?? false) &&
      current?.workspacePath === workspace() &&
      typeof current.pid === 'number'
    ) {
      const result = await invoke<StopBackgroundProcessResult>('stop_background_process', {
        pid: current.pid,
      });
      stoppedLinkedProcess = result.stopped;
    }

    const result = await invoke<BrowserPageCloseResult>('close_browser_page', {
      workspacePath: workspace(),
    });
    if (current?.workspacePath === workspace()) {
      usePreviewStore.getState().closePreviewSession();
    }

    return {
      ...result,
      stoppedLinkedProcess,
    };
  });

  registry.register(toolByName('workspace_project_graph'), async (args: Record<string, unknown>) => {
    const view = asOptionalString(args.view) === 'overview' ? 'overview' : 'full';
    const parsed: ProjectGraphArgs = {
      view,
      relativePath: asOptionalString(args.relativePath),
      maxDepth: boundedNumber(asOptionalNumber(args.maxDepth), 16, 1, Number.MAX_SAFE_INTEGER),
      maxFiles: boundedNumber(asOptionalNumber(args.maxFiles), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxTreeEntries: boundedNumber(asOptionalNumber(args.maxTreeEntries), 320, 20, Number.MAX_SAFE_INTEGER),
      maxSymbolsPerFile: boundedNumber(asOptionalNumber(args.maxSymbolsPerFile), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxEdges: boundedNumber(asOptionalNumber(args.maxEdges), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), Number.MAX_SAFE_INTEGER, 10_000, Number.MAX_SAFE_INTEGER),
    };

    const listResult = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxDepth: parsed.maxDepth,
    });

    const insightEntries = filterWorkspaceInsightEntries(listResult.entries);
    const selectedFiles = selectProjectMapFiles(insightEntries, parsed.maxFiles);
    const fileReads = await Promise.all(
      selectedFiles.map(async (entry) => {
        try {
          const file = await invoke<ReadFileResult>('read_text_file', {
            workspacePath: workspace(),
            relativePath: entry.path,
            maxBytes: parsed.maxBytes,
          });
          return [entry.path, { content: file.content, bytes: file.bytes }] as const;
        } catch {
          return null;
        }
      })
    );

    const fileContents = Object.fromEntries(
      fileReads.filter(
        (
          entry
        ): entry is readonly [string, { content: string; bytes: number }] => entry !== null
      )
    );
    const maxSymbolsPerFile = parsed.maxSymbolsPerFile ?? 24;
    const symbolOverrides = await resolveProjectMapSymbolOverrides(
      workspace(),
      fileContents,
      maxSymbolsPerFile
    );

    let projectMap: Awaited<ReturnType<typeof buildWorkspaceProjectMap>>;
    try {
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents,
        symbolOverrides,
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    } catch (mapError) {
      console.warn('buildWorkspaceProjectMap failed, falling back to tree-only map:', mapError);
      projectMap = await buildWorkspaceProjectMap({
        rootRelativePath: listResult.root || parsed.relativePath,
        entries: insightEntries,
        fileContents: {},
        symbolOverrides: {},
        maxTreeEntries: parsed.maxTreeEntries,
        maxStubsPerFile: maxSymbolsPerFile,
        truncated: listResult.truncated,
      });
    }

    const graph2 = buildWorkspaceProjectGraph({
      projectMap,
      entries: insightEntries,
      fileContents,
      symbolOverrides,
      maxEdges: parsed.maxEdges,
    });

    try {
      return stripGraphNoise(await enrichWorkspaceProjectGraph(graph2, fileContents, 3));
    } catch {
      return stripGraphNoise(graph2);
    }
  });

  registry.register(toolByName('workspace_symbol_lookup'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return lookupWorkspaceSymbols(graph, {
      query: asOptionalString(args.query),
      relativePath: asOptionalString(args.relativePath),
      symbolKind: asOptionalString(args.symbolKind),
      language: asOptionalString(args.language),
      exported: asOptionalBoolean(args.exported, 'exported'),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_dependency_subgraph'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
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

  registry.register(toolByName('workspace_entrypoints'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return findWorkspaceEntrypoints(graph, asOptionalNumber(args.limit));
  });

  registry.register(toolByName('workspace_change_impact'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return analyzeWorkspaceChangeImpact(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
      maxNodes: asOptionalNumber(args.maxNodes),
      maxEdges: asOptionalNumber(args.maxEdges),
    });
  });

  registry.register(toolByName('workspace_symbol_implementations'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return findWorkspaceSymbolImplementations(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      symbolName: asOptionalString(args.symbolName),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_smart_context'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return getWorkspaceSmartContext(graph, {
      query: asString(args.query, 'query'),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
    });
  });

  registry.register(toolByName('workspace_symbol_definition'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await requestWorkspaceSymbolDefinition(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
    });
  });

  registry.register(toolByName('workspace_symbol_references'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await requestWorkspaceSymbolReferences(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      includeDeclaration: asOptionalBoolean(args.includeDeclaration, 'includeDeclaration'),
    });
  });

  registry.register(toolByName('workspace_rename_symbol'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceRename(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      newName: asString(args.newName, 'newName'),
    });
  });

  registry.register(toolByName('workspace_organize_imports'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceOrganizeImports(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_apply_code_action'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceApplyCodeAction(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      title: asOptionalString(args.title),
      kind: asOptionalString(args.kind),
      preferredOnly: asOptionalBoolean(args.preferredOnly, 'preferredOnly'),
    });
  });

  registry.register(toolByName('workspace_fix_diagnostics'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceFixDiagnostics(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_lsp_diagnostics'), async (args: Record<string, unknown>) => {
    const relativePath = asOptionalString(args.relativePath);
    if (relativePath) {
      const languageId = resolveLanguageId(relativePath);
      const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>(
        'lsp_get_diagnostics',
        { workspacePath: workspace(), languageId }
      );
      const allDiags = result.diagnostics ?? {};
      const fileUri = Object.keys(allDiags).find(
        (uri) => uri.endsWith(relativePath) || uri.endsWith(relativePath.replace(/\\/g, '/'))
      );
      const fileDiags = fileUri ? (allDiags[fileUri]?.diagnostics ?? []) : [];
      return JSON.stringify({
        relativePath,
        totalCount: fileDiags.length,
        diagnostics: fileDiags,
      });
    }
    const summary: Record<string, { count: number; topIssues: string[] }> = {};
    let langIds: string[] = [];
    try {
      const providers = await invoke<Array<{ languageId: string }>>('list_available_symbol_providers');
      langIds = providers.map((p) => p.languageId);
    } catch {
      langIds = ['typescript', 'html', 'css', 'json', 'yaml', 'python', 'csharp', 'rust', 'java', 'cpp', 'go', 'shellscript', 'swift', 'sql', 'markdown'];
    }
    for (const langId of langIds) {
      try {
        const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>(
          'lsp_get_diagnostics',
          { workspacePath: workspace(), languageId: langId }
        );
        const diags = result.diagnostics ?? {};
        for (const [uri, entry] of Object.entries(diags)) {
          const diagList = entry.diagnostics ?? [];
          if (diagList.length > 0) {
            const short = uri.replace(/^.*[\\/]/, '');
            summary[short] = {
              count: diagList.length,
              topIssues: (diagList as Array<{ message?: string }>)
                .slice(0, 5)
                .map((d) => d.message ?? ''),
            };
          }
        }
      } catch {
        // LSP not available for this language, skip
      }
    }
    const entries = Object.entries(summary);
    return JSON.stringify({
      totalFiles: entries.length,
      totalIssues: entries.reduce((sum, [, v]) => sum + v.count, 0),
      files: entries.map(([name, info]) => ({ file: name, ...info })),
    });
  });

  registry.register(toolByName('workspace_format_files'), async (args: Record<string, unknown>) => {
    const relativePaths = asOptionalStringArray(args.relativePaths);
    if (!relativePaths || relativePaths.length === 0) {
      throw new Error('relativePaths 必须是非空字符串数组');
    }
    return await performWorkspaceFormatFiles(
      getWorkspaceHost(),
      relativePaths.map((relativePath) => ({
        relativePath,
        languageId: resolveLanguageId(relativePath),
      })),
      {
        tabSize: asOptionalNumber(args.tabSize),
        insertSpaces: asOptionalBoolean(args.insertSpaces, 'insertSpaces'),
      }
    );
  });

  registry.register(toolByName('workspace_git_status'), async () => {
    return await readGitStatus();
  });

  registry.register(toolByName('workspace_git_history'), async (args: Record<string, unknown>) => {
    const limit = Math.min(asOptionalPositiveInteger(args.limit, 'limit') ?? 20, 100);

    const status = await readGitStatus();
    if (!status.available || !status.isRepo) {
      return {
        available: status.available,
        isRepo: status.isRepo,
        entries: [],
        raw: status.raw,
        ...(status.message ? { message: status.message } : {}),
      } satisfies GitHistorySummary;
    }

    const entries = await invoke<import('../utils/snapshot').GitLogEntry[]>('git_log', {
      workspacePath: workspace(),
      limit,
    });
    return {
      available: true,
      isRepo: true,
      entries: entries.map((e) => ({
        hash: e.sha,
        shortHash: e.shortHash,
        committedAt: new Date(e.timestamp * 1000).toISOString(),
        authorName: e.author,
        refNames: e.refs,
        subject: e.message,
        isHead: e.isHead,
      })),
      raw: '',
    } satisfies GitHistorySummary;
  });

  registry.register(toolByName('workspace_git_diff'), async (args: Record<string, unknown>) => {
    const staged = asOptionalBoolean(args.staged, 'staged') === true;
    const pathspecs = asOptionalStringArray(args.pathspecs) ?? [];

    try {
      const result = await invoke<import('../utils/snapshot').GitDiffResult>('git_diff', {
        workspacePath: workspace(),
        staged: staged ? true : false,
        pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
      });
      return {
        available: result.available,
        isRepo: true,
        staged,
        pathspecs,
        stat: result.stat,
        diff: result.diff,
        truncated: result.truncated,
        ...(result.message ? { message: result.message } : {}),
      } satisfies GitDiffSummary;
    } catch (error) {
      return buildGitUnavailableDiff((error as Error).message, staged, pathspecs) satisfies GitDiffSummary;
    }
  });

  registry.register(toolByName('workspace_git_branch_checkout'), async (args: Record<string, unknown>) => {
    const branchName = asString(args.branchName, 'branchName');
    const create = asOptionalBoolean(args.create, 'create');
    const createIfMissing = asOptionalBoolean(args.createIfMissing, 'createIfMissing');

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_branch_checkout', {
        workspacePath: workspace(),
        branchName,
        create: create ?? undefined,
        createIfMissing: createIfMissing ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'branch_checkout', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'branch_checkout', message: `切换分支失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_stage'), async (args: Record<string, unknown>) => {
    const all = asOptionalBoolean(args.all, 'all');
    const pathspecs = asOptionalStringArray(args.pathspecs);

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_stage', {
        workspacePath: workspace(),
        all: all ?? undefined,
        pathspecs: pathspecs ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'stage', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'stage', message: `暂存失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_commit'), async (args: Record<string, unknown>) => {
    const message = asString(args.message, 'message');
    const stageAll = asOptionalBoolean(args.stageAll, 'stageAll');
    const pathspecs = asOptionalStringArray(args.pathspecs);
    const allowEmpty = asOptionalBoolean(args.allowEmpty, 'allowEmpty');

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_commit', {
        workspacePath: workspace(),
        message,
        stageAll: stageAll ?? undefined,
        pathspecs: pathspecs ?? undefined,
        allowEmpty: allowEmpty ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'commit', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'commit', message: `提交失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_restore'), async (args: Record<string, unknown>) => {
    const pathspecs = asOptionalStringArray(args.pathspecs);
    const source = asOptionalString(args.source);

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_restore_files', {
        workspacePath: workspace(),
        pathspecs: pathspecs ?? undefined,
        source: source ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'restore', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'restore', message: `恢复失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_reset'), async (args: Record<string, unknown>) => {
    const target = asString(args.target, 'target');

    try {
      const result = await invoke<{ ok: boolean; filesRestored: number; filesDeleted: number; backupRef: string | null; error: string | null }>(
        'restore_execute',
        { workspacePath: workspace(), targetSha: target }
      );

      if (result.ok) {
        return {
          available: true, isRepo: true, ok: true, action: 'reset', raw: '',
          message: `已回退到 ${target}，备份引用 ${result.backupRef ?? 'N/A'}，恢复 ${result.filesRestored} 个文件。`,
          backupBranch: result.backupRef ?? undefined,
          target,
        };
      }
      return {
        available: true, isRepo: true, ok: false, action: 'reset', raw: '',
        message: result.error ?? '回退失败。',
        backupBranch: result.backupRef ?? undefined,
        target,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: true, isRepo: true, ok: false, action: 'reset', raw: '',
        message: `回退失败: ${msg}`,
        target,
      };
    }
  });

  registry.register(toolByName('workspace_restore_undo'), async (_args: Record<string, unknown>) => {
    try {
      await invoke<void>('restore_undo', { workspacePath: workspace() });
      return {
        available: true, isRepo: true, ok: true, action: 'undo', raw: '',
        message: '已撤销上一次恢复操作。',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: true, isRepo: true, ok: false, action: 'undo', raw: '',
        message: `撤销失败: ${msg}`,
      };
    }
  });

  registry.register(toolByName('workspace_apply_patch'), async (args: Record<string, unknown>) => {
    const parsed: ApplyPatchArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      search: asString(args.search, 'search'),
      replace: asString(args.replace, 'replace'),
      replaceAll: asOptionalBoolean(args.replaceAll, 'replaceAll'),
      expectedOccurrences: asOptionalPositiveInteger(args.expectedOccurrences, 'expectedOccurrences'),
    };

    const current = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: 20_000_000,
    });
    if (current.bytes >= 20_000_000) {
      throw new Error(`文件 ${parsed.relativePath} 超过 20MB 上限，请改用 workspace_write_file 重写整个文件`);
    }
    const patched = applySearchReplacePatch(current.content, {
      search: parsed.search,
      replace: parsed.replace,
      replaceAll: parsed.replaceAll,
      expectedOccurrences: parsed.expectedOccurrences,
    });
    const result = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      content: patched.content,
    });

    // 写后验证：重读确认文件内容与写入一致
    const verified = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: Math.max(patched.content.length + 1024, 16384),
    });
    if (verified.content !== patched.content) {
      throw new Error(
        `文件写入验证失败：${parsed.relativePath} 写入后内容与预期不一致。可能由云同步锁或文件系统问题导致，请重试。`
      );
    }

    editHistory?.record({
      path: result.path,
      before: current.content,
      after: patched.content,
    });
    notifyWorkspaceMutation([result.path]);

    return {
      ...result,
      replacements: patched.replacements,
    } satisfies ApplyPatchResult;
  });

  registry.register(toolByName('workspace_apply_diff'), async (args: Record<string, unknown>) => {
    const parsed: ApplyDiffArgs = {
      patches: asPatchArray(args.patches).map((patch) => ({
        relativePath: asString(patch.relativePath, 'relativePath'),
        search: asString(patch.search, 'search'),
        replace: asString(patch.replace, 'replace'),
        replaceAll: asOptionalBoolean(patch.replaceAll, 'replaceAll'),
        expectedOccurrences: asOptionalPositiveInteger(patch.expectedOccurrences, 'expectedOccurrences'),
      })),
    };
    const uniquePaths = [...new Set(parsed.patches.map((patch) => patch.relativePath))];
    const fileContents: Record<string, string> = {};
    const fileBytes: Record<string, number> = {};

    for (const relativePath of uniquePaths) {
      const current = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath,
        maxBytes: 20_000_000,
      });
      if (current.bytes >= 20_000_000) {
        throw new Error(`文件 ${relativePath} 超过 20MB 上限，请改用 workspace_write_file 重写整个文件`);
      }
      fileContents[relativePath] = current.content;
      fileBytes[relativePath] = current.bytes;
    }

    const diff = applySearchReplaceDiff(fileContents, parsed.patches);
    const files: ApplyDiffFileResult[] = [];

    for (const file of diff.files) {
      const result = await invoke<WriteTextFileResult>('write_text_file', {
        workspacePath: workspace(),
        relativePath: file.path,
        content: file.content,
      });

      // 写后验证
      const verified = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath: file.path,
        maxBytes: Math.max(file.content.length + 1024, 16384),
      });
      if (verified.content !== file.content) {
        throw new Error(
          `文件写入验证失败：${file.path} 写入后内容与预期不一致。可能由云同步锁或文件系统问题导致，请重试。`
        );
      }

      editHistory?.record({
        path: result.path,
        before: fileContents[file.path] ?? null,
        after: file.content,
      });
      files.push({
        ...result,
        patches: file.patches,
        replacements: file.replacements,
      });
    }

    notifyWorkspaceMutation(files.map((file) => file.path));

    return {
      files,
      totalFiles: diff.totalFiles,
      totalPatches: diff.totalPatches,
      totalReplacements: diff.totalReplacements,
    } satisfies ApplyDiffResult;
  });

  registry.register(toolByName('workspace_project_diagnostics'), async () => {
    return await runProjectDiagnostics(workspace(), invoke);
  });

  registry.register(toolByName('local_time_now'), async () => {
    const now = new Date();
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
    const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return {
      iso: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainder}`,
      local: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
      date: `${year}-${month}-${day}`,
      time: `${hours}:${minutes}:${seconds}`,
      weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      offsetMinutes,
      unixMs: now.getTime(),
    } satisfies LocalTimeNowResult;
  });

  // ── 细粒度工具（对 LLM 隐藏）─────────────────────
  const oldToolNames = [
    'workspace_list_files', 'workspace_read_file', 'workspace_read_image', 'workspace_write_file',
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

  registerSharedMergeToolDispatchers({
    registry,
    terminalActionName: 'bash',
    projectGraphHandler: async (args: Record<string, unknown>) => {
      const a = asString(args.action, 'action');
      const m: Record<string, string> = { full: 'workspace_project_graph', overview: 'workspace_project_graph', lookup: 'workspace_symbol_lookup', dependency: 'workspace_dependency_subgraph', entrypoints: 'workspace_entrypoints', impact: 'workspace_change_impact', implementations: 'workspace_symbol_implementations' };
      const target = m[a];
      if (target) return await registry.execute(target, args);
      const graph = await buildIntelligenceProjectGraph(args);
      if (a === 'smart_context') return await getWorkspaceSmartContext(graph, { query: asString(args.query, 'query'), relativePath: asOptionalString(args.relativePath), depth: asOptionalNumber(args.depth) ?? 2 });
      if (a === 'dead_code') return await detectDeadCode(graph);
      if (a === 'circular_deps') return await detectCircularDependencies(graph);
      if (a === 'type_hierarchy') return await buildTypeHierarchy(graph);
      if (a === 'suggest_refactors') return await suggestRefactorings(graph);
      if (a === 'test_impact') return await selectTestsByChangeImpact(graph, asOptionalStringArray(args.paths) ?? []);
      if (a === 'generate_tests') return await generateTestSkeletons(graph);
      throw new Error(`未知的 graph action: ${a}`);
    },
    browserHandler: async (args: Record<string, unknown>) => {
      const a = asString(args.action, 'action');
      const m: Record<string, string> = {
        open: 'browser_open_page',
        navigate: 'browser_navigate_page',
        reload: 'browser_reload_page',
        close: 'browser_close_page',
        get: 'browser_get_preview_session',
        click: 'browser_click',
        type: 'browser_input_text',
        read: 'browser_read_dom',
        screenshot: 'browser_take_screenshot',
      };
      const target = m[a];
      if (!target) throw new Error(`未知的 browser action: ${a}`);
      return await registry.execute(target, args);
    },
    openHandler: async (args: Record<string, unknown>) => {
      return await registry.execute('workspace_open_in_browser', args);
    },
    questionHandler: async (args: Record<string, unknown>) => {
      const question = asString(args.question, 'question');
      const header = asString(args.header, 'header').slice(0, 30);
      const rawOptions = args.options as Array<Record<string, unknown>> | undefined;
      const multiple = args.multiple === true;
      const options = rawOptions
        ?.map((opt) => ({
          label: asString(opt.label, 'option.label').slice(0, 50),
          description: opt.description != null ? asString(opt.description, 'option.description') : undefined,
        }))
        .filter((opt) => opt.label.length > 0);

      return {
        __question: true,
        question,
        header,
        ...(options && options.length > 0 ? { options } : {}),
        ...(options && options.length > 0 ? { multiple } : {}),
        status: 'asked',
      };
    },
  });

  if (options.multimodalEnabled) {
    registry.register(toolByName('read_image'), async (args) => {
      return registry.execute('workspace_read_image', args);
    });
  }

  for (const name of oldToolNames) {
    registry.hideFromLlm(name);
  }
}
