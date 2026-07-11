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
      const workerPrompt = isFeedback
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
          // eslint-disable-next-line no-console
          console.error('[GoalRunner] runWorkerTurn failed', err);
          this.state.status = 'error';
        this.state.error = (err as Error).message;
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        this.notifyAndPersist();
        return this.getState();
      }

      this.state.totalOutputTokens += workerResult.outputTokens;
      this.state.elapsedMs = Date.now() - this.state.startedAt;

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
    void this.callbacks.writeGoalState?.(this.getState());
  }

  private buildInitialPrompt(): string {
    const goalText = this.userGoalText || this.condition.humanReadable;
    const isEn = this.lang === 'en';
    const isTw = this.lang === 'zh-TW';
    const isSubjective = this.condition.clauses.length === 0;

    if (isEn) {
      if (isSubjective) {
        return `You are working toward a goal that will be verified by an AI reviewer.

## Goal
${goalText}

## How This Works
1. Work toward the goal using your tools (read, write, edit, exec, web_search, browser, etc.)
2. When you stop, an AI verifier reviews your execution transcript to judge if the goal is met
3. If not met, you'll receive feedback about what's still needed
4. Continue working — do NOT repeat approaches that already failed

## Critical Rules
- Do NOT declare success without doing real work — the verifier checks your actual tool calls
- Use your tools to actually make changes, don't just talk about what you would do
- Each iteration the verifier reviews what you actually did — make it count
- **IMPORTANT: As you work, explain to the user what you're doing, what you found, and what you're fixing. Don't work silently.**

When you finish a round, summarize what you accomplished and what's left to do. The user is watching this conversation.`;
      }
      return `You are working toward a goal that will be objectively verified by a machine.

## Goal
${goalText}

## Verification Condition
${this.condition.humanReadable}

## How This Works
1. Work toward the goal using your tools (read, write, edit, exec, etc.)
2. When you stop, the system runs the verification command automatically
3. If verification fails, you'll receive detailed feedback about what's still broken
4. Fix the issues and try again — do NOT repeat the same approach that already failed

## Critical Rules
- Do NOT declare success based on your own judgment — the verification command is the only judge
- Do NOT fabricate or assume test output — actually run the commands
- If a command fails, read the error carefully before changing your approach
- Each iteration you'll see the real verification output — use it to guide your next steps
- **IMPORTANT: As you work, explain to the user what you're doing, what you found, and what you're fixing. Don't work silently.**

When you finish a round, summarize what you accomplished. The user is watching this conversation.`;
    }

    const instructions = (() => {
      if (isSubjective) {
        return isTw
          ? `你正在朝一個由 AI 審查者驗收的目標工作。

## 目標
${goalText}

## 運作方式
1. 使用你的工具（read、write、edit、exec、web_search、browser 等）朝目標工作
2. 當你停止時，AI 審查者會檢查你的執行記錄來判斷目標是否達成
3. 如果未達成，你會收到關於還需要什麼的回饋
4. 繼續工作——不要重複已經失敗的方法

## 關鍵規則
- 不要不做實際工作就宣佈成功——審查者檢查的是你實際的工具調用
- 用工具真正做出改變，不要只說你會做什麼
- 每輪審查者都會評估你實際做了什麼——讓它有意義
- **重要：邊工作邊向用戶解釋你在做什麼、發現了什麼、正在修復什麼。不要默默幹活。**

完成一輪後總結你完成了什麼。用戶正在看著這段對話。`
          : `你正在朝一个由 AI 审查者验收的目标工作。

## 目标
${goalText}

## 运作方式
1. 使用你的工具（read、write、edit、exec、web_search、browser 等）朝目标工作
2. 当你停止时，AI 审查者会检查你的执行记录来判断目标是否达成
3. 如果未达成，你会收到关于还需要什么的反馈
4. 继续工作——不要重复已经失败的方法

## 关键规则
- 不要不做实际工作就宣布成功——审查者检查的是你实际的工具调用
- 用工具真正做出改变，不要只说你会做什么
- 每轮审查者都会评估你实际做了什么——让它有意义
- **重要：边工作边向用户解释你在做什么、发现了什么、正在修复什么。不要默默干活。**

完成一轮后总结你完成了什么。用户正在看着这段对话。`;
      }

      return isTw
        ? `你正在朝一個由機器客觀驗證的目標工作。

## 目標
${goalText}

## 驗收條件
${this.condition.humanReadable}

## 運作方式
1. 使用你的工具（read、write、edit、exec 等）朝目標工作
2. 當你停止時，系統會自動執行驗收命令
3. 如果驗收失敗，你會收到關於哪裡還有問題的詳細回饋
4. 修復問題再試一次——不要重複已經失敗的方法

## 關鍵規則
- 不要根據自己的判斷宣佈成功——驗收命令是唯一的裁判
- 不要偽造或假設測試輸出——實際執行命令
- 如果命令失敗，先仔細閱讀錯誤再改變策略
- 每輪你都會看到真實的驗收輸出——用它來指導下一步
- **重要：邊工作邊向用戶解釋你在做什麼、發現了什麼、正在修復什麼。不要默默幹活。**

完成一輪後總結你完成了什麼。用戶正在看著這段對話。`
        : `你正在朝一个由机器客观验证的目标工作。

## 目标
${goalText}

## 验收条件
${this.condition.humanReadable}

## 运作方式
1. 使用你的工具（read、write、edit、exec 等）朝目标工作
2. 当你停止时，系统会自动执行验收命令
3. 如果验收失败，你会收到关于哪里还有问题的详细反馈
4. 修复问题再试一次——不要重复已经失败的方法

## 关键规则
- 不要根据自己的判断宣布成功——验收命令是唯一的裁判
- 不要伪造或假设测试输出——实际执行命令
- 如果命令失败，先仔细阅读错误再改变策略
- 每轮你都会看到真实的验收输出——用它来指导下一步
- **重要：边工作边向用户解释你在做什么、发现了什么、正在修复什么。不要默默干活。**

完成一轮后总结你完成了什么。用户正在看着这段对话。`;
    })();

    return instructions;
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

    if (isEn) {
      const lines: string[] = [
        `## Goal NOT Yet Met (iteration ${this.state.iteration}, attempt ${previousAttempts + 1})`,
        '',
      ];

      if (isSubjective) {
        lines.push('The AI verifier reviewed your work and determined the goal is NOT yet met.');
        lines.push('');
        lines.push('### Verifier Assessment');
        lines.push(`${verdict.verdict}: ${verdict.evidence}`);
        if (verdict.missing) {
          lines.push(`Still needed: ${verdict.missing}`);
        }
        lines.push('');
        lines.push('### What to Do');
        lines.push('The verifier checks your ACTUAL tool calls, not just your words.');
        lines.push('- Use your tools to make real changes (write files, edit code, download resources, etc.)');
        lines.push('- Do NOT just describe what you would do — actually do it');
        lines.push('- Do NOT repeat the same approach that already failed');
        lines.push('- If you\'re stuck after multiple attempts, explain what you\'ve tried and what\'s blocking you');
        lines.push('');
        lines.push('Continue working. The verifier will review again after you stop.');
        lines.push('**Explain to the user what you\'re going to do next, and why.**');
      } else {
        lines.push('The verification command was run and the goal is NOT yet satisfied.');
        lines.push('');
        lines.push('### Verification Results');
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
        lines.push(`${verdict.verdict}: ${verdict.evidence}`);
        if (verdict.missing) {
          lines.push(`Missing: ${verdict.missing}`);
        }
        lines.push('');
        lines.push('### What to Do');
        lines.push('Analyze the above output carefully. The verification output is REAL — do not ignore it.');
        lines.push('- If tests fail, READ the actual error messages above');
        lines.push('- If the exit code is non-zero, find what caused it');
        lines.push('- Do NOT repeat the same fix that already failed');
        lines.push('- If you\'re stuck after multiple attempts, explain what you\'ve tried and what\'s blocking you');
        lines.push('');
        lines.push('Fix the issues. The verification will run again after you stop.');
        lines.push('**Explain to the user what you\'re going to do next, and why.**');
      }

      return lines.join('\n');
    }

    const lines: string[] = (() => {
      if (isTw) {
        if (isSubjective) {
          return [
            `## 目標尚未達成（第 ${this.state.iteration} 輪，第 ${previousAttempts + 1} 次嘗試）`,
            '',
            'AI 審查者檢視了你的工作，判定目標尚未達成。',
            '',
            '### Verifier 評估',
            `${verdict.verdict}: ${verdict.evidence}`,
            ...(verdict.missing ? [`還需要: ${verdict.missing}`] : []),
            '',
            '### 接下來怎麼做',
            '審查者檢查的是你實際的工具調用，不只是你說的話。',
            '- 用工具做出真正的改變（寫文件、編輯代碼、下載資源等）',
            '- 不要只描述你會做什麼——實際去做',
            '- 不要重複已經失敗的方法',
            '- 如果多次嘗試後仍卡住，說明你試過什麼以及什麼在阻擋你',
            '',
            '繼續工作。審查者會在你停止後再次審核。',
            '**請向用戶解釋你接下來打算做什麼，以及為什麼。**',
          ];
        }
        return [
          `## 目標尚未達成（第 ${this.state.iteration} 輪，第 ${previousAttempts + 1} 次嘗試）`,
          '',
          '驗收命令已執行，目標尚未滿足。',
          '',
          '### 驗收結果',
          '```',
          conditionResult.evidence,
          '```',
          '',
          ...(failedClauses.length > 0
            ? [
                '### 未通過的檢查',
                ...failedClauses.map(
                  (c) => `- ${c.evidence.split('\n')[0]} → 退出碼 ${c.exitCode ?? 'null'}`
                ),
                '',
              ]
            : []),
          '### Verifier 評估',
          `${verdict.verdict}: ${verdict.evidence}`,
          ...(verdict.missing ? [`缺失: ${verdict.missing}`] : []),
          '',
          '### 接下來怎麼做',
          '仔細分析上面的輸出。驗收輸出是真實的——不要忽略它。',
          '- 如果測試失敗，閱讀上面的實際錯誤訊息',
          '- 如果退出碼非零，找出原因',
          '- 不要重複已經失敗的修復方法',
          '- 如果多次嘗試後仍卡住，說明你試過什麼以及什麼在阻擋你',
          '',
          '修復問題。你停止後驗收會再次執行。',
          '**請向用戶解釋你接下來打算做什麼，以及為什麼。**',
        ];
      }

      if (isSubjective) {
        return [
          `## 目标尚未达成（第 ${this.state.iteration} 轮，第 ${previousAttempts + 1} 次尝试）`,
          '',
          'AI 审查者检视了你的工作，判定目标尚未达成。',
          '',
          '### Verifier 评估',
          `${verdict.verdict}: ${verdict.evidence}`,
          ...(verdict.missing ? [`还需要: ${verdict.missing}`] : []),
          '',
          '### 接下来怎么做',
          '审查者检查的是你实际的工具调用，不只是你说的话。',
          '- 用工具做出真正的改变（写文件、编辑代码、下载资源等）',
          '- 不要只描述你会做什么——实际去做',
          '- 不要重复已经失败的方法',
          '- 如果多次尝试后仍卡住，说明你试过什么以及什么在阻挡你',
          '',
          '继续工作。审查者会在你停止后再次审核。',
          '**请向用户解释你接下来打算做什么，以及为什么。**',
        ];
      }
      return [
        `## 目标尚未达成（第 ${this.state.iteration} 轮，第 ${previousAttempts + 1} 次尝试）`,
        '',
        '验收命令已执行，目标尚未满足。',
        '',
        '### 验收结果',
        '```',
        conditionResult.evidence,
        '```',
        '',
        ...(failedClauses.length > 0
          ? [
              '### 未通过的检查',
              ...failedClauses.map(
                (c) => `- ${c.evidence.split('\n')[0]} → 退出码 ${c.exitCode ?? 'null'}`
              ),
              '',
            ]
          : []),
        '### Verifier 评估',
        `${verdict.verdict}: ${verdict.evidence}`,
        ...(verdict.missing ? [`缺失: ${verdict.missing}`] : []),
        '',
        '### 接下来怎么做',
        '仔细分析上面的输出。验收输出是真实的——不要忽略它。',
        '- 如果测试失败，阅读上面的实际错误信息',
        '- 如果退出码非零，找出原因',
        '- 不要重复已经失败的修复方法',
        '- 如果多次尝试后仍卡住，说明你试过什么以及什么在阻挡你',
        '',
        '修复问题。你停止后验收会再次执行。',
        '**请向用户解释你接下来打算做什么，以及为什么。**',
      ];
    })();

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
    lines.push('');
  }

  if (state.feedbackHistory.length > 0) {
    lines.push('## Iteration History');
    for (const fb of state.feedbackHistory) {
      const met = fb.conditionResult.met ? '✓' : '✗';
      lines.push(`- Iteration ${fb.iteration}: ${met} condition | Verifier: ${fb.verdict.verdict}`);
    }
    lines.push('');
  }

  if (state.error) {
    lines.push('## Error');
    lines.push(state.error);
  }

  return lines.join('\n');
}
