import { isExecutionHeavyTask as coreIsExecutionHeavyTask } from '@codepapr/core';

export type RoutingWorkMode = 'agent' | 'plan' | 'ask' | 'app';

export interface RoutingSettings {
  model: string;
  fastModelEnabled: boolean;
  fastModel: string;
  temperature: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  compactionTemperature?: number;
}

export interface TaskModelRoute {
  tier: 'primary' | 'fast';
  model: string;
  temperature: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  reason:
    | 'default'
    | 'plan-mode'
    | 'app-mode'
    | 'execution-heavy'
    | 'context-compaction'
    | 'fast-fallback';
}

export function isExecutionHeavyTask(input: string): boolean {
  return coreIsExecutionHeavyTask(input);
}

export function buildPrimaryModelRoute(
  settings: RoutingSettings,
  reason: TaskModelRoute['reason'] = 'default'
): TaskModelRoute {
  return {
    tier: 'primary',
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    thinkingEnabled: settings.thinkingEnabled,
    reason,
  };
}

export function selectContextCompactionModelRoute(
  settings: RoutingSettings,
  preferredModel?: 'fast' | 'primary'
): TaskModelRoute | null {
  const fastModel = settings.fastModel.trim();
  const temp = settings.compactionTemperature ?? 0.1;
  if (preferredModel === 'primary') {
    return {
      tier: 'primary',
      model: settings.model,
      temperature: temp,
      maxTokens: settings.maxTokens,
      thinkingEnabled: false,
      reason: 'context-compaction',
    };
  }
  if (!settings.fastModelEnabled || !fastModel) {
    return null;
  }

  return {
    tier: 'fast',
    model: fastModel,
    temperature: temp,
    maxTokens: settings.maxTokens,
    thinkingEnabled: false,
    reason: 'context-compaction',
  };
}

export function selectTaskModelRoute(
  settings: RoutingSettings,
  mode: RoutingWorkMode,
  input: string,
  preferredTier?: 'primary' | 'fast'
): TaskModelRoute {
  const fastModel = settings.fastModel?.trim();

  if (preferredTier === 'fast' && settings.fastModelEnabled && fastModel) {
    return {
      tier: 'fast',
      model: fastModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      thinkingEnabled: false,
      reason: 'default',
    };
  }

  const primary = buildPrimaryModelRoute(settings);

  if (mode === 'plan' || mode === 'app') {
    return {
      ...primary,
      reason: mode === 'plan' ? 'plan-mode' : 'app-mode',
    };
  }

  if (isExecutionHeavyTask(input)) {
    return {
      ...primary,
      reason: 'execution-heavy',
    };
  }

  return primary;
}
