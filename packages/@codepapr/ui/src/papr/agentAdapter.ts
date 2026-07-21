import type { AgentDefinition } from '@codepapr/core';
import type { PaprAgentDef } from '@codepapr/types';

export function paprAgentToCore(
  appAgent: PaprAgentDef,
  appId: string
): AgentDefinition {
  const tools: Record<string, boolean> = {};
  if (appAgent.tools && appAgent.tools.length > 0) {
    for (const t of appAgent.tools) {
      tools[t] = true;
    }
  }

  return {
    name: `app-${appId}-${appAgent.name}`,
    description: `App agent "${appAgent.name}" from ${appId}`,
    mode: 'subagent',
    model: appAgent.model || 'main',
    prompt: appAgent.systemPrompt ?? 'You are a helpful assistant.',
    tools: appAgent.tools && appAgent.tools.length > 0 ? tools : {},
  };
}
