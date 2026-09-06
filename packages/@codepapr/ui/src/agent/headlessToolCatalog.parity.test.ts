/**
 * Parity guard：headless harness 的工具目录必须与桌面注册表（
 * registerWorkspaceTools + todo + memory，经 agentFactory 相同的
 * FilteringToolRegistry 包装）逐 mode 一致，仅差评测边界内明确豁免的
 * UI-bound 工具集。桌面新增/调整可见工具而未同步 catalog 时，本测试
 * 必须失败。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FilteringToolRegistry,
  ToolRegistry,
  allowToolForReadOnlyMode,
  readOnlyModeBlockMessage,
  isReadOnlyMode,
} from '@codepapr/core';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({})),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { registerWorkspaceTools } from '../tools/workspaceTools';
import { registerTodoListTools } from '../tools/todoListTool';
import { registerMemoryTools } from '../tools/memoryTools';
import {
  HEADLESS_UI_BOUND_EXCLUDED,
  buildHeadlessToolDefinitions,
} from './headlessToolCatalog';

/**
 * P0 评测边界（唯一允许 catalog 少于桌面注册表的名字集）。
 * 桌面若新增 UI-bound 可见工具，omitted 会包含未登记名字 → 本测试失败，
 * 强制显式修订边界；桌面新增非 UI-bound 工具被 catalog 漏掉同理失败。
 */
const HEADLESS_UI_BOUND_OMISSION_UNIVERSE: ReadonlySet<string> = new Set<string>([
  ...HEADLESS_UI_BOUND_EXCLUDED,
]);

interface Case {
  mode: 'ask' | 'plan' | 'agent';
  multimodalEnabled: boolean;
  mcpSearchEnabled: boolean;
}

const CASES: Case[] = [
  { mode: 'ask', multimodalEnabled: false, mcpSearchEnabled: false },
  { mode: 'ask', multimodalEnabled: true, mcpSearchEnabled: false },
  { mode: 'plan', multimodalEnabled: false, mcpSearchEnabled: false },
  { mode: 'agent', multimodalEnabled: false, mcpSearchEnabled: false },
  { mode: 'agent', multimodalEnabled: true, mcpSearchEnabled: false },
  { mode: 'agent', multimodalEnabled: false, mcpSearchEnabled: true },
  { mode: 'agent', multimodalEnabled: true, mcpSearchEnabled: true },
];

function desktopVisibleNames(testCase: Case): string[] {
  const inner: ToolRegistry = isReadOnlyMode(testCase.mode)
    ? new FilteringToolRegistry(allowToolForReadOnlyMode, readOnlyModeBlockMessage)
    : new ToolRegistry();
  registerWorkspaceTools(inner, '/tmp/ws', undefined, undefined, {
    mode: testCase.mode,
    multimodalEnabled: testCase.multimodalEnabled,
    disableWebSearchTools: testCase.mcpSearchEnabled,
  });
  registerTodoListTools(inner, 's1', '', 3);
  registerMemoryTools(inner, '/tmp/ws', 's1');
  return inner
    .getLlmTools()
    .map((tool) => tool.name)
    .sort();
}

function catalogNames(testCase: Case): string[] {
  return buildHeadlessToolDefinitions({
    mode: testCase.mode,
    multimodalEnabled: testCase.multimodalEnabled,
    mcpSearchEnabled: testCase.mcpSearchEnabled,
  })
    .map((tool) => tool.name)
    .sort();
}

describe('headlessToolCatalog ↔ desktop registry parity', () => {
  for (const testCase of CASES) {
    it(`mode=${testCase.mode} mm=${testCase.multimodalEnabled} mcpSearch=${testCase.mcpSearchEnabled}`, () => {
      const desktop = desktopVisibleNames(testCase);
      const catalog = catalogNames(testCase);
      const omitted = desktop.filter((name) => !catalog.includes(name)).sort();
      const added = catalog.filter((name) => !desktop.includes(name)).sort();
      // catalog 绝不允许发明桌面不暴露的工具。
      expect(added).toEqual([]);
      // 差异只能是「已登记的 UI-bound 排除项 ∩ 桌面本模式可见集」。
      expect(omitted).toEqual(
        desktop.filter((name) => HEADLESS_UI_BOUND_OMISSION_UNIVERSE.has(name)).sort()
      );
      // 定义对象必须同源（名称一致还不够，description/parameters 也要一致）。
      const desktopTools = desktopVisibleTools(testCase);
      const catalogTools = buildHeadlessToolDefinitions(testCase);
      for (const tool of catalogTools) {
        expect(desktopTools.find((item) => item.name === tool.name)).toEqual(tool);
      }
    });
  }

  it('harness 永不暴露 app-only / memory 工具（评测边界）', () => {
    for (const mode of ['ask', 'plan', 'agent'] as const) {
      const names = catalogNames({ mode, multimodalEnabled: true, mcpSearchEnabled: false });
      for (const excluded of HEADLESS_UI_BOUND_EXCLUDED) {
        expect(names).not.toContain(excluded);
      }
    }
  });
});

function desktopVisibleTools(testCase: Case) {
  const inner: ToolRegistry = isReadOnlyMode(testCase.mode)
    ? new FilteringToolRegistry(allowToolForReadOnlyMode, readOnlyModeBlockMessage)
    : new ToolRegistry();
  registerWorkspaceTools(inner, '/tmp/ws', undefined, undefined, {
    mode: testCase.mode,
    multimodalEnabled: testCase.multimodalEnabled,
    disableWebSearchTools: testCase.mcpSearchEnabled,
  });
  registerTodoListTools(inner, 's1', '', 3);
  registerMemoryTools(inner, '/tmp/ws', 's1');
  return inner.getLlmTools();
}
