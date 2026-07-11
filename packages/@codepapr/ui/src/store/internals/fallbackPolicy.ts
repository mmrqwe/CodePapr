import { ProviderRequestError } from '@codepapr/api';
import type { TaskModelRoute } from '../../utils/modelRouting';
import type { Settings } from './types';

export function shouldFallbackToPrimaryModel(
  error: unknown,
  route: TaskModelRoute,
  settings: Settings
): boolean {
  if (route.tier !== 'fast') {
    return false;
  }

  const primaryModel = settings.model.trim();
  if (!primaryModel || route.model === primaryModel) {
    return false;
  }

  return (
    error instanceof ProviderRequestError ||
    (error instanceof Error && error.name === 'ProviderRequestError')
  );
}
