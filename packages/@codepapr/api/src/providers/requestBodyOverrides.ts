import type { RequestBodyOverrides } from '@codepapr/types';

const managedFields = new Set([
  'model', 'messages', 'input', 'system', 'stream', 'tools',
  '__proto__', 'constructor', 'prototype',
]);

export function isRequestBodyOverrideField(key: string): boolean {
  return key.length > 0 && key === key.trim() && !managedFields.has(key);
}

export function normalizeRequestBodyOverrides(input: unknown): RequestBodyOverrides | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const entries = Object.entries(input).filter(([key]) => isRequestBodyOverrideField(key));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function applyRequestBodyOverrides(
  payload: Record<string, unknown>,
  overrides: RequestBodyOverrides | undefined,
): Record<string, unknown> {
  if (!overrides) {
    return payload;
  }
  const body = { ...payload };
  for (const [key, value] of Object.entries(overrides)) {
    if (!isRequestBodyOverrideField(key)) continue;
    if (value === null) {
      delete body[key];
    } else {
      body[key] = value;
    }
  }
  return body;
}

export function getRequestOutputTokenLimit(body: Record<string, unknown>): number | undefined {
  const limit = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

export function reachedRequestOutputLimit(body: Record<string, unknown>, outputTokens: number): boolean {
  const limit = getRequestOutputTokenLimit(body);
  return limit !== undefined && outputTokens >= limit;
}
