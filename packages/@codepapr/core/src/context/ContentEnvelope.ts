/**
 * ContentEnvelope：跨边界内容的安全信封（PR4 / ADR-010）。
 *
 * 所有「外部进入内部」的内容流（web / MCP / 工具输出 / session recall /
 * checkpoint 抽取 / memory 写入）都必须先包成信封，携带 source / trust /
 * origin / risk flags。写入策略只读信封字段，绝不直接消费裸内容。
 *
 * 基线安全判定是确定性的，不依赖 LLM；不产生用户审核队列。
 */

export type ContentSourceKind =
  | 'user'
  | 'assistant'
  | 'tool-output'
  | 'web'
  | 'mcp'
  | 'session-recall'
  | 'checkpoint-extraction'
  | 'memory-candidate'
  | 'agent-proposed'
  | 'cold-start-bootstrap';

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

/** 是否只含控制字符（二进制误判保护：解码出的乱码不参与注入检测）。 */
function containsOnlyControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 31) return false;
  }
  return true;
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
    if (decoded && decoded.length > 0 && !containsOnlyControlChars(decoded)) {
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

/** 记忆语义种类。Agent 自报的 category 只是建议；web/MCP 会被运行时改写成 citation。 */
export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'fact'
  | 'convention'
  | 'verification'
  | 'procedure'
  | 'citation'
  | 'decision'
  | 'api'
  | 'general'
  | 'user-note';

export const MEMORY_KINDS: ReadonlySet<string> = new Set([
  'preference',
  'constraint',
  'fact',
  'convention',
  'verification',
  'procedure',
  'citation',
  'decision',
  'api',
  'general',
  'user-note',
]);

/** 不进入 Session Bootstrap 的种类（只进 ledger：procedure 按需召回，citation 仅搜索）。 */
export const BOOTSTRAP_EXCLUDED_MEMORY_KINDS: ReadonlySet<string> = new Set([
  'citation',
  'procedure',
]);

export type MemoryWriteDecision =
  | {
      action: 'persist';
      kind: MemoryKind;
      projectToBootstrap: boolean;
      confidence: 'confirmed' | 'reported';
    }
  | { action: 'drop'; reason: string };

/** 记忆内容尺寸上限（字符）：入队门槛与写入门共用同一常量。 */
export const MEMORY_CONTENT_MAX_CHARS = 8_000;
/** 记忆内容尺寸下限（字符）：过短内容无记忆价值。 */
export const MEMORY_CONTENT_MIN_CHARS = 8;
/**
 * reported（LLM 自报、未经证实）内容的尺寸上限。冷启动 LLM 摘要这类大段
 * blob 破坏原子性：无法近义合并、无法按条预算、召回时被整段挤占预算。
 * confirmed（用户原话 / 工具输出 / 面板手写）不受此限。
 */
export const MEMORY_REPORTED_MAX_CHARS = 400;

export function normalizeMemoryKind(raw: string | undefined): MemoryKind {
  const kind = (raw ?? 'general').trim().toLowerCase();
  return MEMORY_KINDS.has(kind) ? (kind as MemoryKind) : 'general';
}

export function memoryProjectsToBootstrap(kind: string): boolean {
  return !BOOTSTRAP_EXCLUDED_MEMORY_KINDS.has(normalizeMemoryKind(kind));
}

/**
 * M2（ADR-010 信任规则）：只有 confirmed（user / tool-output / 面板手写）
 * 内容才允许进 Session Bootstrap 固定前缀；reported（Agent 自报、冷启动
 * LLM 生成）只进 Recall，防模型臆测固化成「项目真理」。
 */
export function memoryEntryProjectsToBootstrap(
  kind: string,
  confidence: string
): boolean {
  return confidence === 'confirmed' && memoryProjectsToBootstrap(kind);
}

function looksLikeExternalOrigin(envelope: ContentEnvelope): boolean {
  if (envelope.source === 'web' || envelope.source === 'mcp') return true;
  return /^https?:\/\//i.test(envelope.origin);
}

/**
 * 零审核写入门：persist（含 citation）或 drop。不产生 pending 队列。
 *
 * - 风险标记 / 尺寸 / 裸 assistant 推理 → drop
 * - web / MCP / 外部 URL origin → citation（可召回，不进 Bootstrap）
 * - 其余可证明或 Agent 经 memory_write 提出的内容 → 立刻 persist；
 *   但 reported（未证实）不进 Bootstrap 前缀，只进按需召回（M2）
 */
export function planMemoryWrite(input: {
  envelope: ContentEnvelope;
  kind?: string;
}): MemoryWriteDecision {
  const { envelope } = input;
  if (envelope.riskFlags.length > 0) {
    return { action: 'drop', reason: `risk-flags:${envelope.riskFlags.join(',')}` };
  }
  const trimmed = envelope.content.trim();
  if (trimmed.length < MEMORY_CONTENT_MIN_CHARS || trimmed.length > MEMORY_CONTENT_MAX_CHARS) {
    return { action: 'drop', reason: 'content-size' };
  }
  if (envelope.source === 'assistant') {
    return { action: 'drop', reason: 'source-assistant' };
  }

  let kind = normalizeMemoryKind(input.kind);
  if (kind === 'user-note' && envelope.source !== 'user') {
    kind = 'general';
  }
  if (kind === 'citation' || looksLikeExternalOrigin(envelope)) {
    kind = 'citation';
  }

  if (envelope.trust === 'untrusted' && kind !== 'citation') {
    return { action: 'drop', reason: 'untrusted-source' };
  }

  const attested =
    envelope.source === 'user' ||
    envelope.source === 'tool-output' ||
    envelope.trust === 'trusted' ||
    envelope.trust === 'workspace';

  // M8：cold-start-bootstrap（LLM 生成）不再算 attested——幻觉不得以
  // [verified] 姿态冻结进前缀；以 reported 身份只进 Recall。
  const confidence = attested ? 'confirmed' : 'reported';
  // reported 内容必须是原子事实：超长即 blob（清单/摘要），宁可不记。
  if (confidence === 'reported' && trimmed.length > MEMORY_REPORTED_MAX_CHARS) {
    return { action: 'drop', reason: 'reported-too-long' };
  }
  return {
    action: 'persist',
    kind,
    projectToBootstrap: memoryEntryProjectsToBootstrap(kind, confidence),
    confidence,
  };
}

/**
 * 兼容旧调用方：能进 ledger 即为 admitted（citation 也 admitted）。
 * 新代码请用 planMemoryWrite。
 */
export function planMemoryAdmission(envelope: ContentEnvelope): MemoryAdmissionResult {
  const decision = planMemoryWrite({ envelope });
  if (decision.action === 'persist') return { admitted: true };
  return { admitted: false, reason: decision.reason };
}
