/**
 * MEMORY.md（v5：账本退役后的唯一记忆载体）。
 *
 * `.CodePapr/MEMORY.md` 是纯文本 Markdown 长期记忆，由后台 curator 子代理
 * 整存整取维护、用户在面板直接编辑。本模块负责全部文件侧契约：
 * - 读：注入文本 = 文件全文（写入端已封顶，注入侧永远全量，不再投影/检索）；
 * - 写：单飞队列串行化 + 「读时内容守卫」（并发会话防互相覆盖）+
 *   机械门（密钥 redact、注入风险、token/行数上限、更新模式的 mass-drop、
 *   整理模式的目标线与保留锚点）；
 *   校验不过 = 拒写并返回原因（curator 与面板保存共用同一道门）。
 *
 * 尺寸限制：MEMORY_MD_MAX_TOKENS 是唯一硬闸（约 16KB ≈ 120 行），curator 输出
 * 与手工保存共用；因此注入端不需要二次裁剪。旧账本 → 文件的 seed 迁移由
 * Rust DB v9 迁移在打开项目时完成，TS 侧不再读账本。
 */

import { estimateTokens } from '@codepapr/common';
import { envelopeContent, redactSecrets } from '@codepapr/core';
import { invoke } from '@tauri-apps/api/core';

export const MEMORY_MD_PATH = '.CodePapr/MEMORY.md';
/** 写盘硬顶（估算口径）：注入预算与文件预算同源，注入端不再截断。 */
export const MEMORY_MD_MAX_TOKENS = 4_000;
export const MEMORY_MD_MAX_LINES = 120;
/** 预算压力线：用量达硬顶该比例即触发自动整理（提前压缩，避免满额后新事实写不进）。 */
export const MEMORY_MD_CONSOLIDATION_RATIO = 0.9;
/** 整理目标：consolidate 模式的机械输出上限（更新模式与面板保存仍只用硬顶）。 */
export const MEMORY_MD_TARGET_RATIO = 0.8;
export const MEMORY_MD_TARGET_TOKENS = Math.floor(MEMORY_MD_MAX_TOKENS * MEMORY_MD_TARGET_RATIO);
/** 行数目标沿用提示词既有的 100 行（≈83%，低于 90% 触发线）。 */
export const MEMORY_MD_TARGET_LINES = 100;
/**
 * 整理模式洗记忆判定：旧单元被新文本认出的比例。
 * 达到此值说明大半事实还在（允许精简措辞），不再看新文本是否换了说法。
 */
export const MEMORY_MD_CONSOLIDATE_MIN_PREV_RETENTION = 0.5;
/**
 * 旧单元留下不足一半时，新文本里必须有这么高的比例能对上某条旧单元。
 * 这放行「删掉过时条目、留下的行仍是旧事实」；拦住「改写几个字然后换成另一份记忆」。
 */
export const MEMORY_MD_CONSOLIDATE_MIN_NEXT_ANCHOR = 0.8;

export interface MemoryMdPressure {
  tokens: number;
  lines: number;
  /** tokens 或 lines 达触发线（≥90% 硬顶）。 */
  overPressure: boolean;
}

/** 与 validateMemoryMdContent 同口径（trim + estimateTokens）的预算读数。 */
export function getMemoryMdPressure(content: string | null | undefined): MemoryMdPressure {
  const trimmed = content?.trim() ?? '';
  if (!trimmed) {
    return { tokens: 0, lines: 0, overPressure: false };
  }
  const tokens = estimateTokens(trimmed);
  const lines = trimmed.split(/\r?\n/).length;
  return {
    tokens,
    lines,
    overPressure:
      tokens >= MEMORY_MD_MAX_TOKENS * MEMORY_MD_CONSOLIDATION_RATIO ||
      lines >= MEMORY_MD_MAX_LINES * MEMORY_MD_CONSOLIDATION_RATIO,
  };
}

export type MemoryMdLang = 'zh-CN' | 'zh-TW' | 'en';

function copy(lang: MemoryMdLang) {
  switch (lang) {
    case 'en':
      return {
        title: '# Project & User Long-term Memory',
        preferences: '## Preferences & Constraints',
        stack: '## Tech Stack & Environment',
        facts: '## Known Project Facts',
      };
    case 'zh-TW':
      return {
        title: '# 專案與使用者長期記憶',
        preferences: '## 使用者偏好與約束',
        stack: '## 技術棧與環境約束',
        facts: '## 架構與業務已知事實',
      };
    default:
      return {
        title: '# 项目与用户长期记忆',
        preferences: '## 用户偏好与约束',
        stack: '## 技术栈与环境约束',
        facts: '## 架构与业务已知事实',
      };
  }
}

/** 空模板（迁移/首建用）。 */
export function buildMemoryMdTemplate(lang: MemoryMdLang): string {
  const c = copy(lang);
  return `${c.title}\n\n${c.preferences}\n- （暂无）\n\n${c.stack}\n- （暂无）\n\n${c.facts}\n- （暂无）\n`;
}

export async function readMemoryMd(workspacePath: string): Promise<string | null> {
  try {
    const result = await invoke<{ content?: string } | null>('read_text_file', {
      workspacePath: workspacePath.trim(),
      relativePath: MEMORY_MD_PATH,
      maxBytes: 64_000,
    });
    if (!result || typeof result.content !== 'string') return null;
    // 文件不存在时 read_text_file 报错 → null（调用方区分「空/缺失」用 exists 判断）。
    return result.content;
  } catch {
    return null;
  }
}

/** 写盘机械门（curator 与面板保存共用）。prev=null 表示新建文件。 */
export interface MemoryMdGateVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * 记忆单元归一化：供 mass-drop 丢行检查（覆盖常见记忆形态，不只看 `- ` 列表）：
 * `- / * / +` 列表、`1. / 1)` 有序列表、表格数据行、普通段落行；
 * 空行、Markdown 标题、表格分隔行（|---|）不算单元（结构而非条目）。
 * 归一化（去项目符号 / 折叠空白 / 小写）让「改括号、加空格」这类等义改写
 * 不被误判为删除+新增。
 */
function memoryUnitLines(md: string): string[] {
  const items: string[] = [];
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^\|?[\s:|-]+\|?$/.test(line)) continue;
    const body = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) items.push(body.toLowerCase());
  }
  return items;
}

export type MemoryMdWriteOrigin = 'memory-curator' | 'panel' | 'migration' | 'guard';

export interface MemoryMdGateOptions {
  /**
   * 整理模式（仅管家 consolidate 传入）。目标线变成硬门；丢行改用保留锚点，
   * 不再用「零新增且删过半」。面板保存与 update 模式不传。
   */
  consolidate?: boolean;
}

const UNIT_SIMILARITY = 0.5;

function unitTokenSet(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9_./:+-]{2,}/g) ?? []) {
    tokens.add(word);
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let index = 0; index < run.length - 1; index += 1) {
        tokens.add(run.slice(index, index + 2));
      }
    }
  }
  return tokens;
}

/** 收紧措辞仍算同一条：较短一侧的 token 有一半出现在另一侧。 */
function unitsSimilar(prev: string, next: string): boolean {
  if (prev === next) return true;
  const left = unitTokenSet(prev);
  const right = unitTokenSet(next);
  if (left.size === 0 || right.size === 0) return false;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) shared += 1;
  }
  return shared / smaller.size >= UNIT_SIMILARITY;
}

function consolidationWashReason(prevItems: string[], nextItems: string[]): string | null {
  if (prevItems.length === 0) return null;
  if (nextItems.length === 0) return `consolidate-wash:0/${prevItems.length}`;
  let retained = 0;
  for (const prev of prevItems) {
    if (nextItems.some((next) => unitsSimilar(prev, next))) retained += 1;
  }
  if (retained / prevItems.length >= MEMORY_MD_CONSOLIDATE_MIN_PREV_RETENTION) return null;
  let anchored = 0;
  for (const next of nextItems) {
    if (prevItems.some((prev) => unitsSimilar(prev, next))) anchored += 1;
  }
  if (anchored / nextItems.length >= MEMORY_MD_CONSOLIDATE_MIN_NEXT_ANCHOR) return null;
  return `consolidate-wash:${retained}/${prevItems.length}`;
}

export function validateMemoryMdContent(
  prev: string | null,
  next: string,
  origin: MemoryMdWriteOrigin,
  options?: MemoryMdGateOptions
): MemoryMdGateVerdict {
  const reasons: string[] = [];
  const trimmed = next.trim();
  if (!trimmed) {
    return { ok: false, reasons: ['empty'] };
  }
  // 1) 密钥：redact 后内容变化 = 试图写入疑似密钥（curator 与人都一样禁）。
  if (redactSecrets(trimmed) !== trimmed) {
    reasons.push('secrets');
  }
  // 2) 注入式内容风险（复用账本时代的 envelope 风险门）。guard 回滚的是
  // 磁盘上已存在的可信内容（面板/用户手写），按 trusted 处理。
  const trusted = origin === 'panel' || origin === 'guard';
  const envelope = envelopeContent({
    source: trusted ? 'user' : 'memory-candidate',
    trust: trusted ? 'trusted' : 'derived',
    origin: `memory-md:${origin}`,
    content: trimmed,
  });
  if (envelope.riskFlags.length > 0) {
    reasons.push(`risk:${envelope.riskFlags.join(',')}`);
  }
  // 3) 尺寸硬顶。
  if (estimateTokens(trimmed) > MEMORY_MD_MAX_TOKENS) {
    reasons.push('max-tokens');
  }
  const lineCount = trimmed.split(/\r?\n/).length;
  if (lineCount > MEMORY_MD_MAX_LINES) {
    reasons.push('max-lines');
  }
  // 4) 丢行。更新模式：合并/冲突更新是合法动作（有新增就允许删旧）；
  // 「没有任何新增却丢掉过半既有单元」才是失控重写。
  // 整理模式：目标线是硬门（提示词里的 3200/100 不再只是建议）；
  // 删过时条目可以超过一半，但新文本必须仍锚在旧事实上，不能改写后整份换掉。
  if (options?.consolidate) {
    if (estimateTokens(trimmed) > MEMORY_MD_TARGET_TOKENS) reasons.push('over-target:tokens');
    if (lineCount > MEMORY_MD_TARGET_LINES) reasons.push('over-target:lines');
  }
  if (prev) {
    const nextItems = memoryUnitLines(trimmed);
    const prevItems = memoryUnitLines(prev);
    if (options?.consolidate) {
      const wash = consolidationWashReason(prevItems, nextItems);
      if (wash) reasons.push(wash);
    } else {
      const nextSet = new Set(nextItems);
      const prevSet = new Set(prevItems);
      const dropped = prevItems.filter((item) => !nextSet.has(item));
      const added = nextItems.filter((item) => !prevSet.has(item));
      if (added.length === 0 && dropped.length * 2 > prevItems.length) {
        reasons.push(`mass-drop:${dropped.length}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ── 单飞写队列 ────────────────────────────────────────────────────────
// 所有对 MEMORY.md 的写（curator 落盘 / 面板保存 / 迁移种子 / 越权写回滚）
// 串行执行，并在写前重读文件做「期望内容」比对：读入之后文件已被其他路径
// 改动 → 放弃本次写（防并发会话/连点保存互相覆盖）。
let writeChain: Promise<unknown> = Promise.resolve();
/** 受信写入序号：memoryShellGuard 用它区分「合法写入赢得竞态」与越权写。 */
let writeSeq = 0;

export function getMemoryMdWriteSeq(): number {
  return writeSeq;
}

export interface MemoryMdWriteResult extends MemoryMdGateVerdict {
  /** 因外部并发修改被守卫拒绝。 */
  stale?: boolean;
}

export async function requestMemoryMdWrite(
  workspacePath: string,
  next: string,
  options: {
    /** 生成 next 时读到的当前内容；null = 期望文件不存在。不匹配则拒绝。 */
    expectedContent: string | null;
    origin: MemoryMdWriteOrigin;
    /** 迁移种子的生成场景：expected 为 null 且允许跳过「已有文件」。 */
    skipIfExists?: boolean;
    /** 管家 consolidate 落盘：走目标线与保留锚点，不走 update 的 mass-drop。 */
    consolidate?: boolean;
  }
): Promise<MemoryMdWriteResult> {
  const workspace = workspacePath.trim();
  const run = async (): Promise<MemoryMdWriteResult> => {
    const current = await readMemoryMd(workspace);
    if (options.skipIfExists && current !== null) {
      return { ok: true, reasons: ['skipped:already-exists'] };
    }
    const expected = options.expectedContent;
    const currentNormalized = current?.trim() ?? null;
    const expectedNormalized = expected?.trim() ?? null;
    if (currentNormalized !== expectedNormalized) {
      return { ok: false, reasons: ['concurrent-change'], stale: true };
    }
    const verdict = validateMemoryMdContent(current, next, options.origin, {
      consolidate: options.consolidate,
    });
    if (!verdict.ok) {
      return verdict;
    }
    const content = next.endsWith('\n') ? next : `${next}\n`;
    try {
      await invoke('write_text_file', {
        workspacePath: workspace,
        relativePath: MEMORY_MD_PATH,
        content,
      });
    } catch (err) {
      return { ok: false, reasons: [`write-failed:${err instanceof Error ? err.message : String(err)}`] };
    }
    writeSeq += 1;
    return { ok: true, reasons: [] };
  };
  const queued = writeChain.then(run, run);
  writeChain = queued.catch(() => undefined);
  return await queued;
}

// ── 旧账本 → MEMORY.md 的种子迁移：由 Rust DB v9 迁移完成（打开项目时执行）。
// TS 侧只读文件，不再承担迁移。

export function toMemoryMdLang(lang?: string): MemoryMdLang {
  return lang === 'en' ? 'en' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
}

/** 注入内容源：读 MEMORY.md。返回 null = 无记忆可注入。 */
export async function loadMemorySectionForPrompt(workspacePath: string): Promise<string | null> {
  const content = await readMemoryMd(workspacePath.trim());
  return content?.trim() || null;
}

// ── 写入拦截（workspace write/patch/diff 共用） ──────────────────────

/**
 * 归一化路径后与记忆文件比对：账本时代的 `.CodePapr/memory.md` 与 v5 的
 * `.CodePapr/MEMORY.md` —— lowercase 后同串，一个比较覆盖两个名字
 * （APFS 大小写不敏感，二者本就互斥共存于同一文件名槽位）。
 */
export function isMemoryFilePath(relativePath: string): boolean {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalized === '.codepapr/memory.md';
}

export const MEMORY_WRITE_INTERCEPT_NOTE =
  '项目记忆文件（.CodePapr/MEMORY.md）由记忆管家与用户在面板维护，Agent 直接写入已被拒绝。若你刚发现值得长期记住的事实，请在最终答复中明确说明，让用户在「上下文检查器 → 项目记忆」里确认。';
