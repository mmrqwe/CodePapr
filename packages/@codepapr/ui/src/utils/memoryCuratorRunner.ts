/**
 * memoryCuratorRunner: MEMORY.md 维护子代理（v5）的 UI 侧执行器。
 *
 * Curator 与 compactor 同构：internal、零工具、单轮、fast 档（复用
 * compactionModel/compactionTemperature 配置，不引入新设置）。它是「整存整取」
 * 的笔记管家——输入当前 MEMORY.md + 本轮素材（仅用户原话与 assistant 最终文本/
 * 压缩骨架，绝不含原始工具输出，堵住注入写记忆的主通道），输出 NO_CHANGE 或
 * 重写后的完整文件。输出必须过 memoryFile 的机械门（密钥/风险/上限/丢行）才
 * 允许落盘；写盘再经单飞队列 + stale 守卫。
 *
 * 触发点在 store 侧（交付卡点/压缩卡点），本模块只做「跑一次 + 校验 + 写」。
 */

import { BUILTIN_AGENTS, type AgentDefinition } from '@codepapr/core';
import { resolveEffectiveCompactorTier, runCompactorSession } from './compactorRunner';
import {
  MEMORY_MD_MAX_LINES,
  MEMORY_MD_MAX_TOKENS,
  MEMORY_MD_TARGET_LINES,
  MEMORY_MD_TARGET_TOKENS,
  getMemoryMdPressure,
  requestMemoryMdWrite,
  validateMemoryMdContent,
  type MemoryMdLang,
} from './memoryFile';
import type { CompactionSettings } from '../store/internals/types';

export const MEMORY_CURATOR_NO_CHANGE = 'NO_CHANGE';

/** update=有素材的常规归整；consolidate=预算压力下的压缩整理（允许空素材）。 */
export type MemoryCuratorMode = 'update' | 'consolidate';

const CURATOR_SYSTEM_PROMPTS: Record<MemoryMdLang, string> = {
  'zh-CN': `你是 CodePapr 的记忆管家，负责维护一份跨会话的长期记忆文件（Markdown）。
你会收到：当前记忆文件全文 + 最近一轮（或一段被压缩的对话骨架）的交互摘要。

【判断标准】只保留「稳定的、跨会话仍成立的事实」：
- 用户明确表达的偏好、习惯、禁令（"以后都…""别再用…"）；
- 被实际验证过的技术栈/环境事实（包管理器、端口、构建命令、版本约束）；
- 架构决策与业务已知事实（模块迁移、废弃文件、领域规则）。
绝不记录：临时任务状态（待办、正在改哪个文件、本轮报错）、可即时探测的信息（目录树、依赖清单）、密钥或令牌。

【输出协议】
1. 若本轮没有任何值得长期记住的新事实：只输出 NO_CHANGE（一字不差，不要任何其他文字）。
2. 若有：输出重写后的【完整文件】（含所有既有条目），并遵守：
   - 保持三个小节标题结构；同类条目合并、与新事实冲突的旧条目更新或删除；
   - 总行数不超过 100 行，每行一条简短事实（"- " 开头）；
   - 不得发明素材中不存在的信息；不要输出开场白、解释或代码块围栏。`,
  'zh-TW': `你是 CodePapr 的記憶管家，負責維護一份跨會話的長期記憶檔案（Markdown）。
你會收到：當前記憶檔案全文 + 最近一輪（或一段被壓縮的對話骨架）的互動摘要。

【判斷標準】只保留「穩定的、跨會話仍成立的事實」：
- 使用者明確表達的偏好、習慣、禁令；
- 被實際驗證過的技術棧/環境事實（套件管理器、端口、建置命令、版本約束）；
- 架構決策與業務已知事實（模組遷移、廢棄檔案、領域規則）。
絕不記錄：臨時任務狀態、可即時探測的資訊（目錄樹、依賴清單）、密鑰或令牌。

【輸出協定】
1. 若本輪沒有任何值得長期記住的新事實：只輸出 NO_CHANGE（一字不差）。
2. 若有：輸出重寫後的【完整檔案】（含所有既有條目），並遵守：
   - 保持三個小節標題結構；同類條目合併、與新事實衝突的舊條目更新或刪除；
   - 總行數不超過 100 行，每行一條簡短事實（"- " 開頭）；
   - 不得發明素材中不存在的事實；不要輸出開場白或程式碼圍欄。`,
  en: `You are CodePapr's memory curator, maintaining a cross-session long-term memory file (Markdown).
You receive: the current memory file plus a summary of the latest turn (or a compacted conversation skeleton).

[WHAT DESERVES MEMORY] only stable, cross-session facts:
- explicit user preferences, habits, prohibitions;
- tech-stack/environment facts actually verified in practice (package manager, ports, build commands, version constraints);
- architecture decisions and known business facts (module moves, deprecated files, domain rules).
NEVER record: ephemeral task state, instantly-detectable info (directory trees, dependency lists), secrets or tokens.

[OUTPUT PROTOCOL]
1. If nothing new deserves memory: output exactly NO_CHANGE (nothing else).
2. Otherwise output the FULL rewritten file (all existing entries included), obeying:
   - keep the three section headings; merge duplicates; update or delete entries the new facts contradict;
   - at most 100 lines total, one short fact per line ("- " bullets);
   - never invent content absent from the material; no preamble, no code fences.`,
};

/**
 * 整理模式附录（预算压力时追加到系统提示词）：文件已近/触硬顶且本轮可能没有
 * 新事实，任务是压缩整理而非扩充。更新模式不带此段。
 */
const CURATOR_CONSOLIDATION_APPENDIX: Record<MemoryMdLang, string> = {
  'zh-CN': `

【整理模式】文件预算已接近或触及硬顶（上限 ${MEMORY_MD_MAX_TOKENS} tokens / ${MEMORY_MD_MAX_LINES} 行），本轮可能没有任何新事实。你的任务是压缩整理而非扩充：
- 合并语义重复或同族的条目；精简冗长表述；删除已过时、可即时探测（目录树、依赖清单等）或信息量极低的条目；
- 必须保留全部稳定的用户偏好、禁令与关键架构事实，不得发明新事实；
- 输出必须不超过 ${MEMORY_MD_TARGET_TOKENS} tokens 且不超过 ${MEMORY_MD_TARGET_LINES} 行；
- 若所有条目都必要且已无可压缩空间：只输出 NO_CHANGE。
有新事实时按正常判断一并合并进去，同时完成上述压缩。`,
  'zh-TW': `

【整理模式】檔案預算已接近或觸及硬頂（上限 ${MEMORY_MD_MAX_TOKENS} tokens / ${MEMORY_MD_MAX_LINES} 行），本輪可能沒有任何新事實。你的任務是壓縮整理而非擴充：
- 合併語意重複或同族的條目；精簡冗長表述；刪除已過時、可即時探測（目錄樹、依賴清單等）或資訊量極低的條目；
- 必須保留全部穩定的使用者偏好、禁令與關鍵架構事實，不得發明新事實；
- 輸出必須不超過 ${MEMORY_MD_TARGET_TOKENS} tokens 且不超過 ${MEMORY_MD_TARGET_LINES} 行；
- 若所有條目都必要且已無可壓縮空間：只輸出 NO_CHANGE。
有新事實時按正常判斷一併合併進去，同時完成上述壓縮。`,
  en: `

[CONSOLIDATION MODE] The file is at or near its hard budget (${MEMORY_MD_MAX_TOKENS} tokens / ${MEMORY_MD_MAX_LINES} lines) and this turn may bring no new facts. Your job is compaction, not expansion:
- merge duplicate or same-family entries; tighten verbose wording; delete outdated, instantly-detectable (directory trees, dependency lists) or low-value entries;
- keep every stable user preference, prohibition and key architecture fact; never invent facts;
- output must be at most ${MEMORY_MD_TARGET_TOKENS} tokens and ${MEMORY_MD_TARGET_LINES} lines;
- if every entry is necessary and nothing can be compressed: output exactly NO_CHANGE.
If new facts are present, fold them in while applying the compaction above.`,
};

/** 与 compactor 同档策略：模型/温度复用压缩配置，不新增设置项。 */
export function buildCuratorDefinition(params: {
  settings: Pick<
    CompactionSettings,
    'compactionModel' | 'fastModelEnabled' | 'fastModel' | 'compactionTemperature'
  >;
  baseModel: string;
}): AgentDefinition {
  const { settings, baseModel } = params;
  const builtin = BUILTIN_AGENTS.find((agent) => agent.name === 'memory-curator');
  const tier = resolveEffectiveCompactorTier(settings);
  const model =
    tier === 'fast'
      ? (settings.fastModelEnabled && settings.fastModel.trim() ? 'fast' : baseModel)
      : baseModel;
  return {
    name: 'memory-curator',
    description: builtin?.description ?? 'Memory curator (internal)',
    mode: 'subagent',
    model,
    temperature: settings.compactionTemperature,
    tools: {},
    internal: true,
    prompt: '',
  };
}

export interface CuratorPromptParts {
  currentMd: string | null;
  /** 「User: …\nAssistant: …」形式的素材（调用方负责只放用户原话与最终文本）。 */
  material: string;
}

export function buildCuratorUserPrompt(parts: CuratorPromptParts): string {
  const current = parts.currentMd?.trim() || '（文件尚不存在）';
  const material = parts.material.trim() || '（无新素材：仅压缩整理）';
  const pressure = getMemoryMdPressure(parts.currentMd);
  return `当前记忆文件：
<current_memory>
${current}
</current_memory>

预算状态：约 ${pressure.tokens}/${MEMORY_MD_MAX_TOKENS} tokens、${pressure.lines}/${MEMORY_MD_MAX_LINES} 行；输出上限 ${MEMORY_MD_TARGET_TOKENS} tokens / ${MEMORY_MD_TARGET_LINES} 行。

本轮交互摘要：
<interaction>
${material}
</interaction>

按要求输出 NO_CHANGE 或重写后的完整文件。`;
}

export type CuratorOutcome =
  | { kind: 'nochange' }
  | { kind: 'updated'; content: string }
  | { kind: 'rejected'; reasons: string[] }
  | { kind: 'failed'; message: string };

const NO_CHANGE_PATTERN = /^NO_CHANGE[.\s]*$/;

/** 纯解析：curator 原始输出 → 语义结果（不落盘，供单测与写路径共用）。 */
export function parseCuratorOutput(raw: string | null | undefined, currentMd: string | null): CuratorOutcome {
  const content = raw?.trim();
  if (!content) {
    return { kind: 'failed', message: 'curator 输出为空' };
  }
  if (NO_CHANGE_PATTERN.test(content)) {
    return { kind: 'nochange' };
  }
  // 剥掉常见的围栏包裹（模型偶发不守协议）。
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(content);
  const body = (fenced ? fenced[1] : content).trim();
  const verdict = validateMemoryMdContent(currentMd, body, 'memory-curator');
  if (!verdict.ok) {
    return { kind: 'rejected', reasons: verdict.reasons };
  }
  return { kind: 'updated', content: body };
}

export interface RunMemoryCuratorParams {
  workspacePath: string;
  currentMd: string | null;
  material: string;
  settings: CompactionSettings;
  lang: MemoryMdLang;
  abortSignal?: AbortSignal;
  /** 默认 update；consolidate 允许空素材（预算压力下的纯整理）。 */
  mode?: MemoryCuratorMode;
}

/**
 * 跑一次 curator 并（在校验通过时）尝试写盘。
 * 返回 updated 但 written=false 的情况：stale 守卫（并发修改）——由调用方决定
 * 下轮重试（素材仍在，下一卡点会再抽一次）。
 */
export async function runMemoryCurator(
  params: RunMemoryCuratorParams
): Promise<CuratorOutcome & { written?: boolean }> {
  const { workspacePath, currentMd, material, settings, lang, abortSignal } = params;
  const mode: MemoryCuratorMode = params.mode ?? 'update';
  if (!material.trim() && mode !== 'consolidate') {
    return { kind: 'nochange' };
  }
  const baseModel = settings.model.trim();
  const definition = buildCuratorDefinition({ settings, baseModel });
  const systemPrompt =
    mode === 'consolidate'
      ? `${CURATOR_SYSTEM_PROMPTS[lang]}${CURATOR_CONSOLIDATION_APPENDIX[lang]}`
      : CURATOR_SYSTEM_PROMPTS[lang];
  try {
    const result = await runCompactorSession({
      definition: { ...definition, prompt: systemPrompt },
      prompt: buildCuratorUserPrompt({ currentMd, material }),
      settings,
      baseModel,
      lang,
      abortSignal,
    });
    const outcome = parseCuratorOutput(result.content, currentMd);
    if (outcome.kind !== 'updated') {
      return outcome;
    }
    // 卡点超时会 abort 在飞会话：即使 provider 未及时响应取消，也绝不在超时
    // 之后落盘——否则「记忆落后/领先一个 epoch」的时序不可解释。
    if (abortSignal?.aborted) {
      throw new DOMException('Memory curator aborted before write', 'AbortError');
    }
    const written = await requestMemoryMdWrite(workspacePath, outcome.content, {
      expectedContent: currentMd,
      origin: 'memory-curator',
    });
    if (!written.ok) {
      return { kind: 'rejected', reasons: written.reasons, written: false };
    }
    return { ...outcome, written: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
