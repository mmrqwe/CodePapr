import {
  DEFAULT_LOCAL_BASE_URL,
  isListModelsError,
  listModels,
  type ListModelsAuth,
} from '@codepapr/api';
import { errorMessage } from '@codepapr/common';
import { unwrapErrorBody } from '../../utils/errorEnvelope';
import type { ModelProfile } from '../../store/agentStore';
import type { Translation } from './types';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export type ProfileModelsSource = Pick<ModelProfile, 'apiMode' | 'apiFormat' | 'baseURL' | 'apiKey'>;

export function profileModelsCacheKey(profile: ProfileModelsSource): string {
  return [
    profile.apiMode,
    profile.apiFormat,
    resolveProfileModelsBaseURL(profile) ?? '',
    profile.apiKey.trim(),
  ].join('\0');
}

export function listModelsAuthForProfile(profile: Pick<ProfileModelsSource, 'apiMode' | 'apiFormat'>): ListModelsAuth {
  return profile.apiMode === 'custom' && profile.apiFormat === 'claude' ? 'anthropic' : 'bearer';
}

export function resolveProfileModelsBaseURL(
  profile: Pick<ProfileModelsSource, 'apiMode' | 'baseURL'>
): string | null {
  const trimmed = profile.baseURL.trim().replace(/\/+$/, '');
  if (profile.apiMode === 'deepseek') {
    return trimmed || DEFAULT_DEEPSEEK_BASE_URL;
  }
  if (profile.apiMode === 'local') {
    return trimmed || DEFAULT_LOCAL_BASE_URL;
  }
  return trimmed || null;
}

export function assertCanFetchProfileModels(profile: ProfileModelsSource): void {
  if (profile.apiMode === 'custom' && !profile.baseURL.trim()) {
    throw new Error('need-url');
  }
  if (profile.apiMode !== 'local' && !profile.apiKey.trim()) {
    throw new Error('need-key');
  }
}

export async function listModelsForProfile(
  profile: ProfileModelsSource,
  options?: { signal?: AbortSignal; fetchFn?: typeof fetch }
): Promise<string[]> {
  assertCanFetchProfileModels(profile);
  const baseURL = resolveProfileModelsBaseURL(profile);
  if (!baseURL) {
    throw new Error('need-url');
  }
  return listModels({
    baseURL,
    apiKey: profile.apiKey,
    auth: listModelsAuthForProfile(profile),
    signal: options?.signal,
    fetchFn: options?.fetchFn,
  });
}

export function formatListModelsError(err: unknown, t: Translation): string {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return '';
  }
  if (err instanceof Error) {
    if (err.message === 'need-url') {
      return t.fetchModelsNeedUrl;
    }
    if (err.message === 'need-key') {
      return t.fetchModelsNeedKey;
    }
  }
  if (isListModelsError(err)) {
    switch (err.kind) {
      case 'unauthorized':
        return t.fetchModelsUnauthorized;
      case 'not_found':
        return t.fetchModelsNotFound;
      case 'empty':
        return t.fetchModelsEmpty;
      case 'network':
        return t.fetchModelsNetwork;
      default:
        return formatFetchModelsDetail(t, err.message);
    }
  }
  return formatFetchModelsDetail(t, errorMessage(err));
}

/** 未知类失败：错误体可能是 `HTTP NNN: {json}` 信封，先拆封再展示，不吐裸 JSON。 */
function formatFetchModelsDetail(t: Translation, message: string): string {
  const unwrapped = unwrapErrorBody(message);
  if (unwrapped.kind === 'json') {
    const label = unwrapped.label ? `${unwrapped.label}: ` : '';
    return `${t.fetchModelsFailed}: ${label}${unwrapped.text}`.slice(0, 300);
  }
  if (unwrapped.kind === 'html') {
    return `${t.fetchModelsFailed}: HTML error page`;
  }
  return `${t.fetchModelsFailed}: ${message.slice(0, 300)}`;
}

export function filterModelCatalog(ids: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return ids;
  }
  return ids.filter((id) => id.toLowerCase().includes(needle));
}
