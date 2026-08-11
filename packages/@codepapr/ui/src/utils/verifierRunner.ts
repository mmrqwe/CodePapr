/**
 * verifierRunner: Goal 验收器子代理的 UI 层执行器。
 *
 * Verifier 是一个无工具的 ephemeral 子代理，类似于 mentor：
 * - 接收 Worker 的 transcript 摘要和客观条件评估结果
 * - 输出严格 JSON 判定（SATISFIED / NOT_MET / AMBIGUOUS）
 * - 默认使用快速模型，可在高级设置中切换为主模型
 *
 * 复用 runCachedModelRequest 做单次 LLM 调用（无工具循环）。
 */

import { errorMessage } from '@codepapr/common';
import type { GoalVerdict, GoalStrictness, ConditionResult, ICacheStatistics, IChatThinking, ILLMProvider } from '@codepapr/types';
import { ClaudeProvider, OpenAIProvider } from '@codepapr/api';
import { runCachedModelRequest } from './cachedModelRequest';
import type { Settings } from '../store/agentStore';

export type VerifierModelTier = 'fast' | 'primary' | 'mentor';

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

export interface VerifierRunnerParams {
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  settings: Settings;
  /** 主模型名称（verifierModelTier === 'primary' 时使用） */
  primaryModel: string;
  /** 快速模型名称 */
  fastModel: string;
  /** 快速模型是否已启用 */
  fastModelEnabled: boolean;
}

function buildVerifierSystemPrompt(
  isSubjective: boolean,
  strictness: GoalStrictness,
  lang: 'zh-CN' | 'zh-TW' | 'en',
): string {
  const isEn = lang === 'en';
  const isTw = lang === 'zh-TW';

  if (isEn) {
    return buildVerifierSystemPromptEn(isSubjective, strictness);
  }
  return buildVerifierSystemPromptZh(isSubjective, strictness, isTw);
}

function buildVerifierSystemPromptEn(isSubjective: boolean, strictness: GoalStrictness): string {
  const strictnessDesc = strictness === 'strict'
    ? '**Strict mode**: The bar is very high. Only call SATISFIED if you are completely confident every aspect of the goal is fully met. Any doubt → NOT_MET.'
    : strictness === 'loose'
    ? '**Loose mode**: The bar is lower. Call SATISFIED if the Worker made substantial, visible progress and the goal is mostly complete.'
    : '**Normal mode**: Use reasonable judgment. Call SATISFIED if the goal is substantially met. Minor gaps → NOT_MET.';

  const progressThreshold = strictness === 'strict' ? '1.0' : strictness === 'loose' ? '0.7' : '0.9';

  if (isSubjective) {
    return `You are a Goal Verifier for a subjective task. You have NO tools. You only read the execution transcript.

## Your Role
After each Worker turn, you judge whether the Worker genuinely advanced the goal.

${strictnessDesc}

## Judgment Framework (Scoring Rubric)

Score the Worker on these dimensions, then decide the verdict:

| Dimension | 0 points | 0.5 points | 1 point |
|---|---|---|---|
| **Action volume** | No tool calls at all | 1-2 minor tool calls | Multiple substantive tool calls |
| **Goal relevance** | Work is completely off-target | Partially related | Directly addresses the goal |
| **Depth of change** | Only reads / talks about it | Surface-level edits | Meaningful structural changes |
| **Completeness** | Barely started | Halfway there | Goal appears fully achieved |

Add up the scores (0-4 range):
- **SATISFIED**: total ≥ ${strictness === 'strict' ? '4' : strictness === 'loose' ? '2' : '3'}
- **NOT_MET**: total < ${strictness === 'strict' ? '4' : strictness === 'loose' ? '2' : '3'}
- **AMBIGUOUS**: only if you genuinely cannot tell (use very sparingly)

## Completion Threshold
SATISFIED means the goal is substantially COMPLETE — not merely "good progress":
- SATISFIED requires progress ≥ ${progressThreshold}${strictness === 'strict' ? ' with no remaining gaps' : ''}.
- Correct direction, partial edits, or "almost done" → NOT_MET with a concrete missing list.
- Judge against the FULL goal, not just this round's activity.

## Anti-Forgery Checks
Watch for these red flags — they strongly push toward NOT_MET:
- Worker claims "done" but transcript shows only read operations, no writes/edits
- Worker's words describe work that the tool calls don't confirm
- Worker declares success without any tool calls at all
- Output text looks manually typed rather than from a real command
- Worker only describes what they "will" do without doing it

## Output Format (STRICT JSON)

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "One-sentence summary of what you found", "missing": "What's still needed (omit for SATISFIED)", "progress": 0.0-1.0, "failureMode": "no_action" | "wrong_approach" | "partial_fix" | "regression" | "unknown"}

- **progress**: your estimate of how far along the goal is (0 = not started, 1 = done)
- **failureMode**: classify why it failed (omit for SATISFIED):
  - "no_action" — Worker did basically nothing
  - "wrong_approach" — Worker acted but went in the wrong direction
  - "partial_fix" — Worker made progress but didn't finish
  - "regression" — Worker made things worse
  - "unknown" — can't tell

Output ONLY the JSON object, no markdown, no explanation outside JSON.`;
  }

  return `You are a Goal Verifier. You have NO tools. You only read the transcript and condition results. Your job: detect fabrication AND assess real progress.

## Your Role
The Worker pursues a goal with a machine-verifiable condition. After each turn:
1. The system runs the verification command (objective result)
2. You receive the Worker's transcript AND the objective result
3. You determine: is the Worker being honest, and is it making real progress?

${strictnessDesc}

## Judgment Rules

- **SATISFIED**: condition is met: true AND transcript shows real tool calls (exec, test runs, edits) matching the claimed work. No signs of fabrication.
- **NOT_MET**: condition is met: false, OR Worker skipped verification / assumed output / declared success without running commands / fabricated evidence.
- **AMBIGUOUS**: only if transcript and result contradict in a way you cannot resolve. Use very sparingly.

## Anti-Forgery Red Flags
These make NOT_MET more likely:
- Worker claims "tests pass" but no exec/test tool call in transcript
- Worker paraphrases output that doesn't match the actual condition result
- Worker declares success without any tool calls
- Worker's claimed file changes don't match write/edit tool calls
- Output looks manually typed, not from a real command

## Progress Assessment
Even when NOT_MET, assess how much real progress was made:
- **progress 0.0**: no action at all, or purely talking
- **progress 0.3**: started exploring but no real fix attempted
- **progress 0.5**: attempted a fix but it was wrong/incomplete
- **progress 0.7**: mostly there, just one or two things off
- **progress 0.9**: extremely close, minor issue only

## Failure Mode Classification
Classify WHY it failed:
- "no_action" — Worker did basically nothing useful
- "wrong_approach" — Worker tried but the approach was fundamentally wrong
- "partial_fix" — Worker's fix was on the right track but incomplete
- "regression" — Worker introduced new problems / made things worse
- "unknown" — can't determine

## Output Format (STRICT JSON)

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "One-sentence summary", "missing": "What's still wrong (omit for SATISFIED)", "progress": 0.0-1.0, "failureMode": "no_action" | "wrong_approach" | "partial_fix" | "regression" | "unknown"}

Output ONLY the JSON object. No markdown, no extra text.`;
}

function buildVerifierSystemPromptZh(
  isSubjective: boolean,
  strictness: GoalStrictness,
  isTw: boolean,
): string {
  const t = (s: string, tw: string) => (isTw ? tw : s);

  const strictnessDesc = strictness === 'strict'
    ? t('**严格模式**：标准极高。只有当你完全确信目标的每个方面都达成时才判 SATISFIED。有任何疑虑 → NOT_MET。',
        '**嚴格模式**：標準極高。只有當你完全確信目標的每個方面都達成時才判 SATISFIED。有任何疑慮 → NOT_MET。')
    : strictness === 'loose'
    ? t('**宽松模式**：标准较低。Worker 做出大量可见进展、目标接近完成时判 SATISFIED。',
        '**寬鬆模式**：標準較低。Worker 做出大量可見進展、目標接近完成時判 SATISFIED。')
    : t('**一般模式**：合理判断。目标基本达成就判 SATISFIED。有明显缺口 → NOT_MET。',
        '**一般模式**：合理判斷。目標基本達成就判 SATISFIED。有明顯缺口 → NOT_MET。');

  const threshold = strictness === 'strict' ? '4' : strictness === 'loose' ? '2' : '3';
  const progressThreshold = strictness === 'strict' ? '1.0' : strictness === 'loose' ? '0.7' : '0.9';

  if (isSubjective) {
    return `${t('你是主观任务的目标验证者。你没有任何工具，只能阅读执行记录。', '你是主觀任務的目標驗證者。你沒有任何工具，只能閱讀執行記錄。')}

## ${t('你的角色', '你的角色')}
${t('每轮 Worker 结束后，你判断 Worker 是否真正推进了目标。', '每輪 Worker 結束後，你判斷 Worker 是否真正推進了目標。')}

${strictnessDesc}

## ${t('判断框架（评分标准）', '判斷框架（評分標準）')}

${t('从以下维度打分，然后得出结论：', '從以下維度打分，然後得出結論：')}

| ${t('维度', '維度')} | 0 ${t('分', '分')} | 0.5 ${t('分', '分')} | 1 ${t('分', '分')} |
|---|---|---|---|
| **${t('行动量', '行動量')}** | ${t('完全没有工具调用', '完全沒有工具調用')} | 1-2 ${t('个次要工具调用', '個次要工具調用')} | ${t('多个实质性工具调用', '多個實質性工具調用')} |
| **${t('目标相关性', '目標相關性')}** | ${t('工作完全偏离目标', '工作完全偏離目標')} | ${t('部分相关', '部分相關')} | ${t('直接针对目标', '直接針對目標')} |
| **${t('改动深度', '改動深度')}** | ${t('只读 / 嘴上说说', '唯讀 / 嘴上說說')} | ${t('表层修改', '表層修改')} | ${t('有意义的结构性改动', '有意義的結構性改動')} |
| **${t('完成度', '完成度')}** | ${t('刚起步', '剛起步')} | ${t('做到一半', '做到一半')} | ${t('目标看起来完全达成', '目標看起來完全達成')} |

${t('总分', '總分')}（0-4 ${t('分', '分')}）：
- **SATISFIED**：${t('总分', '總分')} ≥ ${threshold}
- **NOT_MET**：${t('总分', '總分')} < ${threshold}
- **AMBIGUOUS**：${t('只有当你真的无法判断时才用（尽量少用）', '只有當你真的無法判斷時才用（盡量少用）')}

## ${t('完成度门槛', '完成度門檻')}
SATISFIED ${t('意味着目标实质完成', '意味著目標實質完成')} —— ${t('而不是"有进展"', '而不是「有進展」')}：
- ${t('判', '判')} SATISFIED ${t('必须', '必須')} progress ≥ ${progressThreshold}${strictness === 'strict' ? t(' 且无任何遗漏', ' 且無任何遺漏') : ''}。
- ${t('方向正确、部分修改、"接近完成" → NOT_MET，并给出具体 missing 清单。', '方向正確、部分修改、「接近完成」→ NOT_MET，並給出具體 missing 清單。')}
- ${t('按整体目标判断，不只看本轮动作。', '按整體目標判斷，不只看本輪動作。')}

## ${t('反伪造检查', '反偽造檢查')}
${t('以下是红旗信号，出现则强烈倾向 NOT_MET：', '以下是紅旗信號，出現則強烈傾向 NOT_MET：')}
- Worker ${t('声称"完成了"但记录里只有读操作，没有写/编辑', '聲稱「完成了」但記錄裡只有讀操作，沒有寫/編輯')}
- Worker ${t('描述的工作和工具调用对不上', '描述的工作和工具調用對不上')}
- Worker ${t('没有任何工具调用就宣称成功', '沒有任何工具調用就宣稱成功')}
- ${t('输出看起来是手打的而不是真实命令输出', '輸出看起來是手打的而不是真實命令輸出')}
- Worker ${t('只描述"将要"做什么但没有实际行动', '只描述「將要」做什麼但沒有實際行動')}

## ${t('输出格式（严格 JSON）', '輸出格式（嚴格 JSON）')}

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "${t('一句话总结你的发现', '一句話總結你的發現')}", "missing": "${t('还需要什么（SATISFIED 时省略）', '還需要什麼（SATISFIED 時省略）')}", "progress": 0.0-1.0, "failureMode": "no_action" | "wrong_approach" | "partial_fix" | "regression" | "unknown"}

- **progress**：${t('你估计目标完成了多少（0 = 没开始，1 = 完成）', '你估計目標完成了多少（0 = 沒開始，1 = 完成）')}
- **failureMode**：${t('失败原因分类（SATISFIED 时省略）', '失敗原因分類（SATISFIED 時省略）')}：
  - "no_action" — Worker ${t('基本什么都没做', '基本什麼都沒做')}
  - "wrong_approach" — Worker ${t('行动了但方向错了', '行動了但方向錯了')}
  - "partial_fix" — Worker ${t('有进展但没做完', '有進展但沒做完')}
  - "regression" — Worker ${t('把事情搞砸了', '把事情搞砸了')}
  - "unknown" — ${t('无法判断', '無法判斷')}

${t('只输出 JSON 对象，不要 markdown，不要 JSON 以外的解释。', '只輸出 JSON 對象，不要 markdown，不要 JSON 以外的解釋。')}`;
  }

  return `${t('你是目标验证者。你没有工具，只能阅读执行记录和条件结果。你的任务：检测伪造 + 评估真实进展。', '你是目標驗證者。你沒有工具，只能閱讀執行記錄和條件結果。你的任務：檢測偽造 + 評估真實進展。')}

## ${t('你的角色', '你的角色')}
Worker ${t('在追求一个有机器验证条件的目标。每轮结束后：', '在追求一個有機器驗證條件的目標。每輪結束後：')}
1. ${t('系统运行验证命令（客观结果）', '系統運行驗證命令（客觀結果）')}
2. ${t('你收到 Worker 的执行记录和客观结果', '你收到 Worker 的執行記錄和客觀結果')}
3. ${t('你判断：Worker 是否诚实，以及它是否在取得真实进展', '你判斷：Worker 是否誠實，以及它是否在取得真實進展')}

${strictnessDesc}

## ${t('判断规则', '判斷規則')}

- **SATISFIED**：${t('条件 met = true，且执行记录显示有真实工具调用（exec、测试运行、编辑）与声称的工作相符。无伪造迹象。', '條件 met = true，且執行記錄顯示有真實工具調用（exec、測試運行、編輯）與聲稱的工作相符。無偽造跡象。')}
- **NOT_MET**：${t('条件 met = false，或 Worker 跳过验证 / 假设输出 / 没运行命令就宣称成功 / 伪造证据。', '條件 met = false，或 Worker 跳過驗證 / 假設輸出 / 沒運行命令就宣稱成功 / 偽造證據。')}
- **AMBIGUOUS**：${t('只有当记录和结果矛盾到无法判断时才用。尽量少用。', '只有當記錄和結果矛盾到無法判斷時才用。盡量少用。')}

## ${t('反伪造红旗', '反偽造紅旗')}
${t('出现以下情况，NOT_MET 的可能性更大：', '出現以下情況，NOT_MET 的可能性更大：')}
- Worker ${t('声称"测试通过了"但记录里没有 exec/test 工具调用', '聲稱「測試通過了」但記錄裡沒有 exec/test 工具調用')}
- Worker ${t('转述的输出和真实条件结果对不上', '轉述的輸出和真實條件結果對不上')}
- Worker ${t('没有任何工具调用就宣告成功', '沒有任何工具調用就宣告成功')}
- Worker ${t('声称的文件改动和 write/edit 工具调用对不上', '聲稱的文件改動和 write/edit 工具調用對不上')}
- ${t('输出看起来是手打的，不是真实命令输出', '輸出看起來是手打的，不是真實命令輸出')}

## ${t('进展评估', '進展評估')}
${t('即使判 NOT_MET，也要评估实际取得了多少进展：', '即使判 NOT_MET，也要評估實際取得了多少進展：')}
- **progress 0.0**：${t('完全没行动，或只是嘴上说说', '完全沒行動，或只是嘴上說說')}
- **progress 0.3**：${t('开始探索了但没尝试真正修复', '開始探索了但沒嘗試真正修復')}
- **progress 0.5**：${t('尝试了修复但方向错了 / 不完整', '嘗試了修復但方向錯了 / 不完整')}
- **progress 0.7**：${t('大部分做对了，只差一两个地方', '大部分做對了，只差一兩個地方')}
- **progress 0.9**：${t('非常接近了，只有小问题', '非常接近了，只有小問題')}

## ${t('失败模式分类', '失敗模式分類')}
${t('判断失败原因：', '判斷失敗原因：')}
- "no_action" — Worker ${t('基本没做有用的事', '基本沒做有用的事')}
- "wrong_approach" — Worker ${t('尝试了但方法根本不对', '嘗試了但方法根本不對')}
- "partial_fix" — Worker ${t('的修复方向对了但不完整', '的修復方向對了但不完整')}
- "regression" — Worker ${t('引入了新问题 / 让事情更糟', '引入了新問題 / 讓事情更糟')}
- "unknown" — ${t('无法确定', '無法確定')}

## ${t('输出格式（严格 JSON）', '輸出格式（嚴格 JSON）')}

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "${t('一句话总结', '一句話總結')}", "missing": "${t('还有什么问题（SATISFIED 时省略）', '還有什麼問題（SATISFIED 時省略）')}", "progress": 0.0-1.0, "failureMode": "no_action" | "wrong_approach" | "partial_fix" | "regression" | "unknown"}

${t('只输出 JSON 对象。不要 markdown，不要额外文字。', '只輸出 JSON 對象。不要 markdown，不要額外文字。')}`;
}

function buildVerifierUserPrompt(
  transcript: string,
  conditionResult: ConditionResult,
  goalText: string,
  isSubjective: boolean,
  lang: 'zh-CN' | 'zh-TW' | 'en',
  iteration: number,
  maxIterations: number,
): string {
  const isEn = lang === 'en';
  const isTw = lang === 'zh-TW';
  const t = (s: string, tw: string) => (isTw ? tw : s);

  const progressContext = isEn
    ? `Iteration ${iteration} of ${maxIterations}. Consider whether this round's progress is reasonable given the remaining budget.`
    : `第 ${iteration} 轮 / 共 ${maxIterations} 轮。${t('请结合剩余预算判断本轮进展是否合理。', '請結合剩餘預算判斷本輪進展是否合理。')}`;

  if (isSubjective) {
    if (isEn) {
      return [
        '## Goal (Subjective — no machine-verifiable condition)',
        goalText,
        '',
        `_${progressContext}_`,
        '',
        '## Worker Execution Transcript',
        '```',
        transcript || '(No tool calls recorded in this turn)',
        '```',
        '',
        '## Task',
        'Based on the transcript, did the Worker genuinely advance the goal? Score it using the rubric and output strict JSON.',
      ].join('\n');
    }
    return [
      '## 目标（主观 — 无机器可验证条件）'.replace('目標', t('目标', '目標')),
      goalText,
      '',
      `_${progressContext}_`,
      '',
      '## Worker 执行记录'.replace('執行記錄', t('执行记录', '執行記錄')),
      '```',
      transcript || t('（本轮无工具调用记录）', '（本輪無工具調用記錄）'),
      '```',
      '',
      '## 任务'.replace('任務', t('任务', '任務')),
      t('根据执行记录，Worker 是否真正推进了目标？使用评分标准打分，输出严格 JSON。',
        '根據執行記錄，Worker 是否真正推進了目標？使用評分標準打分，輸出嚴格 JSON。'),
    ].join('\n');
  }

  if (isEn) {
    return [
      '## Worker Execution Transcript',
      '```',
      transcript || '(No tool calls recorded in this turn)',
      '```',
      '',
      `_${progressContext}_`,
      '',
      '## Objective Condition Result',
      `**Met:** ${conditionResult.met}`,
      '',
      '```',
      conditionResult.evidence,
      '```',
      '',
      '## Task',
      'Based on the transcript and condition result, use the rubric to output your verdict as strict JSON.',
    ].join('\n');
  }

  return [
    '## Worker 执行记录'.replace('執行記錄', t('执行记录', '執行記錄')),
    '```',
    transcript || t('（本轮无工具调用记录）', '（本輪無工具調用記錄）'),
    '```',
    '',
    `_${progressContext}_`,
    '',
    '## 客观条件结果'.replace('客觀條件結果', t('客观条件结果', '客觀條件結果')),
    `**${t('是否通过', '是否通過')}:** ${conditionResult.met}`,
    '',
    '```',
    conditionResult.evidence,
    '```',
    '',
    '## 任务'.replace('任務', t('任务', '任務')),
    t('根据执行记录和条件结果，使用评分标准输出判定，严格 JSON 格式。',
      '根據執行記錄和條件結果，使用評分標準輸出判定，嚴格 JSON 格式。'),
  ].join('\n');
}

function parseVerifierResponse(content: string): GoalVerdict {
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

export async function runVerifier(
  transcript: string,
  conditionResult: ConditionResult,
  goalText: string,
  isSubjective: boolean,
  strictness: GoalStrictness,
  lang: 'zh-CN' | 'zh-TW' | 'en',
  iteration: number,
  maxIterations: number,
  params: VerifierRunnerParams
): Promise<VerifierResult> {
  const mentorConfigured =
    params.settings.mentorEnabled && params.settings.mentorModel.trim().length > 0;
  let tier = resolveVerifierTier(params.settings.verifierModelTier, isSubjective, mentorConfigured);

  let provider: ILLMProvider = params.provider;
  let providerName: 'deepseek' | 'openai' | 'claude' = params.providerName;
  let model: string;
  let maxTokens = params.settings.verifierMaxTokens;
  let thinking: IChatThinking = { type: 'disabled' };

  if (tier === 'mentor') {
    model = params.settings.mentorModel.trim();
    const apiKey = params.settings.mentorApiKey.trim() || params.settings.apiKey.trim();
    const mentorBaseURL = params.settings.mentorBaseURL.trim().replace(/\/+$/, '');
    const baseURL = mentorBaseURL || params.settings.baseURL.trim().replace(/\/+$/, '') || undefined;
    const config = { apiKey, ...(baseURL ? { baseURL } : {}) };
    if (params.settings.mentorApiFormat === 'claude') {
      provider = new ClaudeProvider(config);
      providerName = 'claude';
    } else {
      provider = new OpenAIProvider(config);
      providerName = 'openai';
    }
    maxTokens = params.settings.mentorMaxTokens;
    thinking = params.settings.mentorThinkingEnabled ? { type: 'enabled' } : { type: 'disabled' };
  } else if (tier === 'fast' && params.fastModelEnabled && params.fastModel) {
    model = params.fastModel;
  } else {
    tier = 'primary';
    model = params.primaryModel;
  }

  const systemPrompt = buildVerifierSystemPrompt(isSubjective, strictness, lang);
  const userPrompt = buildVerifierUserPrompt(transcript, conditionResult, goalText, isSubjective, lang, iteration, maxIterations);

  try {
    const result = await runCachedModelRequest({
      provider,
      providerName,
      model,
      systemPrompt,
      userPrompt,
      temperature: params.settings.verifierTemperature,
      maxTokens,
      thinking,
      sessionId: `verifier:${tier}:${model}`,
    });
    const content = result.response.choices[0]?.message.content?.trim() ?? '';
    return { verdict: parseVerifierResponse(content), cacheStats: result.cacheStats, tier };
  } catch (err) {
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
        tier,
      };
    }
    return {
      verdict: {
        verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
        evidence: `Verifier 调用失败（${errorMessage(err)}），降级为仅条件评估`,
        progress: conditionResult.met ? 1 : 0,
        failureMode: conditionResult.met ? undefined : 'unknown',
      },
      tier,
    };
  }
}
