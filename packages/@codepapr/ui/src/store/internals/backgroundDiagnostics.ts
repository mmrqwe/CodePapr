import { invoke } from '@tauri-apps/api/core';
import {
  clearLanguageIntelligencePaths,
  scheduleLanguageIntelligenceRefresh,
} from '../../utils/languageIntelligence';
import {
  runProjectDiagnostics,
  type ProjectDiagnosticsReport,
} from '../../utils/projectDiagnostics';
import { appendErrorMessage } from './messageMutators';
import { formatAgentError } from './errorFormatting';
import { getSettingsError } from './settingsNormalizer';
import { normalizeSettings } from './settingsNormalizer';
import type { StoreGet, StoreSet } from './types';

const BACKGROUND_DIAGNOSTICS_DELAY_MS = 700;
const BACKGROUND_REPAIR_RETRY_DELAY_MS = 1000;
const BACKGROUND_REPAIR_MAX_WAIT_ATTEMPTS = 60;
const BACKGROUND_REPAIR_MAX_ATTEMPTS_PER_CLEAN_PASS = 1;
const MUTATION_VERSION_DEBOUNCE_MS = 150;

let backgroundDiagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
let mutationVersionTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundDiagnosticsRunId = 0;
const backgroundRepairAttemptsByWorkspace = new Map<string, number>();
const backgroundRepairFingerprints = new Set<string>();

function failedDiagnosticStages(report: ProjectDiagnosticsReport): ProjectDiagnosticsReport['stages'] {
  return report.available ? report.stages.filter((stage) => !stage.success) : [];
}

function buildDiagnosticsRepairFingerprint(
  workspacePath: string,
  report: ProjectDiagnosticsReport,
  changedPaths: readonly string[]
): string {
  const stageFingerprint = failedDiagnosticStages(report)
    .map((stage) => `${stage.id}:${stage.status ?? 'unknown'}:${stage.excerpt}`)
    .join('|');
  return `${workspacePath}:${[...changedPaths].sort().join(',')}:${stageFingerprint}`;
}

function buildDiagnosticsRepairPrompt(
  report: ProjectDiagnosticsReport,
  changedPaths: readonly string[]
): string {
  const changedPathList = changedPaths.length ? changedPaths.map((path) => `- ${path}`).join('\n') : '- 未知文件';
  const failedStages = failedDiagnosticStages(report)
    .map((stage) => {
      const command = [stage.command, ...stage.args].join(' ');
      const excerpt = stage.excerpt || stage.stderr || stage.stdout || '没有输出摘要';
      return [`## ${stage.label}`, `命令：${command}`, '输出：', '```text', excerpt, '```'].join('\n');
    })
    .join('\n\n');

  return [
    '后台诊断在最近的文件变更后发现问题。请自动进入修复流。',
    '',
    '变更文件：',
    changedPathList,
    '',
    '诊断失败项：',
    failedStages || '无详细输出。',
    '',
    '要求：先读取相关文件，保持修复范围最小；修复后运行 workspace_project_diagnostics 或最相关的验证命令；如果问题无法安全修复，请明确说明 blocker。',
  ].join('\n');
}

function maybeStartBackgroundRepair(params: {
  get: StoreGet;
  set: StoreSet;
  workspacePath: string;
  report: ProjectDiagnosticsReport;
  changedPaths: readonly string[];
}): void {
  const changedPaths = params.changedPaths
    .map((path) => path.trim())
    .filter((path) => path && !path.startsWith('.CodePapr/'));
  if (changedPaths.length === 0 || failedDiagnosticStages(params.report).length === 0) {
    return;
  }

  const fingerprint = buildDiagnosticsRepairFingerprint(
    params.workspacePath,
    params.report,
    changedPaths
  );
  if (backgroundRepairFingerprints.has(fingerprint)) {
    return;
  }

  const attempts = backgroundRepairAttemptsByWorkspace.get(params.workspacePath) ?? 0;
  if (attempts >= BACKGROUND_REPAIR_MAX_ATTEMPTS_PER_CLEAN_PASS) {
    return;
  }

  const tryStartRepair = (waitAttempt: number) => {
    const state = params.get();
    if (state.workspacePath !== params.workspacePath) {
      return;
    }

    if (state.isLoading) {
      if (waitAttempt >= BACKGROUND_REPAIR_MAX_WAIT_ATTEMPTS) {
        return;
      }
      setTimeout(() => tryStartRepair(waitAttempt + 1), BACKGROUND_REPAIR_RETRY_DELAY_MS);
      return;
    }

    const settingsError = getSettingsError(normalizeSettings(state.settings));
    if (settingsError) {
      return;
    }

    backgroundRepairFingerprints.add(fingerprint);
    backgroundRepairAttemptsByWorkspace.set(params.workspacePath, attempts + 1);
    void state
      .sendMessage(
        buildDiagnosticsRepairPrompt(params.report, changedPaths),
        '后台诊断发现问题，自动进入修复流',
        'agent',
        params.report
      )
      .catch((error) => {
        appendErrorMessage(params.set, formatAgentError(error, state.settings.lang ?? 'zh-CN'));
      });
  };

  setTimeout(() => tryStartRepair(0), BACKGROUND_REPAIR_RETRY_DELAY_MS);
}

function scheduleBackgroundProjectDiagnostics(params: {
  get: StoreGet;
  set: StoreSet;
  paths?: readonly string[];
  autoRepair: boolean;
  delayMs?: number;
}): void {
  if (backgroundDiagnosticsTimer) {
    clearTimeout(backgroundDiagnosticsTimer);
  }

  const runId = backgroundDiagnosticsRunId + 1;
  backgroundDiagnosticsRunId = runId;
  const changedPaths = [...(params.paths ?? [])];
  const workspacePath = params.get().workspacePath.trim();
  if (!workspacePath) {
    return;
  }

  backgroundDiagnosticsTimer = setTimeout(() => {
    void (async () => {
      const state = params.get();
      if (state.workspacePath !== workspacePath || runId !== backgroundDiagnosticsRunId) {
        return;
      }

      try {
        const report = await runProjectDiagnostics(workspacePath, invoke, {
          changedPaths,
        });
        if (params.get().workspacePath !== workspacePath || runId !== backgroundDiagnosticsRunId) {
          return;
        }

        params.get().setProjectDiagnosticsReport(report);
        if (report.overallStatus === 'passed') {
          backgroundRepairAttemptsByWorkspace.set(workspacePath, 0);
        }
        if (params.autoRepair && report.overallStatus === 'failed') {
          maybeStartBackgroundRepair({
            get: params.get,
            set: params.set,
            workspacePath,
            report,
            changedPaths,
          });
        }
      } catch (e) {
        console.warn('Background diagnostics failed:', e);
      }
    })();
  }, params.delayMs ?? BACKGROUND_DIAGNOSTICS_DELAY_MS);
}

export function handleWorkspaceMutation(params: {
  get: StoreGet;
  set: StoreSet;
  paths?: readonly string[];
  scheduleDiagnostics: boolean;
  autoRepair: boolean;
}): void {
  // Debounce the version bump so a burst of writes (e.g. 8 files in one turn)
  // coalesces into a single re-render for subscribers (CodePreviewPanel
  // prewarming), instead of one re-render per write.
  if (mutationVersionTimer) {
    clearTimeout(mutationVersionTimer);
  }
  mutationVersionTimer = setTimeout(() => {
    mutationVersionTimer = null;
    params.set((state) => ({
      workspaceMutationVersion: state.workspaceMutationVersion + 1,
    }));
  }, MUTATION_VERSION_DEBOUNCE_MS);

  const workspacePath = params.get().workspacePath.trim();
  const changedPaths = params.paths ?? [];
  if (workspacePath && changedPaths.length > 0) {
    clearLanguageIntelligencePaths(workspacePath, changedPaths);
    scheduleLanguageIntelligenceRefresh({
      invoke,
      workspacePath,
      paths: changedPaths,
      delayMs: 80,
      maxFiles: changedPaths.length,
      force: true,
    });
  }

  if (!params.scheduleDiagnostics) {
    return;
  }

  scheduleBackgroundProjectDiagnostics({
    get: params.get,
    set: params.set,
    paths: changedPaths,
    autoRepair: params.autoRepair,
  });
}
