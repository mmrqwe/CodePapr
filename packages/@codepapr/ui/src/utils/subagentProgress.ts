export interface SubagentStep {
  name: string;
  status: 'success' | 'error';
  summary: string;
}

export interface SubAgentRun {
  id: string;
  agent: string;
  prompt?: string;
  steps: SubagentStep[];
  state: 'running' | 'completed';
  content?: string;
  collapsed: boolean;
  /** 归属会话。缺省时 UI 不展示，避免切会话/切项目后串到别的对话上。 */
  sessionId?: string;
}

type ProgressListener = (runs: SubAgentRun[]) => void;
const listeners = new Set<ProgressListener>();
const runs: SubAgentRun[] = [];
let nextRunSeq = 0;
// 有界：已完成子代理运行条目保留给 UI 展示/折叠状态，但随调用次数无限增长；
// 只裁剪已完成的最旧条目，运行中的条目绝不移除。
const MAX_COMPLETED_RUNS = 50;

function notify(): void {
  listeners.forEach((fn) => fn([...runs]));
}

function trimCompletedRuns(): void {
  let completed = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].state === 'completed') {
      completed += 1;
    }
  }
  let excess = completed - MAX_COMPLETED_RUNS;
  if (excess <= 0) return;
  for (let index = 0; index < runs.length && excess > 0; ) {
    if (runs[index].state === 'completed') {
      runs.splice(index, 1);
      excess -= 1;
    } else {
      index += 1;
    }
  }
}

function findRun(runId: string): SubAgentRun | undefined {
  return runs.find((run) => run.id === runId);
}

export function getSubagentRuns(): SubAgentRun[] {
  return [...runs];
}

/** 当前会话可见的子代理进度。无 sessionId 的条目不展示，防止跨对话串台。 */
export function getSubagentRunsForSession(sessionId: string | null | undefined): SubAgentRun[] {
  if (!sessionId) return [];
  return getSubagentRuns().filter((run) => run.sessionId === sessionId);
}

export function getSubagentProgress(): { agent: string; steps: SubagentStep[] } {
  const current = runs[runs.length - 1];
  return current ? { agent: current.agent, steps: [...current.steps] } : { agent: '', steps: [] };
}

export function startSubagentProgress(
  agent: string,
  prompt?: string,
  runId?: string,
  sessionId?: string,
): string {
  const id = runId?.trim() || `subagent-run-${++nextRunSeq}`;
  runs.push({ id, agent, prompt, steps: [], state: 'running', collapsed: false, sessionId });
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

export function completeSubagentProgress(runId: string, content: string): void {
  const current = findRun(runId);
  if (current && current.state === 'running') {
    current.state = 'completed';
    current.content = content;
    notify();
  }
}

export function clearSubagentProgress(): void {
  // Mark running ones as completed with empty content
  for (const run of runs) {
    if (run.state === 'running') {
      run.state = 'completed';
    }
  }
  trimCompletedRuns();
  notify();
}

/** 清空全部进度条目（测试、切换/关闭工作区）。与 clear 不同：已完成条目也丢掉。 */
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
