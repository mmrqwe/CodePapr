import type { AgentDefinition } from '@codepapr/core';
import type { PaprAgentDef } from '@codepapr/types';

export function paprAgentToCore(
  appAgent: PaprAgentDef,
  appId: string
): AgentDefinition {
  const hasExplicitTools = appAgent.tools && appAgent.tools.length > 0;
  const tools: Record<string, boolean> | undefined = hasExplicitTools
    ? Object.fromEntries(appAgent.tools!.map((t) => [t, true]))
    : undefined;

  return {
    name: `app-${appId}-${appAgent.name}`,
    description: `App agent "${appAgent.name}" from ${appId}`,
    mode: 'subagent',
    model: appAgent.model || 'main',
    prompt: appAgent.systemPrompt ?? 'You are a helpful assistant.',
    tools,
  };
}
