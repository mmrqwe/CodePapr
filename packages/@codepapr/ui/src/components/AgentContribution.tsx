import { useCallback, useEffect, useState } from 'react';
import { getTranslation, type Lang } from '../utils/i18n';
import {
  loadCheckpointRecords,
  snapshotHeadSha,
  diffSnapshots,
  type CheckpointRecord,
  type FileDiff,
} from '../utils/snapshot';

interface TopFile {
  path: string;
  additions: number;
  deletions: number;
}

interface SessionActivity {
  sessionId: string;
  checkpoints: number;
  firstAt: number;
  lastAt: number;
}

interface ContributionData {
  available: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  topFiles: TopFile[];
  sessions: SessionActivity[];
}

const EMPTY: ContributionData = {
  available: false,
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  topFiles: [],
  sessions: [],
};

async function loadContribution(workspacePath: string): Promise<ContributionData> {
  const records = await loadCheckpointRecords(workspacePath);
  if (records.length === 0) {
    return EMPTY;
  }

  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const fromSha = sorted[0].sha;
  const head = await snapshotHeadSha(workspacePath);
  const toSha = head ?? sorted[sorted.length - 1].sha;

  let files: FileDiff[] = [];
  if (fromSha && toSha && fromSha !== toSha) {
    try {
      files = await diffSnapshots(workspacePath, fromSha, toSha);
    } catch {
      files = [];
    }
  }

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const topFiles = [...files]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 8)
    .map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));

  const bySession = new Map<string, CheckpointRecord[]>();
  for (const record of sorted) {
    const list = bySession.get(record.sessionId);
    if (list) list.push(record);
    else bySession.set(record.sessionId, [record]);
  }
  const sessions = [...bySession.entries()]
    .map(([sessionId, recs]) => ({
      sessionId,
      checkpoints: recs.length,
      firstAt: recs[0].createdAt,
      lastAt: recs[recs.length - 1].createdAt,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);

  return { available: true, filesChanged: files.length, additions, deletions, topFiles, sessions };
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

interface AgentContributionProps {
  workspacePath: string;
  lang?: Lang;
}

export function AgentContribution({ workspacePath, lang }: AgentContributionProps) {
  const t = getTranslation(lang);
  const [data, setData] = useState<ContributionData>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setData(EMPTY);
      return;
    }
    setIsLoading(true);
    try {
      setData(await loadContribution(workspacePath));
    } catch {
      setData(EMPTY);
    } finally {
      setIsLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const net = data.additions - data.deletions;
  const maxChurn = Math.max(...data.topFiles.map((f) => f.additions + f.deletions), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-300">{t.agentContributionTitle}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isLoading || !workspacePath}
          className="rounded-lg border border-[#2a2d3a] px-2.5 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:border-indigo-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? t.projectStatsLoading : t.projectStatsRefresh}
        </button>
      </div>

      {!data.available && !isLoading && (
        <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3 text-xs text-slate-500">
          {t.agentContributionUnavailable}
        </div>
      )}

      {data.available && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-3 py-3">
              <div className="text-[11px] text-slate-500">{t.agentContributionFilesChanged}</div>
              <div className="mt-1 text-lg font-semibold text-slate-100">{data.filesChanged.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-3 py-3">
              <div className="text-[11px] text-slate-500">{t.agentContributionAdditions}</div>
              <div className="mt-1 text-lg font-semibold text-green-400">+{data.additions.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-3 py-3">
              <div className="text-[11px] text-slate-500">{t.agentContributionDeletions}</div>
              <div className="mt-1 text-lg font-semibold text-red-400">−{data.deletions.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-3 py-3">
              <div className="text-[11px] text-slate-500">{t.agentContributionNet}</div>
              <div className={`mt-1 text-lg font-semibold ${net >= 0 ? 'text-indigo-300' : 'text-red-400'}`}>
                {net >= 0 ? '+' : '−'}{Math.abs(net).toLocaleString()}
              </div>
            </div>
          </div>

          {data.topFiles.length > 0 && (
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
              <p className="mb-3 text-xs font-semibold text-slate-300">{t.agentContributionTopFiles}</p>
              <div className="space-y-2">
                {data.topFiles.map((file) => (
                  <div key={file.path} className="flex items-center gap-3">
                    <span className="w-40 flex-shrink-0 truncate text-[11px] text-slate-400" title={file.path}>
                      {fileName(file.path)}
                    </span>
                    <div className="flex h-4 flex-1 overflow-hidden rounded-md bg-[#0a0d14]">
                      <div className="h-full bg-green-500/70" style={{ width: `${(file.additions / maxChurn) * 100}%` }} />
                      <div className="h-full bg-red-500/70" style={{ width: `${(file.deletions / maxChurn) * 100}%` }} />
                    </div>
                    <span className="w-24 flex-shrink-0 text-right text-[11px] tabular-nums">
                      <span className="text-green-400">+{file.additions}</span>
                      <span className="text-slate-600"> / </span>
                      <span className="text-red-400">−{file.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.sessions.length > 0 && (
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
              <p className="mb-3 text-xs font-semibold text-slate-300">{t.agentContributionSessions}</p>
              <div className="space-y-1.5">
                {data.sessions.slice(0, 10).map((session) => (
                  <div key={session.sessionId} className="flex items-center justify-between text-[11px]">
                    <span className="truncate font-mono text-slate-400" title={session.sessionId}>
                      {session.sessionId.slice(0, 8)}
                    </span>
                    <span className="flex-shrink-0 text-slate-500">
                      {session.checkpoints} {t.agentContributionCheckpoints} · {formatTimestamp(session.firstAt)}
                      {session.lastAt !== session.firstAt ? ` → ${formatTimestamp(session.lastAt)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="px-1 text-[10px] leading-relaxed text-slate-600">{t.agentContributionNote}</p>
        </>
      )}
    </div>
  );
}
