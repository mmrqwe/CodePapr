import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tool/ToolRegistry';
import { registerSharedToolDispatchers } from '../src/tool/workspace/registerSharedWorkspaceTools';

function buildRegistry(): { registry: ToolRegistry; captured: Record<string, unknown>[] } {
  const registry = new ToolRegistry();
  const captured: Record<string, unknown>[] = [];
  const stub = (name: string) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  });

  // bash 分发目标：捕获实际收到的参数
  registry.register(stub('workspace_run_shell_command'), async (args) => {
    captured.push(args);
    return { ok: true };
  });
  registry.register(stub('workspace_start_shell_background_command'), async (args) => {
    captured.push(args);
    return { ok: true };
  });
  registry.register(stub('workspace_list_background_processes'), async () => []);
  registry.register(stub('workspace_stop_background_process'), async () => ({ stopped: true }));
  registry.register(stub('workspace_stop_all_background_processes'), async () => ({ stopped: 0 }));

  registerSharedToolDispatchers({ registry });
  return { registry, captured };
}

describe('bash dispatcher', () => {
  it('maps LLM-facing timeout to timeoutSeconds for the fine-grained tool', async () => {
    const { registry, captured } = buildRegistry();
    await registry.execute('bash', { command: 'sleep 1', timeout: 300 });

    expect(captured).toHaveLength(1);
    expect(captured[0].command).toBe('sleep 1');
    expect(captured[0].timeoutSeconds).toBe(300);
  });

  it('prefers explicit timeoutSeconds over timeout', async () => {
    const { registry, captured } = buildRegistry();
    await registry.execute('bash', { command: 'x', timeout: 300, timeoutSeconds: 120 });

    expect(captured[0].timeoutSeconds).toBe(120);
  });

  it('leaves timeoutSeconds undefined when neither is provided', async () => {
    const { registry, captured } = buildRegistry();
    await registry.execute('bash', { command: 'x' });

    expect(captured[0].timeoutSeconds).toBeUndefined();
  });
});
