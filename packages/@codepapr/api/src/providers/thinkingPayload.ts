import type { IChatRequest, ThinkingPayload } from '@codepapr/types';

export function resolveRequestThinkingPayload(
  request: IChatRequest,
  fallback: ThinkingPayload = 'reasoning',
): ThinkingPayload {
  const raw = request.thinking?.payload;
  if (raw === 'reasoning' || raw === 'thinking' || raw === 'both') {
    return raw;
  }
  return fallback;
}

export function shouldSendThinkingType(
  request: IChatRequest,
  fallback: ThinkingPayload = 'reasoning',
): boolean {
  if (!request.thinking) return false;
  const payload = resolveRequestThinkingPayload(request, fallback);
  return payload === 'thinking' || payload === 'both';
}

export function shouldSendReasoningEffort(
  request: IChatRequest,
  fallback: ThinkingPayload = 'reasoning',
): boolean {
  if (!request.thinking || request.thinking.type === 'disabled') return false;
  const payload = resolveRequestThinkingPayload(request, fallback);
  return payload === 'reasoning' || payload === 'both';
}
