import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asOptionalStringArray,
  asPositiveInteger,
  stripGraphNoise,
  lookupWorkspaceSymbols,
  buildWorkspaceDependencySubgraph,
  findWorkspaceEntrypoints,
  analyzeWorkspaceChangeImpact,
  findWorkspaceSymbolImplementations,
  getWorkspaceSmartContext,
  findSymbolAtPosition,
  extractStructuralSymbols,
  requestWorkspaceSymbolDefinition,
  requestWorkspaceSymbolReferences,
  requestWorkspaceHover,
  requestWorkspaceDocumentSymbol,
  requestWorkspaceSymbol,
  requestWorkspaceImplementation,
  requestWorkspacePrepareCallHierarchy,
  requestWorkspaceIncomingCalls,
  requestWorkspaceOutgoingCalls,
  performWorkspaceRename,
  performWorkspaceOrganizeImports,
  performWorkspaceApplyCodeAction,
  performWorkspaceFixDiagnostics,
  performWorkspaceFormatFiles,
} from '@codepapr/core';
import type {
  WorkspaceNavigationResult,
  WorkspaceHoverResult,
  WorkspaceDocumentSymbolResult,
  WorkspaceSymbolSearchResult,
  WorkspaceCallHierarchyPrepareResult,
  WorkspaceCallHierarchyCallsResult,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type ReadFileResult,
} from './workspaceToolHelpers';
import { type WorkspaceToolContext } from './workspaceToolContext';
import { pathsEquivalent } from '../utils/pathComparison';

export function registerWorkspaceGraphLspTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    getWorkspaceHost,
    resolveLanguageId,
    buildIntelligenceProjectGraph,
    ensureExternalPathAllowed,
  } = ctx;

  registry.register(toolByName('workspace_project_graph'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    // stripGraphNoise 会原地裁剪图，先深拷贝，避免污染共享建图缓存。
    return stripGraphNoise(structuredClone(graph));
  });

  registry.register(toolByName('workspace_symbol_lookup'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return lookupWorkspaceSymbols(graph, {
      query: asOptionalString(args.query),
      relativePath: asOptionalString(args.relativePath),
      symbolKind: asOptionalString(args.symbolKind),
      language: asOptionalString(args.language),
      exported: asOptionalBoolean(args.exported, 'exported'),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_dependency_subgraph'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    const direction = asOptionalString(args.direction);
    return buildWorkspaceDependencySubgraph(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      direction:
        direction === 'incoming' || direction === 'outgoing' || direction === 'both'
          ? direction
          : undefined,
      depth: asOptionalNumber(args.depth),
      maxNodes: asOptionalNumber(args.maxNodes),
      maxEdges: asOptionalNumber(args.maxEdges),
    });
  });

  registry.register(toolByName('workspace_entrypoints'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return findWorkspaceEntrypoints(graph, asOptionalNumber(args.limit));
  });

  registry.register(toolByName('workspace_change_impact'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return analyzeWorkspaceChangeImpact(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
      maxNodes: asOptionalNumber(args.maxNodes),
      maxEdges: asOptionalNumber(args.maxEdges),
    });
  });

  registry.register(toolByName('workspace_symbol_implementations'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return findWorkspaceSymbolImplementations(graph, {
      symbolId: asOptionalString(args.symbolId),
      relativePath: asOptionalString(args.relativePath),
      symbolName: asOptionalString(args.symbolName),
      limit: asOptionalNumber(args.limit),
    });
  });

  registry.register(toolByName('workspace_smart_context'), async (args: Record<string, unknown>) => {
    const graph = await buildIntelligenceProjectGraph(args);
    return getWorkspaceSmartContext(graph, {
      query: asString(args.query, 'query'),
      relativePath: asOptionalString(args.relativePath),
      depth: asOptionalNumber(args.depth),
    });
  });

  // ── AST/项目图兜底：LSP 不可用或无结果时，用 AST 项目图提供降级答案（source/confidence 标注精度）──
  const astFallback = {
    async definition(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceNavigationResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, locations: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const lookup = lookupWorkspaceSymbols(graph, { query: node.label, limit: 10 });
      return {
        available: true,
        locations: lookup.matches.map((m) => ({ relativePath: m.path, line: m.line ?? 1, column: 1 })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 项目图的定义查找（按符号名匹配，可能不精确）。',
      };
    },
    async references(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceNavigationResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, locations: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const impact = analyzeWorkspaceChangeImpact(graph, { symbolId: node.id, maxNodes: 100 });
      return {
        available: true,
        locations: impact.impactedSymbols.map((m) => ({ relativePath: m.path, line: m.line ?? 1, column: 1 })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 项目图的引用查找（incoming 依赖，符号级而非精确位置）。',
      };
    },
    async implementation(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceNavigationResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, locations: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const impl = findWorkspaceSymbolImplementations(graph, { symbolName: node.label, limit: 20 });
      return {
        available: true,
        locations: impl.implementations.map((m) => ({ relativePath: m.path, line: m.line ?? 1, column: 1 })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 项目图的实现查找。',
      };
    },
    async workspaceSymbol(args: Record<string, unknown>, query?: string): Promise<WorkspaceSymbolSearchResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const lookup = lookupWorkspaceSymbols(graph, { query, limit: 50 });
      return {
        available: true,
        symbols: lookup.matches.map((m) => ({
          name: m.name,
          kind: m.kind,
          relativePath: m.path,
          line: m.line ?? 1,
          column: 1,
          ...(m.containerName ? { containerName: m.containerName } : {}),
        })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 项目图的工作区符号检索。',
      };
    },
    async documentSymbol(relativePath: string): Promise<WorkspaceDocumentSymbolResult> {
      await ensureExternalPathAllowed(relativePath, 'read');
      const file = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: workspace(),
        relativePath,
        maxBytes: 1_000_000,
      });
      const symbols = extractStructuralSymbols(relativePath, file.content);
      return {
        available: true,
        symbols: symbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          relativePath,
          line: s.line,
          column: 1,
          ...(s.containerName ? { containerName: s.containerName } : {}),
        })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 的文件符号大纲。',
      };
    },
    async hover(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceHoverResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node?.symbol) {
        return { available: false, source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const contents = node.symbol.signature || `${node.symbol.kind} ${node.label}`;
      return { available: true, contents, source: 'ast', confidence: 'medium', message: '基于 AST 的符号签名（无类型信息）。' };
    },
    async prepareCallHierarchy(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceCallHierarchyPrepareResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, items: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      return {
        available: true,
        items: [{ name: node.label, kind: node.symbol?.kind ?? 'symbol', relativePath: node.path, line: node.symbol?.line ?? line, column: 1 }],
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 的调用层级项。',
      };
    },
    async incomingCalls(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceCallHierarchyCallsResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, calls: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const impact = analyzeWorkspaceChangeImpact(graph, { symbolId: node.id, maxNodes: 100 });
      return {
        available: true,
        calls: impact.impactedSymbols.map((m) => ({ name: m.name, relativePath: m.path, line: m.line ?? 1, column: 1 })),
        source: 'ast',
        confidence: 'medium',
        message: '基于 AST 项目图的入调用（incoming 依赖）。',
      };
    },
    async outgoingCalls(args: Record<string, unknown>, relativePath: string, line: number, column?: number): Promise<WorkspaceCallHierarchyCallsResult> {
      const graph = await buildIntelligenceProjectGraph(args);
      const node = findSymbolAtPosition(graph, relativePath, line, column ?? 1);
      if (!node) {
        return { available: false, calls: [], source: 'ast', confidence: 'low', message: 'AST 未能在该位置定位符号。' };
      }
      const sub = buildWorkspaceDependencySubgraph(graph, { symbolId: node.id, direction: 'outgoing', maxNodes: 100 });
      const calls = sub.nodes
        .filter((n) => n.kind === 'symbol' && n.id !== node.id)
        .map((n) => ({ name: n.label, relativePath: n.path, line: n.symbol?.line ?? 1, column: 1 }));
      return { available: true, calls, source: 'ast', confidence: 'medium', message: '基于 AST 项目图的出调用（outgoing 依赖）。' };
    },
  };

  registry.register(toolByName('workspace_symbol_definition'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceSymbolDefinition(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.locations.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.definition(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_symbol_references'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceSymbolReferences(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
      includeDeclaration: asOptionalBoolean(args.includeDeclaration, 'includeDeclaration'),
    });
    if (lsp.available && lsp.locations.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.references(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_symbol_hover'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceHover(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.contents) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.hover(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_document_symbol'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const lsp = await requestWorkspaceDocumentSymbol(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asOptionalNumber(args.line) ?? 1,
      column: asOptionalNumber(args.column),
    });
    if (lsp.available && lsp.symbols.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.documentSymbol(relativePath);
  });

  registry.register(toolByName('workspace_workspace_symbol'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const query = asOptionalString(args.query);
    const lsp = await requestWorkspaceSymbol(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asOptionalNumber(args.line) ?? 1,
      column: asOptionalNumber(args.column),
      query,
    });
    if (lsp.available && lsp.symbols.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.workspaceSymbol(args, query);
  });

  registry.register(toolByName('workspace_implementation'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceImplementation(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.locations.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.implementation(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_prepare_call_hierarchy'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspacePrepareCallHierarchy(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.items.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.prepareCallHierarchy(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_incoming_calls'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceIncomingCalls(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.calls.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.incomingCalls(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_outgoing_calls'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    const line = asPositiveInteger(args.line, 'line');
    const column = asOptionalNumber(args.column);
    const lsp = await requestWorkspaceOutgoingCalls(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line,
      column,
    });
    if (lsp.available && lsp.calls.length > 0) return { ...lsp, source: 'lsp', confidence: 'high' };
    return await astFallback.outgoingCalls(args, relativePath, line, column);
  });

  registry.register(toolByName('workspace_rename_symbol'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceRename(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      newName: asString(args.newName, 'newName'),
    });
  });

  registry.register(toolByName('workspace_organize_imports'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceOrganizeImports(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_apply_code_action'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceApplyCodeAction(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line, 'line'),
      column: asOptionalNumber(args.column),
      title: asOptionalString(args.title),
      kind: asOptionalString(args.kind),
      preferredOnly: asOptionalBoolean(args.preferredOnly, 'preferredOnly'),
    });
  });

  registry.register(toolByName('workspace_fix_diagnostics'), async (args: Record<string, unknown>) => {
    const relativePath = asString(args.relativePath, 'relativePath');
    return await performWorkspaceFixDiagnostics(getWorkspaceHost(), {
      relativePath,
      languageId: resolveLanguageId(relativePath),
      line: asPositiveInteger(args.line ?? 1, 'line'),
      column: asOptionalNumber(args.column) ?? 1,
    });
  });

  registry.register(toolByName('workspace_lsp_diagnostics'), async (args: Record<string, unknown>) => {
    const relativePath = asOptionalString(args.relativePath);
    if (relativePath) {
      const languageId = resolveLanguageId(relativePath);
      const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>(
        'lsp_get_diagnostics',
        { workspacePath: workspace(), languageId }
      );
      const allDiags = result.diagnostics ?? {};
      // 平台感知大小写：LSP 服务器报告的文件 URI 可能与 relativePath 大小写
      // 不一致（macOS/Windows 常见），后缀匹配必须按平台大小写不敏感。
      const fileUri = Object.keys(allDiags).find(
        (uri) =>
          pathsEquivalent(uri, relativePath) ||
          pathsEquivalent(uri.replace(/\\/g, '/'), relativePath)
      );
      const fileDiags = fileUri ? (allDiags[fileUri]?.diagnostics ?? []) : [];
      return JSON.stringify({
        relativePath,
        totalCount: fileDiags.length,
        diagnostics: fileDiags,
      });
    }
    const summary: Record<string, { count: number; topIssues: string[] }> = {};
    let langIds: string[] = [];
    try {
      const providers = await invoke<Array<{ languageId: string }>>('list_available_symbol_providers');
      langIds = providers.map((p) => p.languageId);
    } catch {
      // 兜底列表需与 Rust 侧注册的所有 SymbolProvider 语言保持同步
      // （src-tauri/src/symbol_provider.rs：LSP + AST + Regex 注册的并集），
      // 漂移会导致部分语言在 invoke 失败时静默缺失诊断。
      langIds = [
        'typescript',
        'html',
        'css',
        'json',
        'yaml',
        'python',
        'csharp',
        'rust',
        'java',
        'cpp',
        'go',
        'shellscript',
        'swift',
        'sql',
        'markdown',
        'typescriptreact',
        'javascript',
        'php',
        'ruby',
        'kotlin',
        'dart',
      ];
    }
    for (const langId of langIds) {
      try {
        const result = await invoke<{ diagnostics: Record<string, { diagnostics?: unknown[] }> }>(
          'lsp_get_diagnostics',
          { workspacePath: workspace(), languageId: langId }
        );
        const diags = result.diagnostics ?? {};
        for (const [uri, entry] of Object.entries(diags)) {
          const diagList = entry.diagnostics ?? [];
          if (diagList.length > 0) {
            const short = uri.replace(/^.*[\\/]/, '');
            summary[short] = {
              count: diagList.length,
              topIssues: (diagList as Array<{ message?: string }>)
                .slice(0, 5)
                .map((d) => d.message ?? ''),
            };
          }
        }
      } catch {
        // LSP not available for this language, skip
      }
    }
    const entries = Object.entries(summary);
    return JSON.stringify({
      totalFiles: entries.length,
      totalIssues: entries.reduce((sum, [, v]) => sum + v.count, 0),
      files: entries.map(([name, info]) => ({ file: name, ...info })),
    });
  });

  registry.register(toolByName('workspace_format_files'), async (args: Record<string, unknown>) => {
    const relativePaths = asOptionalStringArray(args.relativePaths);
    if (!relativePaths || relativePaths.length === 0) {
      throw new Error('relativePaths 必须是非空字符串数组');
    }
    return await performWorkspaceFormatFiles(
      getWorkspaceHost(),
      relativePaths.map((relativePath) => ({
        relativePath,
        languageId: resolveLanguageId(relativePath),
      })),
      {
        tabSize: asOptionalNumber(args.tabSize),
        insertSpaces: asOptionalBoolean(args.insertSpaces, 'insertSpaces'),
      }
    );
  });

}
