import type { ProjectDiagnosticStageResult } from './projectDiagnostics';

export interface PreviewLocation {
  path: string;
  line: number;
  column: number;
}

export interface ProjectDiagnosticLocation extends PreviewLocation {
  message: string;
  severity: 'error' | 'warning' | 'info';
  stageId: ProjectDiagnosticStageResult['id'];
  stageLabel: string;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeCandidatePath(value: string): string {
  const trimmed = value.trim().replace(/^at\s+/, '');
  const decoded = trimmed.startsWith('file://')
    ? decodeURIComponent(trimmed.replace(/^file:\/\/+/, '/'))
    : trimmed;
  return normalizeSlashes(decoded).replace(/^\.\/+/, '');
}

function normalizeWorkspacePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/, '');
}

function looksLikeFilePath(value: string): boolean {
  if (!value || /^https?:\/\//i.test(value)) {
    return false;
  }

  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[A-Za-z]:\//.test(value) ||
    /[\\/]/.test(value) ||
    /[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(value)
  );
}

function toWorkspaceRelativePath(candidate: string, workspacePath: string): string | null {
  const normalized = normalizeCandidatePath(candidate);
  if (!looksLikeFilePath(normalized)) {
    return null;
  }

  const workspace = normalizeWorkspacePath(workspacePath);
  if (!workspace) {
    return normalized;
  }

  if (normalized === workspace) {
    return null;
  }

  if (normalized.startsWith(`${workspace}/`)) {
    return normalized.slice(workspace.length + 1);
  }

  if (normalized.startsWith('/')) {
    return null;
  }

  return normalized;
}

function resolveSeverity(text: string): ProjectDiagnosticLocation['severity'] {
  if (/\berror\b/i.test(text)) return 'error';
  if (/\bwarning\b/i.test(text)) return 'warning';
  return 'info';
}

function cleanMessage(text: string): string {
  return text
    .replace(/^\s*[-:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumeric(value: string): number {
  return Number.parseInt(value, 10);
}

function buildLocation(
  workspacePath: string,
  stage: ProjectDiagnosticStageResult,
  pathValue: string,
  lineValue: string,
  columnValue: string,
  message: string
): ProjectDiagnosticLocation | null {
  const path = toWorkspaceRelativePath(pathValue, workspacePath);
  if (!path) {
    return null;
  }

  const line = parseNumeric(lineValue);
  const column = parseNumeric(columnValue);
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
    return null;
  }

  const cleanedMessage = cleanMessage(message) || stage.label;
  return {
    path,
    line,
    column,
    message: cleanedMessage,
    severity: resolveSeverity(cleanedMessage),
    stageId: stage.id,
    stageLabel: stage.label,
  };
}

export function parseProjectDiagnosticLocations(
  workspacePath: string,
  stage: ProjectDiagnosticStageResult
): ProjectDiagnosticLocation[] {
  const lines = `${stage.stderr || ''}\n${stage.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const locations: ProjectDiagnosticLocation[] = [];
  const seen = new Set<string>();
  let stylishPath: string | null = null;

  const pushLocation = (location: ProjectDiagnosticLocation | null) => {
    if (!location) {
      return;
    }

    const key = [
      location.path,
      location.line,
      location.column,
      location.message,
      location.stageId,
    ].join(':');
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    locations.push(location);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      stylishPath = null;
      continue;
    }

    if (!trimmed.includes(':') && !trimmed.includes('(')) {
      const pathCandidate = toWorkspaceRelativePath(trimmed, workspacePath);
      if (pathCandidate) {
        stylishPath = pathCandidate;
        continue;
      }
    }

    const stylishMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning|info)\s+(.*?)(?:\s{2,}\S.*)?$/i);
    if (stylishMatch && stylishPath) {
      pushLocation(
        buildLocation(
          workspacePath,
          stage,
          stylishPath,
          stylishMatch[1]!,
          stylishMatch[2]!,
          `${stylishMatch[3]} ${stylishMatch[4]}`
        )
      );
      continue;
    }

    const colonMatch = trimmed.match(/^(?:at\s+)?(.+):(\d+):(\d+)(?::?\s*)(.*)$/);
    if (colonMatch) {
      pushLocation(
        buildLocation(
          workspacePath,
          stage,
          colonMatch[1]!,
          colonMatch[2]!,
          colonMatch[3]!,
          colonMatch[4]!
        )
      );
      continue;
    }

    const parenMatch = trimmed.match(/^(?:at\s+)?(.+?)\((\d+),\s*(\d+)\)(?::?\s*)(.*)$/);
    if (parenMatch) {
      pushLocation(
        buildLocation(
          workspacePath,
          stage,
          parenMatch[1]!,
          parenMatch[2]!,
          parenMatch[3]!,
          parenMatch[4]!
        )
      );
    }
  }

  return locations;
}
