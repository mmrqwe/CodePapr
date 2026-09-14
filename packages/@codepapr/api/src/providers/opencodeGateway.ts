/**
 * OpenCode Go/Zen 网关契约支持
 *
 * 网关要求客户端以专属 User-Agent 标识自己（而非通用 SDK/HTTP 库名称），
 * 并为每段对话在 x-opencode-session 请求头中发送稳定的会话 ID，
 * 以便网关优化路由与提示词缓存。缺失会话头会返回 400 MissingSessionID。
 */

/** OpenCode 网关要求专属 User-Agent（形如 my-coding-agent/1.0）。
 *  版本号与应用发布版本同步 bump（见根 package.json）。 */
export const CODEPAPR_OPENCODE_USER_AGENT = 'codepapr/0.1.0';

/** baseURL 是否命中 opencode 网关（含 Zen 与 Go，如 https://opencode.ai/zen/go/v1）。 */
export function isOpencodeGatewayBase(baseURL: string | undefined): boolean {
  return String(baseURL ?? '')
    .toLowerCase()
    .includes('opencode.ai');
}

/** 会话 ID：优先使用对话级传入值（agentRuntimeLoop 按 sessionId 透传），
 *  缺省时回退为 provider 实例级随机 id（连接测试等无会话场景）。 */
export function resolveOpencodeSessionId(sessionId: string | undefined): string {
  return (
    String(sessionId ?? '').trim() ||
    `codepapr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

/** 命中 opencode 网关时注入契约头（x-opencode-session / x-opencode-client /
 *  User-Agent）。调用方传入的 base headers 不会被覆盖；非 opencode 端点原样返回。 */
export function applyOpencodeGatewayHeaders(
  headers: Record<string, string>,
  options: { baseURL?: string; sessionId: string; sessionClient?: string }
): Record<string, string> {
  if (!isOpencodeGatewayBase(options.baseURL)) {
    return headers;
  }
  headers['x-opencode-session'] = options.sessionId;
  headers['x-opencode-client'] =
    String(options.sessionClient ?? '').trim() || 'codepapr';
  headers['User-Agent'] = CODEPAPR_OPENCODE_USER_AGENT;
  return headers;
}
