import type { WorkspaceHost } from './host';
import {
  planProjectGraphRename,
  computeRenameEditsForContent,
  applyRenameEditsToContent,
  type ProjectGraphRenameParams,
} from './graphQuery';

export interface WorkspaceSymbolLocation {
  relativePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface WorkspaceNavigationResult {
  available: boolean;
  locations: WorkspaceSymbolLocation[];
  message?: string;
}

export interface WorkspaceLanguagePositionArgs {
  relativePath: string;
  languageId: string;
  line: number;
  column?: number;
}

export interface WorkspaceCodeOperationResult {
  available: boolean;
  ok: boolean;
  changedFiles: string[];
  appliedEdits: number;
  message: string;
  actionTitle?: string;
  failedFiles?: string[];
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<
    | {
        textDocument?: { uri?: string };
        edits?: LspTextEdit[];
      }
    | {
        kind?: string;
        uri?: string;
        oldUri?: string;
        newUri?: string;
      }
  >;
}

interface LspCodeAction {
  title?: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeAbsolutePath(value: string): string {
  const normalized = normalizePath(value).replace(/\/+$/, '');
  return normalized.replace(/^\/([A-Za-z]:\/)/, '$1');
}

function workspaceFileUri(workspacePath: string, relativePath: string): string {
  const workspace = normalizeAbsolutePath(workspacePath);
  const relative = normalizePath(relativePath).replace(/^\.\//, '');
  const fullPath = `${workspace}/${relative}`;
  const prefix = /^[A-Za-z]:\//.test(fullPath) ? 'file:///' : 'file://';
  return encodeURI(`${prefix}${fullPath}`).replace(/[?#]/g, (ch) => (ch === '?' ? '%3F' : '%23'));
}

function relativePathFromFileUri(workspacePath: string, uri: string | undefined): string | null {
  if (!uri) {
    return null;
  }

  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') {
      return null;
    }
    const rawPath = normalizeAbsolutePath(decodeURIComponent(url.pathname));
    const workspace = normalizeAbsolutePath(workspacePath);
    const lowerRawPath = rawPath.toLowerCase();
    const lowerWorkspace = workspace.toLowerCase();
    if (lowerRawPath === lowerWorkspace) {
      return '';
    }
    if (!lowerRawPath.startsWith(`${lowerWorkspace}/`)) {
      return null;
    }
    return rawPath.slice(workspace.length + 1);
  } catch {
    return null;
  }
}

function toLspPosition(line: number, column?: number): LspPosition {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, (column ?? 1) - 1),
  };
}

// 将 LSP 位置转换为 JS 字符串偏移。LSP 的 character 以「编码单元」计，具体编码由客户端与服务器
// 在 initialize 阶段通过 general.positionEncodings 协商。本项目的 Rust 客户端【没有】声明支持
// utf-8/utf-32（见 src-tauri/src/lsp.rs 的 initialize capabilities），因此服务器一律回退到规范默认的
// UTF-16；而 JS 字符串索引恰好就是 UTF-16 编码单元，故这里直接用字符串下标换算是正确的。
// 注意：若将来在 Rust 侧加入 positionEncodings 协商（如支持 utf-8），必须同步在此按协商结果转换 character，
// 否则含非 ASCII 字符（CJK/emoji）的文件会出现偏移错位。
function positionToOffset(content: string, position: LspPosition): number {
  const targetLine = Math.max(0, position.line);
  const targetCharacter = Math.max(0, position.character);
  let line = 0;
  let offset = 0;

  while (line < targetLine && offset < content.length) {
    const nextBreak = content.indexOf('\n', offset);
    if (nextBreak < 0) {
      return content.length;
    }
    offset = nextBreak + 1;
    line += 1;
  }

  return Math.min(content.length, offset + targetCharacter);
}

function applyTextEdits(content: string, edits: readonly LspTextEdit[]): { content: string; appliedEdits: number } {
  const normalized = edits
    .map((edit, index) => ({
      edit,
      index,
      startOffset: positionToOffset(content, edit.range.start),
      endOffset: positionToOffset(content, edit.range.end),
    }))
    .sort(
      (left, right) =>
        right.startOffset - left.startOffset ||
        right.endOffset - left.endOffset ||
        right.index - left.index,
    );

  let nextContent = content;
  for (const item of normalized) {
    nextContent =
      nextContent.slice(0, item.startOffset) +
      item.edit.newText +
      nextContent.slice(item.endOffset);
  }

  return {
    content: nextContent,
    appliedEdits: normalized.length,
  };
}

function normalizeLocations(workspacePath: string, result: unknown): WorkspaceSymbolLocation[] {
  const entries = Array.isArray(result) ? result : result ? [result] : [];
  const locations: WorkspaceSymbolLocation[] = [];
  const seen = new Set<string>();
  const MAX_LOCATIONS = 100;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as {
      uri?: string;
      range?: LspRange;
      targetUri?: string;
      targetRange?: LspRange;
      targetSelectionRange?: LspRange;
    };
    const uri = candidate.targetUri ?? candidate.uri;
    const range = candidate.targetSelectionRange ?? candidate.targetRange ?? candidate.range;
    const relativePath = relativePathFromFileUri(workspacePath, uri);
    if (!relativePath || !range?.start) {
      continue;
    }

    const location: WorkspaceSymbolLocation = {
      relativePath,
      line: (range.start.line ?? 0) + 1,
      column: (range.start.character ?? 0) + 1,
      endLine: (range.end?.line ?? range.start.line ?? 0) + 1,
      endColumn: (range.end?.character ?? range.start.character ?? 0) + 1,
    };
    const key = `${location.relativePath}:${location.line}:${location.column}:${location.endLine ?? 0}:${location.endColumn ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push(location);
    if (locations.length >= MAX_LOCATIONS) break;
  }

  return locations.sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath < right.relativePath ? -1 : 1;
    }
    if (left.line !== right.line) return left.line - right.line;
    return left.column - right.column;
  });
}

const LSP_REQUEST_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）。`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function requestLanguageService<TResult>(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs,
  method: string,
  params: Record<string, unknown>
): Promise<TResult> {
  if (!host.languageService) {
    throw new Error('当前运行时没有可用的语言服务能力。');
  }

  const file = await host.readTextFile({
    relativePath: args.relativePath,
    maxBytes: 1_000_000,
  });

  return await withTimeout(
    host.languageService.request<TResult>({
      relativePath: args.relativePath,
      languageId: args.languageId,
      method,
      content: file.content,
      params: {
        textDocument: { uri: workspaceFileUri(host.workspacePath, args.relativePath) },
        position: toLspPosition(args.line, args.column),
        ...params,
      },
    }),
    LSP_REQUEST_TIMEOUT_MS,
    method,
  );
}

function unavailableNavigation(message: string): WorkspaceNavigationResult {
  return {
    available: false,
    locations: [],
    message,
  };
}

function unavailableOperation(message: string): WorkspaceCodeOperationResult {
  return {
    available: false,
    ok: false,
    changedFiles: [],
    appliedEdits: 0,
    message,
  };
}

export async function requestWorkspaceSymbolDefinition(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs
): Promise<WorkspaceNavigationResult> {
  if (!host.languageService) {
    return unavailableNavigation('当前运行时没有可用的定义跳转能力。');
  }

  try {
    const result = await requestLanguageService<unknown>(host, args, 'textDocument/definition', {});
    return {
      available: true,
      locations: normalizeLocations(host.workspacePath, result),
    };
  } catch (error) {
    return unavailableNavigation(error instanceof Error ? error.message : '定义跳转失败。');
  }
}

export async function requestWorkspaceSymbolReferences(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs & { includeDeclaration?: boolean }
): Promise<WorkspaceNavigationResult> {
  if (!host.languageService) {
    return unavailableNavigation('当前运行时没有可用的引用查找能力。');
  }

  try {
    const result = await requestLanguageService<unknown>(host, args, 'textDocument/references', {
      context: {
        includeDeclaration: args.includeDeclaration !== false,
      },
    });
    return {
      available: true,
      locations: normalizeLocations(host.workspacePath, result),
    };
  } catch (error) {
    return unavailableNavigation(error instanceof Error ? error.message : '引用查找失败。');
  }
}

function collectWorkspaceEditChanges(
  workspacePath: string,
  edit: LspWorkspaceEdit | null | undefined
): Map<string, LspTextEdit[]> {
  const changes = new Map<string, LspTextEdit[]>();
  if (!edit) {
    return changes;
  }

  const hasDocumentChanges = Array.isArray(edit.documentChanges) && edit.documentChanges.length > 0;

  if (!hasDocumentChanges) {
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
      const relativePath = relativePathFromFileUri(workspacePath, uri);
      if (!relativePath || !Array.isArray(edits) || edits.length === 0) {
        continue;
      }
      changes.set(relativePath, edits);
    }
    return changes;
  }

  for (const change of edit.documentChanges ?? []) {
    if (!change || typeof change !== 'object' || !('textDocument' in change)) {
      continue;
    }
    const relativePath = relativePathFromFileUri(workspacePath, change.textDocument?.uri);
    if (!relativePath || !Array.isArray(change.edits) || change.edits.length === 0) {
      continue;
    }
    const existing = changes.get(relativePath) ?? [];
    existing.push(...change.edits);
    changes.set(relativePath, existing);
  }

  return changes;
}

async function applyWorkspaceEdit(host: WorkspaceHost, edit: LspWorkspaceEdit | null | undefined): Promise<WorkspaceCodeOperationResult> {
  if (!host.writeTextFile) {
    return unavailableOperation('当前运行时不支持应用语言服务返回的文件修改。');
  }

  const groupedChanges = collectWorkspaceEditChanges(host.workspacePath, edit);
  if (groupedChanges.size === 0) {
    return {
      available: true,
      ok: false,
      changedFiles: [],
      appliedEdits: 0,
      message: '语言服务没有返回可应用的文本改动。',
    };
  }

  const changedFiles: string[] = [];
  const failedFiles: string[] = [];
  let appliedEdits = 0;
  for (const [relativePath, edits] of groupedChanges.entries()) {
    try {
      const current = await host.readTextFile({ relativePath, maxBytes: 1_000_000 });
      if (current.truncatedByBytes) {
        failedFiles.push(relativePath);
        continue;
      }
      const next = applyTextEdits(current.content, edits);
      await host.writeTextFile({ relativePath, content: next.content });
      changedFiles.push(relativePath);
      appliedEdits += next.appliedEdits;
    } catch {
      failedFiles.push(relativePath);
    }
  }

  const failedNote = failedFiles.length > 0
    ? `（${failedFiles.length} 个文件未能应用：${failedFiles.join('、')}）`
    : '';

  return {
    available: true,
    ok: changedFiles.length > 0,
    changedFiles,
    appliedEdits,
    message: changedFiles.length > 0
      ? `已应用 ${appliedEdits} 处语言服务改动。${failedNote}`
      : `没有可应用的改动。${failedNote}`,
    ...(failedFiles.length > 0 ? { failedFiles } : {}),
  };
}

function buildCodeActionRange(args: WorkspaceLanguagePositionArgs): { range: LspRange } {
  const position = toLspPosition(args.line, args.column);
  return {
    range: {
      start: position,
      end: position,
    },
  };
}

function chooseCodeAction(actions: readonly LspCodeAction[], options: {
  title?: string;
  kind?: string;
  preferredOnly?: boolean;
}): LspCodeAction | null {
  const desiredTitle = options.title?.trim().toLowerCase();
  const desiredKind = options.kind?.trim().toLowerCase();
  const matches = actions.filter((action) => {
    if (!action.edit) {
      return false;
    }
    if (options.preferredOnly === true && action.isPreferred !== true) {
      return false;
    }
    if (desiredTitle && action.title?.trim().toLowerCase() !== desiredTitle) {
      return false;
    }
    if (desiredKind && !action.kind?.trim().toLowerCase().startsWith(desiredKind)) {
      return false;
    }
    return true;
  });

  if (matches.length === 0) {
    return null;
  }
  return matches.find((action) => action.isPreferred) ?? matches[0];
}

async function requestWorkspaceCodeActions(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs,
  only: string[] | undefined
): Promise<LspCodeAction[]> {
  const result = await requestLanguageService<unknown>(host, args, 'textDocument/codeAction', {
    ...buildCodeActionRange(args),
    context: {
      diagnostics: [],
      ...(only && only.length > 0 ? { only } : {}),
    },
  });
  return Array.isArray(result) ? (result as LspCodeAction[]) : [];
}

export async function performWorkspaceRename(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs & { newName: string }
): Promise<WorkspaceCodeOperationResult> {
  if (!host.languageService) {
    return unavailableOperation('当前运行时没有可用的重命名能力。');
  }

  const edit = await requestLanguageService<LspWorkspaceEdit | null>(host, args, 'textDocument/rename', {
    newName: args.newName,
  });
  const result = await applyWorkspaceEdit(host, edit);
  const failureNote = result.failedFiles?.length
    ? `（${result.failedFiles.length} 个文件未能应用：${result.failedFiles.join('、')}）`
    : '';
  return {
    ...result,
    message: result.ok ? `已重命名符号为 ${args.newName}。${failureNote}` : result.message,
  };
}

export async function performWorkspaceFormatFiles(
  host: WorkspaceHost,
  files: Array<{ relativePath: string; languageId: string }>,
  options: { tabSize?: number; insertSpaces?: boolean } = {}
): Promise<WorkspaceCodeOperationResult> {
  if (!host.languageService) {
    return unavailableOperation('当前运行时没有可用的格式化能力。');
  }

  const changedFiles: string[] = [];
  let appliedEdits = 0;
  for (const file of files) {
    const editResult = await requestLanguageService<LspTextEdit[] | null>(
      host,
      {
        relativePath: file.relativePath,
        languageId: file.languageId,
        line: 1,
        column: 1,
      },
      'textDocument/formatting',
      {
        options: {
          tabSize: options.tabSize ?? 2,
          insertSpaces: options.insertSpaces ?? true,
        },
      }
    );
    const applied = await applyWorkspaceEdit(host, {
      changes: editResult
        ? {
            [workspaceFileUri(host.workspacePath, file.relativePath)]: editResult,
          }
        : undefined,
    });
    if (applied.ok) {
      changedFiles.push(...applied.changedFiles);
      appliedEdits += applied.appliedEdits;
    }
  }

  return {
    available: true,
    ok: changedFiles.length > 0,
    changedFiles,
    appliedEdits,
    message: changedFiles.length > 0 ? `已格式化 ${changedFiles.length} 个文件。` : '没有需要格式化的改动。',
  };
}

export async function performWorkspaceOrganizeImports(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs
): Promise<WorkspaceCodeOperationResult> {
  if (!host.languageService) {
    return unavailableOperation('当前运行时没有可用的导入整理能力。');
  }

  const actions = await requestWorkspaceCodeActions(host, args, ['source.organizeImports']);
  const action = chooseCodeAction(actions, { kind: 'source.organizeImports' });
  if (!action?.edit) {
    return {
      available: true,
      ok: false,
      changedFiles: [],
      appliedEdits: 0,
      message: '没有可应用的 organize imports 动作。',
    };
  }

  const result = await applyWorkspaceEdit(host, action.edit);
  return {
    ...result,
    actionTitle: action.title,
    message: result.ok ? `已整理导入：${action.title ?? 'source.organizeImports'}` : result.message,
  };
}

export async function performWorkspaceApplyCodeAction(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs & {
    title?: string;
    kind?: string;
    preferredOnly?: boolean;
  }
): Promise<WorkspaceCodeOperationResult> {
  if (!host.languageService) {
    return unavailableOperation('当前运行时没有可用的代码动作能力。');
  }

  const actions = await requestWorkspaceCodeActions(host, args, args.kind ? [args.kind] : undefined);
  const action = chooseCodeAction(actions, {
    title: args.title,
    kind: args.kind,
    preferredOnly: args.preferredOnly,
  });
  if (!action?.edit) {
    return {
      available: true,
      ok: false,
      changedFiles: [],
      appliedEdits: 0,
      message: '没有找到匹配的可应用代码动作。',
    };
  }

  const result = await applyWorkspaceEdit(host, action.edit);
  return {
    ...result,
    actionTitle: action.title,
    message: result.ok ? `已应用代码动作：${action.title ?? action.kind ?? 'unnamed action'}` : result.message,
  };
}

export async function performWorkspaceFixDiagnostics(
  host: WorkspaceHost,
  args: WorkspaceLanguagePositionArgs
): Promise<WorkspaceCodeOperationResult> {
  const preferred = await performWorkspaceApplyCodeAction(host, {
    ...args,
    kind: 'quickfix',
    preferredOnly: true,
  });
  if (preferred.ok) {
    return preferred;
  }
  return await performWorkspaceApplyCodeAction(host, {
    ...args,
    kind: 'quickfix',
    preferredOnly: false,
  });
}

export async function performProjectGraphRename(
  host: WorkspaceHost,
  args: ProjectGraphRenameParams,
): Promise<WorkspaceCodeOperationResult> {
  const plan = planProjectGraphRename(args);

  if (!plan.symbol) {
    return { available: true, ok: false, changedFiles: [], appliedEdits: 0, message: '未找到要重命名的符号。' };
  }
  if (plan.targetFiles.length === 0) {
    return { available: true, ok: false, changedFiles: [], appliedEdits: 0, message: '未找到该符号的引用位置。' };
  }
  if (!host.writeTextFile) {
    return { available: true, ok: false, changedFiles: [], appliedEdits: 0, message: '当前运行时没有可用的文件写入能力。' };
  }

  const changedFiles: string[] = [];
  const skippedFiles: string[] = [];
  let appliedEdits = 0;

  for (const relativePath of plan.targetFiles) {
    const readResult = await host.readTextFile({ relativePath, maxBytes: 1_000_000 });
    if (readResult.truncatedByBytes) {
      skippedFiles.push(relativePath);
      continue;
    }
    const content = readResult.content;
    if (!content) continue;
    const edits = computeRenameEditsForContent(content, plan.oldName, args.newName);
    if (edits.length === 0) continue;
    const next = applyRenameEditsToContent(content, edits);
    if (next === content) continue;
    await host.writeTextFile({ relativePath, content: next });
    changedFiles.push(relativePath);
    appliedEdits += edits.length;
  }

  const skippedNote = skippedFiles.length > 0
    ? `（跳过 ${skippedFiles.length} 个过大而被截断的文件，避免数据丢失）`
    : '';

  return {
    available: true,
    ok: changedFiles.length > 0,
    changedFiles,
    appliedEdits,
    message: changedFiles.length > 0
      ? `已将 ${changedFiles.length} 个文件中的符号重命名为 ${args.newName}（${appliedEdits} 处引用）。${skippedNote}`
      : `没有可安全重命名的文件。${skippedNote}`,
  };
}
