import { ProviderRequestError } from '@codepapr/api';
import type { Lang } from './types';

export function formatProviderError(error: ProviderRequestError, lang: Lang): string {
  const providerLabel = error.provider || 'LLM';
  const requestIdText = error.requestId
    ? lang === 'en'
      ? ` Request ID: ${error.requestId}.`
      : lang === 'zh-TW'
      ? ` 請求 ID：${error.requestId}。`
      : ` 请求 ID：${error.requestId}。`
    : '';

  if (error.status === 429) {
    return lang === 'en'
      ? `Error: ${providerLabel} request was rate limited (HTTP 429). Check concurrency, quota, or token limits. Detailed response has been printed to the console.${requestIdText}`
      : lang === 'zh-TW'
      ? `錯誤：${providerLabel} 請求觸發了速率限制（HTTP 429）。請檢查並發、額度或 token 限制。詳細回應已輸出到控制台。${requestIdText}`
      : `错误：${providerLabel} 请求触发了速率限制（HTTP 429）。请检查并发、额度或 token 限制。详细响应已输出到控制台。${requestIdText}`;
  }

  return lang === 'en'
    ? `Error: ${providerLabel} request failed${error.status ? ` (HTTP ${error.status})` : ''}. ${error.message}.${requestIdText}`
    : lang === 'zh-TW'
    ? `錯誤：${providerLabel} 請求失敗${error.status ? `（HTTP ${error.status}）` : ''}。${error.message}。${requestIdText}`
    : `错误：${providerLabel} 请求失败${error.status ? `（HTTP ${error.status}）` : ''}。${error.message}。${requestIdText}`;
}

export function formatAgentError(error: unknown, lang: Lang): string {
  if (error instanceof ProviderRequestError) {
    return formatProviderError(error, lang);
  }

  if (
    error instanceof Error &&
    typeof (error as Error & { name?: string }).name === 'string' &&
    (error as Error & { name?: string }).name === 'ProviderRequestError'
  ) {
    return formatProviderError(error as ProviderRequestError, lang);
  }

  const message = error instanceof Error ? error.message : String(error);
  return lang === 'en'
    ? `Error: ${message}`
    : lang === 'zh-TW'
    ? `錯誤：${message}`
    : `错误：${message}`;
}
