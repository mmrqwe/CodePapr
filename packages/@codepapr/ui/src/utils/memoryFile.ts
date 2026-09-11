/**
 * MEMORY.md（v5：账本退役后的唯一记忆载体）。
 *
 * `.CodePapr/MEMORY.md` 是纯文本 Markdown 长期记忆，由后台 curator 子代理
 * 整存整取维护、用户在面板直接编辑。本模块负责全部文件侧契约：
 * - 读：注入文本 = 文件全文（写入端已封顶，注入侧永远全量，不再投影/检索）；
 * - 写：单飞队列串行化 + 「读时内容 hash 守卫」（并发会话防互相覆盖）+
 *   机械门（密钥 redact、注入风险、token/行数上限、未超限丢行检查）；
 *   校验不过 = 拒写并返回原因（curator 与面板保存共用同一道门）。
 * - 迁移：文件不存在且 SQLite 账本有 confirmed 条目时，确定性地生成种子
 *   文件（零 LLM、幂等），替代 ADR-011 时代被退役的 memory.md。
 *
 * 尺寸限制：MEMORY_MD_MAX_TOKENS 是唯一硬闸（约 8KB ≈ 60 行），curator 输出
 * 与手工保存共用；因此注入端不需要二次裁剪。
 */

import { estimateTokens, sha256 } from '@codepapr/common';
import { envelopeContent, redactSecrets } from '@codepapr/core';
import { invoke } from '@tauri-apps/api/core';
import { loadMemoryEntries, type PersistedMemoryEntry } from './projectStorage';

export const MEMORY_MD_PATH = '.CodePapr/MEMORY.md';
/** 写盘硬顶（估算口径）：注入预算与文件预算同源，注入端不再截断。 */
export const MEMORY_MD_MAX_TOKENS = 2_000;
export const MEMORY_MD_MAX_LINES = 60;

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

/** 列表行归一化：只比较 `- xxx` 条目内容（忽略所在小节），用于丢行检查。 */
function listItemLines(md: string): string[] {
  const items: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const body = trimmed.slice(2).replace(/\s+/g, ' ').trim();
    if (body) items.push(body.toLowerCase());
  }
  return items;
}

export function validateMemoryMdContent(
  prev: string | null,
  next: string,
  origin: 'memory-curator' | 'panel' | 'migration'
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
  // 2) 注入式内容风险（复用账本时代的 envelope 风险门）。
  const envelope = envelopeContent({
    source: origin === 'panel' ? 'user' : 'memory-candidate',
    trust: origin === 'panel' ? 'trusted' : 'derived',
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
  if (trimmed.split(/\r?\n/).length > MEMORY_MD_MAX_LINES) {
    reasons.push('max-lines');
  }
  // 4) mass-drop 检查：合并/冲突更新是 curator 的合法动作（素材带来新条目时
  // 允许删旧）；「没有任何新增却丢掉过半既有条目」才是失控重写，拒写。
  if (prev) {
    const nextItems = listItemLines(trimmed);
    const prevItems = listItemLines(prev);
    const nextSet = new Set(nextItems);
    const prevSet = new Set(prevItems);
    const dropped = prevItems.filter((item) => !nextSet.has(item));
    const added = nextItems.filter((item) => !prevSet.has(item));
    if (added.length === 0 && dropped.length * 2 > prevItems.length) {
      reasons.push(`mass-drop:${dropped.length}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ── 单飞写队列 ────────────────────────────────────────────────────────
// 所有对 MEMORY.md 的写（curator 落盘 / 面板保存 / 迁移种子）串行执行，
// 并在写前重读文件做「期望内容」比对：读入之后文件已被其他路径改动 → 放弃
// 本次写（防并发会话/连点保存互相覆盖）。
let writeChain: Promise<unknown> = Promise.resolve();

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
    origin: 'memory-curator' | 'panel' | 'migration';
    /** 迁移种子的生成场景：expected 为 null 且允许跳过「已有文件」。 */
    skipIfExists?: boolean;
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
    const verdict = validateMemoryMdContent(current, next, options.origin);
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
    return { ok: true, reasons: [] };
  };
  const queued = writeChain.then(run, run);
  writeChain = queued.catch(() => undefined);
  return await queued;
}

// ── 迁移：SQLite 账本 → MEMORY.md 种子 ────────────────────────────────

const CATEGORY_GROUPS: Record<'preferences' | 'stack' | 'facts', ReadonlySet<string>> = {
  preferences: new Set(['preference', 'constraint']),
  stack: new Set(['verification', 'convention', 'decision', 'api']),
  facts: new Set(['fact', 'procedure', 'general', 'citation', 'user-note']),
};

/** 账本条目 → 分组 Markdown。仅收 confirmed & active（与旧 Bootstrap 投影同口径）。 */
export function buildSeedFromLedgerEntries(entries: readonly PersistedMemoryEntry[], lang: MemoryMdLang): string {
  const c = copy(lang);
  const groups: Record<'preferences' | 'stack' | 'facts', string[]> = { preferences: [], stack: [], facts: [] };
  for (const entry of entries) {
    if (entry.status !== 'active' || entry.confidence !== 'confirmed') continue;
    const content = redactSecrets(entry.content).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const group = CATEGORY_GROUPS.preferences.has(entry.category)
      ? 'preferences'
      : CATEGORY_GROUPS.stack.has(entry.category)
        ? 'stack'
        : 'facts';
    if (!groups[group].includes(content)) groups[group].push(content);
  }
  const render = (heading: string, items: string[]) =>
    items.length > 0 ? [heading, ...items.map((item) => `- ${item}`)] : [];
  const lines = [
    c.title,
    ...render(c.preferences, groups.preferences),
    ...render(c.stack, groups.stack),
    ...render(c.facts, groups.facts),
  ];
  return `${lines.join('\n')}\n`;
}

let migrationInFlight: Map<string, Promise<void>> | null = null;

/**
 * 注入内容源：读 MEMORY.md；文件缺失且账本有 confirmed 条目 → 生成种子
 * （幂等：skipIfExists 防并发重复迁移）。返回 null = 无记忆可注入。
 */
export function toMemoryMdLang(lang?: string): MemoryMdLang {
  return lang === 'en' ? 'en' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
}

export async function loadMemorySectionForPrompt(
  workspacePath: string,
  lang?: string
): Promise<string | null> {
  const workspace = workspacePath.trim();
  const mdLang = toMemoryMdLang(lang);
  const content = await readMemoryMd(workspace);
  if (content !== null) {
    const trimmed = content.trim();
    return trimmed || null;
  }
  // 迁移：账本 → 种子。失败/空账本 → 无记忆。
  if (!migrationInFlight) migrationInFlight = new Map();
  const pending = migrationInFlight.get(workspace);
  if (pending) {
    await pending;
    const after = await readMemoryMd(workspace);
    return after?.trim() || null;
  }
  const task = (async () => {
    try {
      const entries = await loadMemoryEntries(workspace, true);
      const confirmed = entries.filter((entry) => entry.confidence === 'confirmed');
      if (confirmed.length === 0) return;
      const seed = buildSeedFromLedgerEntries(confirmed, mdLang);
      if (estimateTokens(seed) > MEMORY_MD_MAX_TOKENS) {
        // 超顶种子不写（宁可无记忆也不截断丢约束）；留给面板/curator 处理。
        return;
      }
      await requestMemoryMdWrite(workspace, seed, {
        expectedContent: null,
        origin: 'migration',
        skipIfExists: true,
      });
    } catch (err) {
      console.warn('[memory-md] 账本迁移失败:', err instanceof Error ? err.message : err);
    } finally {
      migrationInFlight?.delete(workspace);
    }
  })();
  migrationInFlight.set(workspace, task);
  await task;
  const after = await readMemoryMd(workspace);
  return after?.trim() || null;
}

/** 内容 hash（审计/测试用；写守卫用原文比对，不依赖此函数）。 */
export async function memoryMdHash(workspacePath: string): Promise<string | null> {
  const content = await readMemoryMd(workspacePath);
  return content === null ? null : await sha256(content.trim());
}
