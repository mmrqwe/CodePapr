/**
 * errorEnvelope: HTTP 错误体"拆信封"。
 *
 * 各家 LLM provider 的错误体格式五花八门（Anthropic/OpenAI/AWS 套娃/中转站 HTML 页），
 * 类型无法穷举也不该穷举。这里不做任何类型映射表，只做通用拆解：
 *   1. 剥 `HTTP NNN: ` 前缀；
 *   2. JSON → 递归提取"人话"字段（message/msg/detail/reason/error…任意深度），
 *      并提取 type/code 作为展示标签（如 CreditsError、insufficient_quota）；
 *   3. HTML 错误页（网关/中转站常见）→ 标记为 html，由调用方输出一句话文案；
 *   4. 其余 → 原样（raw），行为与旧实现一致。
 * 服务端自己的 message 字段原样透传（不翻译），它天然随上游更新、零维护。
 */

export type UnwrappedErrorBody =
  | { kind: 'json'; status?: number; label?: string; text: string }
  | { kind: 'html'; status?: number }
  | { kind: 'raw'; status?: number };

const HTTP_PREFIX = /^HTTP\s+(\d{3})\s*:\s*/i;

/** 优先按此顺序找消息字段（大小写不敏感，覆盖 AWS 的 Message / OpenAI 的 message 等）。 */
const MESSAGE_KEYS = ['message', 'msg', 'detail', 'reason', 'error_description', 'description', 'error'];

/** type/code 键名（大小写不敏感，含 errorType/errorCode 驼峰变体），
 *  跳过 'error' 这类无信息量的泛型值。 */
const LABEL_KEYS = ['type', 'code', 'error_type', 'errortype', 'error_code', 'errorcode'];
const GENERIC_LABELS = new Set(['error', 'errors', 'failure', 'failed', 'general']);

const MAX_TEXT_LENGTH = 500;

function getCaseInsensitive(obj: Record<string, unknown>, key: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === key) {
      return v;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 递归提取最适合展示给人看的文本；找不到返回 undefined。 */
function findHumanMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => findHumanMessage(item, depth + 1))
      .filter((part): part is string => !!part);
    return parts.length ? parts.join(' ') : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of MESSAGE_KEYS) {
    const direct = value[key];
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }
  }
  // error 键是对象时优先钻进去（{error:{message}} / {type:"error",error:{…}} / AWS 套娃）
  const errorValue = value['error'];
  if (isRecord(errorValue) || Array.isArray(errorValue)) {
    const inner = findHumanMessage(errorValue, depth + 1);
    if (inner) {
      return inner;
    }
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested) || Array.isArray(nested)) {
      const inner = findHumanMessage(nested, depth + 1);
      if (inner) {
        return inner;
      }
    }
  }
  // 没有任何 message-ish 字段：取最长的字符串值兜底（仍好过吐裸 JSON）
  let longest: string | undefined;
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v.trim() && (!longest || v.length > longest.length)) {
      longest = v.trim();
    }
  }
  return longest;
}

/** 提取展示标签：内层 error 的 type/code 优先于外层。 */
function findLabel(value: unknown): string | undefined {
  const scopes: Record<string, unknown>[] = [];
  if (isRecord(value)) {
    scopes.push(value);
    const inner = value['error'];
    if (isRecord(inner)) {
      scopes.unshift(inner);
    }
  }
  for (const scope of scopes) {
    for (const key of LABEL_KEYS) {
      const v = getCaseInsensitive(scope, key);
      const label = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : undefined;
      if (label && !GENERIC_LABELS.has(label.toLowerCase())) {
        return label;
      }
    }
  }
  return undefined;
}

function looksLikeHtml(trimmed: string): boolean {
  if (!trimmed.startsWith('<')) {
    return false;
  }
  return /^<!doctype\s|^<html[\s>]|^<\?xml/i.test(trimmed) || /<\/[a-z]/i.test(trimmed.slice(0, 2000));
}

function capText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

export function unwrapErrorBody(raw: string): UnwrappedErrorBody {
  let body = (raw ?? '').trim();
  let status: number | undefined;
  const prefixMatch = HTTP_PREFIX.exec(body);
  if (prefixMatch) {
    status = Number(prefixMatch[1]);
    body = body.slice(prefixMatch[0].length).trim();
  }
  if (!body) {
    return { kind: 'raw', status };
  }
  if (looksLikeHtml(body)) {
    return { kind: 'html', status };
  }
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const text = findHumanMessage(parsed);
      if (text) {
        return { kind: 'json', status, label: findLabel(parsed), text: capText(text) };
      }
    } catch {
      // 非法 JSON：按原文处理
    }
  }
  return { kind: 'raw', status };
}

/** 把拆封结果里可展示的部分拼成一句 detail（`Label: message`）；raw 返回 undefined。 */
export function unwrappedDetail(unwrapped: UnwrappedErrorBody): string | undefined {
  if (unwrapped.kind === 'json') {
    return unwrapped.label ? `${unwrapped.label}: ${unwrapped.text}` : unwrapped.text;
  }
  return undefined;
}
