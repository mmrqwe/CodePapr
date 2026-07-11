import { isExecutionHeavyTask } from './agentConfig';

export interface SubagentRouteSettings {
  baseModel: string;
  fastModelEnabled: boolean;
  fastModel?: string;
  taskPrompt: string;
  explicitModel?: string;
  defaultTemperature: number;
  explicitTemperature?: number;
}

export interface SubagentExecutionRoute {
  tier: 'primary' | 'fast';
  model: string;
  temperature: number;
  reason: 'explicit-model' | 'execution-heavy' | 'fast-subtask' | 'default';
}

export function selectSubagentExecutionRoute(
  settings: SubagentRouteSettings
): SubagentExecutionRoute {
  const explicitModel = settings.explicitModel?.trim();
  const fastModel = settings.fastModel?.trim();
  const temperature = settings.explicitTemperature ?? settings.defaultTemperature;

  if (explicitModel) {
    return {
      tier:
        settings.fastModelEnabled && fastModel && explicitModel === fastModel ? 'fast' : 'primary',
      model: explicitModel,
      temperature,
      reason: 'explicit-model',
    };
  }

  if (isExecutionHeavyTask(settings.taskPrompt)) {
    return {
      tier: 'primary',
      model: settings.baseModel,
      temperature,
      reason: 'execution-heavy',
    };
  }

  if (settings.fastModelEnabled && fastModel) {
    return {
      tier: 'fast',
      model: fastModel,
      temperature,
      reason: 'fast-subtask',
    };
  }

  return {
    tier: 'primary',
    model: settings.baseModel,
    temperature,
    reason: 'default',
  };
}
