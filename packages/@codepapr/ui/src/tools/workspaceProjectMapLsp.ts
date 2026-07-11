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
  activeDocuments: Set<string>;
}

export interface LspConnectionPool {
  acquire(languageId: string, workspacePath: string): Promise<LspConnectionHandle>;
  release(handle: LspConnectionHandle): void;
  closeAll(): Promise<void>;
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
      return handle;
    }

    // 创建新连接
    handle = {
      languageId,
      workspacePath,
      acquiredAt: Date.now(),
      activeDocuments: new Set(),
    };
    this.connections.set(key, handle);
    this.poolSize++;

    // 如果连接池满了，停止并移除最早的连接，避免被淘汰的后端 LSP 进程变成孤儿
    if (this.poolSize > this.maxPoolSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.connections.entries()) {
        if (v.acquiredAt < oldestTime) {
          oldestTime = v.acquiredAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const evicted = this.connections.get(oldestKey);
        this.connections.delete(oldestKey);
        this.poolSize--;
        if (evicted) {
          await this.shutdownConnection(evicted);
        }
      }
    }

    return handle;
  }

  release(_handle: LspConnectionHandle): void {
    // 保持连接在池中，下次可以复用
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
      // 如果有连接池，不立即关闭文档，保持复用
      if (!connectionPool) {
        await invoke<boolean>('lsp_close_document', {
          workspacePath,
          languageId,
          relativePath,
        }).catch(() => undefined);
      }
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
  concurrencyLimit: number = 5
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
    const batch = lspSupportedFiles.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map(async ({ path, languageId, content }) => {
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

// ============= LSP ProjectGraph 增强器 =============

export interface LspSymbolReference {
  filePath: string;
  line: number;
  character: number;
  fromSymbol?: string;
  toSymbol?: string;
}

export interface LspInheritanceRelation {
  fromSymbol: string;
  toSymbol: string;
  kind: 'extends' | 'implements';
  toFilePath?: string;
}

export interface LspProjectGraphEnhancer {
  enhanceReferences(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; line: number; kind: string }>
  ): Promise<LspSymbolReference[]>;
  enhanceInheritance(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; line: number; kind: string }>
  ): Promise<LspInheritanceRelation[]>;
}

// 创建 LSP 增强器
export function createLspProjectGraphEnhancer(
  workspacePath: string,
  _connectionPool: LspConnectionPool = globalLspPool
): LspProjectGraphEnhancer {
  return {
    async enhanceReferences(filePath, content, symbols) {
      const languageId = lspLanguageFromPath(filePath);
      if (!languageId || !describeLspSupport(languageId) || symbols.length === 0) {
        return [];
      }

      try {
        await invoke('lsp_open_document', {
          workspacePath,
          languageId,
          relativePath: filePath,
          content,
          version: 1,
        });

        const refPromises = symbols.map(async (symbol) => {
          try {
            const requestResult = await invoke<LspRequestEnvelope<unknown>>('lsp_request', {
              workspacePath,
              languageId,
              method: 'textDocument/references',
              params: {
                textDocument: { uri: workspaceFileUri(workspacePath, filePath) },
                position: { line: Math.max(0, symbol.line - 1), character: 0 },
                context: { includeDeclaration: false },
              },
            });

            const result = requestResult.message?.result;
            const symbolRefs: LspSymbolReference[] = [];
            if (Array.isArray(result)) {
              for (const ref of result) {
                if (ref && typeof ref === 'object' && 'uri' in ref && 'range' in ref) {
                  const uri = ref.uri;
                  const range = ref.range;
                  if (uri && range?.start?.line != null) {
                    const refFilePath = uri.startsWith('file://')
                      ? decodeURIComponent(uri.slice(7))
                      : uri;
                    let relativeRefPath = refFilePath;
                    if (relativeRefPath.startsWith(workspacePath)) {
                      relativeRefPath = relativeRefPath.slice(workspacePath.length);
                      if (relativeRefPath.startsWith('/') || relativeRefPath.startsWith('\\')) {
                        relativeRefPath = relativeRefPath.slice(1);
                      }
                    }
                    symbolRefs.push({
                      filePath: relativeRefPath,
                      line: range.start.line + 1,
                      character: range.start.character ?? 0,
                      fromSymbol: symbol.name,
                    });
                  }
                }
              }
            }
            return symbolRefs;
          } catch {
            return [];
          }
        });

        const results = await Promise.all(refPromises);
        return results.flat();
      } catch {
        return [];
      } finally {
        await invoke('lsp_close_document', {
          workspacePath,
          languageId,
          relativePath: filePath,
        }).catch(() => {});
      }
    },

    async enhanceInheritance(filePath, content, symbols) {
      const languageId = lspLanguageFromPath(filePath);
      if (!languageId || !describeLspSupport(languageId)) {
        return [];
      }

      const classSymbols = symbols.filter((s) => ['class', 'interface', 'struct'].includes(s.kind));
      if (classSymbols.length === 0) return [];

      try {
        await invoke('lsp_open_document', {
          workspacePath,
          languageId,
          relativePath: filePath,
          content,
          version: 1,
        });

        const typeDefPromises = classSymbols.map(async (symbol) => {
          try {
            await invoke<LspRequestEnvelope<unknown>>('lsp_request', {
              workspacePath,
              languageId,
              method: 'textDocument/typeDefinition',
              params: {
                textDocument: { uri: workspaceFileUri(workspacePath, filePath) },
                position: { line: Math.max(0, symbol.line - 1), character: 0 },
              },
            });
          } catch { /* skip failed go-to-definition */ }
        });

        await Promise.all(typeDefPromises);
        return [];
      } catch {
        return [];
      } finally {
        await invoke('lsp_close_document', {
          workspacePath,
          languageId,
          relativePath: filePath,
        }).catch(() => {});
      }
    },
  };
}