import { DEFAULT_STREAM_MAX_RETRIES, ProviderRequestError } from '@codepapr/api';
import type { Lang } from './types';

function formatNetworkInterruption(lang: Lang): string {
  const retries = DEFAULT_STREAM_MAX_RETRIES;
  return lang === 'en'
    ? `Connection lost — still failing after ${retries} retries. Please check your network and try again.`
    : lang === 'zh-TW'
    ? `連線中斷，重試 ${retries} 次後仍失敗。請檢查網路後重試。`
    : `连接中断，重试 ${retries} 次后仍失败。请检查网络后重试。`;
}

/** 无 HTTP 状态码的可重试错误 = 流中断 / 请求超时等网络层故障。
 *  429/5xx 带 status，走各自的文案。 */
function isNetworkInterruption(error: ProviderRequestError): boolean {
  return error.retriable && error.status === undefined;
}

export function formatProviderError(error: ProviderRequestError, lang: Lang): string {
  if (isNetworkInterruption(error)) {
    return formatNetworkInterruption(lang);
  }

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

  if (
    error instanceof Error &&
    (error as Error & { name?: string }).name === 'StreamIdleTimeoutError'
  ) {
    return formatNetworkInterruption(lang);
  }

  const message = error instanceof Error ? error.message : String(error);
  return lang === 'en'
    ? `Error: ${message}`
    : lang === 'zh-TW'
    ? `錯誤：${message}`
    : `错误：${message}`;
}
