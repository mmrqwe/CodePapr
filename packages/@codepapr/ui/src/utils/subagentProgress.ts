export interface SubagentStep {
  name: string;
  status: 'success' | 'error';
  summary: string;
}

/**
 * 子代理运行中的进度条目。面板只是「进行中」指示器：子代理完成
 * （complete 帧）或所属回合结算时条目即被移除，结果本身由执行过程里的
 * 任务工具卡片与主回复呈现。不存在已完成态的条目。
 */
export interface SubAgentRun {
  id: string;
  agent: string;
  prompt?: string;
  steps: SubagentStep[];
  collapsed: boolean;
  /** 归属会话。缺省时 UI 不展示，避免切会话/切项目后串到别的对话上。 */
  sessionId?: string;
  /** 归属回合请求。回合结算（result/error/cancel 等）时按此兜底清除。 */
  requestId?: string;
}

type ProgressListener = (runs: SubAgentRun[]) => void;
const listeners = new Set<ProgressListener>();
const runs: SubAgentRun[] = [];
let nextRunSeq = 0;

function notify(): void {
  listeners.forEach((fn) => fn([...runs]));
}

function findRun(runId: string): SubAgentRun | undefined {
  return runs.find((run) => run.id === runId);
}

/** 移除全部命中条目（同 id 重复 start 条目一并清掉），有移除才通知。 */
function removeRuns(match: (run: SubAgentRun) => boolean): void {
  let removed = false;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (match(runs[index])) {
      runs.splice(index, 1);
      removed = true;
    }
  }
  if (removed) notify();
}

export function getSubagentRuns(): SubAgentRun[] {
  return [...runs];
}

/** 当前会话可见的子代理进度。无 sessionId 的条目不展示，防止跨对话串台。 */
export function getSubagentRunsForSession(sessionId: string | null | undefined): SubAgentRun[] {
  if (!sessionId) return [];
  return getSubagentRuns().filter((run) => run.sessionId === sessionId);
}

export function startSubagentProgress(
  agent: string,
  prompt?: string,
  runId?: string,
  sessionId?: string,
  requestId?: string,
): string {
  const id = runId?.trim() || `subagent-run-${++nextRunSeq}`;
  const existing = findRun(id);
  if (existing) {
    // 重复 start 帧（重放/双监听）：复用在飞条目，避免第二条永远无人结算。
    return id;
  }
  runs.push({ id, agent, prompt, steps: [], collapsed: true, sessionId, requestId });
  notify();
  return id;
}

export function pushSubagentStep(runId: string, step: SubagentStep): void {
  const current = findRun(runId);
  if (current) {
    current.steps.push(step);
    notify();
  }
}

/** 子代理结束：进度条目即时从面板移除（结果已由消息流/工具卡片呈现）。 */
export function completeSubagentProgress(runId: string): void {
  removeRuns((run) => run.id === runId);
}

/** 回合结算兜底：complete 帧丢失/迟不到时，按 requestId 清掉该回合在飞条目。 */
export function finalizeSubagentRunsForRequest(requestId: string): void {
  removeRuns((run) => run.requestId === requestId);
}

/** agent 销毁/崩溃兜底：按会话清掉残留的在飞条目。 */
export function finalizeSubagentRunsForSession(sessionId: string): void {
  removeRuns((run) => run.sessionId === sessionId);
}

/** 清空全部进度条目（测试、切换/关闭工作区）。 */
export function resetSubagentProgress(): void {
  runs.length = 0;
  notify();
}

export function toggleSubagentCollapse(target: number | string): void {
  const targetRun =
    typeof target === 'string'
      ? findRun(target)
      : target >= 0 && target < runs.length
        ? runs[target]
        : undefined;
  if (targetRun) {
    targetRun.collapsed = !targetRun.collapsed;
    notify();
  }
}

export function subscribeSubagentProgress(fn: ProgressListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
