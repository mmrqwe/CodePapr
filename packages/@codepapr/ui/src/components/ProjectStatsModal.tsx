import { errorMessage } from '@codepapr/common';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getTranslation, type Lang } from '../utils/i18n';
import { AgentContribution } from './AgentContribution';
import { ToolUsageStats } from './ToolUsageStats';

interface ProjectLanguageStat {
  id: string;
  label: string;
  files: number;
  lines: number;
  code: number;
  blank: number;
  comment: number;
}

interface DirectoryStat {
  name: string;
  files: number;
  lines: number;
}

interface FileSizeBucket {
  label: string;
  files: number;
  lines: number;
}

interface CodeRatio {
  code: number;
  config: number;
  doc: number;
}

interface AverageMetrics {
  avgLinesPerFile: number;
  medianLinesPerFile: number;
  maxLinesPerFile: number;
  totalTextFiles: number;
}

interface ProjectStatsResult {
  totalFiles: number;
  totalDirectories: number;
  textFiles: number;
  codeFiles: number;
  skippedFiles: number;
  totalLines: number;
  codeLines: number;
  blankLines: number;
  commentLines: number;
  languages: ProjectLanguageStat[];
  largestFile: {
    path: string;
    lines: number;
  } | null;
  truncated: boolean;
  directoryBreakdown: DirectoryStat[];
  fileSizeDistribution: FileSizeBucket[];
  codeRatio: CodeRatio;
  avgMetrics: AverageMetrics;
}

interface ProjectStatsModalProps {
  workspacePath: string;
  lang?: Lang;
  onClose: () => void;
}

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f7df1e',
  python: '#3572A5',
  java: '#b07219',
  go: '#00ADD8',
  rust: '#dea584',
  csharp: '#178600',
  cpp: '#f34b7d',
  css: '#563d7c',
  html: '#e34c26',
  dart: '#00B4AB',
  kotlin: '#A97BFF',
  swift: '#F05138',
  ruby: '#701516',
  php: '#4F5D95',
  lua: '#000080',
  perl: '#0298c3',
  shell: '#89e051',
  dockerfile: '#384d54',
  scala: '#c22d40',
  r: '#198CE7',
  graphql: '#e10098',
  objective_c: '#438eff',
  fsharp: '#b845fc',
  json: '#292929',
  yaml: '#cb171e',
  ini: '#6c93b5',
  toml: '#9c4221',
  xml: '#0060ac',
  markdown: '#083fa1',
  plaintext: '#666666',
  sql: '#e38c00',
  powershell: '#012456',
  haskell: '#5e5086',
  elixir: '#6e4a7e',
  clojure: '#db5855',
  erlang: '#B83998',
  groovy: '#4298b8',
  vue: '#41b883',
  svelte: '#ff3e00',
  tsx: '#3178c6',
  jsx: '#f7df1e',
};

function resolveLanguageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? LANGUAGE_COLORS[language.toLowerCase()] ?? '#4a5568';
}

function formatLanguageLabel(language: string): string {
  switch (language) {
    case 'typescript': return 'TypeScript';
    case 'javascript': return 'JavaScript';
    case 'csharp': return 'C#';
    case 'cpp': return 'C/C++';
    case 'shell': return 'Shell';
    case 'ini': return 'INI/TOML';
    case 'json': return 'JSON';
    case 'markdown': return 'Markdown';
    case 'plaintext': return 'Plain Text';
    case 'xml': return 'XML';
    case 'yaml': return 'YAML';
    case 'objective-c': return 'Objective-C';
    case 'fsharp': return 'F#';
    case 'pgsql': return 'PostgreSQL';
    case 'mysql': return 'MySQL';
    default: return language.charAt(0).toUpperCase() + language.slice(1);
  }
}

interface RawLanguageStat {
  id: string;
  files: number;
  lines: number;
  code: number;
  blank: number;
  comment: number;
}

interface RawProjectStats {
  totalFiles: number;
  totalDirectories: number;
  textFiles: number;
  codeFiles: number;
  skippedFiles: number;
  totalLines: number;
  codeLines: number;
  blankLines: number;
  commentLines: number;
  languages: RawLanguageStat[];
  largestFile: { path: string; lines: number } | null;
  truncated: boolean;
  directoryBreakdown: DirectoryStat[];
  fileSizeDistribution: FileSizeBucket[];
  codeRatio: CodeRatio;
  avgMetrics: AverageMetrics;
}

async function loadProjectStats(workspacePath: string): Promise<ProjectStatsResult> {
  const raw = await invoke<RawProjectStats>('compute_project_stats', { workspacePath });
  return {
    ...raw,
    languages: raw.languages.map((lang) => ({
      ...lang,
      label: formatLanguageLabel(lang.id),
    })),
  };
}

function StackedBar({ segments, height = 12 }: { segments: { color: string; width: number; label?: string }[]; height?: number }) {
  const total = segments.reduce((sum, s) => sum + s.width, 0);
  return (
    <div className="overflow-hidden rounded-full" style={{ height }}>
      <div className="flex h-full">
        {segments.map((seg, i) => (
          <div
            key={i}
            style={{
              width: total > 0 ? `${(seg.width / total) * 100}%` : '0%',
              backgroundColor: seg.color,
              minWidth: seg.width > 0 ? '4px' : '0px',
            }}
            title={seg.label ? `${seg.label}: ${seg.width.toLocaleString()} lines (${total > 0 ? ((seg.width / total) * 100).toFixed(1) : 0}%)` : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function LanguageBar({ languages, totalLines }: { languages: ProjectLanguageStat[]; totalLines: number }) {
  if (languages.length === 0) return null;
  return (
    <div className="space-y-2">
      <StackedBar
        segments={languages.map((lang) => ({
          color: resolveLanguageColor(lang.id),
          width: lang.lines,
          label: lang.label,
        }))}
        height={10}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {languages.map((lang) => {
          const pct = totalLines > 0 ? ((lang.lines / totalLines) * 100).toFixed(1) : '0';
          return (
            <div key={lang.id} className="flex items-center gap-1.5 text-[11px]">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: resolveLanguageColor(lang.id) }}
              />
              <span className="text-fg-soft">{lang.label}</span>
              <span className="text-fg-muted">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HorizontalBar({ label, value, max, color = '#6366f1', suffix = '' }: { label: string; value: number; max: number; color?: string; suffix?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 flex-shrink-0 text-[11px] text-fg-muted truncate">{label}</span>
      <div className="flex-1 h-5 bg-deep rounded-md overflow-hidden">
        <div
          className="h-full rounded-md transition-all duration-300 flex items-center justify-end pr-1.5"
          style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%`, backgroundColor: color }}
        >
          {pct >= 15 && (
            <span className="text-[10px] font-medium text-fg/80">{pct}%</span>
          )}
        </div>
      </div>
      <span className="w-36 flex-shrink-0 text-right text-[11px] text-fg-muted tabular-nums truncate">
        {value.toLocaleString()}{suffix}
      </span>
    </div>
  );
}

function RatioBar({ code, config, doc }: CodeRatio) {
  const total = code + config + doc;
  return (
    <div className="space-y-2">
      <StackedBar
        segments={[
          { color: '#6366f1', width: code, label: 'Code' },
          { color: '#f59e0b', width: config, label: 'Config' },
          { color: '#a855f7', width: doc, label: 'Doc' },
        ]}
        height={12}
      />
      <div className="flex gap-4 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#6366f1' }} />
          <span className="text-fg-soft">Code</span>
          <span className="text-fg-muted">{total > 0 ? ((code / total) * 100).toFixed(1) : 0}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#f59e0b' }} />
          <span className="text-fg-soft">Config</span>
          <span className="text-fg-muted">{total > 0 ? ((config / total) * 100).toFixed(1) : 0}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#a855f7' }} />
          <span className="text-fg-soft">Doc</span>
          <span className="text-fg-muted">{total > 0 ? ((doc / total) * 100).toFixed(1) : 0}%</span>
        </div>
      </div>
    </div>
  );
}

function SizeDistribution({ buckets }: { buckets: FileSizeBucket[] }) {
  const maxFiles = Math.max(...buckets.map((b) => b.files), 1);
  const labels = { small: '<200', medium: '200–999', large: '1000+' };
  const colors: Record<string, string> = { small: '#22c55e', medium: '#eab308', large: '#ef4444' };

  return (
    <div className="space-y-1.5">
      {buckets.map((bucket) => (
        <div key={bucket.label} className="flex items-center gap-3">
          <span className="w-14 flex-shrink-0 text-[11px] text-fg-muted">
            {labels[bucket.label as keyof typeof labels] ?? bucket.label}
          </span>
          <div className="flex-1 h-5 bg-deep rounded-md overflow-hidden relative">
            <div
              className="h-full rounded-md transition-all duration-300"
              style={{
                width: `${Math.max((bucket.files / maxFiles) * 100, bucket.files > 0 ? 3 : 0)}%`,
                backgroundColor: colors[bucket.label] ?? '#4a5568',
              }}
            />
          </div>
          <span className="w-20 flex-shrink-0 text-right text-[11px] text-fg-muted tabular-nums">
            {bucket.files.toLocaleString()} files
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Directory treemap ──────────────────────────────────────────────────

interface TreemapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
}

const TREEMAP_COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#84cc16', '#14b8a6', '#f97316'];

// Balanced-split treemap: recursively split the space along its longer axis,
// keeping the two halves as close to equal total weight as possible.
export function computeTreemap(items: { id: string; value: number }[], width: number, height: number): TreemapRect[] {
  const positive = items.filter((item) => item.value > 0);
  if (positive.length === 0 || width <= 0 || height <= 0) return [];

  const layout = (list: { id: string; value: number }[], x: number, y: number, w: number, h: number): TreemapRect[] => {
    const sum = list.reduce((s, item) => s + item.value, 0);
    if (sum <= 0 || w <= 0 || h <= 0) return [];
    if (list.length === 1) {
      return [{ id: list[0].id, x, y, w, h, value: list[0].value }];
    }
    const sorted = [...list].sort((a, b) => b.value - a.value);
    let acc = 0;
    let split = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += sorted[i].value;
      split = i;
      if (acc >= sum / 2) break;
    }
    const left = sorted.slice(0, split + 1);
    const right = sorted.slice(split + 1);
    const leftSum = left.reduce((s, item) => s + item.value, 0);
    const frac = leftSum / sum;
    if (w >= h) {
      const lw = w * frac;
      return [...layout(left, x, y, lw, h), ...layout(right, x + lw, y, w - lw, h)];
    }
    const lh = h * frac;
    return [...layout(left, x, y, w, lh), ...layout(right, x, y + lh, w, h - lh)];
  };

  return layout(positive, 0, 0, width, height);
}

function DirectoryTreemap({ dirs, totalLines }: { dirs: DirectoryStat[]; totalLines: number }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const rects = useMemo(
    () => computeTreemap(dirs.map((d) => ({ id: d.name, value: d.lines })), 100, 100),
    [dirs],
  );
  const byName = useMemo(() => new Map(dirs.map((d) => [d.name, d])), [dirs]);
  if (rects.length === 0) return null;

  return (
    <div className="relative h-44 w-full overflow-hidden rounded-lg border border-line bg-deep">
      {rects.map((rect, i) => {
        const stat = byName.get(rect.id);
        const color = TREEMAP_COLORS[i % TREEMAP_COLORS.length];
        const pct = totalLines > 0 ? ((rect.value / totalLines) * 100).toFixed(1) : '0';
        const isHovered = hovered === rect.id;
        const dimmed = hovered !== null && !isHovered;
        const showLabel = rect.w > 20 && rect.h > 16;
        return (
          <div
            key={rect.id}
            className="treemap-cell absolute flex flex-col justify-between overflow-hidden border border-line p-1.5 transition-[opacity,filter] duration-200"
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.w}%`,
              height: `${rect.h}%`,
              backgroundColor: color,
              opacity: dimmed ? 0.3 : 0.85,
              filter: isHovered ? 'brightness(1.25)' : undefined,
              zIndex: isHovered ? 10 : 1,
              animationDelay: `${i * 45}ms`,
            }}
            onMouseEnter={() => setHovered(rect.id)}
            onMouseLeave={() => setHovered(null)}
            title={`${rect.id} · ${stat?.files ?? 0} files · ${rect.value.toLocaleString()} lines (${pct}%)`}
          >
            {showLabel && (
              <>
                <span className="truncate text-[10px] font-semibold leading-tight text-fg/90">{rect.id}</span>
                {rect.h > 26 && (
                  <span className="truncate text-[9px] leading-tight text-fg/70">
                    {rect.value.toLocaleString()} lines
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sortable / filterable language table ───────────────────────────────

type LangSortKey = 'label' | 'files' | 'lines' | 'code' | 'blank' | 'comment';

function LanguageTable({
  languages,
  sortKey,
  sortDir,
  onSort,
  t,
}: {
  languages: ProjectLanguageStat[];
  sortKey: LangSortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: LangSortKey) => void;
  t: Record<string, string>;
}) {
  const columns: { key: LangSortKey; label: string; numeric: boolean }[] = [
    { key: 'label', label: t.projectStatsLanguage, numeric: false },
    { key: 'files', label: t.projectStatsFiles, numeric: true },
    { key: 'lines', label: t.projectStatsLines, numeric: true },
    { key: 'code', label: t.projectStatsCodeLines, numeric: true },
    { key: 'blank', label: t.projectStatsBlankLines, numeric: true },
    { key: 'comment', label: t.projectStatsCommentLines, numeric: true },
  ];

  const header = (col: { key: LangSortKey; label: string; numeric: boolean }) => {
    const active = sortKey === col.key;
    const arrow = active ? (sortDir === 'desc' ? '↓' : '↑') : '';
    return (
      <th
        key={col.key}
        onClick={() => onSort(col.key)}
        className={`cursor-pointer select-none whitespace-nowrap px-2 py-1.5 font-medium transition-colors hover:text-accent-text ${
          col.numeric ? 'text-right' : 'text-left'
        } ${active ? 'text-accent-text' : 'text-fg-muted'}`}
      >
        {col.label} {arrow}
      </th>
    );
  };

  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr className="border-b border-line">{columns.map(header)}</tr>
      </thead>
      <tbody>
        {languages.map((lang) => (
          <tr key={lang.id} className="border-b border-line transition-colors last:border-0 hover:bg-hover">
            <td className="px-2 py-1.5">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 flex-shrink-0 rounded-sm" style={{ backgroundColor: resolveLanguageColor(lang.id) }} />
                <span className="text-fg-soft">{lang.label}</span>
              </span>
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">{lang.files.toLocaleString()}</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-fg-soft">{lang.lines.toLocaleString()}</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-accent-text">{lang.code.toLocaleString()}</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">{lang.blank.toLocaleString()}</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-green-300">{lang.comment.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const statsCache = new Map<string, { stats: ProjectStatsResult; at: number }>();

export function resetProjectStatsCache(): void {
  statsCache.clear();
}

export function ProjectStatsModal({
  workspacePath,
  lang,
  onClose,
}: ProjectStatsModalProps) {
  const t = getTranslation(lang);
  const initialCached = workspacePath ? statsCache.get(workspacePath) : undefined;
  const [stats, setStats] = useState<ProjectStatsResult | null>(initialCached?.stats ?? null);
  const [isLoading, setIsLoading] = useState(Boolean(workspacePath));
  const [error, setError] = useState('');
  const [statsAt, setStatsAt] = useState<number | null>(initialCached?.at ?? null);
  const [langSortKey, setLangSortKey] = useState<LangSortKey>('lines');
  const [langSortDir, setLangSortDir] = useState<'asc' | 'desc'>('desc');
  const [langFilter, setLangFilter] = useState('');
  const requestIdRef = useRef(0);

  const refreshStats = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!workspacePath) {
      setStats(null);
      setError('');
      setStatsAt(null);
      setIsLoading(false);
      return;
    }
    const cached = statsCache.get(workspacePath);
    if (cached) {
      setStats(cached.stats);
      setStatsAt(cached.at);
    } else {
      setStats(null);
      setStatsAt(null);
    }
    setIsLoading(true);
    setError('');
    try {
      const result = await loadProjectStats(workspacePath);
      if (requestId !== requestIdRef.current) return;
      const now = Date.now();
      statsCache.set(workspacePath, { stats: result, at: now });
      setStats(result);
      setStatsAt(now);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (!statsCache.get(workspacePath)) {
        setStats(null);
        setError(errorMessage(err));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [workspacePath]);

  useEffect(() => {
    void refreshStats();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refreshStats]);

  const handleLangSort = (key: LangSortKey) => {
    if (langSortKey === key) {
      setLangSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setLangSortKey(key);
      setLangSortDir(key === 'label' ? 'asc' : 'desc');
    }
  };

  const visibleLanguages = useMemo(() => {
    if (!stats) return [];
    const query = langFilter.trim().toLowerCase();
    const filtered = query
      ? stats.languages.filter(
          (l) => l.label.toLowerCase().includes(query) || l.id.toLowerCase().includes(query),
        )
      : stats.languages;
    const dir = langSortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (langSortKey === 'label') return a.label.localeCompare(b.label) * dir;
      return (a[langSortKey] - b[langSortKey]) * dir;
    });
  }, [stats, langFilter, langSortKey, langSortDir]);

  const dirMaxFiles = useMemo(() => {
    if (!stats) return 1;
    return Math.max(...stats.directoryBreakdown.map((d) => d.files), 1);
  }, [stats]);

  const fileCountLabel = lang === 'en' ? 'files' : lang === 'zh-TW' ? '個文件' : '个文件';
  const dirLabel = lang === 'en' ? 'dirs' : lang === 'zh-TW' ? '個目錄' : '个目录';
  const truncatedLabel = lang === 'en' ? 'file list truncated' : lang === 'zh-TW' ? '文件列表已截斷' : '文件列表已截断';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex h-[90vh] w-[min(96vw,1280px)] flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t.projectStatsTitle}</h2>
            <p className="mt-1 text-xs text-fg-muted">
              {t.projectStatsAnalysisDepth}
              {statsAt !== null && (
                <span className="ml-2 text-fg-dim">
                  · {t.projectStatsAsOf} {formatClock(statsAt)}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshStats()}
              title={t.projectStatsTip}
              disabled={isLoading || !workspacePath}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-accent-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? t.projectStatsLoading : t.projectStatsRefresh}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t.cancel}
              className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
            >
              ×
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {isLoading && !stats && (
            <div className="rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg-muted">
              {t.projectStatsLoading}
            </div>
          )}

          {error && !stats && (
            <div className="rounded-xl border border-danger-bg bg-danger-bg px-4 py-3 text-sm text-danger">
              {t.projectStatsUnavailable}: {error}
            </div>
          )}

          {stats && (
            <>
              <div className="stats-reveal grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-line bg-base px-4 py-3">
                  <div className="text-[11px] text-fg-muted">{t.projectStatsTotalFiles}</div>
                  <div className="mt-1 text-lg font-semibold text-fg">{stats.totalFiles.toLocaleString()}</div>
                  <div className="text-[11px] text-fg-dim">
                    {stats.totalDirectories.toLocaleString()} {dirLabel}
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-base px-4 py-3">
                  <div className="text-[11px] text-fg-muted">{t.projectStatsTotalLines}</div>
                  <div className="mt-1 text-lg font-semibold text-fg">{stats.totalLines.toLocaleString()}</div>
                  <div className="text-[11px] text-fg-dim">{stats.codeLines.toLocaleString()} code</div>
                </div>
                <div className="rounded-xl border border-line bg-base px-4 py-3">
                  <div className="text-[11px] text-fg-muted">{t.projectStatsTextFiles}</div>
                  <div className="mt-1 text-lg font-semibold text-fg">{stats.textFiles.toLocaleString()}</div>
                  <div className="text-[11px] text-fg-dim">{stats.skippedFiles} skipped</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '60ms' }}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold text-fg-soft">{t.projectStatsLanguages}</p>
                    <input
                      type="text"
                      value={langFilter}
                      onChange={(e) => setLangFilter(e.target.value)}
                      placeholder={t.projectStatsFilterPlaceholder}
                      className="w-32 rounded-lg border border-line bg-deep px-2.5 py-1 text-[11px] text-fg-soft placeholder-slate-600 transition-colors focus:border-accent-soft focus:outline-none"
                    />
                  </div>
                  <LanguageBar languages={stats.languages.slice(0, 12)} totalLines={stats.totalLines} />
                  <div className="mt-3 max-h-64 overflow-y-auto">
                    <LanguageTable
                      languages={visibleLanguages}
                      sortKey={langSortKey}
                      sortDir={langSortDir}
                      onSort={handleLangSort}
                      t={t}
                    />
                  </div>
                </div>

                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '90ms' }}>
                  <ToolUsageStats lang={lang} />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '120ms' }}>
                  <p className="text-xs font-semibold text-fg-soft mb-3">{t.projectStatsAvgMetrics}</p>
                  <div className="space-y-3">
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsAvgLines}</div>
                      <div className="text-base font-semibold text-accent-text">{stats.avgMetrics.avgLinesPerFile.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsMedianLines}</div>
                      <div className="text-base font-semibold text-accent-text">{stats.avgMetrics.medianLinesPerFile.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsMaxLines}</div>
                      <div className="text-base font-semibold text-accent-text">{stats.avgMetrics.maxLinesPerFile.toLocaleString()}</div>
                    </div>
                  </div>
                </div>

                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '150ms' }}>
                  <p className="text-xs font-semibold text-fg-soft mb-3">{t.projectStatsLineComposition}</p>
                  <StackedBar
                    segments={[
                      { color: '#6366f1', width: stats.codeLines, label: t.projectStatsCodeLines },
                      { color: '#64748b', width: stats.blankLines, label: t.projectStatsBlankLines },
                      { color: '#22c55e', width: stats.commentLines, label: t.projectStatsCommentLines },
                    ]}
                    height={12}
                  />
                  <div className="mt-3 space-y-3">
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsCodeLines}</div>
                      <div className="text-base font-semibold text-accent-text">{stats.codeLines.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsBlankLines}</div>
                      <div className="text-base font-semibold text-fg-soft">{stats.blankLines.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-fg-muted">{t.projectStatsCommentLines}</div>
                      <div className="text-base font-semibold text-green-300">{stats.commentLines.toLocaleString()}</div>
                    </div>
                  </div>
                </div>

                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '180ms' }}>
                  <p className="text-xs font-semibold text-fg-soft mb-3">{t.projectStatsCodeRatio}</p>
                  <RatioBar code={stats.codeRatio.code} config={stats.codeRatio.config} doc={stats.codeRatio.doc} />
                </div>
              </div>

              {stats.directoryBreakdown.length > 0 && (
                <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '180ms' }}>
                  <p className="text-xs font-semibold text-fg-soft mb-3">{t.projectStatsDirectories}</p>
                  <DirectoryTreemap dirs={stats.directoryBreakdown} totalLines={stats.totalLines} />
                  <div className="mt-3 space-y-1.5">
                    {stats.directoryBreakdown.map((dir) => (
                      <HorizontalBar
                        key={dir.name}
                        label={dir.name}
                        value={dir.files}
                        max={dirMaxFiles}
                        color="#6366f1"
                        suffix={` ${fileCountLabel} · ${dir.lines.toLocaleString()} lines`}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {stats.fileSizeDistribution.length > 0 && (
                  <div className="stats-reveal rounded-xl border border-line bg-base p-4" style={{ animationDelay: '210ms' }}>
                    <p className="text-xs font-semibold text-fg-soft mb-3">{t.projectStatsFileSize}</p>
                    <SizeDistribution buckets={stats.fileSizeDistribution} />
                  </div>
                )}

                {stats.largestFile && (
                  <div className="stats-reveal rounded-xl border border-line bg-base px-4 py-3" style={{ animationDelay: '240ms' }}>
                    <div className="text-xs font-semibold text-fg">{t.projectStatsLargestFile}</div>
                    <div className="mt-2 break-all text-sm text-fg-soft">
                      {stats.largestFile.path} · {stats.largestFile.lines.toLocaleString()} lines
                    </div>
                    <div className="mt-1 text-[11px] text-fg-muted">
                      {stats.truncated ? truncatedLabel : ''}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="border-t border-line pt-4">
            <AgentContribution workspacePath={workspacePath} lang={lang} />
          </div>
        </div>
      </div>
    </div>
  );
}
