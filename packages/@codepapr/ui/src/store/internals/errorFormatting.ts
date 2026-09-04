import { DEFAULT_STREAM_MAX_RETRIES, ProviderRequestError } from '@codepapr/api';
import { unwrapErrorBody } from '../../utils/errorEnvelope';
import type { Lang } from './types';

function formatNetworkInterruption(lang: Lang, retries = DEFAULT_STREAM_MAX_RETRIES): string {
  return lang === 'en'
    ? `Connection lost — still failing after ${retries} retries. Please check your network and try again.`
    : lang === 'zh-TW'
    ? `連線中斷，重試 ${retries} 次後仍失敗。請檢查網路後重試。`
    : `连接中断，重试 ${retries} 次后仍失败。请检查网络后重试。`;
}

/** 无 HTTP 状态码的可重试错误 = 流中断 / 请求超时等网络层故障。
 *  429/5xx 带 status，走各自的文案。
 *  请求级重试耗尽（attempts 已设且无 status）同样归入网络层故障文案，
 *  用真实重试次数而不是硬编码常量。 */
function isNetworkInterruption(error: ProviderRequestError): boolean {
  return (
    (error.retriable && error.status === undefined) ||
    (error.attempts !== undefined && error.status === undefined)
  );
}

export function formatProviderError(error: ProviderRequestError, lang: Lang): string {
  if (isNetworkInterruption(error)) {
    return formatNetworkInterruption(lang, error.attempts ?? DEFAULT_STREAM_MAX_RETRIES);
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

  // 兜底分支：先拆错误体信封（JSON 取内层 message + 类型标签，HTML 归一句话），
  // 只有 raw（非 JSON/非 HTML）才回退到原有的整段 message 直出。
  const unwrapped = unwrapErrorBody(error.responseBody ?? error.message);
  const statusEn = error.status ? ` (HTTP ${error.status})` : '';
  const statusZh = error.status ? `（HTTP ${error.status}）` : '';
  let detail: string;
  if (unwrapped.kind === 'json') {
    detail = unwrapped.label
      ? `${unwrapped.label}: ${unwrapped.text}`
      : unwrapped.text;
  } else if (unwrapped.kind === 'html') {
    detail =
      lang === 'en'
        ? 'The server returned an HTML error page instead of a JSON response. Detailed response has been printed to the console.'
        : lang === 'zh-TW'
        ? '服務端返回的是 HTML 錯誤頁而非 JSON 回應。詳細回應已輸出到控制台。'
        : '服务端返回的是 HTML 错误页而非 JSON 响应。详细响应已输出到控制台。';
  } else {
    detail = error.message;
  }

  return lang === 'en'
    ? `Error: ${providerLabel} request failed${statusEn}. ${detail}.${requestIdText}`
    : lang === 'zh-TW'
    ? `錯誤：${providerLabel} 請求失敗${statusZh}。${detail}。${requestIdText}`
    : `错误：${providerLabel} 请求失败${statusZh}。${detail}。${requestIdText}`;
}

function isAgentIdleTimeout(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error as Error & { name?: string }).name === 'AgentIdleTimeoutError'
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Agent idle timeout/i.test(message);
}

function formatAgentIdleTimeout(lang: Lang): string {
  return lang === 'en'
    ? 'The model did not respond for a while, so this turn was stopped. Please try again.'
    : lang === 'zh-TW'
      ? '模型長時間沒有回應，已停止本回合。請再試一次。'
      : '模型长时间没有响应，已停止本回合。请再试一次。';
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

  if (isAgentIdleTimeout(error)) {
    return formatAgentIdleTimeout(lang);
  }

  // PR2：ContextBudget reject-request 的结构化错误。Worker 边界只保留
  // name/message（errorName 透传），按 name 识别，文案本地化（不拼接
  // core 侧的中文 message，避免双语混杂）。
  if (
    error instanceof Error &&
    (error as Error & { name?: string }).name === 'ContextBudgetRejectedError'
  ) {
    return lang === 'en'
      ? 'Context exceeds the configured limit even after emergency compaction. Reduce the task scope, clear older sessions, or increase maxContextTokens.'
      : lang === 'zh-TW'
        ? '上下文超出設定上限，緊急壓縮後仍超限。請縮小任務範圍、清空舊會話或調大 maxContextTokens。'
        : '上下文超出设定上限，紧急压缩后仍超限。请缩小任务范围、清空旧会话或调大 maxContextTokens。';
  }

  const message = error instanceof Error ? error.message : String(error);
  // worker 边界降级为 plain Error 时（只剩 name/message），message 里可能仍带着
  // `HTTP NNN: {json}` 信封，同样先拆封再展示。
  const unwrapped = unwrapErrorBody(message);
  const statusEn = unwrapped.status ? ` (HTTP ${unwrapped.status})` : '';
  const statusZh = unwrapped.status ? `（HTTP ${unwrapped.status}）` : '';
  if (unwrapped.kind === 'json') {
    const detail = unwrapped.label
      ? `${unwrapped.label}: ${unwrapped.text}`
      : unwrapped.text;
    return lang === 'en'
      ? `Error: request failed${statusEn}. ${detail}.`
      : lang === 'zh-TW'
      ? `錯誤：請求失敗${statusZh}。${detail}。`
      : `错误：请求失败${statusZh}。${detail}。`;
  }
  if (unwrapped.kind === 'html') {
    return lang === 'en'
      ? `Error: request failed${statusEn}. The server returned an HTML error page.`
      : lang === 'zh-TW'
      ? `錯誤：請求失敗${statusZh}。服務端返回了 HTML 錯誤頁。`
      : `错误：请求失败${statusZh}。服务端返回了 HTML 错误页。`;
  }
  return lang === 'en'
    ? `Error: ${message}`
    : lang === 'zh-TW'
    ? `錯誤：${message}`
    : `错误：${message}`;
}
