import type { ProjectDiagnosticsReport } from './projectDiagnostics';
import {
  parseProjectDiagnosticLocations,
  type ProjectDiagnosticLocation,
} from './projectDiagnosticLocations';

export interface ProjectFileDiagnosticsSummary {
  available: boolean;
  overallStatus: ProjectDiagnosticsReport['overallStatus'];
  covered: boolean;
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  items: ProjectDiagnosticLocation[];
}

export function createEmptyProjectFileDiagnosticsSummary(
  overallStatus: ProjectDiagnosticsReport['overallStatus'] = 'unavailable'
): ProjectFileDiagnosticsSummary {
  return {
    available: false,
    overallStatus,
    covered: false,
    total: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    items: [],
  };
}

function isPythonDiagnosticsCoveredPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.toLowerCase().endsWith('.py')) {
    return false;
  }

  return !normalized.split('/').some((part) =>
    part === '__pycache__' ||
    part === 'node_modules' ||
    part === '.git' ||
    part === '.venv' ||
    part === 'venv' ||
    part === '.mypy_cache' ||
    part === '.pytest_cache'
  );
}

function isTypeScriptFamilyPath(path: string): boolean {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(path.toLowerCase());
}

function isPackageScriptCoverageStage(scriptName: string): boolean {
  return /(?:build|check|lint|typecheck)/i.test(scriptName);
}

function isPathCoveredByProjectDiagnostics(
  report: ProjectDiagnosticsReport,
  selectedPath: string
): boolean {
  return report.stages.some(
    (stage) =>
      (stage.kind === 'python-syntax' && isPythonDiagnosticsCoveredPath(selectedPath)) ||
      ((stage.kind === 'package-script' || !stage.kind) &&
        stage.success &&
        isTypeScriptFamilyPath(selectedPath) &&
        isPackageScriptCoverageStage(stage.scriptName))
  );
}

export function summarizeProjectFileDiagnostics(params: {
  workspacePath: string;
  selectedPath: string | null;
  report: ProjectDiagnosticsReport | null;
}): ProjectFileDiagnosticsSummary {
  const { report, selectedPath, workspacePath } = params;
  if (!report || !selectedPath) {
    return createEmptyProjectFileDiagnosticsSummary(report?.overallStatus ?? 'unavailable');
  }

  if (!report.available) {
    return createEmptyProjectFileDiagnosticsSummary(report.overallStatus);
  }

  const items = report.stages.flatMap((stage) =>
    parseProjectDiagnosticLocations(workspacePath, stage).filter(
      (location) => location.path === selectedPath
    )
  );

  return items.reduce<ProjectFileDiagnosticsSummary>(
    (summary, item) => {
      summary.items.push(item);
      summary.total += 1;
      if (item.severity === 'error') summary.errors += 1;
      if (item.severity === 'warning') summary.warnings += 1;
      if (item.severity === 'info') summary.infos += 1;
      return summary;
    },
    {
      available: true,
      overallStatus: report.overallStatus,
      covered: items.length > 0 || isPathCoveredByProjectDiagnostics(report, selectedPath),
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      items: [],
    }
  );
}