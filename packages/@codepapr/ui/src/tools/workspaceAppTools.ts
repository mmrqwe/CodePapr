import { invoke } from '@tauri-apps/api/core';
import { asString } from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type BackgroundProcessExitInfo,
  type ReadFileResult,
} from './workspaceToolHelpers';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import type { PaprAppSettings, PaprManifest } from '@codepapr/types';
import {
  LOCAL_ORDER,
  accessMeetsTool,
  legacyLevelToAccess,
  resolveEffectiveAccess,
  type PaprAccess,
  type PaprLocalAccess,
} from '../papr/levelGrants';
import { isPluginApp, parsePaprKind, parsePluginSurfaceArg, pluginIsEnabled, readAppManifest, resolvePaprEntryFile, shouldRevealOnPublish } from '../papr/pluginSurface';
import { postAppEvent } from '../papr/appChannelHub';
import { type WorkspaceToolContext } from './workspaceToolContext';
import { findPreviewProcessForPort, processPreviewUrl } from '../utils/loopbackPreview';

/** app_render 禁止携带的写文件/清单字段：这些必须用 write/edit/patch 落盘。 */
const APP_RENDER_WRITE_ARG_KEYS = [
  'html',
  'files',
  'title',
  'kind',
  'surface',
  'agents',
  'local',
  'network',
  'command',
  'args',
  'port',
  'icon',
  'permissions',
  'level',
] as const;

const LOCAL_LABEL: Record<PaprLocalAccess, string> = {
  none: '无',
  read: '只读',
  write: '读写执行',
};

/** app 图标：写入 manifest 以便扫描恢复。空串忽略；过长或含路径字符拒绝。 */
function normalizeAppIcon(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 16 || /[\n\r\\/]/.test(trimmed)) {
    throw new Error(`icon 必须是不超过 16 个字符的 emoji 或短标签，收到: ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

/** app_publish 频道名：字母/数字开头，1-64 位（与 Rust 侧长度上限一致）。 */
const APP_PUBLISH_CHANNEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** app_publish 单条 payload 上限：防止把大文件内容塞进 app db。 */
const APP_PUBLISH_MAX_PAYLOAD_BYTES = 256 * 1024;

/** manifest inbox 频道声明（契约）：app_publish 只允许命中已声明频道。 */
export interface PaprInboxSummary {
  channel: string;
  description?: string;
  example?: unknown;
}

/**
 * 校验 manifest.inbox 声明。未声明（undefined）合法 = 不启用契约；
 * 声明则每个频道名必须合法、定义必须是对象。app_render 挂载前调用，
 * 让 agent 在创建应用时就拿到明确报错。
 */
export function validateManifestInbox(manifest: PaprManifest): void {
  const inbox = manifest.inbox;
  if (inbox === undefined) return;
  if (typeof inbox !== 'object' || inbox === null || Array.isArray(inbox)) {
    throw new Error(
      'manifest inbox 必须是对象：{ "<channel>": { "description": "...", "example": {...} } }',
    );
  }
  for (const [channel, def] of Object.entries(inbox)) {
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) {
      throw new Error(
        `inbox 频道名 '${channel}' 非法：须字母/数字开头，仅字母/数字/-/_，1-64 字符`,
      );
    }
    if (typeof def !== 'object' || def === null || Array.isArray(def)) {
      throw new Error(`inbox.${channel} 必须是对象（{ description?, example? }）`);
    }
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`inbox.${channel}.description 必须是字符串`);
    }
  }
}

/** 从 manifest 提取 inbox 摘要（app_list 输出，供 agent 发现推送契约）。 */
export function summarizeManifestInbox(manifest: PaprManifest | null | undefined): PaprInboxSummary[] | undefined {
  const inbox = manifest?.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return undefined;
  const entries = Object.entries(inbox);
  if (entries.length === 0) return undefined;
  return entries.map(([channel, def]) => ({
    channel,
    ...(typeof def?.description === 'string' && def.description.trim().length > 0
      ? { description: def.description }
      : {}),
    ...(def && 'example' in def && def.example !== undefined ? { example: def.example } : {}),
  }));
}

/**
 * 解析 manifest 的访问参数：优先 local/network（两轴），缺省回落旧 level。
 */
function parseAccess(args: Record<string, unknown>): PaprAccess {
  const rawLocal = args.local;
  const rawNetwork = args.network;
  if (rawLocal !== undefined || rawNetwork !== undefined) {
    if (rawLocal !== undefined && !LOCAL_ORDER.includes(rawLocal as PaprLocalAccess)) {
      throw new Error(`local 必须是 none/read/write，收到: ${JSON.stringify(rawLocal)}`);
    }
    if (rawNetwork !== undefined && typeof rawNetwork !== 'boolean') {
      throw new Error(`network 必须是布尔值，收到: ${JSON.stringify(rawNetwork)}`);
    }
    return {
      local: (rawLocal as PaprLocalAccess) ?? 'none',
      network: rawNetwork === true,
    };
  }
  const level = typeof args.level === 'number' ? args.level : 1;
  if (![0, 1, 2, 3].includes(level)) {
    throw new Error(`level 必须是 0/1/2/3，收到: ${args.level}`);
  }
  return legacyLevelToAccess(level);
}

function validateAgentTools(params: {
  agents: Array<{ name: string; tools?: string[] }>;
  access: PaprAccess;
  disableWebSearchTools: boolean;
}): void {
  const { agents, access, disableWebSearchTools } = params;
  for (const agent of agents) {
    if (!agent.tools) continue;
    for (const toolName of agent.tools) {
      if (typeof toolName !== 'string' || toolName.trim().length === 0) {
        throw new Error(`agents[${agent.name}].tools 含非法工具名: ${JSON.stringify(toolName)}`);
      }
      if (toolName === 'task' || toolName === 'app_render') {
        throw new Error(`agents[${agent.name}].tools 不能声明 ${toolName}（App Agent 始终排除该工具）`);
      }
      if (toolName.startsWith('mcp__')) {
        if (!access.network) {
          throw new Error(`agents[${agent.name}].tools 声明了 MCP 工具 ${toolName}，MCP 工具需要 network: true（当前 network: ${access.network}）`);
        }
        continue;
      }
      if (!accessMeetsTool(access, toolName)) {
        throw new Error(
          `agents[${agent.name}].tools 中的 ${toolName} 不在当前访问档（local=${LOCAL_LABEL[access.local]}, network=${access.network}）允许范围内，请调整 manifest.json 的 local/network 或从 tools 中移除。`
        );
      }
      if ((toolName === 'websearch' || toolName === 'webfetch') && disableWebSearchTools) {
        throw new Error(`设置已启用 MCP 搜索，websearch/webfetch 不可用。请改为在 agents[${agent.name}].tools 中显式声明对应的 MCP 搜索工具（mcp__ 前缀名称），或在设置中关闭 MCP 搜索`);
      }
    }
  }
}

function validateManifestAgents(raw: unknown): Array<{ name: string; tools?: string[]; }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('manifest.agents 必须是数组');
  }
  const agents: Array<{ name: string; tools?: string[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('agents 每个元素必须是对象');
    }
    const a = item as { name?: unknown; model?: unknown; maxToolRounds?: unknown; inheritContext?: unknown; tools?: string[]; };
    if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) {
      throw new Error('agents 每个元素必须包含非空 name 字段');
    }
    if (a.name.length > 64) {
      throw new Error(`agent name 超过 64 字符限制: ${a.name}`);
    }
    if (a.model !== undefined && !['main', 'fast', 'mentor'].includes(String(a.model))) {
      throw new Error(`agent model 必须是 main/fast/mentor，收到: ${a.model}`);
    }
    if (a.maxToolRounds !== undefined && (typeof a.maxToolRounds !== 'number' || !Number.isInteger(a.maxToolRounds) || a.maxToolRounds < 1)) {
      throw new Error(`agent maxToolRounds 必须是正整数: ${a.maxToolRounds}`);
    }
    if (a.inheritContext !== undefined) {
      if (typeof a.inheritContext !== 'object' || a.inheritContext === null || Array.isArray(a.inheritContext)) {
        throw new Error(`agent inheritContext 必须是对象: ${JSON.stringify(a.inheritContext)}`);
      }
      const inherit = a.inheritContext as Record<string, unknown>;
      for (const field of ['skills', 'projectRules', 'projectMemory', 'customPrompt'] as const) {
        const val = inherit[field];
        if (val !== undefined && typeof val !== 'boolean') {
          throw new Error(`agent inheritContext.${field} 必须是布尔值: ${val}`);
        }
      }
    }
    agents.push({ name: a.name, tools: a.tools });
  }
  return agents;
}

async function readAppTextFile(workspacePath: string, relativePath: string): Promise<string | null> {
  try {
    const file = await invoke<ReadFileResult>('read_text_file', {
      workspacePath,
      relativePath,
      maxBytes: 2_000_000,
    });
    return typeof file?.content === 'string' ? file.content : null;
  } catch {
    return null;
  }
}

export async function resolveAppManifest(
  appId: string,
  workspacePath: string,
): Promise<{ manifest: PaprManifest; scope: 'global' | 'workspace' } | null> {
  const inStore = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
  if (inStore?.manifestJson) {
    try {
      return {
        manifest: JSON.parse(inStore.manifestJson) as PaprManifest,
        scope: inStore.scope ?? 'workspace',
      };
    } catch { /* ignore */ }
  }
  if (workspacePath) {
    const wsManifestRaw = await readAppTextFile(workspacePath, `.CodePapr/apps/${appId}/manifest.json`);
    if (wsManifestRaw) {
      try {
        return {
          manifest: JSON.parse(wsManifestRaw) as PaprManifest,
          scope: 'workspace',
        };
      } catch { /* ignore */ }
    }
  }
  try {
    const scanned = await invoke<Array<{ app_id: string; manifest_json: string | null; scope?: 'workspace' | 'global'; }>>('scan_workspace_apps', { workspacePath: workspacePath || '' });
    const match = scanned.find((d) => d.app_id === appId);
    if (match?.manifest_json) {
      return {
        manifest: JSON.parse(match.manifest_json) as PaprManifest,
        scope: match.scope ?? 'workspace',
      };
    }
  } catch { /* best-effort */ }
  return null;
}

export function registerWorkspaceAppTools(ctx: WorkspaceToolContext): void {
  const { registry, workspace } = ctx;
  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const writeKeys = APP_RENDER_WRITE_ARG_KEYS.filter((key) => {
      const value = args[key];
      return value !== undefined && value !== null;
    });
    if (writeKeys.length > 0) {
      throw new Error(
        `app_render 只打开已落盘的应用，不能写入文件。请用 write/edit/patch 把 ${writeKeys.join(', ')} 写入 .CodePapr/apps/<appId>/，然后只传 appId 调用 app_render({ appId })。`,
      );
    }
    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(`appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`);
    }
    let appDir = `.CodePapr/apps/${rawAppId}`;
    const manifestPath = `${appDir}/manifest.json`;
    let manifestRaw = await readAppTextFile(workspace(), manifestPath);
