import { invoke } from '@tauri-apps/api/core';

// asset 协议 scope 默认空（tauri.conf.json），只在工作区打开时按需授权
// （grant_workspace_asset_scope）。重复授权无害但没必要，按路径去重。
const grantedWorkspacePaths = new Set<string>();

/** 授予该工作区的 asset 协议读取权限（聊天图片/代码预览图片显示依赖）。
 *  失败时仅告警：图片加载会优雅降级，不阻塞工作区打开。 */
export async function grantWorkspaceAssetScope(workspacePath: string): Promise<void> {
  const trimmed = workspacePath.trim();
  if (!trimmed || grantedWorkspacePaths.has(trimmed)) return;
  try {
    await invoke('grant_workspace_asset_scope', { workspacePath: trimmed });
    grantedWorkspacePaths.add(trimmed);
  } catch (err) {
    console.warn(
      '[CodePapr] 授权工作区资源访问失败（图片可能无法显示）:',
      err instanceof Error ? err.message : err
    );
  }
}
