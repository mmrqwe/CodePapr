/**
 * 新工具分发器注册。
 * 将 LLM 可见工具分发到对应的细粒度工具。
 * CLI 和 UI 共用，通过 options 注入平台差异。
 */

import type { IToolDefinition } from '@codepapr/types';
import type { ToolHandler, ToolRegistry } from '../ToolRegistry';
import { MERGE_TOOL_DEFINITIONS } from './mergeToolDefs';
import { asString } from './toolArgHelpers';

function findTool(name: string): IToolDefinition {
  const tool = MERGE_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`工具定义不存在: ${name}`);
  }
  return tool;
}

function forward(registry: ToolRegistry, target: string): ToolHandler {
  return async (args, context) => registry.execute(target, args, context);
}

export interface SharedToolDispatcherOptions {
  registry: ToolRegistry;

  /** graph 工具 handler（平台特有——CLI 直接执行查询，UI 分发到细粒度工具） */
  graphHandler?: ToolHandler;

  /** lsp 工具 handler（平台特有——CLI 传语言 ID，UI 用 LSP 文件解析） */
  lspHandler?: ToolHandler;

  /** browser 工具 handler（平台特有——CLI 降级，UI 完整） */
  browserHandler?: ToolHandler;

  /** question 工具 handler（CLI 直接抛错，UI 返回结构化标记） */
  questionHandler?: ToolHandler;
}

export function registerSharedToolDispatchers(options: SharedToolDispatcherOptions): void {
  const { registry } = options;

  // ──── 文件系统 ────
  registry.register(findTool('read'), forward(registry, 'workspace_read_file'));
  registry.register(findTool('write'), forward(registry, 'workspace_write_file'));
  registry.register(findTool('edit'), async (args, context) => {
    return await registry.execute('workspace_apply_patch', args, context);
  });
  registry.register(findTool('patch'), async (args, context) => {
    return await registry.execute('workspace_apply_diff', args, context);
  });
  registry.register(findTool('grep'), async (args, context) => {
    if (args.semantic === true) {
      const relativePath = typeof args.relativePath === 'string' ? args.relativePath : undefined;
      if (relativePath) {
        try {
          const result = await registry.execute('workspace_workspace_symbol', {
            query: args.query,
            relativePath,
          }, context) as { available?: boolean };
          if (result && result.available !== false) return result;
        } catch { /* LSP 不可用，降级正则 */ }
      }
      const regexResult = await registry.execute('workspace_search_text', { ...args, isRegexp: true }, context) as Record<string, unknown>;
      const semanticNote = '语义搜索不可用（无 LSP 或未指定锚点文件 relativePath），已降级正则搜索。';
      const innerNote = typeof regexResult.note === 'string' ? regexResult.note : '';
      return { ...regexResult, degraded: true, note: innerNote ? `${semanticNote} ${innerNote}` : semanticNote };
    }
    return await registry.execute('workspace_search_text', { ...args, isRegexp: true }, context);
  });
  registry.register(findTool('glob'), async (args, context) => {
    const rawQuery = asString(args.query, 'query');
    const regexQuery = globToRegex(rawQuery);
    return await registry.execute('workspace_search_files', { ...args, query: regexQuery, isRegexp: true }, context);
  });
  registry.register(findTool('list'), forward(registry, 'workspace_list_files'));

  // ──── 项目语义图 ────
  registry.register(findTool('graph'), options.graphHandler ?? createDefaultGraphHandler(registry));

  // ──── LSP 导航 ────
  registry.register(findTool('lsp'), options.lspHandler ?? createDefaultLspHandler(registry));

  // ──── LSP 修改 ────
  registry.register(findTool('lsp_edit'), async (args) => {
    const a = asString(args.action, 'action');
    const m: Record<string, string> = {
      rename: 'workspace_rename_symbol',
      code_action: 'workspace_apply_code_action',
      format: 'workspace_format_files',
    };
    const target = m[a];
    if (!target) throw new Error(`未知的 lsp_edit action: ${a}`);
    return await registry.execute(target, args);
  });

  // ──── 诊断 ────
  registry.register(findTool('diagnostics'), async (args) => {
    if (args.project === true) {
      return await registry.execute('workspace_project_diagnostics', args);
    }
    return await registry.execute('workspace_lsp_diagnostics', args);
  });

  // ──── Git ────
  registry.register(findTool('git'), async (args) => {
    const a = asString(args.action, 'action');
    const m: Record<string, string> = {
      status: 'workspace_git_status',
      diff: 'workspace_git_diff',
      log: 'workspace_git_history',
      branch: 'workspace_git_branch_checkout',
      stage: 'workspace_git_stage',
      commit: 'workspace_git_commit',
      restore: 'workspace_git_restore',
      reset: 'workspace_git_reset',
    };
    const target = m[a];
    if (!target) throw new Error(`未知的 git action: ${a}`);
    return await registry.execute(target, args);
  });

  // ──── bash：shell 命令执行 + 后台进程管理 ────
  registry.register(findTool('bash'), async (args, context) => {
    const a = typeof args.action === 'string' ? args.action : 'run';
    if (a === 'list') {
      return await registry.execute('workspace_list_background_processes', args, context);
    }
    if (a === 'stop') {
      return await registry.execute('workspace_stop_background_process', args, context);
    }
    if (a === 'stop_all') {
      return await registry.execute('workspace_stop_all_background_processes', args, context);
    }
    if (a !== 'run') throw new Error(`未知的 bash action: ${a}`);
    if (args.background === true) {
      return await registry.execute('workspace_start_shell_background_command', args, context);
    }
    // LLM 侧参数名是 timeout，细粒度工具期望 timeoutSeconds；不做映射超时会被静默忽略
    const timeoutSeconds = args.timeoutSeconds ?? args.timeout;
    return await registry.execute('workspace_run_shell_command', { ...args, timeoutSeconds }, context);
  });

  // ──── 浏览器 ────
  registry.register(findTool('browser'), options.browserHandler ?? createDefaultBrowserHandler());

  // ──── Web ────
  // websearch 是原生细粒度工具，直接对 LLM 可见，不需要额外分发器
  registry.register(findTool('webfetch'), async (args) => {
    if (args.save === true) {
      return await registry.execute('web_download_file', {
        url: args.url,
        relativePath: args.relativePath,
      });
    }
    return await registry.execute('web_fetch_url', {
      url: args.url,
      maxBytes: args.maxBytes,
    });
  });

  // ──── 辅助 ────
  registry.register(findTool('skill'), forward(registry, 'skill_load'));
  registry.register(findTool('question'), options.questionHandler ?? createDefaultQuestionHandler());
}

// ──── 默认 handlers ────

function createDefaultGraphHandler(registry: ToolRegistry): ToolHandler {
  return async (args) => {
    const a = asString(args.action, 'action');
    const m: Record<string, string> = {
      full: 'workspace_project_graph',
      overview: 'workspace_project_graph',
      lookup: 'workspace_symbol_lookup',
      dependency: 'workspace_dependency_subgraph',
      entrypoints: 'workspace_entrypoints',
      impact: 'workspace_change_impact',
      implementations: 'workspace_symbol_implementations',
      smart_context: 'workspace_smart_context',
    };
    const target = m[a];
    if (target) return await registry.execute(target, args);

    throw new Error(`graph action "${a}" 需要平台 handler 支持（dead_code/circular_deps/type_hierarchy/suggest_refactors/test_impact/generate_tests）`);
  };
}

function createDefaultLspHandler(registry: ToolRegistry): ToolHandler {
  return async (args) => {
    const a = asString(args.action, 'action');
    const m: Record<string, string> = {
      goToDefinition: 'workspace_symbol_definition',
      findReferences: 'workspace_symbol_references',
      hover: 'workspace_symbol_hover',
      documentSymbol: 'workspace_document_symbol',
      workspaceSymbol: 'workspace_workspace_symbol',
      goToImplementation: 'workspace_implementation',
      prepareCallHierarchy: 'workspace_prepare_call_hierarchy',
      incomingCalls: 'workspace_incoming_calls',
      outgoingCalls: 'workspace_outgoing_calls',
    };
    const target = m[a];
    if (!target) throw new Error(`未知的 lsp action: ${a}`);
    return await registry.execute(target, args);
  };
}

function createDefaultBrowserHandler(): ToolHandler {
  return async (args) => {
    const a = asString(args.action, 'action');
    throw new Error(`当前环境不支持 browser action: ${a}。仅桌面客户端支持完整浏览器交互。`);
  };
}

function createDefaultQuestionHandler(): ToolHandler {
  return async () => {
    throw new Error('question 工具仅在桌面客户端 Plan 模式下可用');
  };
}

function globToRegex(glob: string): string {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          pattern += '(.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      pattern += '\\' + ch;
    } else {
      pattern += ch;
    }
    i += 1;
  }

  return '^' + pattern + '$';
}

// ──── 保留旧接口兼容 ────

/** @deprecated Use registerSharedToolDispatchers */
export function registerSharedMergeToolDispatchers(options: {
  registry: ToolRegistry;
  projectGraphHandler?: ToolHandler;
  lspHandler?: ToolHandler;
  questionHandler?: ToolHandler;
  browserHandler?: ToolHandler;
  terminalActionName?: string;
}): void {
  registerSharedToolDispatchers({
    registry: options.registry,
    graphHandler: options.projectGraphHandler,
    lspHandler: options.lspHandler,
    browserHandler: options.browserHandler,
    questionHandler: options.questionHandler,
  });
}
