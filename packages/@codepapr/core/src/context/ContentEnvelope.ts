/**
 * ContentEnvelope：跨边界内容的安全信封（PR4，不变式 9）。
 *
 * 所有「外部进入内部」的内容流（web / MCP / 工具输出 / session recall /
 * checkpoint 抽取 / memory 候选准入）都必须先包成信封，携带 source / trust /
 * origin / risk flags。准入策略只读信封字段，绝不直接消费裸内容。
 *
 * 基线安全判定是确定性的，不依赖 LLM。
 */

export type ContentSourceKind =
  | 'user'
  | 'assistant'
  | 'tool-output'
  | 'web'
  | 'mcp'
  | 'session-recall'
  | 'checkpoint-extraction'
  | 'memory-candidate';

export type ContentTrust = 'trusted' | 'workspace' | 'derived' | 'untrusted';

export type ContentRiskFlag =
  | 'injection-instruction'
  | 'policy-bypass'
  | 'secret'
  | 'shell-command'
  | 'upload-command';

export interface ContentEnvelope {
  source: ContentSourceKind;
  trust: ContentTrust;
  /** 来源标识：文件路径 / URL / 工具名 / 消息 ID。 */
  origin: string;
  content: string;
  riskFlags: ContentRiskFlag[];
}

/** 注入指令模式：试图改变行为/规则/权限的措辞。 */
const INJECTION_PATTERN =
  /忽略|ignore|override|覆盖|改写|忘记.*(之前|以上)|forget (previous|everything)|disregard|你是现在|从现在开始|new instructions|新的指令|你必须服从|must obey|删除所有文件|把.*权限.*给|修改安全策略|change (the )?policy|bypass|绕过/i;

const SECRET_PATTERNS: ReadonlyArray<{ label: ContentRiskFlag; pattern: RegExp }> = [
  { label: 'secret', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'secret', pattern: /(sk|api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}["']?/i },
  { label: 'shell-command', pattern: /(^|\n)\s*(sudo\s+|rm\s+-rf\s+|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))/i },
  { label: 'upload-command', pattern: /(scp\s+|rsync\s+.*(user@|:\/\/)|curl\s+.*-F\s|git\s+push.*--force)/i },
  { label: 'policy-bypass', pattern: /(disable|turn off|关闭|停用)\s+(sandbox|防火墙|firewall|permission|权限|安全)/i },
];

/** 零宽字符（视觉不可见的拼接/混淆载体）：检测前剥离。 */
const ZERO_WIDTH_CHARS = /[\u200B-\u200F\u2028\u2029\uFEFF\u2060-\u206F]/g;

/** Base64 载荷启发式：≥40 字符的 base64 块（允许换行折叠）。 */
const BASE64_BLOB_PATTERN = /(?:[A-Za-z0-9+/]{40,}={0,2}(?:\s{0,2})?)+/g;

/** 尝试解码 Base64 为 UTF-8（标准/URL-safe 均支持）。 */
function decodeBase64Utf8(input: string): string | null {
  const compact = input.replace(/\s+/g, '');
  if (compact.length % 4 !== 0) return null;
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * P2-3：注入检测加固。正则检测是 best-effort，这里补三类确定性归一化：
 * 1. Unicode NFKC：同形字（𝕚𝕘𝕟𝕠𝕣𝕖 等）折叠回基础字形后再匹配；
 * 2. 零宽字符剥离（视觉拼接混淆）；
 * 3. Base64 载荷：解码后对解码文本再跑一次注入/命令检测。
 */
function detectRiskFlags(content: string): ContentRiskFlag[] {
  const flags = new Set<ContentRiskFlag>();

  const normalizedCandidates = [
    content.replace(ZERO_WIDTH_CHARS, '').normalize('NFKC'),
  ];
  for (const match of content.matchAll(BASE64_BLOB_PATTERN)) {
    const decoded = decodeBase64Utf8(match[0]);
    if (decoded && decoded.length > 0 && !/^[\x00-\x1F]*$/.test(decoded)) {
      normalizedCandidates.push(decoded.replace(ZERO_WIDTH_CHARS, '').normalize('NFKC'));
    }
  }

  for (const candidate of normalizedCandidates) {
    if (INJECTION_PATTERN.test(candidate)) {
      flags.add('injection-instruction');
    }
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(candidate)) {
        flags.add(label);
      }
    }
  }
  return [...flags];
}

export interface EnvelopeInput {
  source: ContentSourceKind;
  trust: ContentTrust;
  origin: string;
  content: string;
}

/** 包信封（含保守注入/密钥/命令风险标记）。 */
export function envelopeContent(input: EnvelopeInput): ContentEnvelope {
  return {
    source: input.source,
    trust: input.trust,
    origin: input.origin,
    content: input.content,
    riskFlags: detectRiskFlags(input.content),
  };
}

/**
 * 保守密钥脱敏（确定性强力规则，宁错杀不漏放）。仅替换值部分，
 * 保留键名以便人类读懂「这里曾有密钥」。
 */
export function redactSecrets(content: string): string {
  let redacted = content;
  redacted = redacted.replace(
    /((?:sk|api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)(["']?)[A-Za-z0-9_\-+/=]{16,}\2/gi,
    '$1$2[REDACTED]$2'
  );
  redacted = redacted.replace(
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    '$1\n[REDACTED]\n$2'
  );
  return redacted;
}

export type MemoryAdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: string };

/**
 * 记忆准入门（不变式：只有 user-confirmed / 执行验证 / 可信项目证据 /
 * 多可信来源才能自动准入；web/MCP 永不自动准入）。
 */
export function planMemoryAdmission(envelope: ContentEnvelope): MemoryAdmissionResult {
  if (envelope.trust === 'untrusted') {
    return { admitted: false, reason: 'untrusted-source' };
  }
  if (envelope.source === 'web' || envelope.source === 'mcp') {
    return { admitted: false, reason: 'untrusted-source' };
  }
  if (envelope.riskFlags.length > 0) {
    return {
      admitted: false,
      reason: `risk-flags:${envelope.riskFlags.join(',')}`,
    };
  }
  const trimmed = envelope.content.trim();
  if (trimmed.length < 8 || trimmed.length > 2_000) {
    return { admitted: false, reason: 'content-size' };
  }
  // 允许准入的自动来源：工具执行验证（workspace）与用户/检查点抽取（trusted/derived）。
  const allowedSource =
    envelope.source === 'tool-output' ||
    envelope.source === 'user' ||
    envelope.source === 'checkpoint-extraction' ||
    envelope.source === 'memory-candidate';
  if (!allowedSource) {
    return { admitted: false, reason: `source-${envelope.source}` };
  }
  return { admitted: true };
}
