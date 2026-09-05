import { describe, expect, it } from 'vitest';
import { FilteringToolRegistry, ToolRegistry } from '../src/tool/ToolRegistry';
import { allowToolForReadOnlyMode, readOnlyModeBlockMessage } from '../src/agent/agentConfig';
import { registerSharedToolDispatchers } from '../src/tool/workspace/registerSharedWorkspaceTools';

function stub(name: string) {
  return { name, description: name, parameters: { type: 'object', properties: {} } };
}

describe('grep dispatcher (T2: literal by default)', () => {
  function build() {
    const registry = new ToolRegistry();
    const captured: Record<string, unknown>[] = [];
    registry.register(stub('workspace_search_text'), async (args) => {
      captured.push(args);
      return { matches: [] };
    });
    registerSharedToolDispatchers({ registry });
    return { registry, captured };
  }

  it('forwards isRegexp:false when the model does not ask for regex', async () => {
    const { registry, captured } = build();
    await registry.execute('grep', { query: 'foo.bar' });
    expect(captured[0].isRegexp).toBe(false);
  });

  it('forwards isRegexp:true only when explicitly requested', async () => {
    const { registry, captured } = build();
    await registry.execute('grep', { query: 'foo.bar', isRegexp: true });
    expect(captured[0].isRegexp).toBe(true);
  });
});

describe('FilteringToolRegistry read-only git gate (T4)', () => {
  function build() {
    const registry = new FilteringToolRegistry(allowToolForReadOnlyMode, readOnlyModeBlockMessage);
    const calls: Record<string, unknown>[] = [];
    registry.register(stub('git'), async (args) => {
      calls.push(args);
      return { ok: true };
    });
    registry.register(stub('write'), async () => ({ ok: true }));
    return { registry, calls };
  }

  it('keeps git visible/registered but rejects mutating actions at execute time', async () => {
    const { registry, calls } = build();
    expect(registry.get('git')).toBeDefined();
    await expect(registry.execute('git', { action: 'status' })).resolves.toEqual({ ok: true });
    await expect(registry.execute('git', { action: 'diff' })).resolves.toEqual({ ok: true });
    await expect(registry.execute('git', { action: 'log' })).resolves.toEqual({ ok: true });
    await expect(registry.execute('git', { action: 'commit' })).rejects.toThrow(/git\(action: commit\)/);
    await expect(registry.execute('git', { action: 'reset' })).rejects.toThrow(/只读模式/);
    expect(calls.map((c) => c.action)).toEqual(['status', 'diff', 'log']);
  });

  it('still hard-blocks fully mutating tools like write', async () => {
    const { registry } = build();
    expect(registry.get('write')).toBeUndefined();
    await expect(registry.execute('write', {})).rejects.toThrow(/No handler/);
  });
});
