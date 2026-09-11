/**
 * Headless harness 的 LLM 工具目录：外部 CLI/评测路径专用。
 *
 * 单一事实源约束：本模块只做「名字选择 + 定义查找」，不复制任何工具描述
 * 字符串。定义全部来自 toolByName（workspaceToolDefinitions.ts，含
 * MERGE_TOOL_DEFINITIONS）与 core 工厂；可见性规则来自 core
 * `isPromptToolVisible`（与桌面 promptBuilders 同一函数）。
 *
 * 与桌面 `registerWorkspaceTools` 组装的注册表等价，减去评测边界内
 * 明确不暴露的 UI-bound 工具（HEADLESS_UI_BOUND_EXCLUDED，见 ADR 讨论文档
 * §5 的 headless 策略）。等价性由 headlessToolCatalog.parity.test.ts 强制。
 */
import {
  buildTodoToolDefinition,
  DEFAULT_PROMPT_TOOL_NAMES,
  isMinimalAgentToolName,
  isPromptToolVisible,
  type AgentToolProfile,
  type PromptMode,
} from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import { toolByName } from '../tools/workspaceToolDefinitions';

/**
 * P0 评测边界：这些工具依赖桌面 WebView 生命周期/面板（browser overlay、
 * app 生命周期）。headless 不声明它们——模型看不到就不会调用，避免
 * “每次调用必失败”的脏 trace。P1 若开放 CDP 数据面，从这里移除对应项
 * 并接入应答器。
 */
export const HEADLESS_UI_BOUND_EXCLUDED: ReadonlySet<string> = new Set([
  'browser',
  'app_render',
  'app_list',
  'app_start',
  'app_stop',
  'app_delete',
  'app_publish',
]);

export interface HeadlessToolCatalogOptions {
  mode: PromptMode;
  multimodalEnabled: boolean;
  mcpSearchEnabled: boolean;
  /** task 工具依赖子代理定义；P0 harness 不加载自定义 agents，缺省不暴露。 */
  agentDefinitionsCount?: number;
  /** 工具面档位：与桌面共用 MINIMAL_AGENT_TOOLS 单源（mode ∩ profile）。 */
  toolProfile?: AgentToolProfile;
}

export function buildHeadlessToolDefinitions(
  options: HeadlessToolCatalogOptions
): IToolDefinition[] {
  const { mode, multimodalEnabled, mcpSearchEnabled, agentDefinitionsCount = 0, toolProfile = 'default' } = options;
  const minimal = toolProfile === 'minimal';
  // N1：极简档不加载 MCP 工具，「MCP 搜索替代原生 web」的前提不成立——
  // 若照旧隐藏 websearch/webfetch，极简+MCP 搜索开启会出现零搜索能力。
  const webHidden = mcpSearchEnabled && !minimal;
  const definitions: IToolDefinition[] = [];
  for (const name of DEFAULT_PROMPT_TOOL_NAMES) {
    if (HEADLESS_UI_BOUND_EXCLUDED.has(name)) continue;
    if (name === 'task' && agentDefinitionsCount === 0) continue;
    if (!isPromptToolVisible(name, mode, { multimodalEnabled, mcpSearchEnabled: webHidden })) continue;
    if (minimal && !isMinimalAgentToolName(name)) continue;
    definitions.push(resolveToolDefinition(name));
  }
  return definitions;
}

/** 名字 → 桌面同源定义。找不到立即抛错（宁可在装配期炸，不静默降级）。 */
function resolveToolDefinition(name: string): IToolDefinition {
  if (name === 'todo') {
    const definition = buildTodoToolDefinition();
    if (!definition) {
      throw new Error('buildTodoToolDefinition() 返回空定义');
    }
    return definition;
  }
  if (name === 'task') {
    // 仅在 agentDefinitionsCount > 0 时到达这里；调用方必须经
    // buildTaskToolDefinition 注入真实代理清单，P0 不走该分支。
    throw new Error('task 工具定义需由调用方经 buildTaskToolDefinition 提供');
  }
  return toolByName(name);
}
