import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import {
  formatProjectDiagnosticsTimestamp,
  type ProjectDiagnosticsReport,
} from '../utils/projectDiagnostics';
import {
  parseProjectDiagnosticLocations,
  type ProjectDiagnosticLocation,
} from '../utils/projectDiagnosticLocations';

interface ProjectDiagnosticsPanelProps {
  workspacePath: string;
  lang?: Lang;
  compact?: boolean;
  onSelectDiagnosticLocation?: (location: ProjectDiagnosticLocation) => void;
}

function stageStatusText(
  report: ProjectDiagnosticsReport,
  t: ReturnType<typeof getTranslation>
): string {
  if (!report.available) {
    return t.projectDiagnosticsUnavailable;
  }

  return report.overallStatus === 'passed'
    ? t.projectDiagnosticsPassed
    : t.projectDiagnosticsFailed;
}

function needsDiagnosticsSchemaRefresh(report: ProjectDiagnosticsReport | null): boolean {
  return !!report?.available && report.stages.some((stage) => !stage.kind);
}

export function ProjectDiagnosticsPanel({
  workspacePath,
  lang,
  compact = false,
  onSelectDiagnosticLocation,
}: ProjectDiagnosticsPanelProps) {
  const t = getTranslation(lang);
  const report = useAgentStore((state) => state.projectDiagnosticsReport);
  const refreshProjectDiagnostics = useAgentStore((state) => state.refreshProjectDiagnostics);
  const setProjectDiagnosticsReport = useAgentStore((state) => state.setProjectDiagnosticsReport);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const autoLoadWorkspaceRef = useRef<string | null>(null);

  const refreshDiagnostics = useCallback(
    async (silent: boolean = false) => {
      if (!workspacePath) {
        setProjectDiagnosticsReport(null);
        setError('');
        return;
      }

      if (!silent) {
        setIsLoading(true);
      }

      try {
        await refreshProjectDiagnostics();
        setError('');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!silent) {
          setIsLoading(false);
        }
      }
    },
    [refreshProjectDiagnostics, setProjectDiagnosticsReport, workspacePath]
  );

  useEffect(() => {
    if (!workspacePath) {
      autoLoadWorkspaceRef.current = null;
      setError('');
      return;
    }

    const refreshReason = needsDiagnosticsSchemaRefresh(report) ? 'schema' : null;
    if (!refreshReason) {
      return;
    }
    const autoLoadKey = `${workspacePath}:${refreshReason}`;
    if (autoLoadWorkspaceRef.current === autoLoadKey) {
      return;
    }

    autoLoadWorkspaceRef.current = autoLoadKey;
    void refreshDiagnostics(!!report);
  }, [refreshDiagnostics, report, workspacePath]);

  const stageLocations = useMemo(
    () =>
      new Map(
        (report?.stages ?? []).map((stage) => [
          stage.id,
          parseProjectDiagnosticLocations(workspacePath, stage),
        ])
      ),
    [report?.stages, workspacePath]
  );

  const details = (
    <>
      {report?.ranAt && !error && (
        <div className="mt-2 text-[10px] text-slate-600">
          {t.projectDiagnosticsUpdatedAt}:{' '}
          {formatProjectDiagnosticsTimestamp(report.ranAt, lang)}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
          {error}
        </div>
      )}

      {!error && report && !report.available && (
        <div className="mt-3 rounded-xl border border-[#2a2d3a] bg-[#121722] px-3 py-2 text-xs leading-relaxed text-slate-400">
          {report.message ?? t.projectDiagnosticsUnavailable}
        </div>
      )}

      {!error && report?.available && (
        <div className="mt-3 grid gap-2">
          {report.stages.map((stage) => (
            <div
              key={stage.id}
              className="rounded-xl border border-[#2a2d3a] bg-[#11141c] px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-200">
                    {stage.label}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-500">
                    {[stage.command, ...stage.args].join(' ')}
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    stage.success
                      ? 'border-emerald-500/40 text-emerald-200'
                      : 'border-amber-500/40 text-amber-200'
                  }`}
                >
                  {stage.success ? t.projectDiagnosticsPassed : t.projectDiagnosticsFailed}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500">
                <span>
                  {t.projectDiagnosticsExitCode}: {stage.timedOut ? t.projectDiagnosticsTimedOut : stage.status ?? 'unknown'}
                </span>
                {stage.fallback && (
                  <span>{t.projectDiagnosticsBuildFallback}</span>
                )}
                {stageLocations.get(stage.id)?.length ? (
                  <span>
                    {t.projectDiagnosticsLocations}: {stageLocations.get(stage.id)?.length}
                  </span>
                ) : null}
              </div>
              {(stageLocations.get(stage.id)?.length ?? 0) > 0 && (
                <div className="mt-2 grid gap-1.5">
                  {stageLocations.get(stage.id)?.slice(0, 8).map((location) => (
                    <button
                      key={`${location.stageId}-${location.path}-${location.line}-${location.column}-${location.message}`}
                      type="button"
                      onClick={() => onSelectDiagnosticLocation?.(location)}
                      className="rounded-lg border border-[#2a2d3a] bg-[#0d1017] px-2.5 py-2 text-left text-[11px] text-slate-300 transition-colors hover:border-indigo-500/40 hover:text-slate-100"
                    >
                      <div className="font-mono text-[10px] text-slate-500">
                        {location.path}:{location.line}:{location.column}
                      </div>
                      <div className="mt-1 leading-relaxed">{location.message}</div>
                    </button>
                  ))}
                </div>
              )}
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[#232734] bg-[#0d1017] px-2 py-2 font-mono text-[10px] leading-relaxed text-slate-300">
                {stage.excerpt || t.projectDiagnosticsNoOutput}
              </pre>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={compact ? 'rounded-xl border border-[#2a2d3a] bg-[#10141d] px-3 py-2.5' : 'border-b border-[#2a2d3a] px-4 py-3'}>
      <div className={`flex justify-between gap-3 ${compact ? 'items-center' : 'items-start'}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-300">
              {t.projectDiagnostics}
            </h3>
            {report && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  report.overallStatus === 'passed'
                    ? 'border-emerald-500/40 text-emerald-200'
                    : report.overallStatus === 'failed'
                    ? 'border-amber-500/40 text-amber-200'
                    : 'border-slate-500/40 text-slate-300'
                }`}
              >
                {stageStatusText(report, t)}
              </span>
            )}
          </div>
          {compact ? (
            report?.ranAt && !error ? (
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                {t.projectDiagnosticsUpdatedAt}: {formatProjectDiagnosticsTimestamp(report.ranAt, lang)}
              </p>
            ) : (
              !workspacePath ? (
                <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                  {t.projectDiagnosticsUnavailable}
                </p>
              ) : null
            )
          ) : (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
              {t.projectDiagnosticsDesc}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refreshDiagnostics()}
            title={t.projectDiagnosticsRefreshTip}
            disabled={!workspacePath || isLoading}
            className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? t.projectDiagnosticsRunning : t.projectDiagnosticsRefresh}
          </button>
        </div>
      </div>

      {!compact && details}
      {compact && error && <div className="mt-3">{details}</div>}
    </div>
  );
}
