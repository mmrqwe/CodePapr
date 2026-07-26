import { invoke } from '@tauri-apps/api/core';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { describeLspSupport } from '../utils/lspSupport';
import type { WorkspaceMapSymbolSummary } from './workspaceToolUtils';

interface ProjectMapFileContent {
  content: string;
  bytes: number;
}

interface LspPosition {
  line?: number;
  character?: number;
}

interface LspRange {
  start?: LspPosition;
  end?: LspPosition;
}

interface LspLocation {
  uri?: string;
  range?: LspRange;
}

interface LspDocumentSymbolLike {
  name?: string;
  detail?: string;
  kind?: number;
  containerName?: string;
  range?: LspRange;
  selectionRange?: LspRange;
  location?: LspLocation;
  children?: LspDocumentSymbolLike[];
}

interface LspOpenDocumentResponse {
  message?: {
    server?: {
      toolSource?: string;
    };
  };
}

interface LspRequestEnvelope<T> {
  message?: {
    result?: T;
  };
}

// LSP 连接池接口
export interface LspConnectionHandle {
  languageId: string;
  workspacePath: string;
  acquiredAt: number;
  lastUsedAt: number;
  refCount: number;
  activeDocuments: Set<string>;
}

export interface LspConnectionPool {
  acquire(languageId: string, workspacePath: string): Promise<LspConnectionHandle>;
  release(handle: LspConnectionHandle): void;
  closeAll(): Promise<void>;
  closeWorkspace?(workspacePath: string): Promise<void>;
}

// 全局 LSP 连接池实例
class GlobalLspConnectionPool implements LspConnectionPool {
  private connections: Map<string, LspConnectionHandle> = new Map();
  private poolSize = 0;
  private readonly maxPoolSize = 10;

  async acquire(languageId: string, workspacePath: string): Promise<LspConnectionHandle> {
    const key = `${languageId}:${workspacePath}`;
    let handle = this.connections.get(key);
    if (handle) {
      handle.lastUsedAt = Date.now();
      handle.refCount += 1;
      return handle;
    }

    // 创建新连接
    handle = {
      languageId,
      workspacePath,
      acquiredAt: Date.now(),
      lastUsedAt: Date.now(),
      refCount: 1,
      activeDocuments: new Set(),
    };
    this.connections.set(key, handle);
    this.poolSize++;

    // 如果连接池满了，停止并移除「最久未使用且当前空闲」的连接，避免被淘汰的后端 LSP 进程变成孤儿，
    // 同时绝不淘汰仍有 in-flight 请求（refCount>0）的连接，否则会在请求进行中杀掉其语言服务器。
    if (this.poolSize > this.maxPoolSize) {
      let evictKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.connections.entries()) {
        if (v.refCount > 0) continue;
        if (v.lastUsedAt < oldestTime) {
          oldestTime = v.lastUsedAt;
          evictKey = k;
        }
      }
      if (evictKey) {
        const evicted = this.connections.get(evictKey);
        this.connections.delete(evictKey);
        this.poolSize--;
        if (evicted) {
          await this.shutdownConnection(evicted);
        }
      }
    }

    return handle;
  }

  release(handle: LspConnectionHandle): void {
    // 保持连接在池中，下次可以复用；仅递减引用计数并刷新最近使用时间。
    handle.refCount = Math.max(0, handle.refCount - 1);
    handle.lastUsedAt = Date.now();
  }

  private async shutdownConnection(handle: LspConnectionHandle): Promise<void> {
    for (const doc of handle.activeDocuments) {
      try {
        await invoke('lsp_close_document', {
          workspacePath: handle.workspacePath,
          languageId: handle.languageId,
          relativePath: doc,
        });
      } catch {
        // 忽略：文档可能已经关闭
      }
    }
    try {
      await invoke('lsp_stop_server', {
        workspacePath: handle.workspacePath,
        languageId: handle.languageId,
      });
    } catch {
      // 忽略：进程可能已经退出
    }
  }

  async closeWorkspace(workspacePath: string): Promise<void> {
    for (const [key, handle] of [...this.connections.entries()]) {
      if (handle.workspacePath !== workspacePath) continue;
      this.connections.delete(key);
      this.poolSize = Math.max(0, this.poolSize - 1);
      await this.shutdownConnection(handle);
    }
  }

  async closeAll(): Promise<void> {
    for (const handle of this.connections.values()) {
      await this.shutdownConnection(handle);
    }
    this.connections.clear();
    this.poolSize = 0;
  }
}

// 全局连接池实例
export const globalLspPool = new GlobalLspConnectionPool();

const LSP_SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum-member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type-parameter',
};

const CONTAINER_SYMBOL_KINDS = new Set([
  'class',
  'interface',
  'enum',
  'namespace',
  'module',
  'package',
  'struct',
  'object',
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function workspaceFileUri(workspacePath: string, relativePath: string): string {
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRelativePath = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
  const raw = `file://${normalizedWorkspacePath}/${normalizedRelativePath}`;
  return encodeURI(raw).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function isProjectMapLspLanguage(languageId: string): boolean {
  // 所有有 LSP 支持的语言都使用 LSP
  return describeLspSupport(languageId) !== null;
}

function lspSymbolKindLabel(kind: number | undefined): string {
  if (typeof kind !== 'number' || !Number.isFinite(kind)) {
    return 'symbol';
  }

  return LSP_SYMBOL_KIND_LABELS[Math.trunc(kind)] ?? 'symbol';
}

function lspSymbolLine(symbol: LspDocumentSymbolLike): number {
  const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range;
  return Math.max((range?.start?.line ?? 0) + 1, 1);
}

function buildLspSymbolSignature(
  name: string,
  containerName: string | undefined,
  detail: string | undefined
): string {
  const qualifiedName = containerName ? `${containerName}.${name}` : name;
  const normalizedDetail = detail ? collapseWhitespace(detail) : '';
  if (!normalizedDetail) {
    return qualifiedName;
  }

  if (/^[<([:]/.test(normalizedDetail)) {
    return `${qualifiedName}${normalizedDetail}`;
  }

  return `${qualifiedName} ${normalizedDetail}`;
}

function appendDocumentSymbols(
  result: unknown,
  maxSymbols: number,
  symbols: WorkspaceMapSymbolSummary[],
  inheritedContainerName?: string
): void {
  if (!Array.isArray(result) || symbols.length >= maxSymbols) {
    return;
  }

  for (const rawSymbol of result) {
    if (symbols.length >= maxSymbols) {
      break;
    }

    if (!rawSymbol || typeof rawSymbol !== 'object') {
      continue;
    }

    const symbol = rawSymbol as LspDocumentSymbolLike;
    const name = typeof symbol.name === 'string' ? collapseWhitespace(symbol.name) : '';
    if (!name) {
      continue;
    }

    const kind = lspSymbolKindLabel(symbol.kind);
    const containerName =
      typeof symbol.containerName === 'string' && symbol.containerName.trim().length > 0
        ? collapseWhitespace(symbol.containerName)
        : inheritedContainerName;

    symbols.push({
      name,
      kind,
      signature: buildLspSymbolSignature(name, containerName, symbol.detail),
      line: lspSymbolLine(symbol),
      containerName,
      exported: !containerName,
    });

    if (symbols.length >= maxSymbols) {
      break;
    }

    if (Array.isArray(symbol.children) && symbol.children.length > 0) {
      const nextContainerName = CONTAINER_SYMBOL_KINDS.has(kind) ? name : containerName;
      appendDocumentSymbols(symbol.children, maxSymbols, symbols, nextContainerName);
    }
  }
}

export function normalizeProjectMapDocumentSymbols(
  result: unknown,
  maxSymbols: number = 8
): WorkspaceMapSymbolSummary[] {
  const symbols: WorkspaceMapSymbolSummary[] = [];
  appendDocumentSymbols(result, Math.max(1, maxSymbols), symbols);
  return symbols;
}

async function loadProjectMapSymbolsFromLsp(
  workspacePath: string,
  relativePath: string,
  languageId: string,
  content: string,
  maxSymbols: number,
  connectionPool?: LspConnectionPool
): Promise<WorkspaceMapSymbolSummary[]> {
  let opened = false;
  let handle: LspConnectionHandle | null = null;

  try {
    // 从连接池获取连接（如果有）
    if (connectionPool) {
      handle = await connectionPool.acquire(languageId, workspacePath);
    }

    await invoke<LspOpenDocumentResponse>('lsp_open_document', {
      workspacePath,
      languageId,
      relativePath,
      content,
      version: 1,
    });
    opened = true;

    // 记录文档为活跃
    handle?.activeDocuments.add(relativePath);

    const requestResult = await invoke<LspRequestEnvelope<unknown>>('lsp_request', {
      workspacePath,
      languageId,
      method: 'textDocument/documentSymbol',
      params: {
        textDocument: {
          uri: workspaceFileUri(workspacePath, relativePath),
        },
      },
    });

    return normalizeProjectMapDocumentSymbols(requestResult.message?.result, maxSymbols);
  } catch {
    return [];
  } finally {
    if (opened) {
      // 连接池复用的是「语言服务器」而非「已打开的文档」：documentSymbol 是一次性请求，
      // 读取完符号后立即关闭文档，避免数百个文件长期挂在语言服务器上占用内存。
      handle?.activeDocuments.delete(relativePath);
      await invoke<boolean>('lsp_close_document', {
        workspacePath,
        languageId,
        relativePath,
      }).catch(() => undefined);
      // 释放连接
      if (handle) {
        connectionPool?.release(handle);
      }
    }
  }
}

export async function resolveProjectMapSymbolOverrides(
  workspacePath: string,
  fileContents: Record<string, ProjectMapFileContent>,
  maxSymbols: number,
  concurrencyLimit: number = 5,
  isCancelled?: () => boolean
): Promise<Record<string, WorkspaceMapSymbolSummary[]>> {
  const overrides: Record<string, WorkspaceMapSymbolSummary[]> = {};

  // 收集有 LSP 支持的文件
  const lspSupportedFiles: Array<{ path: string; languageId: string; content: string }> = [];
  for (const [path, file] of Object.entries(fileContents)) {
    const languageId = lspLanguageFromPath(path);
    if (languageId && isProjectMapLspLanguage(languageId)) {
      lspSupportedFiles.push({ path, languageId, content: file.content });
    }
  }

  // 分批并发处理，避免同时请求太多 LSP 连接
  for (let i = 0; i < lspSupportedFiles.length; i += concurrencyLimit) {
    if (isCancelled?.()) break;
    const batch = lspSupportedFiles.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map(async ({ path, languageId, content }) => {
      if (isCancelled?.()) return { path, symbols: [] as WorkspaceMapSymbolSummary[] };
      const symbols = await loadProjectMapSymbolsFromLsp(
        workspacePath,
        path,
        languageId,
        content,
        maxSymbols,
        globalLspPool
      );
      return { path, symbols };
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value && result.value.symbols.length > 0) {
        overrides[result.value.path] = result.value.symbols;
      }
    }
  }

  return overrides;
}
