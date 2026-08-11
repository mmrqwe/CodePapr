export interface SubagentStep {
  name: string;
  status: 'success' | 'error';
  summary: string;
}

export interface SubAgentRun {
  agent: string;
  prompt?: string;
  steps: SubagentStep[];
  state: 'running' | 'completed';
  content?: string;
  collapsed: boolean;
}

type ProgressListener = (runs: SubAgentRun[]) => void;
const listeners = new Set<ProgressListener>();
const runs: SubAgentRun[] = [];
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
export function getSubagentRuns(): SubAgentRun[] {
  return [...runs];
}

export function getSubagentProgress(): { agent: string; steps: SubagentStep[] } {
  const current = runs[runs.length - 1];
  return current ? { agent: current.agent, steps: [...current.steps] } : { agent: '', steps: [] };
}

export function startSubagentProgress(agent: string, prompt?: string): void {
  runs.push({ agent, prompt, steps: [], state: 'running', collapsed: false });
  notify();
}

export function pushSubagentStep(step: SubagentStep): void {
  const current = runs[runs.length - 1];
  if (current) {
    current.steps.push(step);
    notify();
  }
}

export function completeSubagentProgress(content: string): void {
  const current = runs[runs.length - 1];
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

export function toggleSubagentCollapse(index: number): void {
  if (index >= 0 && index < runs.length) {
    runs[index].collapsed = !runs[index].collapsed;
    notify();
  }
}

export function subscribeSubagentProgress(fn: ProgressListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
