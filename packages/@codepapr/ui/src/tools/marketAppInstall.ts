import { invoke } from '@tauri-apps/api/core';
import type { AppInstallScope, PaprAppListing } from '../utils/marketAppTypes';
import { OFFICIAL_APPS_RAW_BASE } from './marketAppApi';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { isPluginApp, pluginIsEnabled, pluginShouldAutostartOverlay } from '../papr/pluginSurface';

const GITHUB_TREE_API =
  'https://api.github.com/repos/mmrqwe/codepapr-apps/git/trees/main?recursive=1';

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
  const normDir = appDirectory.replace(/^\/+|\/+$/g, '');
  try {
    const res = await fetch(GITHUB_TREE_API, {
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
): Promise<AppInstallFile[]> {
  const normDir = listing.directory.replace(/^\/+|\/+$/g, '');
  const entryFile = sanitizeRelativePath(listing.entry || 'index.html') || 'index.html';

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
      const url = `${OFFICIAL_APPS_RAW_BASE}/${normDir}/${rel}`;
      const res = await fetch(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        continue;
      }
      const content = await res.text();
      downloaded.push({ relativePath: rel, content });
    }
    if (downloaded.length > 0) return downloaded;
  }

  const treeFiles = await fetchAppTreeFileList(listing.directory);
  if (treeFiles && treeFiles.length > 0) {
    const downloaded: AppInstallFile[] = [];
    for (const rel of treeFiles) {
      const url = `${OFFICIAL_APPS_RAW_BASE}/${normDir}/${rel}`;
      const res = await fetch(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        continue;
      }
      const content = await res.text();
      downloaded.push({ relativePath: rel, content });
    }
    if (downloaded.length > 0) return downloaded;
  }

  const downloadedMap = new Map<string, string>();
  const queue = new Set<string>(['manifest.json', entryFile, ...DEFAULT_STANDARD_FILES]);

  for (const rel of queue) {
    if (downloadedMap.has(rel)) continue;
    const url = `${OFFICIAL_APPS_RAW_BASE}/${normDir}/${rel}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        if (rel === 'manifest.json' || rel === entryFile) {
          throw new Error(`下载必要文件失败 (${rel}): HTTP ${res.status}`);
        }
        continue;
      }
      const content = await res.text();
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

export async function installMarketApp(options: {
  listing: PaprAppListing;
  scope: AppInstallScope;
  workspacePath?: string | null;
}): Promise<{ ok: boolean; error?: string; targetDir?: string }> {
  const { listing, scope, workspacePath } = options;

  if (scope === 'workspace' && !workspacePath) {
    return { ok: false, error: '安装到当前项目需要先打开工作区' };
  }

  try {
    const files = await downloadAppFiles(listing);

    const targetDir = await invoke<string>('papr_install_app_files', {
      workspacePath: workspacePath || null,
      scope,
      appId: listing.id,
      files: files.map((f) => ({ relative_path: f.relativePath, content: f.content })),
    });

    if (workspacePath) {
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
        >('scan_workspace_apps', { workspacePath });

        for (const app of discovered) {
          if (app.app_id === listing.id) {
            await invoke('register_app_workspace', {
              appId: app.app_id,
              workspacePath,
            });
            break;
          }
        }
      } catch {
        // non-blocking
      }
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

    return { ok: true, targetDir };
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
    await invoke('papr_uninstall_app', {
      workspacePath: workspacePath || null,
      scope,
      appId,
      removeData: !!purgeData,
    });

    try {
      const store = useAppRuntimeStore.getState();
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
