/**
 * goalCondition: /goal 指令的验证条件解析与评估（纯逻辑）。
 *
 * 条件语法：
 *   exec:<command>                         — 退出码必须为 0
 *   exec:<command> match:<pattern>         — 退出码 0 且 stdout 匹配正则
 *   exec:<cmd1> && exec:<cmd2>             — 所有子句都必须通过
 *
 * 可选的自然语言目标用 | 分隔：
 *   修复 auth 测试 | exec:npm test
 *   fix auth tests | exec:npm test match:"\\d+ passed"
 *
 * 如果没有 |，整个输入被当作验证条件处理。
 */

import type {
  GoalCondition,
  GoalConditionClause,
  GoalStrictness,
  ConditionResult,
  ConditionClauseResult,
} from '@codepapr/types';

/** 条件执行器接口：由 UI/CLI 层注入具体命令执行实现 */
export interface ConditionExecutor {
  runCommand(
    workspacePath: string,
    command: string,
    args: string[]
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
}

export class GoalConditionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalConditionParseError';
  }
}

/**
 * 将命令行字符串拆分为 command + args。
 * 支持引号包裹的参数（单引号和双引号）。
 *
 * 转义语义对齐 POSIX shell：
 * - 单引号内完全不转义（字面量）；
 * - 双引号内仅针对 \" \\ \$ \` 转义；其它字符前缀的反斜杠（如 "\d+"、"\s"）保留字面反斜杠；
 * - 无引号时 \ 转义其后的任意紧跟字符。
 */
function tokenizeCommand(line: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    if (quote === 'single') {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') {
        quote = null;
        i++;
      } else if (ch === '\\') {
        const next = line[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 2;
        } else {
          // 双引号内普通字符前的反斜杠保留（例如 "\d+" 保持 \d+，不被吞为 d+）
          current += ch;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
      continue;
    }

    // 无引号状态
    if (ch === '\\') {
      const next = line[i + 1];
      if (next !== undefined) {
        current += next;
        i += 2;
      } else {
        current += ch;
        i++;
      }
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      i++;
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current) {
    tokens.push(current);
  }

  if (quote) {
    throw new GoalConditionParseError(`引号未闭合: ${line}`);
  }

  const [command, ...args] = tokens;
  if (!command) {
    throw new GoalConditionParseError(`命令不能为空: ${line}`);
  }
  return { command, args };
}

/**
 * 解析单个子句字符串，如 `exec:npm test match:"\\d+ passed"`
 */
/** 按顶层 && 拆分子句：引号（单/双）内的 && 视为字面量不拆分。
 *  与裸 split 不同，保留各子句原文（由 parseClause 负责 trim），
 *  空子句同样保留以维持原有的「条件子句不能为空」报错行为。 */
function splitTopLevelClauses(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '&' && text[i + 1] === '&') {
      parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
  }

  parts.push(current.trim());
  return parts;
}

function parseClause(clauseStr: string): GoalConditionClause {
  const trimmed = clauseStr.trim();
  if (!trimmed) {
    throw new GoalConditionParseError('条件子句不能为空');
  }

  // 提取 exec: 前缀
  const execMatch = trimmed.match(/^exec:\s*(.*)$/s);
  if (!execMatch) {
    throw new GoalConditionParseError(
      `条件必须以 exec: 开头（当前仅支持命令退出码/输出验证）。无效条件: ${trimmed}`
    );
  }

  const rest = execMatch[1].trim();
  if (!rest) {
    throw new GoalConditionParseError('exec: 后必须跟命令');
  }

  // 提取可选的 match:"pattern" 后缀
  let matchPattern: string | undefined;
  let commandPart = rest;

  const matchMatch = rest.match(/\s+match:\s*"((?:[^"\\]|\\.)*)"\s*$/);
  if (matchMatch) {
    matchPattern = matchMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    commandPart = rest.slice(0, matchMatch.index).trim();
  } else {
    const matchSingle = rest.match(/\s+match:\s*'((?:[^'\\]|\\.)*)'\s*$/);
    if (matchSingle) {
      matchPattern = matchSingle[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      commandPart = rest.slice(0, matchSingle.index).trim();
    }
  }

  if (!commandPart) {
    throw new GoalConditionParseError('exec: 后必须跟命令');
  }

  const { command, args } = tokenizeCommand(commandPart);

  const clause: GoalConditionClause = {
    type: 'exec',
    command,
    args,
  };
  if (matchPattern) {
    clause.matchPattern = matchPattern;
  }
  return clause;
}

/**
 * 从输入文本开头提取标志参数，如 --strict、--loose、--plan-first。
 * 返回提取后的剩余文本和解析出的标志。
 */
function extractFlags(input: string): {
  rest: string;
  strictness: GoalStrictness;
  planFirst: boolean;
} {
  let rest = input.trim();
  let strictness: GoalStrictness = 'normal';
  let strictnessSet = false;
  let planFirst = false;

  // 持续提取开头的 --flag
  const flagPattern = /^--(\S+)\s*/;
  let match: RegExpMatchArray | null;
  while ((match = rest.match(flagPattern))) {
    const flag = match[1].toLowerCase();
    if (flag === 'strict' || flag === 'loose' || flag === 'normal') {
      if (strictnessSet && strictness !== flag as GoalStrictness) {
        throw new GoalConditionParseError(
          `冲突的标志: --${strictness} 和 --${flag} 不能同时使用。请只指定一个严格度。`
        );
      }
      strictness = flag as GoalStrictness;
      strictnessSet = true;
    } else if (flag === 'plan-first' || flag === 'planfirst' || flag === 'plan') {
      planFirst = true;
    } else {
      // 不认识的 flag，停止提取，保留原样
      break;
    }
    rest = rest.slice(match[0].length).trim();
  }

  return { rest, strictness, planFirst };
}

/**
 * 解析 /goal 后的完整输入，生成结构化的验证条件。
 *
 * 支持在开头加标志：
 *   /goal --strict exec:npm test
 *   /goal --loose 美化登录页
 *   /goal --plan-first 重构 auth 模块
 *
 * 两种模式：
 * 1. 客观验证模式：输入包含 exec: 条件（可选自然语言目标 | 分隔）
 *    示例: exec:npm test | 修复测试 | exec:npm test match:"\d+ passed"
 * 2. 主观验证模式：输入是纯自然语言目标，无 exec: 条件
 *    示例: 给我补充足够的真实图片，让这个网站真正丰富起来
 *    此时 clauses 为空数组，由 Verifier 主观判定
 *
 * @param input /goal 之后的所有参数（空格连接后的原始字符串）
 * @returns 解析后的 GoalCondition + planFirst 标志
 * @throws GoalConditionParseError 当输入为空时
 */
export function parseGoalCondition(input: string): GoalCondition {
  const rawText = input.trim();
  if (!rawText) {
    throw new GoalConditionParseError(
      '/goal 需要指定目标。示例:\n  /goal exec:npm test（客观验证）\n  /goal 修复登录页的样式问题（主观验证）\n  /goal --strict exec:npm test（严格模式）'
    );
  }

  // 提取标志参数
  const { rest, strictness, planFirst } = extractFlags(rawText);

  if (!rest) {
    throw new GoalConditionParseError('标志参数后必须跟目标描述或验证条件');
  }

  // 分离自然语言目标和验证条件
  let goalText = '';
  let conditionText = rest;

  // pipeIndex >= 0 覆盖 rest 以 | 开头的边界情况（如 "/goal | exec:npm test"）：
  // 旧实现用 > 0，index 0 时跳过拆分，前导 | 残留在 conditionText 中，
  // 报出费解的「条件必须以 exec: 开头」。
  const pipeIndex = rest.indexOf('|');
  if (pipeIndex >= 0) {
    goalText = rest.slice(0, pipeIndex).trim();
    conditionText = rest.slice(pipeIndex + 1).trim();
  }

  if (!conditionText) {
    throw new GoalConditionParseError('| 后必须跟验证条件');
  }

  // 检查是否包含 exec: 前缀
  const hasExecCondition = conditionText.includes('exec:');

  if (!hasExecCondition) {
    // 主观验证模式：整个输入是自然语言目标
    // 如果有 | 但后面不是 exec:，把 goalText + conditionText 合并作为目标
    const fullGoalText = goalText
      ? `${goalText} | ${conditionText}`
      : conditionText;
    return {
      clauses: [],
      rawText,
      humanReadable: fullGoalText,
      strictness,
      planFirst,
    };
  }

  // 客观验证模式：按 && 拆分多个子句（引号内的 && 属于命令/匹配模式本身，
  // 不能拆。旧实现裸 split 会把 exec:grep "a&&b" 切成两个废子句）。
  const clauseStrings = splitTopLevelClauses(conditionText);
  const clauses: GoalConditionClause[] = clauseStrings.map(parseClause);

  const humanReadable = buildHumanReadable(clauses);

  return {
    clauses,
    rawText,
    humanReadable: goalText
      ? `${goalText}（验收: ${humanReadable}）`
      : humanReadable,
    strictness,
    planFirst,
  };
}

function buildHumanReadable(clauses: GoalConditionClause[]): string {
  const parts = clauses.map((clause) => {
    const cmd = [clause.command, ...clause.args].join(' ');
    if (clause.matchPattern) {
      return `命令 "${cmd}" 退出码为 0 且输出匹配 /${clause.matchPattern}/`;
    }
    return `命令 "${cmd}" 退出码为 0`;
  });
  return parts.join(' 且 ');
}

/**
 * 评估验证条件：执行所有子句的命令，检查退出码和输出匹配。
 */
export async function evaluateGoalCondition(
  condition: GoalCondition,
  workspacePath: string,
  executor: ConditionExecutor
): Promise<ConditionResult> {
  // 主观验证模式：无 exec: 条件，跳过命令执行
  if (condition.clauses.length === 0) {
    return {
      met: false,
      evidence: '主观验证模式：无客观验证条件，由 Verifier 主观判定目标是否达成。',
      details: [],
    };
  }

  const details: ConditionClauseResult[] = [];

  for (let i = 0; i < condition.clauses.length; i++) {
    const clause = condition.clauses[i];
    const result = await executor.runCommand(
      workspacePath,
      clause.command,
      clause.args
    );

    let met = result.exitCode === 0 && !result.timedOut;

    if (met && clause.matchPattern) {
      try {
        const regex = new RegExp(clause.matchPattern);
        met = regex.test(result.stdout);
      } catch {
        met = false;
      }
    }

    if (clause.negate) {
      met = !met;
    }

    const evidenceLines: string[] = [
      `命令: ${clause.command} ${clause.args.join(' ')}`,
      `退出码: ${result.exitCode ?? 'null'}${result.timedOut ? ' (超时)' : ''}`,
    ];
    if (clause.matchPattern) {
      evidenceLines.push(`匹配模式: /${clause.matchPattern}/`);
      evidenceLines.push(
        met ? '输出匹配 ✓' : '输出不匹配 ✗'
      );
    }
    const stdoutTrimmed = result.stdout.trim();
    if (stdoutTrimmed) {
      const tail = stdoutTrimmed.slice(-2000);
      evidenceLines.push(`stdout (末尾 2000 字符):\n${tail}`);
    }
    const stderrTrimmed = result.stderr.trim();
    if (stderrTrimmed) {
      const tail = stderrTrimmed.slice(-1000);
      evidenceLines.push(`stderr (末尾 1000 字符):\n${tail}`);
    }

    details.push({
      clauseIndex: i,
      met,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      evidence: evidenceLines.join('\n'),
    });
  }

  const allMet = details.every((d) => d.met);
  const evidence = details
    .map((d, i) => `--- 子句 ${i + 1} ${d.met ? '✓ 通过' : '✗ 未通过'} ---\n${d.evidence}`)
    .join('\n\n');

  return {
    met: allMet,
    evidence,
    details,
  };
}
