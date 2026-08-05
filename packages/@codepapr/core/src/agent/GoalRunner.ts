/**
 * GoalRunner: /goal 指令的外循环编排器（纯逻辑，不依赖 UI）。
 *
 * 核心机制：
 *  1. Worker 模型（主 Agent）执行一轮工作
 *  2. 客观条件函数执行验证命令，判定条件是否达成
 *  3. Verifier 子代理（无工具）读取 transcript，防止 Worker 伪造成功假象
 *  4. 条件函数判定 + Verifier 反伪造 = 双保险
 *  5. 未达成 → 生成反馈注入下一轮 → 继续循环
 *
 * 该类通过依赖注入接收所有外部能力（agent 执行、verifier 调用、条件评估、状态持久化），
 * 因此可被 UI 和 CLI 双入口复用，也可单测。
 */

import type {
  GoalCondition,
  GoalVerdict,
  GoalRunnerState,
  GoalRunnerLimits,
  GoalIterationFeedback,
  ConditionResult,
  ConditionClauseResult,
} from '@codepapr/types';

export interface WorkerTurnResult {
  /** Worker 的最终文本回复 */
  content: string;
  /** 本轮执行的 transcript 摘要（工具调用 + 结果），传给 Verifier */
  transcript: string;
  /** 本轮消耗的 output tokens */
  outputTokens: number;
}

export interface GoalRunnerCallbacks {
  /** 执行一轮 Worker turn，返回结果和 transcript */
  runWorkerTurn: (prompt: string, isFeedback: boolean) => Promise<WorkerTurnResult>;
  /** 调用 Verifier 子代理，让它基于 transcript 判定 Worker 是否在伪造成功 */
  runVerifier: (transcript: string, conditionResult: ConditionResult) => Promise<GoalVerdict>;
  /** 执行验证条件命令，返回客观结果 */
  evaluateCondition: () => Promise<ConditionResult>;
  /** 状态变更通知（UI 更新 banner） */
  onStateChange: (state: GoalRunnerState) => void;
  /** 可选：触发上下文压缩 */
  onCompaction?: () => Promise<void>;
  /** 可选：持久化 goal 状态到文件（防 context rot） */
  writeGoalState?: (state: GoalRunnerState) => Promise<void>;
  /** 检查是否被用户中断 */
  isAborted: () => boolean;
}

export interface GoalRunnerOptions {
  condition: GoalCondition;
  /** 用户的自然语言目标（可选，用于注入 Worker 提示词） */
  userGoalText: string;
  callbacks: GoalRunnerCallbacks;
  limits: GoalRunnerLimits;
  lang?: 'zh-CN' | 'zh-TW' | 'en';
}

export const DEFAULT_GOAL_MAX_ITERATIONS = 20;
export const DEFAULT_GOAL_MAX_WALL_CLOCK_MS = 1_800_000; // 30 min
export const DEFAULT_GOAL_COMPACTION_INTERVAL = 5;

export class GoalRunner {
  private condition: GoalCondition;
  private userGoalText: string;
  private callbacks: GoalRunnerCallbacks;
  private limits: GoalRunnerLimits;
  private lang: 'zh-CN' | 'zh-TW' | 'en';

  private state: GoalRunnerState;

  constructor(opts: GoalRunnerOptions) {
    this.condition = opts.condition;
    this.userGoalText = opts.userGoalText;
    this.callbacks = opts.callbacks;
    this.limits = opts.limits;
    this.lang = opts.lang ?? 'zh-CN';

    this.state = {
      status: 'running',
      iteration: 0,
      startedAt: Date.now(),
      elapsedMs: 0,
      totalOutputTokens: 0,
      lastVerdict: null,
      lastConditionResult: null,
      feedbackHistory: [],
    };
  }

  getState(): GoalRunnerState {
    return { ...this.state };
  }

  async run(): Promise<GoalRunnerState> {
    // eslint-disable-next-line no-console
    console.log('[GoalRunner] run() started', { maxIterations: this.limits.maxIterations, maxWallClockMs: this.limits.maxWallClockMs });
    for (let iteration = 0; iteration < this.limits.maxIterations; iteration++) {
      if (this.callbacks.isAborted()) {
        this.state.status = 'interrupted';
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        this.notifyAndPersist();
        return this.getState();
      }

      const elapsed = Date.now() - this.state.startedAt;
      if (elapsed > this.limits.maxWallClockMs) {
        this.state.status = 'limit_exceeded';
        this.state.elapsedMs = elapsed;
        this.notifyAndPersist();
        return this.getState();
      }

      if (
        this.limits.maxCostTokens &&
        this.state.totalOutputTokens > this.limits.maxCostTokens
      ) {
        this.state.status = 'limit_exceeded';
        this.state.elapsedMs = elapsed;
        this.notifyAndPersist();
        return this.getState();
      }

      this.state.iteration = iteration + 1;
      this.state.elapsedMs = elapsed;
      this.notifyAndPersist();

      // ── Worker turn ──────────────────────────────────────────
      const isFeedback = iteration > 0;
      // plan-first 跳过第 1 轮评估后，第 2 轮 feedbackHistory 为空，用初始提示
      const useFeedback = isFeedback && this.state.feedbackHistory.length > 0;
      const workerPrompt = useFeedback
        ? this.buildFeedbackPrompt()
        : this.buildInitialPrompt();
      // eslint-disable-next-line no-console
      console.log('[GoalRunner] iteration', iteration + 1, { isFeedback, promptLength: workerPrompt.length });

      let workerResult: WorkerTurnResult;
      try {
        // eslint-disable-next-line no-console
        console.log('[GoalRunner] calling runWorkerTurn', { iteration: iteration + 1, isFeedback });
        workerResult = await this.callbacks.runWorkerTurn(workerPrompt, isFeedback);
        // eslint-disable-next-line no-console
        console.log('[GoalRunner] runWorkerTurn completed', { iteration: iteration + 1, contentLength: workerResult.content.length, outputTokens: workerResult.outputTokens });
      } catch (err) {
        console.error('[GoalRunner] runWorkerTurn failed', err);
        this.state.status = 'error';
        this.state.error = (err as Error).message;
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        this.notifyAndPersist();
        return this.getState();
      }

      this.state.totalOutputTokens += workerResult.outputTokens;
      this.state.elapsedMs = Date.now() - this.state.startedAt;

      // ── plan-first 模式：第 1 轮只规划，跳过评估 ──────────────
      if (this.limits.planFirst && iteration === 0) {
        // eslint-disable-next-line no-console
        console.log('[GoalRunner] plan-first: skipping evaluation for iteration 1');
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        this.notifyAndPersist();
        continue;
      }

      // ── 客观条件评估 ──────────────────────────────────────────
      let conditionResult: ConditionResult;
      try {
        conditionResult = await this.callbacks.evaluateCondition();
      } catch (err) {
        // 条件评估本身出错（如命令不存在），记录但继续让 Verifier 判断
        conditionResult = {
          met: false,
          evidence: `条件评估出错: ${(err as Error).message}`,
          details: [],
        };
      }
      this.state.lastConditionResult = conditionResult;

      // ── Verifier 反伪造检查 ───────────────────────────────────
      let verdict: GoalVerdict;
      try {
        verdict = await this.callbacks.runVerifier(
          workerResult.transcript,
          conditionResult
        );
      } catch {
        // Verifier 出错时降级：仅依赖条件评估结果
        verdict = {
          verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
          evidence: 'Verifier 调用失败，降级为仅条件评估',
          progress: conditionResult.met ? 1 : 0,
          failureMode: conditionResult.met ? undefined : 'unknown',
        };
      }
      this.state.lastVerdict = verdict;

      // ── 记录反馈 ──────────────────────────────────────────────
      const feedback: GoalIterationFeedback = {
        iteration: iteration + 1,
        verdict,
        conditionResult,
      };
      this.state.feedbackHistory.push(feedback);

      // ── 判定是否达成 ──────────────────────────────────────────
      // 客观模式（有 exec: 条件）：条件满足 + Verifier 确认 = 双保险
      // 主观模式（无 exec: 条件）：仅 Verifier 判定 SATISFIED
      const hasObjectiveCondition = this.condition.clauses.length > 0;
      const isSatisfied = hasObjectiveCondition
        ? (conditionResult.met && verdict.verdict === 'SATISFIED')
        : (verdict.verdict === 'SATISFIED');
      if (isSatisfied) {
        this.state.status = 'satisfied';
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        this.notifyAndPersist();
        return this.getState();
      }

      // ── 上下文压缩 ────────────────────────────────────────────
      const compactionInterval = this.limits.compactionEveryNIterations ?? DEFAULT_GOAL_COMPACTION_INTERVAL;
      if (compactionInterval > 0 && (iteration + 1) % compactionInterval === 0) {
        try {
          await this.callbacks.onCompaction?.();
        } catch {
          // 压缩失败不阻断 goal 循环
        }
      }

      this.state.elapsedMs = Date.now() - this.state.startedAt;
      this.notifyAndPersist();
    }

    // 迭代次数耗尽
    this.state.status = 'limit_exceeded';
    this.state.elapsedMs = Date.now() - this.state.startedAt;
    this.notifyAndPersist();
    return this.getState();
  }

  private notifyAndPersist(): void {
    this.callbacks.onStateChange(this.getState());
    // fire-and-forget 持久化必须接住失败：`void` 不会捕获 reject，旧实现下
    // 每次写失败（磁盘满/权限）都成为 unhandled rejection（每迭代约 7 次）。
    const pending = this.callbacks.writeGoalState?.(this.getState());
    pending?.catch((error: unknown) => {
      console.warn('[GoalRunner] 状态持久化失败:', error);
    });
  }

  private buildInitialPrompt(): string {
    const goalText = this.userGoalText || this.condition.humanReadable;
    const isEn = this.lang === 'en';
    const isTw = this.lang === 'zh-TW';
    const isSubjective = this.condition.clauses.length === 0;
    const maxIter = this.limits.maxIterations;
    const planFirst = !!this.limits.planFirst;
    const strictLabel = this.condition.strictness === 'strict'
      ? (isEn ? 'strict' : isTw ? '嚴格' : '严格')
      : this.condition.strictness === 'loose'
      ? (isEn ? 'loose' : isTw ? '寬鬆' : '宽松')
      : (isEn ? 'normal' : isTw ? '一般' : '一般');

    if (isEn) {
      return this.buildInitialPromptEn(goalText, isSubjective, maxIter, strictLabel, planFirst);
    }

    return this.buildInitialPromptZh(goalText, isSubjective, maxIter, strictLabel, planFirst, isTw);
  }

  private buildInitialPromptEn(
    goalText: string,
    isSubjective: boolean,
    maxIter: number,
    strictLabel: string,
    planFirst: boolean,
  ): string {
    const verificationSection = isSubjective
      ? `## Verification
An AI verifier will review your tool-call transcript after each round. It judges based on what you ACTUALLY did, not what you say you'll do.

Strictness level: **${strictLabel}**`
      : `## Verification Condition
${this.condition.humanReadable}

After each round, the system runs this command automatically. The exit code is the final judge.`;

    const planSection = planFirst
      ? `## First-Round Strategy (Iteration 1)
This is iteration 1 of ${maxIter} total. Use this round for:
1. **Read-only exploration** — understand the codebase, find relevant files, reproduce the issue
2. **Output a concrete sub-plan** — break the goal into 3-5 ordered steps with specific deliverables
3. **Identify risks and unknowns** — flag what could go wrong

Do NOT start implementing in round 1. Planning saves iterations.`
      : `## First-Round Strategy (Iteration 1)
This is iteration 1 of ${maxIter} total. Before changing anything:
1. **Explore first** — read relevant files, reproduce the issue, understand the root cause
2. **Prioritize the biggest blocker** — don't nibble at edges, attack the core problem
3. **Make substantive progress** — each round should visibly move the needle`;

    return `You are in a goal-driven autonomous loop. Your mission: achieve the goal in as few iterations as possible.

## Goal
${goalText}

${verificationSection}

## How the Loop Works
1. You work for one round using all your tools
2. Verification runs automatically when you stop
3. If not met, you get detailed feedback + failure history
4. You try again with a different approach — same approach = wasted iteration

## Budget & Pressure
- **Max iterations: ${maxIter}** — you have limited rounds. Use them wisely.
- Each wasted iteration brings you closer to failure.
- Quality matters more than speed, but progress must be visible every round.

${planSection}

## Non-Negotiable Rules
1. **No empty talk.** Don't describe what you "would" do — actually do it. The verifier checks tool calls.
2. **No self-declared victory.** Never claim the goal is done — verification decides.
3. **No fabricated output.** Never make up test results or command output.
4. **No repeating failures.** If an approach failed, analyze why and pivot before trying again.
5. **Read errors carefully.** When a command fails, the full output is your most valuable signal.

## Round-End Routine
When you finish working this round, end with this structure:
- **What I did**: 1-2 sentence summary of concrete changes
- **What I think the result will be**: your best guess, with low confidence
- **What's next if this fails**: your backup plan

Focus on execution. Make this round count.`;
  }

  private buildInitialPromptZh(
    goalText: string,
    isSubjective: boolean,
    maxIter: number,
    strictLabel: string,
    planFirst: boolean,
    isTw: boolean,
  ): string {
    const t = (s: string, tw: string) => (isTw ? tw : s);

    const verificationSection = isSubjective
      ? `## ${t('验收方式', '驗收方式')}
${t('每轮结束后，AI 审查者会检查你的工具调用记录。它只看你实际做了什么，不看你说了什么。', '每輪結束後，AI 審查者會檢查你的工具調用記錄。它只看你實際做了什麼，不看你說了什麼。')}

${t('严格度', '嚴格度')}：**${strictLabel}**`
      : `## ${t('验收条件', '驗收條件')}
${this.condition.humanReadable}

${t('每轮结束后系统自动执行此命令，退出码为最终判定依据。', '每輪結束後系統自動執行此命令，退出碼為最終判定依據。')}`;

    const planSection = planFirst
      ? `## ${t('第 1 轮策略', '第 1 輪策略')}（${t('第 1 轮', '第 1 輪')} / ${t('共', '共')} ${maxIter} ${t('轮', '輪')}）
${t('本轮只做规划，不动手实现：', '本輪只做規劃，不動手實現：')}
1. **${t('只读探索', '唯讀探索')}** — ${t('理解代码结构、定位相关文件、复现问题', '理解代碼結構、定位相關文件、重現問題')}
2. **${t('输出具体子计划', '輸出具體子計劃')}** — ${t('把目标拆成 3-5 个有序步骤，明确每步交付物', '把目標拆成 3-5 個有序步驟，明確每步交付物')}
3. **${t('识别风险和未知项', '識別風險和未知項')}** — ${t('标出可能出问题的地方', '標出可能出問題的地方')}

${t('第 1 轮不要写代码。规划是为了节省后续迭代。', '第 1 輪不要寫代碼。規劃是為了節省後續疊代。')}`
      : `## ${t('第 1 轮策略', '第 1 輪策略')}（${t('第 1 轮', '第 1 輪')} / ${t('共', '共')} ${maxIter} ${t('轮', '輪')}）
${t('动手之前先想清楚：', '動手之前先想清楚：')}
1. **${t('先探索', '先探索')}** — ${t('读相关文件、复现问题、理解根因', '讀相關文件、重現問題、理解根因')}
2. **${t('先打最大的阻塞点', '先打最大的阻塞點')}** — ${t('不要在边缘问题上磨蹭，直击核心', '不要在邊緣問題上磨蹭，直擊核心')}
3. **${t('每轮都要有实质性进展', '每輪都要有實質性進展')}** — ${t('不能原地踏步', '不能原地踏步')}`;

    return `${t('你处于一个目标驱动的自主循环中。你的任务：用尽可能少的轮次达成目标。', '你處於一個目標驅動的自主循環中。你的任務：用盡可能少的輪次達成目標。')}

## ${t('目标', '目標')}
${goalText}

${verificationSection}

## ${t('循环机制', '循環機制')}
1. ${t('你使用所有工具工作一轮', '你使用所有工具工作一輪')}
2. ${t('停止后自动运行验收', '停止後自動運行驗收')}
3. ${t('未通过 → 你会收到详细反馈 + 历史失败记录', '未通過 → 你會收到詳細回饋 + 歷史失敗記錄')}
4. ${t('换方法重试 —— 同样的方法 = 浪费一轮', '換方法重試 —— 同樣的方法 = 浪費一輪')}

## ${t('预算与压力', '預算與壓力')}
- **${t('最多', '最多')} ${maxIter} ${t('轮', '輪')}** —— ${t('轮次有限，请善用。', '輪次有限，請善用。')}
- ${t('每浪费一轮，离失败就近一步。', '每浪費一輪，離失敗就近一步。')}
- ${t('质量比速度重要，但每轮必须有可见进展。', '質量比速度重要，但每輪必須有可見進展。')}

${planSection}

## ${t('铁律', '鐵律')}
1. **${t('不说空话。', '不說空話。')}** ${t('不要描述你"将会"做什么 —— 实际去做。审查者看的是工具调用记录。', '不要描述你「將會」做什麼 —— 實際去做。審查者看的是工具調用記錄。')}
2. **${t('不自我宣告胜利。', '不自我宣告勝利。')}** ${t('永远不要声称目标已完成 —— 验收说了算。', '永遠不要聲稱目標已完成 —— 驗收說了算。')}
3. **${t('不伪造输出。', '不偽造輸出。')}** ${t('绝不编造测试结果或命令输出。', '絕不編造測試結果或命令輸出。')}
4. **${t('不重复失败。', '不重複失敗。')}** ${t('一个方法失败了，先分析原因再换方向重试。', '一個方法失敗了，先分析原因再換方向重試。')}
5. **${t('认真读错误。', '認真讀錯誤。')}** ${t('命令失败时，完整的错误输出是最有价值的信号。', '命令失敗時，完整的錯誤輸出是最有價值的信號。')}

## ${t('本轮结束时', '本輪結束時')}
${t('工作结束时，按以下结构收尾：', '工作結束時，按以下結構收尾：')}
- **${t('做了什么', '做了什麼')}**：${t('1-2 句话概述具体改动', '1-2 句話概述具體改動')}
- **${t('预期结果', '預期結果')}**：${t('你对结果的最佳猜测（保持低自信）', '你對結果的最佳猜測（保持低自信）')}
- **${t('如果失败的备选方案', '如果失敗的備選方案')}**：${t('你的 Plan B', '你的 Plan B')}

${t('专注执行。让这一轮物有所值。', '專注執行。讓這一輪物有所值。')}`;
  }

  private buildFeedbackPrompt(): string {
    const lastFeedback = this.state.feedbackHistory[this.state.feedbackHistory.length - 1];
    const conditionResult = lastFeedback.conditionResult;
    const verdict = lastFeedback.verdict;
    const isEn = this.lang === 'en';
    const isTw = this.lang === 'zh-TW';
    const isSubjective = this.condition.clauses.length === 0;

    const failedClauses = conditionResult.details.filter((d) => !d.met);
    const previousAttempts = this.state.feedbackHistory.length;
    const remaining = this.limits.maxIterations - this.state.iteration;
    const historySummary = this.buildFailureHistorySummary(isEn, isTw);

    if (isEn) {
      return this.buildFeedbackPromptEn(
        isSubjective, failedClauses, conditionResult, verdict,
        previousAttempts, remaining, historySummary,
      );
    }

    return this.buildFeedbackPromptZh(
      isSubjective, failedClauses, conditionResult, verdict,
      previousAttempts, remaining, historySummary, isTw,
    );
  }

  private buildFailureHistorySummary(isEn: boolean, isTw: boolean): string {
    const history = this.state.feedbackHistory;
    if (history.length <= 1) return '';

    const MAX_SHOWN = 5;
    const shown = history.slice(-MAX_SHOWN);
    const olderCount = history.length - shown.length;

    const lines: string[] = [];
    const label = isEn ? '## Failure History' : isTw ? '## 失敗歷史' : '## 失败历史';
    lines.push(label);
    lines.push(isEn
      ? `You've failed ${history.length} times already. Learn from each one — don't repeat the same pattern.`
      : isTw
      ? `你已經失敗了 ${history.length} 次。從每次失敗中學習 —— 不要重複同樣的模式。`
      : `你已经失败了 ${history.length} 次。从每次失败中学习 —— 不要重复同样的模式。`
    );
    if (olderCount > 0) {
      lines.push(isEn
        ? `(Showing last ${MAX_SHOWN} of ${history.length} failures)`
        : isTw
        ? `（顯示最近 ${MAX_SHOWN} 條，共 ${history.length} 條失敗）`
        : `（显示最近 ${MAX_SHOWN} 条，共 ${history.length} 条失败）`);
    }
    lines.push('');

    for (let i = 0; i < shown.length; i++) {
      const fb = shown[i];
      const roundNum = history.length - shown.length + i + 1;
      const v = fb.verdict;
      const cond = fb.conditionResult;

      let reason = '';
      if (cond.details.length > 0) {
        const failed = cond.details.filter(d => !d.met);
        const firstFailed = failed[0];
        if (firstFailed) {
          const firstLine = firstFailed.evidence.split('\n').find(
            l => l.includes('stdout') || l.includes('退出碼') || l.includes('退出码')
          ) ?? firstFailed.evidence.split('\n')[0];
          reason = firstLine.slice(0, 120);
        }
      } else if (v.missing) {
        reason = v.missing.slice(0, 120);
      } else {
        reason = v.evidence.slice(0, 120);
      }

      const progressInfo = typeof v.progress === 'number'
        ? (isEn ? ` | progress: ${Math.round(v.progress * 100)}%` : isTw ? ` | 進展: ${Math.round(v.progress * 100)}%` : ` | 进展: ${Math.round(v.progress * 100)}%`)
        : '';

      const failureModeInfo = v.failureMode
        ? (isEn ? ` | mode: ${v.failureMode}` : isTw ? ` | 模式: ${v.failureMode}` : ` | 模式: ${v.failureMode}`)
        : '';

      lines.push(`- ${isEn ? 'Round' : isTw ? '第' : '第'} ${roundNum}${isEn ? '' : isTw ? '輪' : '轮'}: ${reason}${progressInfo}${failureModeInfo}`);
    }

    lines.push('');
    lines.push(isEn
      ? '### Retrospective Required'
      : isTw ? '### 必須復盤' : '### 必须复盘');
    lines.push(isEn
      ? 'Before writing any code this round, answer these questions in your head:'
      : isTw
      ? '本輪寫任何代碼之前，先在腦中回答這些問題：'
      : '本轮写任何代码之前，先在脑中回答这些问题：');
    lines.push(isEn
      ? '1. What pattern is repeating across failures?'
      : isTw ? '1. 失敗中有什麼重複的模式？' : '1. 失败中有什么重复的模式？');
    lines.push(isEn
      ? '2. What assumption was wrong last time?'
      : isTw ? '2. 上次哪個假設是錯的？' : '2. 上次哪个假设是错的？');
    lines.push(isEn
      ? '3. What completely different approach could I try?'
      : isTw ? '3. 我可以嘗試什麼完全不同的方法？' : '3. 我可以尝试什么完全不同的方法？');
    lines.push('');

    return lines.join('\n');
  }

  private buildFeedbackPromptEn(
    isSubjective: boolean,
    failedClauses: ConditionClauseResult[],
    conditionResult: ConditionResult,
    verdict: GoalVerdict,
    previousAttempts: number,
    remaining: number,
    historySummary: string,
  ): string {
    const lines: string[] = [
      `## GOAL NOT MET — Iteration ${this.state.iteration} | ${remaining} attempts remaining`,
      '',
      `You have failed ${previousAttempts} times. ${remaining} rounds left. Don't waste them.`,
      '',
    ];

    if (isSubjective) {
      lines.push('### Verifier Assessment');
      lines.push(`**Verdict:** ${verdict.verdict}`);
      lines.push(`**Evidence:** ${verdict.evidence}`);
      if (verdict.missing) {
        lines.push(`**Still needed:** ${verdict.missing}`);
      }
      if (typeof verdict.progress === 'number') {
        lines.push(`**Progress:** ${Math.round(verdict.progress * 100)}%`);
      }
      if (verdict.failureMode) {
        lines.push(`**Failure mode:** ${verdict.failureMode}`);
      }
      lines.push('');
    } else {
      lines.push('### Verification Result');
      lines.push('```');
      lines.push(conditionResult.evidence);
      lines.push('```');
      lines.push('');

      if (failedClauses.length > 0) {
        lines.push('### Failed Checks');
        for (const clause of failedClauses) {
          lines.push(`- ${clause.evidence.split('\n')[0]} → exit code ${clause.exitCode ?? 'null'}`);
        }
        lines.push('');
      }

      lines.push('### Verifier Assessment');
      lines.push(`**Verdict:** ${verdict.verdict}`);
      lines.push(`**Evidence:** ${verdict.evidence}`);
      if (verdict.missing) {
        lines.push(`**Missing:** ${verdict.missing}`);
      }
      if (typeof verdict.progress === 'number') {
        lines.push(`**Progress:** ${Math.round(verdict.progress * 100)}%`);
      }
      if (verdict.failureMode) {
        lines.push(`**Failure mode:** ${verdict.failureMode}`);
      }
      lines.push('');
    }

    if (historySummary) {
      lines.push(historySummary);
    }

    lines.push('### Strategy for This Round');
    lines.push(isSubjective
      ? 'The verifier checks your ACTUAL tool calls, not your words. Make real changes.'
      : 'The verification output above is REAL. Read it. Understand the root cause. Don\'t guess.');
    lines.push('');
    lines.push('- **Pivot hard.** If the same approach has failed multiple times, try something fundamentally different.');
    lines.push('- **Go deeper.** If you\'ve been making surface-level changes, dig into the underlying cause.');
    lines.push('- **Read before writing.** Don\'t modify code you don\'t fully understand.');
    lines.push('- **If stuck after 3+ attempts, consider:** asking a sub-agent for a second opinion, or trying a completely different approach.');
    lines.push('');
    lines.push(`You have ${remaining} rounds left. Make this one count.`);

    return lines.join('\n');
  }

  private buildFeedbackPromptZh(
    isSubjective: boolean,
    failedClauses: ConditionClauseResult[],
    conditionResult: ConditionResult,
    verdict: GoalVerdict,
    previousAttempts: number,
    remaining: number,
    historySummary: string,
    isTw: boolean,
  ): string {
    const t = (s: string, tw: string) => (isTw ? tw : s);

    const lines: string[] = [
      `## 目標未達成 — 第 ${this.state.iteration} 輪 | 剩餘 ${remaining} 次機會`,
      '',
      `你已經失敗了 ${previousAttempts} 次。還剩 ${remaining} 輪。不要浪費它們。`.replace('剩餘', t('剩余', '剩餘')).replace('還剩', t('还剩', '還剩')),
      '',
    ];

    if (isSubjective) {
      lines.push('### Verifier 評估'.replace('評估', t('评估', '評估')));
      lines.push(`**判定：** ${verdict.verdict}`);
      lines.push(`**依據：** ${verdict.evidence}`);
      if (verdict.missing) {
        lines.push(`**還需要：** ${verdict.missing}`.replace('還需要', t('还需要', '還需要')));
      }
      if (typeof verdict.progress === 'number') {
        lines.push(`**進展：** ${Math.round(verdict.progress * 100)}%`.replace('進展', t('进展', '進展')));
      }
      if (verdict.failureMode) {
        lines.push(`**失敗模式：** ${verdict.failureMode}`.replace('失敗模式', t('失败模式', '失敗模式')));
      }
      lines.push('');
    } else {
      lines.push('### 驗收結果'.replace('驗收', t('验收', '驗收')));
      lines.push('```');
      lines.push(conditionResult.evidence);
      lines.push('```');
      lines.push('');

      if (failedClauses.length > 0) {
        lines.push('### 未通過的檢查'.replace('未通過', t('未通过', '未通過')).replace('檢查', t('检查', '檢查')));
        for (const clause of failedClauses) {
          const line0 = clause.evidence.split('\n')[0];
          lines.push(`- ${line0} → ${t('退出码', '退出碼')} ${clause.exitCode ?? 'null'}`);
        }
        lines.push('');
      }

      lines.push('### Verifier 評估'.replace('評估', t('评估', '評估')));
      lines.push(`**判定：** ${verdict.verdict}`);
      lines.push(`**依據：** ${verdict.evidence}`);
      if (verdict.missing) {
        lines.push(`**缺失：** ${verdict.missing}`);
      }
      if (typeof verdict.progress === 'number') {
        lines.push(`**進展：** ${Math.round(verdict.progress * 100)}%`.replace('進展', t('进展', '進展')));
      }
      if (verdict.failureMode) {
        lines.push(`**失敗模式：** ${verdict.failureMode}`.replace('失敗模式', t('失败模式', '失敗模式')));
      }
      lines.push('');
    }

    if (historySummary) {
      lines.push(historySummary);
    }

    lines.push('### 本輪策略'.replace('本輪', t('本轮', '本輪')));
    lines.push(isSubjective
      ? t('审查者看的是你实际的工具调用，不是你说的话。做出真正的改变。', '審查者看的是你實際的工具調用，不是你說的話。做出真正的改變。')
      : t('上面的验收输出是真实的。认真读。理解根因。不要猜。', '上面的驗收輸出是真實的。認真讀。理解根因。不要猜。'));
    lines.push('');
    lines.push(`- ${t('果断换方向。', '果斷換方向。')}${t('同样的方法已经失败多次，试试完全不同的思路。', '同樣的方法已經失敗多次，試試完全不同的思路。')}`);
    lines.push(`- ${t('挖得更深。', '挖得更深。')}${t('如果你一直在做表面修改，去深挖根本原因。', '如果你一直在做表面修改，去深挖根本原因。')}`);
    lines.push(`- ${t('先读再写。', '先讀再寫。')}${t('不要修改你不完全理解的代码。', '不要修改你不完全理解的代碼。')}`);
    lines.push(`- ${t('如果连续 3 次以上失败，考虑：', '如果連續 3 次以上失敗，考慮：')}${t('调用子代理征求第二意见，或尝试完全不同的方法。', '調用子代理徵求第二意見，或嘗試完全不同的方法。')}`);
    lines.push('');
    lines.push(t(`你还剩 ${remaining} 轮。好好珍惜。`, `你還剩 ${remaining} 輪。好好珍惜。`));

    return lines.join('\n');
  }
}

/**
 * 将 GoalRunnerState 序列化为 Markdown 文件内容，用于持久化防 context rot。
 */
export function serializeGoalState(state: GoalRunnerState, condition: GoalCondition, userGoalText: string): string {
  const lines: string[] = [
    '# Goal State',
    '',
    `**Status:** ${state.status}`,
    `**Iteration:** ${state.iteration}`,
    `**Started:** ${new Date(state.startedAt).toISOString()}`,
    `**Elapsed:** ${Math.round(state.elapsedMs / 1000)}s`,
    `**Output tokens:** ${state.totalOutputTokens}`,
    `**Strictness:** ${condition.strictness}`,
    `**Plan first:** ${condition.planFirst}`,
    '',
    '## Goal',
    userGoalText || condition.humanReadable,
    '',
    '## Verification Condition',
    condition.humanReadable,
    '',
  ];

  if (state.lastConditionResult) {
    lines.push('## Last Condition Result');
    lines.push('```');
    lines.push(state.lastConditionResult.evidence);
    lines.push('```');
    lines.push('');
  }

  if (state.lastVerdict) {
    lines.push('## Last Verifier Verdict');
    lines.push(`${state.lastVerdict.verdict}: ${state.lastVerdict.evidence}`);
    if (state.lastVerdict.missing) {
      lines.push(`Missing: ${state.lastVerdict.missing}`);
    }
    if (typeof state.lastVerdict.progress === 'number') {
      lines.push(`Progress: ${Math.round(state.lastVerdict.progress * 100)}%`);
    }
    if (state.lastVerdict.failureMode) {
      lines.push(`Failure mode: ${state.lastVerdict.failureMode}`);
    }
    lines.push('');
  }

  if (state.feedbackHistory.length > 0) {
    lines.push('## Iteration History');
    for (const fb of state.feedbackHistory) {
      const met = fb.conditionResult.met ? '✓' : '✗';
      const prog = typeof fb.verdict.progress === 'number' ? ` | progress: ${Math.round(fb.verdict.progress * 100)}%` : '';
      const fm = fb.verdict.failureMode ? ` | mode: ${fb.verdict.failureMode}` : '';
      lines.push(`- Iteration ${fb.iteration}: ${met} condition | Verifier: ${fb.verdict.verdict}${prog}${fm}`);
    }
    lines.push('');
  }

  if (state.error) {
    lines.push('## Error');
    lines.push(state.error);
  }

  return lines.join('\n');
}
