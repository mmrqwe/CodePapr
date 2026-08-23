/**
 * GET {baseURL}/models — OpenAI-compat / DeepSeek / local / Claude / Responses.
 * One shot: no chat ping, no retries. Callers type the model name if listing is unsupported.
 */

import { getGlobalFetchFn } from './ILLMProvider';

export const LIST_MODELS_TIMEOUT_MS = 15_000;
export const ANTHROPIC_API_VERSION = '2023-06-01';

export type ListModelsAuth = 'bearer' | 'anthropic';
export type ListModelsErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'http'
  | 'network'
  | 'empty'
  | 'invalid';

export class ListModelsError extends Error {
  readonly kind: ListModelsErrorKind;
  readonly status?: number;

  constructor(kind: ListModelsErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ListModelsError';
    this.kind = kind;
    this.status = status;
  }
}

export function isListModelsError(err: unknown): err is ListModelsError {
  return err instanceof ListModelsError || (err instanceof Error && err.name === 'ListModelsError');
}

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 400) {
    return trimmed;
  }
  return `${trimmed.slice(0, 400)}…`;
}

function collectCatalogItems(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (!body || typeof body !== 'object') {
    return [];
  }
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return obj.data;
  }
  if (Array.isArray(obj.models)) {
    return obj.models;
  }
  return [];
}

function itemModelId(item: unknown): string | undefined {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    return trimmed || undefined;
  }
  if (!item || typeof item !== 'object') {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'model', 'name', 'model_id', 'max_model_id'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Parse OpenAI `{ data: [{ id }] }`, Claude the same, Ollama-style `{ models: [{ name }] }`. */
export function parseModelCatalog(body: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of collectCatalogItems(body)) {
    const id = itemModelId(item);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildHeaders(auth: ListModelsAuth, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = apiKey.trim();
  if (!key) {
    return headers;
  }
  if (auth === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_API_VERSION;
    return headers;
  }
  headers.Authorization = `Bearer ${key}`;
  return headers;
}

export async function listModels(options: {
  baseURL: string;
  apiKey?: string;
  auth?: ListModelsAuth;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string[]> {
  const baseURL = options.baseURL.trim().replace(/\/+$/, '');
  if (!baseURL) {
    throw new ListModelsError('invalid', 'API base URL is required');
  }

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }

  const url = `${baseURL}/models`;
  const fetchFn = options.fetchFn ?? getGlobalFetchFn();
  const timeoutMs = options.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: buildHeaders(options.auth ?? 'bearer', options.apiKey ?? ''),
      signal: controller.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? err;
    }
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new ListModelsError('network', 'Request timed out');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ListModelsError('network', message || 'Network request failed');
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ListModelsError('unauthorized', 'API key rejected', response.status);
  }
  if (response.status === 404) {
    throw new ListModelsError('not_found', 'Model list endpoint not found', 404);
  }
  if (!response.ok) {
    const body = truncateBody(await response.text().catch(() => ''));
    throw new ListModelsError(
      'http',
      body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`,
      response.status
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ListModelsError('invalid', 'Response was not JSON');
  }

  const ids = parseModelCatalog(parsed);
  if (ids.length === 0) {
    throw new ListModelsError('empty', 'Model list was empty');
  }
  return ids;
}
