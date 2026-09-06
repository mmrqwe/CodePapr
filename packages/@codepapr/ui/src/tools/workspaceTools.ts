import {
  ToolRegistry,
  APP_ONLY_TOOL_NAMES,
  registerSharedMergeToolDispatchers,
  getWorkspaceSmartContext,
  detectDeadCode,
  detectCircularDependencies,
  buildTypeHierarchy,
  suggestRefactorings,
  selectTestsByChangeImpact,
  generateTestSkeletons,
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalStringArray,
} from '@codepapr/core';
import type { EditHistory } from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import { createWorkspaceToolContext } from './workspaceToolContext';
import { registerWorkspaceFileTools } from './workspaceFileTools';
import { registerWorkspaceAppTools } from './workspaceAppTools';
import { registerWorkspaceExecTools } from './workspaceExecTools';
import { registerWorkspaceSearchWebTools } from './workspaceSearchWebTools';
import { registerWorkspaceBrowserTools } from './workspaceBrowserTools';
import { registerWorkspaceGraphLspTools } from './workspaceGraphLspTools';
import { registerWorkspaceGitTools } from './workspaceGitTools';
import { registerWorkspaceMiscTools } from './workspaceMiscTools';
import {
  type WorkspaceMutationListener,
  type RegisterWorkspaceToolsOptions,
} from './workspaceToolHelpers';

export type { WorkspaceMutationListener, RegisterWorkspaceToolsOptions };

/** question 工具最多返回的预定义选项数，防止模型撑爆 UI 与上下文。 */
const MAX_QUESTION_OPTIONS = 8;

/** 按 Unicode 码点截断（避免切开代理对/组合字符产生乱码），超长补省略号。 */
function truncateSafe(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return `${chars.slice(0, maxLength - 1).join('')}…`;
}


export function registerWorkspaceTools(
  registry: ToolRegistry,
  workspacePath: string,
  editHistory?: EditHistory,
  onWorkspaceMutated?: WorkspaceMutationListener,
  options: RegisterWorkspaceToolsOptions = {}
): void {
  const ctx = createWorkspaceToolContext({
    registry,
    workspacePath,
    editHistory,
    onWorkspaceMutated,
    options,
  });
  registerWorkspaceFileTools(ctx);
  registerWorkspaceAppTools(ctx);
  registerWorkspaceExecTools(ctx);
  registerWorkspaceSearchWebTools(ctx);
  registerWorkspaceBrowserTools(ctx);
  registerWorkspaceGraphLspTools(ctx);
  registerWorkspaceGitTools(ctx);
  registerWorkspaceMiscTools(ctx);

  const { buildIntelligenceProjectGraph } = ctx;

  // ── 细粒度工具（对 LLM 隐藏）─────────────────────
  const oldToolNames = [
    'workspace_list_files', 'workspace_read_file', 'workspace_read_image', 'workspace_write_file',
    'workspace_search_text', 'workspace_search_files',
    'workspace_apply_patch', 'workspace_apply_diff',
    'workspace_project_graph', 'workspace_symbol_lookup', 'workspace_dependency_subgraph',
    'workspace_entrypoints', 'workspace_change_impact', 'workspace_symbol_implementations',
    'workspace_smart_context',
    'workspace_symbol_definition', 'workspace_symbol_references', 'workspace_lsp_diagnostics',
    'workspace_symbol_hover', 'workspace_document_symbol', 'workspace_workspace_symbol',
    'workspace_implementation', 'workspace_prepare_call_hierarchy',
    'workspace_incoming_calls', 'workspace_outgoing_calls',
    'workspace_rename_symbol', 'workspace_organize_imports', 'workspace_apply_code_action',
    'workspace_fix_diagnostics', 'workspace_format_files',
    'workspace_git_status', 'workspace_git_diff', 'workspace_git_history',
    'workspace_git_branch_checkout', 'workspace_git_stage', 'workspace_git_commit',
    'workspace_git_restore', 'workspace_git_reset', 'workspace_restore_undo',
    'workspace_run_command', 'workspace_project_diagnostics',
    'workspace_run_shell_command', 'workspace_start_shell_background_command',
    'workspace_start_background_command', 'workspace_start_preview_session',
    'workspace_list_background_processes', 'workspace_stop_background_process',
    'workspace_stop_all_background_processes',
    'shell_open_session', 'shell_list_sessions', 'shell_read_output',
    'shell_send_input', 'shell_close_session',
    'browser_open_preview', 'browser_get_preview_session', 'browser_navigate_preview',
    'browser_reload_preview', 'browser_close_preview',
    'browser_open_page', 'browser_navigate_page', 'browser_reload_page',
    'browser_click', 'browser_input_text', 'browser_read_dom',
    'browser_take_screenshot', 'browser_close_page',
    'web_fetch_url', 'web_download_file',
    'skill_load', 'local_time_now',
  ];

  registerSharedMergeToolDispatchers({
    registry,
    terminalActionName: 'bash',
    projectGraphHandler: async (args: Record<string, unknown>, context) => {
      const a = asString(args.action, 'action');
      const m: Record<string, string> = { full: 'workspace_project_graph', overview: 'workspace_project_graph', lookup: 'workspace_symbol_lookup', dependency: 'workspace_dependency_subgraph', entrypoints: 'workspace_entrypoints', impact: 'workspace_change_impact', implementations: 'workspace_symbol_implementations' };
      const target = m[a];
      if (target) return await registry.execute(target, args, context);
      const graph = await buildIntelligenceProjectGraph(args);
      if (a === 'smart_context') return await getWorkspaceSmartContext(graph, { query: asString(args.query, 'query'), relativePath: asOptionalString(args.relativePath), depth: asOptionalNumber(args.depth) ?? 2 });
      if (a === 'dead_code') return await detectDeadCode(graph);
      if (a === 'circular_deps') return await detectCircularDependencies(graph);
      if (a === 'type_hierarchy') return await buildTypeHierarchy(graph);
      if (a === 'suggest_refactors') return await suggestRefactorings(graph);
      if (a === 'test_impact') return await selectTestsByChangeImpact(graph, asOptionalStringArray(args.paths) ?? []);
      if (a === 'generate_tests') return await generateTestSkeletons(graph);
      throw new Error(
        `graph 工具无此 action: ${a}。可用 action：${[
          ...Object.keys(m),
          'smart_context',
          'dead_code',
          'circular_deps',
          'type_hierarchy',
          'suggest_refactors',
          'test_impact',
          'generate_tests',
        ].join(' / ')}`
      );
    },
    browserHandler: async (args: Record<string, unknown>, context) => {
      const a = asString(args.action, 'action');
      const m: Record<string, string> = {
        open: 'browser_open_page',
        navigate: 'browser_navigate_page',
        reload: 'browser_reload_page',
        close: 'browser_close_page',
        get: 'browser_get_preview_session',
        click: 'browser_click',
        type: 'browser_input_text',
        read: 'browser_read_dom',
        screenshot: 'browser_take_screenshot',
      };
      const target = m[a];
      if (!target)
        throw new Error(
          `browser 工具无此 action: ${a}。可用 action：${Object.keys(m).join(' / ')}`
        );
      return await registry.execute(target, args, context);
    },
    questionHandler: async (args: Record<string, unknown>) => {
      const question = asString(args.question, 'question');
      const header = truncateSafe(asString(args.header, 'header'), 30);
      const rawOptions = Array.isArray(args.options) ? args.options : undefined;
      const multiple = args.multiple === true;
      const options = rawOptions
        ?.flatMap((item) => {
          if (typeof item === 'string') {
            return item.trim() ? [{ label: truncateSafe(item.trim(), 50) }] : [];
          }
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return [];
          }
          const record = item as Record<string, unknown>;
          if (typeof record.label !== 'string' || !record.label.trim()) {
            return [];
          }
          return [{
            label: truncateSafe(record.label.trim(), 50),
            description: typeof record.description === 'string'
              ? truncateSafe(record.description, 200)
              : undefined,
          }];
        })
        .slice(0, MAX_QUESTION_OPTIONS);

      return {
        __question: true,
        question,
        header,
        ...(options && options.length > 0 ? { options } : {}),
        ...(options && options.length > 0 ? { multiple } : {}),
      };
    },
  });

  registry.register(toolByName('read_image'), async (args) => {
    return registry.execute('workspace_read_image', args);
  });
  if (!options.multimodalEnabled) {
    registry.hideFromLlm('read_image');
  }

  // MCP 搜索启用时底层 web_fetch_url / web_download_file 不注册，
  // 合并层 webfetch 分发器虽已注册但调用必失败，需一并对 LLM 隐藏。
  if (options.disableWebSearchTools) {
    registry.hideFromLlm('webfetch');
  }

  for (const name of oldToolNames) {
    registry.hideFromLlm(name);
  }

  // 按模式过滤工具可见性
  const mode = options.mode ?? 'agent';
  // 与 agentConfig 的 APP_ONLY_TOOL_NAMES 单一事实源保持一致：
  // app_list 是只读发现工具，已从 app-only 名单移出，Agent/Plan/Ask 均可见（T1）。
  if (mode !== 'app') {
    for (const name of APP_ONLY_TOOL_NAMES) {
      registry.hideFromLlm(name);
    }
  }
  if (mode !== 'plan') {
    registry.hideFromLlm('question');
  }

  // graph 工具默认对主代理 LLM 软隐藏：项目结构改用 list（目录树+逐文件轻量符号），符号导航改用 lsp。
  // 软隐藏保留定义与 handler——子代理（如 Explore，exposeGraphToLlm:true）仍可经白名单选取并执行。
  if (!options.exposeGraphToLlm) {
    registry.softHideFromLlm('graph');
  }
}
