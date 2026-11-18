import type { IChatRequest } from '@codepapr/types';

export function isOfficialApiHost(baseURL: string | undefined, hostname: string): boolean {
  try {
    const url = new URL(baseURL ?? '');
    return url.protocol === 'https:' && url.hostname === hostname;
  } catch {
    return false;
  }
}

function openAIModelName(model: string): string {
  const name = model.trim().toLowerCase();
  return name.startsWith('ft:') ? name.split(':')[1] : name;
}

function isOpenAIReasoningModel(model: string): boolean {
  return /^(?:o[1-9]\d*|gpt-(?:[5-9]|\d{2,}))(?=[.-]|$)/.test(openAIModelName(model));
}

export function officialOpenAIReasoningEffort(
  request: IChatRequest,
  fallback?: string,
): string | undefined {
  if (request.thinking?.type !== 'enabled' || !isOpenAIReasoningModel(request.model)) {
    return undefined;
  }
  const name = openAIModelName(request.model);
  if (/^o1-(?:mini|preview)(?:-|$)/.test(name)) {
    return undefined;
  }
  const effort = request.thinking.reasoningEffort?.trim();
  if (!effort || !/^(?:none|minimal|low|medium|high|xhigh|max)$/.test(effort)) {
    return fallback;
  }
  if (/^o[1-9]\d*(?:-|$)/.test(name) && !/^(?:low|medium|high)$/.test(effort)) {
    return fallback;
  }
  if (effort === 'none' && /^gpt-6(?:-astra|\.1-sol|\.2-(?:astra|sol))(?=-|$)/.test(name)) {
    return fallback;
  }
  if (effort === 'minimal' && /^gpt-6\.1-sol(?:-|$)/.test(name)) {
    return fallback;
  }
  return effort;
}

export function supportsOfficialOpenAISampling(model: string, effort: string | undefined): boolean {
  if (!isOpenAIReasoningModel(model)) {
    return true;
  }
  const name = openAIModelName(model);
  // GPT-5.1/5.2 default to no reasoning. GPT-5.4 supports sampling at effort "none".
  return (effort === undefined && /^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/.test(name)) ||
    (effort === 'none' && /^gpt-5\.[124](?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(name));
}
