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

function notify(): void {
  listeners.forEach((fn) => fn([...runs]));
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
