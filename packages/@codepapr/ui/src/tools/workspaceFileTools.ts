import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asOptionalPositiveInteger,
  asPatchArray,
} from '@codepapr/core';
import type { IImageContent } from '@codepapr/types';
import { toolByName } from './workspaceToolDefinitions';
import {
  OUTLINE_LINE_THRESHOLD,
  LIST_SYMBOL_FILE_LIMIT,
  LIST_SYMBOL_FILE_MAX_BYTES,
  LIST_SYMBOLS_PER_FILE,
  extractFileSymbols,
  findSymbolByName,
  sliceLines,
  formatOutline,
  type ListFilesArgs,
  type ListFilesResult,
  type ReadFileArgs,
  type ReadFileResult,
  type ReadImageFileArgs,
  type ReadImageFileResult,
  type WriteFileArgs,
  type WriteTextFileResult,
  type WriteFileResult,
  type ApplyPatchArgs,
  type ApplyPatchResult,
  type ApplyDiffArgs,
  type ApplyDiffFileResult,
  type ApplyDiffResult,
} from './workspaceToolHelpers';
import { applySearchReplaceDiff, applySearchReplacePatch } from './workspaceToolUtils';
import { lspLanguageFromPath } from '../utils/editorLanguage';
import { type WorkspaceToolContext } from './workspaceToolContext';
import {
  isMemoryFilePath,
  proposeMemoryCandidateFromWrite,
  reprojectMemoryManagedZone,
  MEMORY_WRITE_INTERCEPT_NOTE,
} from './memoryTools';

/**
 * ADR-008/010：memory.md 的 Agent 直接写入被拦截 → 自动写入策略。
 */
async function interceptMemoryFileWrite(
  ctx: WorkspaceToolContext,
  relativePath: string,
  content: string
): Promise<{ intercepted: true; candidateId: string } | { intercepted: false }> {
  if (!isMemoryFilePath(relativePath)) {
    return { intercepted: false };
  }
  const result = await proposeMemoryCandidateFromWrite({
    workspacePath: ctx.workspace(),
    sessionId: ctx.sessionId,
    content,
    origin: 'workspace-write-tool',
  });
  if (result.status === 'saved' && result.projectToBootstrap) {
    await reprojectMemoryManagedZone(ctx.workspace());
  }
  return { intercepted: true, candidateId: result.candidateId };
}

/**
 * 读取结果若被字节上限截断则拒绝用于"读全文 → 局部替换 → 写回"链路：
 * 在截断内容上打补丁并整体写回会静默丢失文件尾部（不可逆数据丢失）。
 */
function assertReadNotTruncated(result: ReadFileResult, relativePath: string): void {
  if (result.truncatedByBytes || result.bytes >= 20_000_000) {
    throw new Error(`文件 ${relativePath} 超过 20MB 上限，请改用 workspace_write_file 重写整个文件`);
  }
}

/** 写后验证：正常全量比对；回读被截断时（读写上限一致，理论上不发生）降级为前缀比对，避免误报失败 */
function assertWriteVerified(verified: ReadFileResult, expected: string, relativePath: string): void {
  const matches = verified.truncatedByBytes
    ? expected.startsWith(verified.content)
    : verified.content === expected;
  if (!matches) {
    throw new Error(
      `文件写入验证失败：${relativePath} 写入后内容与预期不一致。可能由云同步锁或文件系统问题导致，请重试。`
    );
  }
}

export function registerWorkspaceFileTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    readBeforeContent,
    astPreCheck,
    lspDiagnosticsHook,
    describeAmbiguousMatches,
    ensureExternalPathAllowed,
    notifyWorkspaceMutation,
    editHistory,
    options,
    sessionId: toolSessionId,
  } = ctx;
  // app 模式下放行 .CodePapr/apps（Papr 应用源码存放处），其余模式保持屏蔽
  const includeCodePaprApps = options.mode === 'app';

  registry.register(toolByName('workspace_list_files'), async (args: Record<string, unknown>, context) => {
    const parsed: ListFilesArgs = {
      relativePath: asOptionalString(args.relativePath),
      maxDepth: asOptionalNumber(args.maxDepth),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'list', context?.signal);
    const result = await invoke<ListFilesResult>('list_workspace_files', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxDepth: parsed.maxDepth,
      includeCodePaprApps,
    });

    // 轻量逐文件符号：对代码文件附带顶层符号大纲（AST，无 AST 支持或失败则跳过该文件）
    const symbolsByFile: Record<string, string> = {};
    const codeFiles = result.entries
      .filter((e) => !e.isDir && e.bytes <= LIST_SYMBOL_FILE_MAX_BYTES && lspLanguageFromPath(e.path))
      .slice(0, LIST_SYMBOL_FILE_LIMIT);
    await Promise.all(
      codeFiles.map(async (e) => {
        try {
          const languageId = lspLanguageFromPath(e.path);
          const file = await invoke<ReadFileResult>('read_text_file', {
            workspacePath: workspace(),
            relativePath: e.path,
            maxBytes: LIST_SYMBOL_FILE_MAX_BYTES,
          });
          const symbols = await extractFileSymbols(languageId, file.content);
          const topLevel = symbols.filter((s) => !s.containerName).slice(0, LIST_SYMBOLS_PER_FILE);
          if (topLevel.length > 0) {
            symbolsByFile[e.path] = topLevel.map((s) => `${s.name} (${s.kind})`).join(', ');
          }
        } catch {
          // 单文件符号提取失败则跳过（降级）
        }
      })
    );

    const note = result.truncated
      ? '（列表已截断，仅返回部分条目；请改用 relativePath 指定目录或降低 maxDepth 分批浏览）'
      : undefined;

    return { ...result, symbolsByFile, note };
  });

  registry.register(toolByName('workspace_read_file'), async (args: Record<string, unknown>, context) => {
    const parsed: ReadFileArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      maxBytes: asOptionalNumber(args.maxBytes),
      startLine: asOptionalNumber(args.startLine),
      endLine: asOptionalNumber(args.endLine),
      aroundLine: asOptionalNumber(args.aroundLine),
      contextLines: asOptionalNumber(args.contextLines),
      symbol: asOptionalString(args.symbol),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'read', context?.signal);
    const languageId = lspLanguageFromPath(parsed.relativePath);
    const hasLineAnchor =
      parsed.startLine != null || parsed.endLine != null || parsed.aroundLine != null;

    // 符号切片：传了 symbol 时，用 AST 定位符号行范围后只读该符号（无 AST 则降级文本搜索）
    if (parsed.symbol) {
      const full = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath: parsed.relativePath,
        maxBytes: 20_000_000,
      });
      const symbols = await extractFileSymbols(languageId, full.content);
      const target = findSymbolByName(symbols, parsed.symbol);
      if (target) {
        return {
          ...full,
          content: sliceLines(full.content, target.line, target.endLine),
          startLine: target.line,
          endLine: target.endLine,
          truncatedByRange: false,
          symbol: target.name,
          symbolKind: target.kind,
          note: `已用 AST 定位符号 ${target.name} (${target.kind}) L${target.line}-L${target.endLine}，仅返回该符号代码。`,
        };
      }
      const lines = full.content.split('\n');
      const lower = parsed.symbol.toLowerCase();
      const idx = lines.findIndex((l) => l.toLowerCase().includes(lower));
      if (idx >= 0) {
        const start = Math.max(1, idx + 1 - 5);
        const end = Math.min(lines.length, idx + 1 + 20);
        return {
          ...full,
          content: sliceLines(full.content, start, end),
          startLine: start,
          endLine: end,
          truncatedByRange: false,
          note: `该语言无 AST 支持或未找到符号 "${parsed.symbol}"，已降级文本搜索，返回首个匹配行附近 L${start}-L${end}。`,
        };
      }
      return {
        ...full,
        note: `未能定位符号 "${parsed.symbol}"（无 AST 支持且文本未匹配），已返回全文。`,
      };
    }

    const result = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: parsed.maxBytes,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      aroundLine: parsed.aroundLine,
      contextLines: parsed.contextLines,
    });

    // 自动大纲：整文件读取且文件较大、未截断时附带符号大纲（AST 不支持则降级跳过）
    if (
      !hasLineAnchor &&
      languageId &&
      result.totalLines > OUTLINE_LINE_THRESHOLD &&
      !result.truncatedByBytes
    ) {
      const symbols = await extractFileSymbols(languageId, result.content);
      if (symbols.length > 0) {
        return {
          ...result,
          outline: formatOutline(symbols),
          outlineNote: `文件较大（${result.totalLines} 行），已附带 ${symbols.length} 个符号大纲；可用 read(relativePath, symbol: "符号名") 精确读取某个符号。`,
        };
      }
    }

    return result;
  });

  registry.register(toolByName('workspace_read_image'), async (args: Record<string, unknown>, context) => {
    const parsed: ReadImageFileArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      maxBytes: asOptionalNumber(args.maxBytes),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'read', context?.signal);
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

  registry.register(toolByName('workspace_write_file'), async (args: Record<string, unknown>, context) => {
    const parsed: WriteFileArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      content: asString(args.content, 'content'),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'write', context?.signal);

    // ADR-008：memory.md 拦截 → 候选（不落盘）。
    const memoryIntercept = await interceptMemoryFileWrite(ctx, parsed.relativePath, parsed.content);
    if (memoryIntercept.intercepted) {
      return {
        path: '.CodePapr/memory.md',
        intercepted: true,
        candidateId: memoryIntercept.candidateId,
        bytes: 0,
        change: { kind: 'updated', added: 0, deleted: 0, beforeLines: 0, afterLines: 0 },
        notes: [MEMORY_WRITE_INTERCEPT_NOTE],
      } satisfies WriteFileResult;
    }

    const before = await readBeforeContent(parsed.relativePath);

    const notes: string[] = [];
    const preCheck = await astPreCheck(parsed.relativePath, before ?? '', parsed.content);
    if (preCheck.rejected) {
      throw new Error(preCheck.rejected);
    }
    if (preCheck.note) {
      notes.push(preCheck.note);
    }

    const result = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      content: parsed.content,
    });

    const verified = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: Math.max(new TextEncoder().encode(parsed.content).length + 1024, 16384),
    });
    assertWriteVerified(verified, parsed.content, parsed.relativePath);

    const diag = await lspDiagnosticsHook(parsed.relativePath, parsed.content);
    notes.push(diag.note);

    editHistory?.record({
      path: result.path,
      before,
      after: parsed.content,
    });
    notifyWorkspaceMutation([result.path]);
    return {
      ...result,
      diagnostics: diag.diagnostics,
      notes,
    } satisfies WriteFileResult;
  });


  registry.register(toolByName('workspace_apply_patch'), async (args: Record<string, unknown>, context) => {
    const parsed: ApplyPatchArgs = {
      relativePath: asString(args.relativePath, 'relativePath'),
      search: asString(args.search, 'search'),
      replace: asString(args.replace, 'replace'),
      replaceAll: asOptionalBoolean(args.replaceAll, 'replaceAll'),
      expectedOccurrences: asOptionalPositiveInteger(args.expectedOccurrences, 'expectedOccurrences'),
    };
    await ensureExternalPathAllowed(parsed.relativePath, 'write', context?.signal);

    const current = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: 20_000_000,
    });
    assertReadNotTruncated(current, parsed.relativePath);
    const ambiguity = await describeAmbiguousMatches(
      parsed.relativePath,
      current.content,
      parsed.search,
      parsed.replaceAll
    );
    if (ambiguity) {
      throw new Error(ambiguity);
    }
    const patched = applySearchReplacePatch(current.content, {
      search: parsed.search,
      replace: parsed.replace,
      replaceAll: parsed.replaceAll,
      expectedOccurrences: parsed.expectedOccurrences,
    });

    // ADR-008：memory.md 拦截 → 候选（不落盘）。
    const memoryIntercept = await interceptMemoryFileWrite(ctx, parsed.relativePath, patched.content);
    if (memoryIntercept.intercepted) {
      return {
        path: '.CodePapr/memory.md',
        intercepted: true,
        candidateId: memoryIntercept.candidateId,
        replacements: patched.replacements,
        bytes: 0,
        change: { kind: 'updated', added: 0, deleted: 0, beforeLines: 0, afterLines: 0 },
        notes: [MEMORY_WRITE_INTERCEPT_NOTE],
      } satisfies ApplyPatchResult;
    }

    // 前置 AST 语法预检：仅当修改引入新语法错误时拦截、不落盘（语言不支持则降级跳过）
    const notes: string[] = [];
    const preCheck = await astPreCheck(parsed.relativePath, current.content, patched.content);
    if (preCheck.rejected) {
      throw new Error(preCheck.rejected);
    }
    if (preCheck.note) {
      notes.push(preCheck.note);
    }

    const result = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      content: patched.content,
    });

    // 写后验证：重读确认文件内容与写入一致
    const verified = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      maxBytes: Math.max(new TextEncoder().encode(patched.content).length + 1024, 16384),
    });
    assertWriteVerified(verified, patched.content, parsed.relativePath);

    // 后置 LSP 诊断钩子：返回编译诊断供模型继续修复（无 LSP 则降级跳过）
    const diag = await lspDiagnosticsHook(parsed.relativePath, patched.content);
    notes.push(diag.note);

    editHistory?.record({
      path: result.path,
      before: current.content,
      after: patched.content,
    });
    notifyWorkspaceMutation([result.path]);

    return {
      ...result,
      replacements: patched.replacements,
      diagnostics: diag.diagnostics,
      notes,
    } satisfies ApplyPatchResult;
  });

  registry.register(toolByName('workspace_apply_diff'), async (args: Record<string, unknown>, context) => {
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
      await ensureExternalPathAllowed(relativePath, 'write', context?.signal);
      const current = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath,
        maxBytes: 20_000_000,
      });
      assertReadNotTruncated(current, relativePath);
      fileContents[relativePath] = current.content;
      fileBytes[relativePath] = current.bytes;
    }

    // 歧义预检：给出比 applySearchReplaceDiff 泛化报错更明确的提示。
    // 旧实现曾在同一循环里"干跑"逐条应用并维护 runningContents，但结果
    // 从未被使用（applySearchReplaceDiff 会从头重算），且 `catch { break }`
    // 会静默吞掉错误——已删除这段死代码。
    for (const patch of parsed.patches) {
      const patchContent = fileContents[patch.relativePath] ?? '';
      const ambiguity = await describeAmbiguousMatches(
        patch.relativePath,
        patchContent,
        patch.search,
        patch.replaceAll
      );
      if (ambiguity) {
        throw new Error(`${patch.relativePath}: ${ambiguity}`);
      }
    }

    const diff = applySearchReplaceDiff(fileContents, parsed.patches);

    // ADR-008/010：memory.md 拦截 → 自动写入（不落盘）；其余文件正常走写盘。
    const interceptedFiles: ApplyDiffFileResult[] = [];
    const writeFiles = diff.files.filter((file) => !isMemoryFilePath(file.path));
    for (const file of diff.files) {
      if (!isMemoryFilePath(file.path)) continue;
      const result = await proposeMemoryCandidateFromWrite({
        workspacePath: workspace(),
        sessionId: toolSessionId,
        content: file.content,
        origin: 'workspace-apply-diff-tool',
      });
      if (result.status === 'saved' && result.projectToBootstrap) {
        await reprojectMemoryManagedZone(workspace());
      }
      interceptedFiles.push({
        path: file.path,
        intercepted: true,
        candidateId: result.candidateId,
        patches: file.patches,
        replacements: file.replacements,
        bytes: 0,
        change: { kind: 'updated', added: 0, deleted: 0, beforeLines: 0, afterLines: 0 },
        notes: [MEMORY_WRITE_INTERCEPT_NOTE],
      });
    }

    // 前置 AST 语法预检：任一文件引入新语法错误则整体拦截、全部不落盘（语言不支持则降级跳过）
    const notes: string[] = [];
    for (const file of writeFiles) {
      const preCheck = await astPreCheck(file.path, fileContents[file.path] ?? '', file.content);
      if (preCheck.rejected) {
        throw new Error(`${file.path}: ${preCheck.rejected}`);
      }
      if (preCheck.note) {
        notes.push(`${file.path}: ${preCheck.note}`);
      }
    }

    const files: ApplyDiffFileResult[] = [];

    // #25：写盘阶段原子化——旧实现逐文件写+验证，中途失败会留下「前半已应用、
    // 后半未应用」的部分状态。改为：全部写盘并验证通过后才算成功；任一文件
    // 失败则回滚已写入的文件（新文件删除、旧文件恢复原内容），整体报错。
    const applied: Array<{ path: string; before: string | null; result: WriteTextFileResult }> = [];
    try {
      for (const file of writeFiles) {
        const result = await invoke<WriteTextFileResult>('write_text_file', {
          workspacePath: workspace(),
          relativePath: file.path,
          content: file.content,
        });
        // 写成功即登记（必须在验证之前）：验证失败时该文件已落新内容，
        // 若未登记会被回滚漏掉，仍留下部分应用状态。
        applied.push({ path: file.path, before: fileContents[file.path] ?? null, result });

        // 写后验证
        const verified = await invoke<ReadFileResult>('read_text_file', {
          workspacePath: workspace(),
          relativePath: file.path,
          maxBytes: Math.max(new TextEncoder().encode(file.content).length + 1024, 16384),
        });
        assertWriteVerified(verified, file.content, file.path);
      }
    } catch (err) {
      // 回滚已写入的文件：尽量恢复到写前状态
      for (const entry of applied.reverse()) {
        try {
          if (entry.before === null) {
            await invoke('delete_workspace_file', {
              workspacePath: workspace(),
              relativePath: entry.path,
            });
          } else {
            await invoke('write_text_file', {
              workspacePath: workspace(),
              relativePath: entry.path,
              content: entry.before,
            });
          }
        } catch {
          // best-effort 回滚：单个文件失败不阻断整体报错
        }
      }
      throw err;
    }

    // 全部写入成功后才做后置处理：LSP 诊断钩子 + editHistory + 结果
    for (const file of writeFiles) {
      const result = applied.find((entry) => entry.path === file.path)!.result;
      // 后置 LSP 诊断钩子：返回编译诊断供模型继续修复（无 LSP 则降级跳过）
      const diag = await lspDiagnosticsHook(file.path, file.content);
      notes.push(`${file.path}: ${diag.note}`);

      editHistory?.record({
        path: result.path,
        before: fileContents[file.path] ?? null,
        after: file.content,
      });
      files.push({
        ...result,
        patches: file.patches,
        replacements: file.replacements,
        diagnostics: diag.diagnostics,
      });
    }

    notifyWorkspaceMutation(files.map((file) => file.path));

    return {
      files: [...files, ...interceptedFiles],
      totalFiles: diff.totalFiles,
      totalPatches: diff.totalPatches,
      totalReplacements: diff.totalReplacements,
      notes,
    } satisfies ApplyDiffResult;
  });

}
