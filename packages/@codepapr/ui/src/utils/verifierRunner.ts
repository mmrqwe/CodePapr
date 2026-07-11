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

import type { GoalVerdict, ConditionResult, ICacheStatistics, ILLMProvider } from '@codepapr/types';
import { runCachedModelRequest } from './cachedModelRequest';
import type { Settings } from '../store/agentStore';

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

function buildVerifierSystemPrompt(isSubjective: boolean): string {
  if (isSubjective) {
    return `You are a Goal Verifier for a subjective task. You have NO tools. You can only read the execution transcript provided to you.

## Your Role

The Worker (main Agent) has been working toward a subjective goal (no machine-verifiable exit code). After each Worker turn, you receive the Worker's execution transcript and must judge: did the Worker genuinely complete the goal?

## Judgment Rules

- **SATISFIED**: The Worker's transcript shows real, meaningful tool calls (file writes, edits, web downloads, etc.) that clearly advance the stated goal. The work is substantive, not just lip service.
- **NOT_MET**: The Worker hasn't done enough work yet, OR declared success without actual tool calls to back it up, OR the work is superficial/irrelevant to the goal.
- **AMBIGUOUS**: You genuinely cannot tell from the transcript whether the goal is met. Use sparingly.

## What to Look For

- Real file write/edit operations that match the goal description
- Downloaded resources (images, assets) if the goal involves adding content
- The transcript should show the Worker actually doing things, not just talking about doing them
- If the Worker claims "done" but the transcript is empty or only contains read operations, judge NOT_MET

## Output Format (STRICT JSON)

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "One-sentence summary", "missing": "What's still needed (omit for SATISFIED)"}

Output ONLY the JSON object.`;
  }

  return `You are a Goal Verifier. You have NO tools. You can only read the execution transcript and condition results provided to you. Your job is to detect whether the Worker is fabricating success.

## Your Role

The Worker (main Agent) has been working toward a goal with a machine-verifiable condition. After each Worker turn:
1. The system runs the verification command and gets an objective result (exit code, stdout, stderr)
2. You receive the Worker's execution transcript AND the objective condition result
3. You must determine: did the Worker actually do the work, or is it trying to declare victory without real proof?

## Judgment Rules

- **SATISFIED**: The condition result shows met: true AND the Worker's transcript shows real tool calls (exec, test runs, etc.) that correspond to the claimed work. No signs of fabrication.
- **NOT_MET**: The condition result shows met: false, OR the Worker's transcript shows it skipped verification, assumed output, or declared success without running commands.
- **AMBIGUOUS**: The condition result and Worker's claims contradict each other in a way you cannot resolve without tools. Use sparingly.

## Anti-Forgery Checks

Watch for these red flags in the Worker's transcript:
- Worker claims "tests pass" but no exec/test tool call appears in the transcript
- Worker paraphrases supposed output that doesn't match the actual condition result
- Worker declares success without any tool calls at all
- Worker's claimed file changes don't correspond to actual write/edit tool calls
- Output text that looks manually typed rather than from a real command

## Output Format (STRICT JSON)

{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "One-sentence summary", "missing": "What's still needed (omit for SATISFIED)"}

Output ONLY the JSON object.`;
}

function buildVerifierUserPrompt(
  transcript: string,
  conditionResult: ConditionResult,
  goalText: string,
  isSubjective: boolean
): string {
  if (isSubjective) {
    return [
      '## Goal (Subjective — no machine-verifiable condition)',
      goalText,
      '',
      '## Worker Execution Transcript',
      '```',
      transcript || '(No tool calls recorded in this turn)',
      '```',
      '',
      '## Task',
      'Based on the transcript above, did the Worker genuinely complete the goal? Output your verdict as strict JSON.',
    ].join('\n');
  }

  return [
    '## Worker Execution Transcript',
    '```',
    transcript || '(No tool calls recorded in this turn)',
    '```',
    '',
    '## Objective Condition Result',
    `**Met:** ${conditionResult.met}`,
    '',
    '```',
    conditionResult.evidence,
    '```',
    '',
    '## Task',
    'Based on the above transcript and condition result, output your verdict as strict JSON.',
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
      return {
        verdict: parsed.verdict,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
        missing: typeof parsed.missing === 'string' ? parsed.missing : undefined,
      };
    }
  } catch {
    // JSON 解析失败，尝试从文本中提取 verdict
  }

  // 降级：从文本中推断
  const upper = trimmed.toUpperCase();
  if (upper.includes('SATISFIED')) {
    return {
      verdict: 'SATISFIED',
      evidence: trimmed.slice(0, 500),
    };
  }
  if (upper.includes('AMBIGUOUS')) {
    return {
      verdict: 'AMBIGUOUS',
      evidence: trimmed.slice(0, 500),
      missing: 'Verifier 输出格式异常',
    };
  }
  // 默认 NOT_MET
  return {
    verdict: 'NOT_MET',
    evidence: trimmed.slice(0, 500) || 'Verifier 未返回有效判定',
    missing: 'Verifier 输出无法解析为标准 JSON',
  };
}

export interface VerifierResult {
  verdict: GoalVerdict;
  cacheStats?: ICacheStatistics;
  tier: 'primary' | 'fast';
}

export async function runVerifier(
  transcript: string,
  conditionResult: ConditionResult,
  goalText: string,
  isSubjective: boolean,
  params: VerifierRunnerParams
): Promise<VerifierResult> {
  const useFast =
    params.settings.verifierModelTier === 'fast' &&
    params.fastModelEnabled &&
    params.fastModel;

  const model = useFast ? params.fastModel : params.primaryModel;
  const tier: 'primary' | 'fast' = useFast ? 'fast' : 'primary';
  const systemPrompt = buildVerifierSystemPrompt(isSubjective);
  const userPrompt = buildVerifierUserPrompt(transcript, conditionResult, goalText, isSubjective);

  try {
    const result = await runCachedModelRequest({
      provider: params.provider,
      providerName: params.providerName,
      model,
      systemPrompt,
      userPrompt,
      temperature: params.settings.verifierTemperature,
      maxTokens: params.settings.verifierMaxTokens,
      thinking: { type: 'disabled' },
      sessionId: `verifier:${model}`,
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
          evidence: `Verifier 调用失败（${(err as Error).message}），主观模式无法降级`,
          missing: 'Verifier 不可用',
        },
        tier,
      };
    }
    return {
      verdict: {
        verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
        evidence: `Verifier 调用失败（${(err as Error).message}），降级为仅条件评估`,
      },
      tier,
    };
  }
}
