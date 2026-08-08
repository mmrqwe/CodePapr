import { invoke } from '@tauri-apps/api/core';
import { lspLanguageFromPath } from './editorLanguage';
import { describeLspSupport } from './lspSupport';
import { workspaceFileUri } from '../tools/workspaceProjectMapLsp';

interface WarmupFileEntry {
  path: string;
  isDir: boolean;
}

const WARMUP_MAX_DEPTH = 8;
const WARMUP_MAX_LANGUAGES = 8;
const WARMUP_MAX_FILE_BYTES = 200_000;

const warmupInFlight = new Set<string>();

/**
 * 工作区打开时后台预热 LSP：按文件列表推导语言，并行启动各语言服务器，
 * 并对每种语言的第一个文件发起一次 documentSymbol，让 tsserver/pyright/
 * rust-analyzer 等项目加载与索引尽早开始，而不是等 ProjectGraph 构建时才
 * 卡在冷启动上。
 *
 * 纯 fire-and-forget：任何失败都静默忽略，不影响工作区打开流程。
 */
export async function warmupLspForWorkspace(workspacePath: string): Promise<void> {
  if (!workspacePath || warmupInFlight.has(workspacePath)) {
    return;
  }
  warmupInFlight.add(workspacePath);
  try {
    const listResult = await invoke<{ entries?: WarmupFileEntry[] }>('list_workspace_files', {
      workspacePath,
      maxDepth: WARMUP_MAX_DEPTH,
    });

    const languageFiles = new Map<string, string>();
    for (const entry of listResult?.entries ?? []) {
      if (entry.isDir) continue;
      const languageId = lspLanguageFromPath(entry.path);
      if (!languageId || !describeLspSupport(languageId)) continue;
      if (!languageFiles.has(languageId)) {
        languageFiles.set(languageId, entry.path);
      }
      if (languageFiles.size >= WARMUP_MAX_LANGUAGES) break;
    }

    await Promise.allSettled(
      [...languageFiles.entries()].map(async ([languageId, relativePath]) => {
        try {
          await invoke('lsp_start_server', { workspacePath, languageId });
          const fileResult = await invoke<{ content: string }>('read_text_file', {
            workspacePath,
            relativePath,
            maxBytes: WARMUP_MAX_FILE_BYTES,
          });
          const uri = workspaceFileUri(workspacePath, relativePath);
          await invoke('lsp_open_document', {
            workspacePath,
            languageId,
            relativePath,
            content: fileResult.content,
            version: 1,
            diagWaitMs: 0,
          });
          await invoke('lsp_request', {
            workspacePath,
            languageId,
            method: 'textDocument/documentSymbol',
            params: { textDocument: { uri } },
          }).catch(() => undefined);
          await invoke('lsp_close_document', {
            workspacePath,
            languageId,
            relativePath,
          }).catch(() => undefined);
        } catch {
          // 忽略：预热失败不影响主流程
        }
      })
    );
  } catch {
    // 忽略：目录列表失败时跳过预热
  } finally {
    warmupInFlight.delete(workspacePath);
  }
}
