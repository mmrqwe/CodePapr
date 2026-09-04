import { invoke } from '@tauri-apps/api/core';
import type { AppInstallScope, PaprAppListing } from '../utils/marketAppTypes';
import { OFFICIAL_APPS_RAW_BASE } from './marketAppApi';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore } from '../papr/permissionStore';
import { isPluginApp, pluginIsEnabled, pluginShouldAutostartOverlay } from '../papr/pluginSurface';
import { legacyLevelToAccess, LOCAL_ORDER, type PaprLocalAccess } from '../papr/levelGrants';

const GITHUB_TREE_API =
  'https://api.github.com/repos/mmrqwe/codepapr-apps/git/trees/main?recursive=1';

/** 单次下载超时：无 AbortSignal 的裸 fetch 遇到挂死的连接会让安装按钮永久
 *  置灰（promise 永不 settle）。与 marketSkillInstall 同一模式。 */
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GithubTreeItem {
  path: string;
  type: string;
}

interface GithubTreeResponse {
  tree: GithubTreeItem[];
}

export type AppInstallFile = {
  relativePath: string;
  content: string;
};

/** 标准默认文件清单（最基础兜底） */
const DEFAULT_STANDARD_FILES = ['manifest.json', 'index.html', 'css/theme.css', 'js/main.js', 'js/db.js'];

/** 规范化相对路径，防止路径遍历并清理首尾斜杠与查询参数 */
export function sanitizeRelativePath(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.split(/[?#]/)[0].trim();
  if (!trimmed) return null;
  // 过滤外部协议与绝对网络资源 (http:, https:, //, data:, blob:, mailto:, javascript:)
  if (/^(https?:|\/\/|data:|blob:|mailto:|javascript:)/i.test(trimmed)) return null;
  const clean = trimmed.replace(/^\/+/, '');
  if (!clean) return null;
  // 过滤系统注入的虚拟 SDK 路径
  if (clean === '__papr_sdk.js' || clean.endsWith('/__papr_sdk.js')) return null;
  // 安全防遍历与反斜杠
  if (clean.includes('..') || clean.includes('\\')) return null;
  return clean;
}

/**
 * directory 消毒 + URL 同源断言：listing.directory 只去首尾斜杠时，
 * `../../evil/repo/branch` 会被 WHATWG URL 规范化成另一个仓库的 raw 地址，
 * 让任意 GitHub 内容以"官方市场"名义落盘。这里要求最终 URL 仍钉在
 * 官方仓库 main 分支路径内，越界即拒装。
 */
const OFFICIAL_RAW_ORIGIN = 'https://raw.githubusercontent.com';
const OFFICIAL_RAW_PATH_PREFIX = '/mmrqwe/codepapr-apps/main/';

export function assertOfficialRawUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法的应用下载地址: ${url}`);
  }
  if (parsed.origin !== OFFICIAL_RAW_ORIGIN || !parsed.pathname.startsWith(OFFICIAL_RAW_PATH_PREFIX)) {
    throw new Error(`拒绝下载官方仓库之外的内容: ${url}`);
  }
  return url;
}

function safeNormDirectory(raw: string | undefined): string {
  const clean = raw ? sanitizeRelativePath(raw) : null;
  if (!clean) {
    throw new Error(`应用目录不合法（疑似路径遍历）: ${JSON.stringify(raw)}`);
  }
  return clean.replace(/\/+$/, '');
}

function officialRawUrl(normDir: string, rel: string): string {
  return assertOfficialRawUrl(`${OFFICIAL_APPS_RAW_BASE}/${normDir}/${rel}`);
}

/** 内容 SHA-256（hex）。crypto.subtle 缺失时返回 null，由调用方 fail-closed。 */
async function sha256Hex(content: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 完整性校验：listing.sha256 声明了该文件就必须匹配，否则中止安装。 */
async function verifyFileIntegrity(
  rel: string,
  content: string,
  expected: Record<string, string> | undefined,
): Promise<void> {
  const want = expected?.[rel]?.toLowerCase();
  if (!want) return;
  const got = await sha256Hex(content);
  if (!got) {
    throw new Error(`无法校验文件完整性（crypto.subtle 不可用）: ${rel}`);
  }
  if (got !== want) {
    throw new Error(`文件校验和不匹配 (${rel}): 期望 ${want}，实际 ${got}`);
  }
}

/** 从 HTML 源码中智能解析引用的本地相对资源 (JS / CSS / 图片 / 字体等) */
export function extractLocalAssetsFromHtml(html: string): string[] {
  if (!html || typeof html !== 'string') return [];
  const assets = new Set<string>();

  // 1. 匹配 <script src="...">
  const scriptRegex = /<script\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const s = sanitizeRelativePath(match[1]);
    if (s) assets.add(s);
  }

  // 2. 匹配 <link href="..."> (stylesheet, icon, etc.)
  const linkRegex = /<link\b[^>]*?\bhref=["']([^"']+)["'][^>]*>/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    const s = sanitizeRelativePath(match[1]);
    if (s) assets.add(s);
  }

  // 3. 匹配 <img src="..."> 与 <source src="...">
  const mediaRegex = /<(?:img|source|video|audio)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((match = mediaRegex.exec(html)) !== null) {
    const s = sanitizeRelativePath(match[1]);
    if (s) assets.add(s);
  }

  return Array.from(assets);
}

/** 从 GitHub Git Tree API 动态解析应用目录下的所有文件 */
export async function fetchAppTreeFileList(appDirectory: string): Promise<string[] | null> {
  let normDir: string;
  try {
    normDir = safeNormDirectory(appDirectory);
  } catch {
    return null;
  }
  try {
    const res = await fetchWithTimeout(GITHUB_TREE_API, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as GithubTreeResponse;
      if (Array.isArray(data.tree)) {
        const found = data.tree
          .filter(
            (item) =>
              item.type === 'blob' &&
              (item.path === normDir || item.path.startsWith(`${normDir}/`)),
          )
          .map((item) => sanitizeRelativePath(item.path.slice(normDir.length)))
          .filter((p): p is string => !!p);
        if (found.length > 0) return found;
      }
    }
  } catch {
    // 允许降级
  }
  return null;
}

export async function downloadAppFiles(
  listing: PaprAppListing,
  warnings?: string[],
): Promise<AppInstallFile[]> {
  const normDir = safeNormDirectory(listing.directory);
  const entryFile = sanitizeRelativePath(listing.entry || 'index.html') || 'index.html';
  const expectedHashes = listing.sha256;
  const noteOptionalFailure = (rel: string, reason: string) => {
    warnings?.push(`${rel}: ${reason}`);
  };

  if (Array.isArray(listing.files) && listing.files.length > 0) {
    const explicitFiles = Array.from(
      new Set(
        ['manifest.json', entryFile, ...listing.files]
          .map((f) => sanitizeRelativePath(f))
          .filter((f): f is string => !!f),
      ),
    );
    const downloaded: AppInstallFile[] = [];
    for (const rel of explicitFiles) {
      const url = officialRawUrl(normDir, rel);
      const res = await fetchWithTimeout(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        noteOptionalFailure(rel, `HTTP ${res.status}`);
        continue;
      }
      const content = await res.text();
      await verifyFileIntegrity(rel, content, expectedHashes);
      downloaded.push({ relativePath: rel, content });
    }
    if (downloaded.length > 0) return downloaded;
  }

  const treeFiles = await fetchAppTreeFileList(listing.directory);
  if (treeFiles && treeFiles.length > 0) {
    const downloaded: AppInstallFile[] = [];
    for (const rel of treeFiles) {
      const url = officialRawUrl(normDir, rel);
      const res = await fetchWithTimeout(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        noteOptionalFailure(rel, `HTTP ${res.status}`);
        continue;
      }
      const content = await res.text();
      await verifyFileIntegrity(rel, content, expectedHashes);
      downloaded.push({ relativePath: rel, content });
    }
    if (downloaded.length > 0) return downloaded;
  }

  const downloadedMap = new Map<string, string>();
  const queue = new Set<string>(['manifest.json', entryFile, ...DEFAULT_STANDARD_FILES]);

  for (const rel of queue) {
    if (downloadedMap.has(rel)) continue;
    const url = officialRawUrl(normDir, rel);
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        continue;
      }
      const content = await res.text();
      await verifyFileIntegrity(rel, content, expectedHashes);
      downloadedMap.set(rel, content);

      if (rel.endsWith('.html') || rel.endsWith('.htm')) {
        const assets = extractLocalAssetsFromHtml(content);
        for (const asset of assets) {
          if (!downloadedMap.has(asset)) {
            queue.add(asset);
          }
        }
      }
    } catch (err) {
      if (rel === 'manifest.json' || rel === entryFile) {
        throw err;
      }
    }
  }

  const downloaded: AppInstallFile[] = Array.from(downloadedMap.entries()).map(
    ([relativePath, content]) => ({ relativePath, content }),
  );

  if (downloaded.length === 0) {
    throw new Error('未下载到任何有效应用文件');
  }

  return downloaded;
}

/** 安装前反欺骗校验：下载回来的 manifest.json 自声明权限不得超出市场条目
 *  向用户展示的 permissions。否则市场卡片显示"离线/无本地访问"，装完却是
 *  local:write + network:true——声明与契约脱钩。 */
export function assertListingPermissions(
  listing: PaprAppListing,
  manifest: Record<string, unknown>,
): void {
  const declared = listing.permissions;
  if (!declared) return;
  const legacy =
    typeof manifest.level === 'number' ? legacyLevelToAccess(manifest.level) : null;
  const local =
    manifest.local === 'none' || manifest.local === 'read' || manifest.local === 'write'
      ? manifest.local
      : legacy?.local;
  const network =
    typeof manifest.network === 'boolean' ? manifest.network : legacy?.network ?? false;
  const rank = (l: PaprLocalAccess) => LOCAL_ORDER.indexOf(l);
  if (declared.local && local && rank(local) > rank(declared.local)) {
    throw new Error(
      `manifest 声明 local:"${local}" 超出市场条目标注的 "${declared.local}"，已中止安装`,
    );
  }
  if (declared.network === false && network) {
    throw new Error('manifest 声明需要网络，但市场条目标注为离线，已中止安装');
  }
}

export async function installMarketApp(options: {
  listing: PaprAppListing;
  scope: AppInstallScope;
  workspacePath?: string | null;
}): Promise<{ ok: boolean; error?: string; targetDir?: string; warnings?: string[] }> {
  const { listing, scope, workspacePath } = options;

  if (scope === 'workspace' && !workspacePath) {
    return { ok: false, error: '安装到当前项目需要先打开工作区' };
  }

  try {
    const warnings: string[] = [];
    const files = await downloadAppFiles(listing, warnings);

    // 落盘前反欺骗：manifest 自声明权限 ⊆ 市场条目展示权限。
    const manifestFileForCheck = files.find((f) => f.relativePath === 'manifest.json');
    if (manifestFileForCheck) {
      assertListingPermissions(
        listing,
        JSON.parse(manifestFileForCheck.content) as Record<string, unknown>,
      );
    }

    const targetDir = await invoke<string>('papr_install_app_files', {
      workspacePath: workspacePath || null,
      scope,
      appId: listing.id,
      files: files.map((f) => ({ relative_path: f.relativePath, content: f.content })),
    });

    // 始终 scan+register（global 安装无工作区时用空串：scan_workspace_apps
    // 空路径只扫 global，resolve_app_dir('') 正确回落 global 目录）。
    // 旧实现 workspacePath 为空时跳过，global 应用成为"幽灵安装"：
    // 落盘成功但未注册，协议 404、市场卡片立即回显"未安装"。
    try {
      const discovered = await invoke<
        Array<{
          app_id: string;
          title: string;
          html: string;
          manifest_json: string | null;
          command: string | null;
          args: string[] | null;
          port: number | null;
          icon: string | null;
          scope?: 'workspace' | 'global';
        }>
      >('scan_workspace_apps', { workspacePath: workspacePath || '' });

      for (const app of discovered) {
        if (app.app_id === listing.id) {
          await invoke('register_app_workspace', {
            appId: app.app_id,
            workspacePath: workspacePath || '',
            manifestJson: app.manifest_json ?? undefined,
          });
          break;
        }
      }
    } catch {
      // non-blocking
    }

    try {
      const manifestFile = files.find((f) => f.relativePath === 'manifest.json');
      if (manifestFile) {
        const manifest = JSON.parse(manifestFile.content);
        if (isPluginApp({ manifestJson: manifestFile.content })) {
          const store = useAppRuntimeStore.getState();
          const chrome = store.pluginChrome[listing.id];
          const enabled = pluginIsEnabled(manifest, chrome);
          if (enabled) {
            store.enablePlugin(listing.id);
            if (pluginShouldAutostartOverlay(manifest, chrome)) {
              store.pinPlugin(listing.id);
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return { ok: true, targetDir, warnings: warnings.length > 0 ? warnings : undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uninstallMarketApp(options: {
  appId: string;
  scope: AppInstallScope;
  workspacePath?: string | null;
  purgeData?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { appId, scope, workspacePath, purgeData } = options;

  try {
    // 先停后端（与 app_delete 同口径）：store 的 pid 是权威运行进程；
    // papr_uninstall_app 内另有按端口兜底。漏停会让进程从已删除目录继续
    // 服务旧代码并占用端口（math-mentor 同类事故）。
    const store = useAppRuntimeStore.getState();
    const running = store.apps.find((a) => a.appId === appId);
    if (running?.pid) {
      try {
        await invoke('stop_background_process', { pid: running.pid, source: 'market-uninstall' });
      } catch {
        // best-effort：Rust 侧按端口兜底
      }
    }

    await invoke('papr_uninstall_app', {
      workspacePath: workspacePath || null,
      scope,
      appId,
      removeData: !!purgeData,
    });

    try {
      usePermissionStore.getState().clearManifest(appId);
      store.unpinPlugin?.(appId);
      store.closeApp?.(appId);
    } catch {
      // non-blocking for headless/test environments
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
