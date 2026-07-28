import { describe, expect, it } from 'vitest';
import { WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS, NEW_TOOL_DEFINITIONS, MERGE_TOOL_DEFINITIONS, OLD_MERGE_TOOL_NAMES } from '../src';

describe('workspace intelligence tool definitions', () => {
  it('keeps ProjectGraph as the single overview and semantic graph tool', () => {
    const projectGraph = WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS.find(
      (tool) => tool.name === 'workspace_project_graph'
    );

    expect(projectGraph).toBeDefined();
    expect(projectGraph?.description).toContain('默认的项目理解工具');
    expect(projectGraph?.description).toContain('目录树');
    expect(projectGraph?.description).toContain('代码结构骨架摘要');
    expect(projectGraph?.parameters.properties).toHaveProperty('view');
    expect(
      WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS.some((tool) => tool.name === 'workspace_project_map')
    ).toBe(false);
  });
});

describe('NEW_TOOL_DEFINITIONS', () => {
  const tools = NEW_TOOL_DEFINITIONS;

  it('contains 26 LLM-facing tools', () => {
    expect(tools).toHaveLength(26);
  });

  const actionTools = ['graph', 'lsp', 'lsp_edit', 'git', 'browser', 'shell', 'proc', 'list'] as const;
  const actionRequiredTools = ['graph', 'lsp', 'lsp_edit', 'git', 'browser', 'shell'] as const;

  it.each(actionTools)('%s has action enum constraint', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(tool?.parameters.properties.action).toHaveProperty('enum');
    const actionEnum = (tool?.parameters.properties.action as { enum?: string[] }).enum;
    expect(actionEnum).toBeDefined();
    expect(actionEnum!.length).toBeGreaterThan(0);
  });

  it.each(actionRequiredTools)('%s has action in required', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool?.parameters.required).toContain('action');
  });

  it('proc action is optional (defaults to list)', () => {
    const proc = tools.find((t) => t.name === 'proc')!;
    const required: string[] | undefined = proc.parameters.required;
    expect(required ? required.includes('action') : true).toBe(true);
    // proc has action in properties but not in required
    expect(proc.parameters.properties.action).toBeDefined();
    expect(required || []).not.toContain('action');
  });

  describe('tools without action param have no enum', () => {
    const noActionTools = tools.filter((t) => !actionTools.includes(t.name as typeof actionTools[number]));
    it.each(noActionTools.map((t) => t.name))('%s', (name) => {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.parameters.properties.action || null).toBeNull();
    });
  });

  describe('required fields', () => {
    it('read requires relativePath', () => {
      expect(find('read')?.parameters.required).toContain('relativePath');
    });
    it('write requires relativePath and content', () => {
      expect(find('write')?.parameters.required).toEqual(['relativePath', 'content']);
    });
    it('edit requires relativePath, search, replace', () => {
      expect(find('edit')?.parameters.required).toEqual(['relativePath', 'search', 'replace']);
    });
    it('patch requires patches', () => {
      expect(find('patch')?.parameters.required).toEqual(['patches']);
    });
    it('grep requires query', () => {
      expect(find('grep')?.parameters.required).toContain('query');
    });
    it('glob requires query', () => {
      expect(find('glob')?.parameters.required).toContain('query');
    });
    it('graph requires action', () => {
      expect(find('graph')?.parameters.required).toContain('action');
    });
    it('lsp requires action, relativePath', () => {
      expect(find('lsp')?.parameters.required).toEqual(['action', 'relativePath']);
    });
    it('git requires action', () => {
      expect(find('git')?.parameters.required).toContain('action');
    });
    it('exec requires command', () => {
      expect(find('exec')?.parameters.required).toContain('command');
    });
    it('shell requires action', () => {
      expect(find('shell')?.parameters.required).toContain('action');
    });
    it('web_fetch requires url', () => {
      expect(find('web_fetch')?.parameters.required).toContain('url');
    });
    it('web_download requires url', () => {
      expect(find('web_download')?.parameters.required).toContain('url');
    });
  });

  describe('enum values', () => {
    it('graph has all 14 actions', () => {
      const e = getEnum('graph');
      expect(e).toEqual([
        'full', 'overview', 'lookup', 'implementations', 'dependency',
        'entrypoints', 'impact', 'smart_context', 'dead_code',
        'circular_deps', 'type_hierarchy', 'suggest_refactors',
        'test_impact', 'generate_tests',
      ]);
    });
    it('list has files and overview actions', () => {
      const e = getEnum('list');
      expect(e).toEqual(['files', 'overview']);
    });
    it('lsp has the 9 opencode navigation actions (no diagnostics)', () => {
      const e = getEnum('lsp');
      expect(e).toEqual([
        'goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol',
        'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls',
      ]);
      expect(e).not.toContain('diagnostics');
    });
    it('lsp_edit has rename, code_action, format (no organize_imports, fix)', () => {
      const e = getEnum('lsp_edit');
      expect(e).toEqual(['rename', 'code_action', 'format']);
    });
    it('git has 8 actions', () => {
      const e = getEnum('git');
      expect(e).toEqual(['status', 'diff', 'log', 'branch', 'stage', 'commit', 'restore', 'reset']);
    });
    it('browser has 9 actions', () => {
      const e = getEnum('browser');
      expect(e).toEqual(['open', 'navigate', 'reload', 'close', 'click', 'type', 'read', 'screenshot', 'get']);
    });
    it('shell has 5 actions', () => {
      const e = getEnum('shell');
      expect(e).toEqual(['open', 'send', 'read', 'close', 'list']);
    });
    it('proc has 3 actions', () => {
      const e = getEnum('proc');
      expect(e).toEqual(['list', 'stop', 'stop_all']);
    });
  });

  describe('no old tool names in new definitions', () => {
    it.each(OLD_MERGE_TOOL_NAMES)('"%s" is not a new tool name', (oldName) => {
      const found = tools.find((t) => t.name === oldName);
      expect(found).toBeUndefined();
    });
  });
});

function find(name: string) {
  return NEW_TOOL_DEFINITIONS.find((t) => t.name === name);
}

function getEnum(name: string): string[] {
  const tool = find(name);
  const action = tool?.parameters.properties.action as { enum?: string[] } | undefined;
  return action?.enum ?? [];
}

describe('MERGE_TOOL_DEFINITIONS is alias of NEW_TOOL_DEFINITIONS', () => {
  it('both exports reference the same array', () => {
    expect(MERGE_TOOL_DEFINITIONS).toBe(NEW_TOOL_DEFINITIONS);
  });
});
