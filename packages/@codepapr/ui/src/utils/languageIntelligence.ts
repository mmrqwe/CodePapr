import { lspLanguageFromPath } from './editorLanguage';
import type { MonacoExternalMarker } from '@codepapr/editor';
import { yieldToMainThread } from './taskScheduling';

interface ReadFileResult {
  path: string;
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

interface LspDiagnostic {
  range?: LspRange;
  severity?: number;
  message?: string;
  source?: string;
}

interface LspPublishDiagnostics {
  uri?: string;
  diagnostics?: LspDiagnostic[];
}

export interface LspServerDetails {
  languageId: string;
  serverFamily: string;
  running: boolean;
  command: string;
  toolOrigin?: string;
  toolSource?: string;
  toolLabel?: string;
  managedCachePath?: string | null;
  pid: number | null;
  openDocuments: number;
  stderrTail: string[];
}

interface LspOpenDocumentResponse {
  message: {
    opened?: boolean;
    diagnostics?: LspPublishDiagnostics[];
    workspaceDiagnostics?: LspPublishDiagnostics[];
    server?: LspServerDetails;
  };
}

interface LspRequestEnvelope<T> {
  message: {
    result?: T;
  };
}

export interface LanguageIntelligenceSnapshot {
  workspacePath: string;
  relativePath: string;
  languageId: string;
  status: 'analyzing' | 'ready' | 'unavailable';
  diagnostics: number;
  detail: string;
  markers: MonacoExternalMarker[];
  server: LspServerDetails | null;
  symbolCount: number;
  updatedAt: number;
}

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type LanguageIntelligenceListener = (snapshot: LanguageIntelligenceSnapshot) => void;

const LANGUAGE_INTELLIGENCE_MAX_BYTES = 300_000;
const LANGUAGE_INTELLIGENCE_DEFAULT_LIMIT = 24;
const LANGUAGE_INTELLIGENCE_INTER_TASK_DELAY_MS = 90;
const languageIntelligenceCache = new Map<string, LanguageIntelligenceSnapshot>();
const languageIntelligencePending = new Map<string, Promise<void>>();
const languageIntelligenceListeners = new Set<LanguageIntelligenceListener>();
const workspaceGenerations = new Map<string, number>();

interface WorkspaceLanguageQueueState {
  invoke: InvokeLike;
  paths: string[];
  enqueued: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

const workspaceLanguageQueues = new Map<string, WorkspaceLanguageQueueState>();

let lspDocumentVersion = 1;

function nextLspDocumentVersion(): number {
  const version = lspDocumentVersion;
  lspDocumentVersion += 1;
  return version;
}

function cacheKey(workspacePath: string, relativePath: string): string {
  return `${workspacePath}\u0000${relativePath}`;
}

function workspaceFileUri(workspacePath: string, relativePath: string): string {
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRelativePath = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
  return encodeURI(`file://${normalizedWorkspacePath}/${normalizedRelativePath}`).replace(/#/g, '%23');
}

function generationForWorkspace(workspacePath: string): number {
  return workspaceGenerations.get(workspacePath) ?? 0;
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function normalizeFileUriPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }

  return decodeURIComponent(uri.replace(/^file:\/+/, '/')).replace(/\\/g, '/');
}

function relativePathFromFileUri(workspacePath: string, uri: string | undefined): string | null {
  if (!uri) {
    return null;
  }

  const workspace = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const filePath = normalizeFileUriPath(uri);
  if (!workspace || !filePath.startsWith(`${workspace}/`)) {
    return null;
  }

  return normalizePath(filePath.slice(workspace.length + 1));
}

function getOrCreateWorkspaceQueue(workspacePath: string, invoke: InvokeLike): WorkspaceLanguageQueueState {
  const existing = workspaceLanguageQueues.get(workspacePath);
  if (existing) {
    existing.invoke = invoke;
    return existing;
  }

  const next: WorkspaceLanguageQueueState = {
    invoke,
    paths: [],
    enqueued: new Set<string>(),
    timer: null,
    running: false,
  };
  workspaceLanguageQueues.set(workspacePath, next);
  return next;
}

function dropWorkspaceQueueIfIdle(workspacePath: string): void {
  const queue = workspaceLanguageQueues.get(workspacePath);
  if (!queue) {
    return;
  }

  if (!queue.running && queue.timer === null && queue.paths.length === 0) {
    workspaceLanguageQueues.delete(workspacePath);
  }
}

function enqueueWorkspacePath(queue: WorkspaceLanguageQueueState, relativePath: string): void {
  if (queue.enqueued.has(relativePath)) {
    return;
  }
  queue.paths.push(relativePath);
  queue.enqueued.add(relativePath);
}

function processWorkspaceQueue(workspacePath: string): void {
  const queue = workspaceLanguageQueues.get(workspacePath);
  if (!queue || queue.running) {
    return;
  }

  const relativePath = queue.paths.shift();
  if (!relativePath) {
    dropWorkspaceQueueIfIdle(workspacePath);
    return;
  }

  queue.enqueued.delete(relativePath);
  const languageId = lspLanguageFromPath(relativePath);
  if (!languageId) {
    queue.timer = setTimeout(() => {
      queue.timer = null;
      processWorkspaceQueue(workspacePath);
    }, 0);
    return;
  }

  const generation = generationForWorkspace(workspacePath);
  const key = cacheKey(workspacePath, relativePath);
  queue.running = true;

  const promise = (async () => {
    await refreshLanguageIntelligenceForFile({
      invoke: queue.invoke,
      workspacePath,
      relativePath,
      languageId,
      generation,
    });
  })()
    .finally(async () => {
      if (languageIntelligencePending.get(key) === promise) {
        languageIntelligencePending.delete(key);
      }
      queue.running = false;
      await yieldToMainThread();
      queue.timer = setTimeout(() => {
        queue.timer = null;
        processWorkspaceQueue(workspacePath);
      }, LANGUAGE_INTELLIGENCE_INTER_TASK_DELAY_MS);
    });

  languageIntelligencePending.set(key, promise);
}

function latestLspDiagnostics(response: LspOpenDocumentResponse): LspDiagnostic[] {
  const notifications = response.message.diagnostics ?? [];
  if (notifications.length === 0) {
    return [];
  }
  return notifications[notifications.length - 1]?.diagnostics ?? [];
}

function toMarkerSeverity(severity: number | undefined): MonacoExternalMarker['severity'] {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'info';
  }
}

function diagnosticsToMarkers(diagnostics: readonly LspDiagnostic[]): MonacoExternalMarker[] {
  return diagnostics.map((diagnostic) => {
    const startLineNumber = Math.max((diagnostic.range?.start?.line ?? 0) + 1, 1);
    const startColumn = Math.max((diagnostic.range?.start?.character ?? 0) + 1, 1);
    const endLineNumber = Math.max((diagnostic.range?.end?.line ?? startLineNumber - 1) + 1, startLineNumber);
    const endColumn = Math.max((diagnostic.range?.end?.character ?? startColumn) + 1, startColumn + 1);
    return {
      severity: toMarkerSeverity(diagnostic.severity),
      message: diagnostic.message ?? 'LSP diagnostic',
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
      source: diagnostic.source ?? 'LSP',
    };
  });
}

function lspDiagnosticsToMarkers(response: LspOpenDocumentResponse): MonacoExternalMarker[] {
  return diagnosticsToMarkers(latestLspDiagnostics(response));
}

function publishWorkspaceDiagnostics(params: {
  response: LspOpenDocumentResponse;
  workspacePath: string;
  currentRelativePath: string;
  currentLanguageId: string;
  server: LspServerDetails | null;
}): void {
  const diagnostics = params.response.message.workspaceDiagnostics ?? [];
  if (diagnostics.length === 0) {
    return;
  }

  for (const item of diagnostics) {
    const relativePath = relativePathFromFileUri(params.workspacePath, item.uri);
    if (!relativePath || relativePath === params.currentRelativePath) {
      continue;
    }

    const languageId = lspLanguageFromPath(relativePath) ?? params.currentLanguageId;
    const existing = getCachedLanguageIntelligence(params.workspacePath, relativePath);
    const markers = diagnosticsToMarkers(item.diagnostics ?? []);
    publishSnapshot({
      workspacePath: params.workspacePath,
      relativePath,
      languageId,
      status: 'ready',
      diagnostics: markers.length,
      detail: '',
      markers,
      server: params.server,
      symbolCount: existing?.symbolCount ?? 0,
      updatedAt: Date.now(),
    });
  }
}

function publishSnapshot(snapshot: LanguageIntelligenceSnapshot): void {
  languageIntelligenceCache.set(cacheKey(snapshot.workspacePath, snapshot.relativePath), snapshot);
  for (const listener of languageIntelligenceListeners) {
    listener(snapshot);
  }
}

function isCurrentWorkspaceGeneration(workspacePath: string, generation: number): boolean {
  return generationForWorkspace(workspacePath) === generation;
}

async function requestDocumentSymbols(params: {
  invoke: InvokeLike;
  workspacePath: string;
  relativePath: string;
  languageId: string;
}): Promise<number> {
  try {
    const response = await params.invoke<LspRequestEnvelope<unknown>>('lsp_request', {
      workspacePath: params.workspacePath,
      languageId: params.languageId,
      method: 'textDocument/documentSymbol',
      params: {
        textDocument: { uri: workspaceFileUri(params.workspacePath, params.relativePath) },
      },
    });
    return Array.isArray(response.message.result) ? response.message.result.length : 0;
  } catch {
    return 0;
  }
}

async function refreshLanguageIntelligenceForFile(params: {
  invoke: InvokeLike;
  workspacePath: string;
  relativePath: string;
  languageId: string;
  generation: number;
}): Promise<void> {
  const { invoke, workspacePath, relativePath, languageId, generation } = params;
  if (!isCurrentWorkspaceGeneration(workspacePath, generation)) {
    return;
  }

  publishSnapshot({
    workspacePath,
    relativePath,
    languageId,
    status: 'analyzing',
    diagnostics: 0,
    detail: '',
    markers: [],
    server: null,
    symbolCount: 0,
    updatedAt: Date.now(),
  });

  try {
    const file = await invoke<ReadFileResult>('read_text_file', {
      workspacePath,
      relativePath,
      maxBytes: LANGUAGE_INTELLIGENCE_MAX_BYTES,
    });
    if (!isCurrentWorkspaceGeneration(workspacePath, generation)) {
      return;
    }

    const opened = await invoke<LspOpenDocumentResponse>('lsp_open_document', {
      workspacePath,
      languageId,
      relativePath,
      content: file.content,
      version: nextLspDocumentVersion(),
    });
    if (!isCurrentWorkspaceGeneration(workspacePath, generation)) {
      return;
    }

    const symbolCount = await requestDocumentSymbols({
      invoke,
      workspacePath,
      relativePath,
      languageId,
    });

    const publishResult = (diags: LspPublishDiagnostics[], workspaceDiags: LspPublishDiagnostics[]) => {
      const response = { message: { diagnostics: diags, workspaceDiagnostics: workspaceDiags } } as LspOpenDocumentResponse;
      const markers = lspDiagnosticsToMarkers(response);
      publishWorkspaceDiagnostics({
        response,
        workspacePath,
        currentRelativePath: relativePath,
        currentLanguageId: languageId,
        server: opened.message.server ?? null,
      });
      publishSnapshot({
        workspacePath,
        relativePath,
        languageId,
        status: 'ready',
        diagnostics: markers.length,
        detail: '',
        markers,
        server: opened.message.server ?? null,
        symbolCount,
        updatedAt: Date.now(),
      });
    };

    publishResult(opened.message.diagnostics ?? [], opened.message.workspaceDiagnostics ?? []);

    void (async () => {
      let hasDiagnostics = (opened.message.diagnostics?.length ?? 0) > 0;
      const started = Date.now();
      const MAX_POLL_MS = 30_000;
      while (Date.now() - started < MAX_POLL_MS) {
        await new Promise((r) => setTimeout(r, 500));
        if (!isCurrentWorkspaceGeneration(workspacePath, generation)) return;
        try {
          const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>('lsp_get_diagnostics', {
            workspacePath,
            languageId,
          });
          const uriDiags = result.diagnostics?.[workspaceFileUri(workspacePath, relativePath)];
          const workspaceDiags: LspPublishDiagnostics[] = Object.entries(result.diagnostics ?? {}).map(([uri, d]) => ({
            uri,
            diagnostics: (d.diagnostics ?? []) as LspDiagnostic[],
          }));
          const currentDiags = (uriDiags?.diagnostics ?? []) as LspDiagnostic[];
          if (currentDiags.length > 0) hasDiagnostics = true;
          publishResult([
            { uri: workspaceFileUri(workspacePath, relativePath), diagnostics: currentDiags },
          ], workspaceDiags);
          if (hasDiagnostics && currentDiags.length > 0) break;
        } catch {
          break;
        }
      }
    })();
  } catch (error) {
    if (!isCurrentWorkspaceGeneration(workspacePath, generation)) {
      return;
    }
    publishSnapshot({
      workspacePath,
      relativePath,
      languageId,
      status: 'unavailable',
      diagnostics: 0,
      detail: error instanceof Error ? error.message : String(error),
      markers: [],
      server: null,
      symbolCount: 0,
      updatedAt: Date.now(),
    });
  }
}

export function getCachedLanguageIntelligence(
  workspacePath: string,
  relativePath: string
): LanguageIntelligenceSnapshot | null {
  return languageIntelligenceCache.get(cacheKey(workspacePath, relativePath)) ?? null;
}

export function subscribeLanguageIntelligence(
  listener: LanguageIntelligenceListener
): () => void {
  languageIntelligenceListeners.add(listener);
  return () => {
    languageIntelligenceListeners.delete(listener);
  };
}

export function clearLanguageIntelligenceWorkspace(workspacePath: string): void {
  if (!workspacePath) {
    return;
  }
  workspaceGenerations.set(workspacePath, generationForWorkspace(workspacePath) + 1);
  const prefix = `${workspacePath}\u0000`;
  for (const key of languageIntelligenceCache.keys()) {
    if (key.startsWith(prefix)) {
      languageIntelligenceCache.delete(key);
    }
  }
  for (const key of languageIntelligencePending.keys()) {
    if (key.startsWith(prefix)) {
      languageIntelligencePending.delete(key);
    }
  }
  const queue = workspaceLanguageQueues.get(workspacePath);
  if (queue?.timer) {
    clearTimeout(queue.timer);
  }
  workspaceLanguageQueues.delete(workspacePath);
}

export function clearLanguageIntelligencePaths(workspacePath: string, paths: readonly string[]): void {
  for (const path of paths) {
    const relativePath = normalizePath(path);
    if (relativePath) {
      languageIntelligenceCache.delete(cacheKey(workspacePath, relativePath));
    }
  }
}

export function scheduleLanguageIntelligenceRefresh(params: {
  invoke: InvokeLike;
  workspacePath: string;
  paths: readonly string[];
  delayMs?: number;
  maxFiles?: number;
  force?: boolean;
}): void {
  const workspacePath = params.workspacePath.trim();
  if (!workspacePath) {
    return;
  }

  const seen = new Set<string>();
  const generation = generationForWorkspace(workspacePath);
  const maxFiles = params.maxFiles ?? LANGUAGE_INTELLIGENCE_DEFAULT_LIMIT;
  const delayMs = params.delayMs ?? 0;
  const paths = params.paths
    .map(normalizePath)
    .filter((path) => {
      if (!path || seen.has(path)) {
        return false;
      }
      seen.add(path);
      return !!lspLanguageFromPath(path);
    })
    .slice(0, maxFiles);

  if (paths.length === 0) {
    return;
  }

  const queue = getOrCreateWorkspaceQueue(workspacePath, params.invoke);

  for (const relativePath of paths) {
    const languageId = lspLanguageFromPath(relativePath);
    if (!languageId) {
      continue;
    }

    const key = cacheKey(workspacePath, relativePath);
    if (
      !params.force &&
      (languageIntelligencePending.has(key) ||
        languageIntelligenceCache.has(key) ||
        queue.enqueued.has(relativePath))
    ) {
      continue;
    }

    if (params.force) {
      languageIntelligenceCache.delete(key);
    }

    enqueueWorkspacePath(queue, relativePath);
  }

  if (!isCurrentWorkspaceGeneration(workspacePath, generation)) {
    return;
  }

  if (queue.timer) {
    return;
  }

  queue.timer = setTimeout(() => {
    queue.timer = null;
    processWorkspaceQueue(workspacePath);
  }, delayMs);
}
