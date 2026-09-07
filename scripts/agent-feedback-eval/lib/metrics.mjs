#!/usr/bin/env node
/**
 * L2 六项指标计算（论文第 5 点：评估 = 模型 + 接口 + 反馈闭环）。
 * 全部从事件流（run.start/tool.start/tool.end/message.end/run.end）派生，
 * 不新增埋点——复用 AppendOnlyLog 已有的工具调用落账结构。
 *
 * 指标分组（刻意对应论文三要素）：
 *   模型能力    : firstCallSuccess
 *   接口设计    : contextPollution
 *   反馈闭环    : recovery, roundsToConverge, deadLoopCount, fallbackQuality
 */

function toolPairs(events) {
  const byId = new Map();
  const order = [];
  for (const line of events) {
    if (line.type === 'tool.start') {
      const id = String(line.toolCallId ?? '');
      if (!byId.has(id)) {
        byId.set(id, { id, name: line.toolName ?? '?', arguments: line.arguments ?? {}, ok: null, errorPreview: '', outputChars: 0 });
        order.push(id);
      } else {
        // dedup 后带 arguments 的权威 start 覆盖占位
        const rec = byId.get(id);
        if (line.arguments && Object.keys(line.arguments).length) rec.arguments = line.arguments;
      }
    } else if (line.type === 'tool.end') {
      const id = String(line.toolCallId ?? '');
      const rec = byId.get(id);
      if (rec) {
        rec.ok = line.success !== false;
        rec.errorPreview = typeof line.errorPreview === 'string' ? line.errorPreview : '';
        rec.outputChars =
          typeof line.outputPreview === 'string' ? line.outputPreview.length : 0;
      }
    }
  }
  return order.map((id) => byId.get(id));
}

function roundCount(events) {
  let max = 0;
  for (const line of events) {
    if (line.type === 'message.end' && typeof line.round === 'number') {
      max = Math.max(max, line.round);
    }
  }
  return max;
}

/**
 * 死循环：同一 toolName+序列化 arguments 连续出现 >= 3 次。
 * 连续（而非总次数）判定避免把"合理地多次 read 不同行"误计。
 */
function deadLoopCount(calls) {
  let loops = 0;
  let streakKey = '';
  let streak = 0;
  for (const c of calls) {
    const key = `${c.name}::${JSON.stringify(c.arguments ?? {})}`;
    if (key === streakKey) {
      streak += 1;
      if (streak === 3) loops += 1; // 首次越阈计一次，后续同类不重复计
    } else {
      streakKey = key;
      streak = 1;
    }
  }
  return loops;
}

/**
 * @param run   cliRunner.runCase 的结果
 * @param scenario { budgetRounds, expectToolAfterError?, avoidTool? }
 */
export function computeMetrics(run, scenario) {
  const calls = toolPairs(run.events);
  const first = calls[0];
  const firstCallSuccess = first ? first.ok === true : false;

  const errorCalls = calls.filter((c) => c.ok === false);
  const hadError = errorCalls.length > 0;

  // 收敛轮数：首个 error 之后，到第一个"成功且改变了世界"的工具的索引距离
  const rounds = roundCount(run.events);

  // fallbackQuality：错误文案点名的替代工具，模型是否真的用了。
  // 注意"用对了"包含两种时序：撞墙后改道；或先用了正确工具、之后的
  // 试探性错误无关紧要（此时强制"错误之后才算"会误伤高效行为）。
  let fallbackQuality = null;
  if (scenario.expectToolAfterError && hadError) {
    const errIdx = calls.findIndex((c) => c.ok === false);
    const usedAfter = calls.slice(errIdx + 1).some((c) => c.name === scenario.expectToolAfterError && c.ok);
    const usedBefore = calls.slice(0, errIdx).some((c) => c.name === scenario.expectToolAfterError && c.ok);
    fallbackQuality = usedAfter || usedBefore;
  }

  // 反模式：被明确引导不要用的工具，错误后仍调用
  let avoidViolation = false;
  if (scenario.avoidTool && hadError) {
    const errIdx = calls.findIndex((c) => c.ok === false);
    avoidViolation = calls.slice(errIdx + 1).some((c) => c.name === scenario.avoidTool);
  }

  const contextPollution = calls.reduce((m, c) => Math.max(m, c.outputChars || 0), 0);

  const timedOut = run.exitCode === 2;
  const pass =
    !timedOut &&
    run.exitCode === 0 &&
    rounds <= scenario.budgetRounds &&
    deadLoopCount(calls) === 0 &&
    fallbackQuality !== false &&
    !avoidViolation &&
    (scenario.assert ? !!scenario.assert(run, calls) : true);

  return {
    pass,
    exitCode: run.exitCode,
    firstCallSuccess,
    hadError,
    toolCallCount: calls.length,
    errorCount: errorCalls.length,
    rounds,
    budgetRounds: scenario.budgetRounds,
    deadLoops: deadLoopCount(calls),
    fallbackQuality,
    avoidViolation,
    contextPollutionChars: contextPollution,
    elapsedMs: run.elapsedMs,
    toolSequence: calls.map((c) => `${c.name}${c.ok ? '' : '!'}`),
  };
}

export { toolPairs, roundCount };
