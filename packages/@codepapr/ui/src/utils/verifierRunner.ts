/**
 * verifierRunner: Goal 验收器（Verifier）子代理的 UI 层执行器。
 *
 * Verifier 是内置的只读内部子代理（agentConfig 的 BUILTIN_AGENTS）：
 * - internal: true → 不经 task 工具暴露给主 Agent，仅供 GoalRunner 内部调用
 * - 工具白名单：read / grep / glob / list（只能核实，不能修改）
 * - 接收 Worker 的 transcript 摘要、Worker 自述与客观条件评估结果，
 *   可用只读工具亲自核实文件内容，输出严格 JSON 判定
 *   （SATISFIED / NOT_MET / AMBIGUOUS）
 * - 模型档位由 verifierModelTier 决定（fast / primary / mentor），
 *   主观目标（无 exec: 条件）默认升级为 mentor 模型
 *
 * 复用 uiTaskTool.runSubagent 执行完整的子代理会话（含工具循环）。
 */

import { errorMessage } from '@codepapr/common';
import {
  BUILTIN_AGENTS,
  VERIFIER_PROMPT_OBJECTIVE,
  VERIFIER_PROMPT_SUBJECTIVE,
  type AgentDefinition,
} from '@codepapr/core';
import type { GoalVerdict, GoalStrictness, ConditionResult, ICacheStatistics } from '@codepapr/types';
import { runSubagent, type UiTaskToolContext } from '../tools/uiTaskTool';
import type { Settings } from '../store/agentStore';

export type VerifierModelTier = 'fast' | 'primary' | 'mentor';

/** Verifier 单次验收的工具轮数上限：只做抽查核实，不做全量审计。 */
export const VERIFIER_MAX_TOOL_ROUNDS = 6;
/** Verifier 单次验收的墙钟预算（毫秒）：3 分钟。 */
export const VERIFIER_MAX_WALL_CLOCK_MS = 180_000;

/**
 * 解析 Verifier 实际使用的模型档位（纯函数，可单测）：
 * - 主观目标（无 exec: 条件）在 fast 档自动升级为 mentor（抽象目标需要更强判断力）；
 * - mentor 档未配置 mentor 模型时静默降级为 primary。
 */
export function resolveVerifierTier(
  settingsTier: VerifierModelTier,
  isSubjective: boolean,
  mentorConfigured: boolean,
): VerifierModelTier {
  let tier: VerifierModelTier = settingsTier;
  if (isSubjective && tier === 'fast') {
    tier = 'mentor';
  }
  if (tier === 'mentor' && !mentorConfigured) {
    tier = 'primary';
  }
  return tier;
}

/** 判定 Verifier 本轮实际使用的模型档位（与 buildVerifierDefinition 同源）。 */
export function resolveEffectiveVerifierTier(
  settings: Settings,
  isSubjective: boolean,
): VerifierModelTier {
  const mentorConfigured = settings.mentorEnabled && settings.mentorModel.trim().length > 0;
  return resolveVerifierTier(settings.verifierModelTier, isSubjective, mentorConfigured);
}

/**
 * 构建 Verifier 子代理的运行时定义（纯函数，可单测）：
 * - 模型档位按 resolveVerifierTier 解析：
 *   fast → model: 'fast'（fastModel 未启用时降为 baseModel 字符串 → 强制 primary 档）
 *   primary → model: baseModel 字符串（显式模型 → 路由强制 primary 档）
 *   mentor → model: 'mentor'（resolveSubagentExecution 内处理 mentor 回退）
 * - 主观目标使用主观评分提示词，客观目标使用条件判定提示词
 * - 温度取 settings.verifierTemperature（低温度 → 判定更确定）
 */
export function buildVerifierDefinition(params: {
  settings: Settings;
  isSubjective: boolean;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  baseModel: string;
}): AgentDefinition {
  const { settings, isSubjective, baseModel } = params;
  const builtin = BUILTIN_AGENTS.find((agent) => agent.name === 'verifier');
  const tier = resolveEffectiveVerifierTier(settings, isSubjective);

  const model = tier === 'fast'
    ? (settings.fastModelEnabled && settings.fastModel.trim() ? 'fast' : baseModel)
    : tier === 'mentor'
      ? 'mentor'
      : baseModel;

  const promptSource = isSubjective ? VERIFIER_PROMPT_SUBJECTIVE : VERIFIER_PROMPT_OBJECTIVE;
  const prompt: Record<string, string> = {
    'zh-CN': promptSource['zh-CN'],
    'zh-TW': promptSource['zh-TW'],
    en: promptSource.en,
  };

  return {
    name: 'verifier',
    description: builtin?.description ?? 'Goal verifier (internal)',
    mode: 'subagent',
    model,
    temperature: settings.verifierTemperature,
    tools: builtin?.tools ?? { read: true, grep: true, glob: true, list: true },
    internal: true,
    prompt,
  };
}

function buildStrictnessSection(
  isSubjective: boolean,
  strictness: GoalStrictness,
  lang: 'zh-CN' | 'zh-TW' | 'en',
): string {
  const isEn = lang === 'en';
  const isTw = lang === 'zh-TW';
  const t = (s: string, tw: string, en: string) => (isEn ? en : isTw ? tw : s);

  if (isEn) {
    const desc = strictness === 'strict'
      ? '**Strict mode**: The bar is very high. Only call SATISFIED if you are completely confident every aspect of the goal is fully met. Any doubt → NOT_MET.'
      : strictness === 'loose'
        ? '**Loose mode**: The bar is lower. Call SATISFIED if the Worker made substantial, visible progress and the goal is mostly complete.'
        : '**Normal mode**: Use reasonable judgment. Call SATISFIED if the goal is substantially met. Minor gaps → NOT_MET.';
    if (!isSubjective) return desc;
    const threshold = strictness === 'strict' ? '4' : strictness === 'loose' ? '2' : '3';
    const progressThreshold = strictness === 'strict' ? '1.0' : strictness === 'loose' ? '0.7' : '0.9';
    return `${desc}\n- Rubric total for SATISFIED: ≥ ${threshold} points.\n- SATISFIED also requires progress ≥ ${progressThreshold}${strictness === 'strict' ? ' with no remaining gaps' : ''}.`;
  }

  const desc = strictness === 'strict'
    ? t('**严格模式**：标准极高。只有当你完全确信目标的每个方面都达成时才判 SATISFIED。有任何疑虑 → NOT_MET。',
        '**嚴格模式**：標準極高。只有當你完全確信目標的每個方面都達成時才判 SATISFIED。有任何疑慮 → NOT_MET。',
        '')
    : strictness === 'loose'
      ? t('**宽松模式**：标准较低。Worker 做出大量可见进展、目标接近完成时判 SATISFIED。',
          '**寬鬆模式**：標準較低。Worker 做出大量可見進展、目標接近完成時判 SATISFIED。',
          '')
      : t('**一般模式**：合理判断。目标基本达成就判 SATISFIED。有明显缺口 → NOT_MET。',
          '**一般模式**：合理判斷。目標基本達成就判 SATISFIED。有明顯缺口 → NOT_MET。',
          '');
  if (!isSubjective) return desc;
  const threshold = strictness === 'strict' ? '4' : strictness === 'loose' ? '2' : '3';
  const progressThreshold = strictness === 'strict' ? '1.0' : strictness === 'loose' ? '0.7' : '0.9';
  return `${desc}\n- ${t(`SATISFIED 需总分 ≥ ${threshold} 分。`, `SATISFIED 需總分 ≥ ${threshold} 分。`, '')}\n- ${t(`SATISFIED 同时要求 progress ≥ ${progressThreshold}${strictness === 'strict' ? ' 且无任何遗漏' : ''}。`, `SATISFIED 同時要求 progress ≥ ${progressThreshold}${strictness === 'strict' ? ' 且無任何遺漏' : ''}。`, '')}`;
}

/** 构建 Verifier 子代理的用户提示词（任务输入，含核实指令）。 */
export function buildVerifierUserPrompt(params: {
  transcript: string;
  workerContent: string;
  conditionResult: ConditionResult;
  goalText: string;
  isSubjective: boolean;
  strictness: GoalStrictness;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  iteration: number;
  maxIterations: number;
}): string {
  const { transcript, workerContent, conditionResult, goalText, isSubjective, strictness, lang, iteration, maxIterations } = params;
  const isEn = lang === 'en';
  const isTw = lang === 'zh-TW';
  const t = (s: string, tw: string, en: string) => (isEn ? en : isTw ? tw : s);

  const progressContext = isEn
    ? `Iteration ${iteration} of ${maxIterations}. Consider whether this round's progress is reasonable given the remaining budget.`
    : `${t('第', '第', '')} ${iteration} ${t('轮', '輪', '')} / ${t('共', '共', '')} ${maxIterations} ${t('轮', '輪', '')}。${t('请结合剩余预算判断本轮进展是否合理。', '請結合剩餘預算判斷本輪進展是否合理。', '')}`;

  const goalSection = isEn
    ? ['## Goal', goalText].join('\n')
    : [`## ${t('目标', '目標', '')}`, goalText].join('\n');

  const strictnessSection = isEn
    ? ['## Strictness', buildStrictnessSection(isSubjective, strictness, lang)].join('\n')
    : [`## ${t('严格度', '嚴格度', '')}`, buildStrictnessSection(isSubjective, strictness, lang)].join('\n');

  const transcriptSection = [
    `## ${t('Worker 执行记录（工具调用 transcript）', 'Worker 執行記錄（工具調用 transcript）', 'Worker Execution Transcript (tool calls)')}`,
    '```',
    transcript || t('（本轮无工具调用记录）', '（本輪無工具調用記錄）', '(No tool calls recorded in this turn)'),
    '```',
  ].join('\n');

  const claimSection = [
    `## ${t("Worker 本轮自述（其声称做了什么）", 'Worker 本輪自述（其聲稱做了什麼）', "Worker's Own Report (what it claims to have done)")}`,
    '```',
    workerContent.trim() ? workerContent.trim() : t('（无文字回复）', '（無文字回覆）', '(No text reply)'),
    '```',
    t('注意：Worker 的自述不可尽信，以你亲自核实的结果为准。', '注意：Worker 的自述不可盡信，以你親自核實的結果為準。', 'Note: do not trust the Worker\'s self-description — your own verification wins.'),
  ].join('\n');

  const lines: string[] = [goalSection, '', progressContext, '', strictnessSection, '', transcriptSection, '', claimSection];

  if (!isSubjective) {
    lines.push(
      '',
      `## ${t('客观条件结果', '客觀條件結果', 'Objective Condition Result')}`,
      `**${t('是否通过', '是否通過', 'Met')}:** ${conditionResult.met}`,
      '',
      '```',
      conditionResult.evidence,
      '```',
    );
  }

  lines.push(
    '',
    `## ${t('任务', '任務', 'Task')}`,
    isEn
      ? 'Based on the transcript, the Worker\'s report, and the condition result, use the rules in your system prompt to output your verdict as strict JSON. Spot-check key claims with read/grep before judging.'
      : t('根据执行记录、Worker 自述与条件结果，按系统提示词中的规则输出判定（严格 JSON）。关键声称请用 read/grep 抽查核实后再下结论。',
          '根據執行記錄、Worker 自述與條件結果，按系統提示詞中的規則輸出判定（嚴格 JSON）。關鍵聲稱請用 read/grep 抽查核實後再下結論。',
          ''),
  );

  return lines.join('\n');
}

/**
 * 从子代理最终回复中解析判定（兼容 JSON 代码块与纯文本降级推断）。
 */
export function parseVerifierResponse(content: string): GoalVerdict {
  const trimmed = content.trim();

  // 尝试从 markdown 代码块中提取 JSON
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonBlockMatch ? jsonBlockMatch[1].trim() : trimmed;

  // 尝试直接解析 JSON
  try {
    const parsed = JSON.parse(jsonStr);
    if (
      parsed.verdict === 'SATISFIED' ||
      parsed.verdict === 'NOT_MET' ||
      parsed.verdict === 'AMBIGUOUS'
    ) {
      const result: GoalVerdict = {
        verdict: parsed.verdict,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
      };
      if (typeof parsed.missing === 'string' && parsed.missing) {
        result.missing = parsed.missing;
      }
      if (typeof parsed.progress === 'number' && !Number.isNaN(parsed.progress)) {
        result.progress = Math.max(0, Math.min(1, parsed.progress));
      }
      if (
        typeof parsed.failureMode === 'string' &&
        ['no_action', 'wrong_approach', 'partial_fix', 'regression', 'unknown'].includes(parsed.failureMode)
      ) {
        result.failureMode = parsed.failureMode as GoalVerdict['failureMode'];
      }
      return result;
    }
  } catch {
    // JSON 解析失败，尝试从文本中提取 verdict
  }

  // 降级：从文本中推断（注意顺序：先排除否定，再匹配肯定）
  const upper = trimmed.toUpperCase();
  if (upper.includes('NOT_MET') || upper.includes('NOT SATISFIED') || upper.includes('NOT MET')) {
    return {
      verdict: 'NOT_MET',
      evidence: trimmed.slice(0, 500) || 'Verifier 未返回有效判定',
      missing: 'Verifier 输出无法解析为标准 JSON',
      progress: 0,
      failureMode: 'unknown',
    };
  }
  if (upper.includes('AMBIGUOUS')) {
    return {
      verdict: 'AMBIGUOUS',
      evidence: trimmed.slice(0, 500),
      missing: 'Verifier 输出格式异常',
      progress: 0.5,
      failureMode: 'unknown',
    };
  }
  if (upper.includes('SATISFIED')) {
    return {
      verdict: 'SATISFIED',
      evidence: trimmed.slice(0, 500),
      progress: 1.0,
    };
  }
  // 默认 NOT_MET
  return {
    verdict: 'NOT_MET',
    evidence: trimmed.slice(0, 500) || 'Verifier 未返回有效判定',
    missing: 'Verifier 输出无法解析为标准 JSON',
    progress: 0,
    failureMode: 'unknown',
  };
}

export interface VerifierResult {
  verdict: GoalVerdict;
  cacheStats?: ICacheStatistics;
  tier: VerifierModelTier;
}

export interface RunVerifierSubagentParams {
  transcript: string;
  workerContent: string;
  conditionResult: ConditionResult;
  goalText: string;
  isSubjective: boolean;
  strictness: GoalStrictness;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  iteration: number;
  maxIterations: number;
  settings: Settings;
  /** 主模型名（verifierModelTier 解析为 primary 时使用）。 */
  primaryModel: string;
  /** 用户中断信号：中飞可取消（子代理 abort 抛 AbortError）。 */
  abortSignal?: AbortSignal;
}

/**
 * 执行一轮 Verifier 子代理验收：构建运行时定义 → runSubagent（带只读工具循环）
 * → 解析最终 JSON 判定。失败时保持旧语义降级：
 * - 主观目标：返回 NOT_MET（循环继续，由 GoalRunner 的进度门槛兜底）
 * - 客观目标：降级为仅条件评估（met → SATISFIED / 否则 NOT_MET）
 */
export async function runVerifierSubagent(
  context: UiTaskToolContext,
  params: RunVerifierSubagentParams,
): Promise<VerifierResult> {
  const {
    transcript,
    workerContent,
    conditionResult,
    goalText,
    isSubjective,
    strictness,
    lang,
    iteration,
    maxIterations,
    settings,
    primaryModel,
    abortSignal,
  } = params;

  const tier = resolveEffectiveVerifierTier(settings, isSubjective);
  // fast 档但 fastModel 未启用时，子代理实际走 primary 模型（定义 model 降为 baseModel）
  const effectiveTier: VerifierModelTier =
    tier === 'fast' && !(settings.fastModelEnabled && settings.fastModel.trim())
      ? 'primary'
      : tier;
  const definition = buildVerifierDefinition({ settings, isSubjective, lang, baseModel: primaryModel });
  const prompt = buildVerifierUserPrompt({
    transcript,
    workerContent,
    conditionResult,
    goalText,
    isSubjective,
    strictness,
    lang,
    iteration,
    maxIterations,
  });

  // 克隆上下文施加 verifier 专属预算：工具轮数上限 + maxTokens + 关闭 thinking。
  const verifierContext: UiTaskToolContext = {
    ...context,
    maxToolRounds: Math.min(context.maxToolRounds, VERIFIER_MAX_TOOL_ROUNDS),
    defaultMaxTokens: settings.verifierMaxTokens,
    thinkingEnabled: false,
  };

  try {
    const result = await runSubagent(
      verifierContext,
      definition,
      prompt,
      abortSignal,
      VERIFIER_MAX_WALL_CLOCK_MS,
    );
    const content = result.content?.trim() ?? '';
    return {
      verdict: parseVerifierResponse(content),
      cacheStats: result.cacheStats,
      tier: result.tier,
    };
  } catch (err) {
    // 用户中断：AbortError 必须上抛给 GoalRunner 按 interrupted 收尾，
    // 不能吞掉后让循环继续烧下一轮。
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    // Verifier 调用失败时降级
    if (isSubjective) {
      // 主观模式无法降级到条件评估，返回 NOT_MET 让循环继续
      return {
        verdict: {
          verdict: 'NOT_MET',
          evidence: `Verifier 调用失败（${errorMessage(err)}），主观模式无法降级`,
          missing: 'Verifier 不可用',
          progress: 0,
          failureMode: 'unknown',
        },
        tier: effectiveTier,
      };
    }
    return {
      verdict: {
        verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
        evidence: `Verifier 调用失败（${errorMessage(err)}），降级为仅条件评估`,
        progress: conditionResult.met ? 1 : 0,
        failureMode: conditionResult.met ? undefined : 'unknown',
      },
      tier: effectiveTier,
    };
  }
}
