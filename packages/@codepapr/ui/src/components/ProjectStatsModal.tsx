import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getTranslation, type Lang } from '../utils/i18n';
import { languageFromPath } from '../utils/editorLanguage';

interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

interface ListFilesResult {
  root: string;
  entries: FileEntry[];
  truncated: boolean;
}

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}

interface ProjectLanguageStat {
  id: string;
  label: string;
  files: number;
  lines: number;
}

interface DirectoryStat {
  name: string;
  files: number;
  lines: number;
}

interface FileSizeBucket {
  label: string;
  range: [number, number | null];
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

const LIST_DEPTH = 6;
const MAX_BYTES_PER_FILE = 400_000;
const BATCH_SIZE = 16;
const NON_CODE_LANGUAGES = new Set(['plaintext', 'markdown']);
const CONFIG_LANGUAGES = new Set(['json', 'ini', 'yaml', 'xml', 'bicep', 'toml']);
const DOC_LANGUAGES = new Set(['markdown', 'plaintext']);

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

function countLines(content: string): number {
  if (!content) return 0;
  return content.replace(/\r\n/g, '\n').split('\n').length;
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

function isCodeLanguage(language: string): boolean {
  return !NON_CODE_LANGUAGES.has(language);
}

function resolveFileCategory(language: string): 'code' | 'config' | 'doc' {
  if (DOC_LANGUAGES.has(language)) return 'doc';
  if (CONFIG_LANGUAGES.has(language)) return 'config';
  return 'code';
}

function getTopLevelDirectory(path: string): string {
  const normalized = path.replace(/^\.\//, '');
  const idx = normalized.indexOf('/');
  if (idx === -1) return '(root)';
  return normalized.substring(0, idx);
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function loadProjectStats(workspacePath: string): Promise<ProjectStatsResult> {
  const listResult = await invoke<ListFilesResult>('list_workspace_files', {
    workspacePath,
    maxDepth: LIST_DEPTH,
  });
  const files = listResult.entries.filter((entry) => !entry.isDir);
  const directories = listResult.entries.filter((entry) => entry.isDir);
  const languageMap = new Map<string, ProjectLanguageStat>();
  const dirMap = new Map<string, { files: number; lines: number }>();
  const fileLineLengths: number[] = [];
  let textFiles = 0;
  let codeFiles = 0;
  let skippedFiles = 0;
  let totalLines = 0;
  let codeLines = 0;
  let largestFile: ProjectStatsResult['largestFile'] = null;
  let codeLinesCount = 0;
  let configLinesCount = 0;
  let docLinesCount = 0;

  for (let index = 0; index < files.length; index += BATCH_SIZE) {
    const batch = files.slice(index, index + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const result = await invoke<ReadFileResult>('read_text_file', {
            workspacePath,
            relativePath: file.path,
            maxBytes: MAX_BYTES_PER_FILE,
          });
          return { path: file.path, content: result.content };
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (!result) {
        skippedFiles += 1;
        continue;
      }

      const lines = countLines(result.content);
      const language = languageFromPath(result.path);
      const codeLike = isCodeLanguage(language);
      textFiles += 1;
      totalLines += lines;
      fileLineLengths.push(lines);

      if (codeLike) {
        codeFiles += 1;
        codeLines += lines;
      }

      const category = resolveFileCategory(language);
      if (category === 'code') codeLinesCount += lines;
      else if (category === 'config') configLinesCount += lines;
      else docLinesCount += lines;

      const topDir = getTopLevelDirectory(result.path);
      const dir = dirMap.get(topDir) ?? { files: 0, lines: 0 };
      dir.files += 1;
      dir.lines += lines;
      dirMap.set(topDir, dir);

      const currentLanguage = languageMap.get(language) ?? {
        id: language,
        label: formatLanguageLabel(language),
        files: 0,
        lines: 0,
      };
      currentLanguage.files += 1;
      currentLanguage.lines += lines;
      languageMap.set(language, currentLanguage);

      if (!largestFile || lines > largestFile.lines) {
        largestFile = { path: result.path, lines };
      }
    }
  }

  const sizeBuckets: FileSizeBucket[] = [
    { label: 'small', range: [0, 199], files: 0, lines: 0 },
    { label: 'medium', range: [200, 999], files: 0, lines: 0 },
    { label: 'large', range: [1000, null], files: 0, lines: 0 },
  ];

  for (const lines of fileLineLengths) {
    if (lines < 200) {
      sizeBuckets[0].files += 1;
      sizeBuckets[0].lines += lines;
    } else if (lines < 1000) {
      sizeBuckets[1].files += 1;
      sizeBuckets[1].lines += lines;
    } else {
      sizeBuckets[2].files += 1;
      sizeBuckets[2].lines += lines;
    }
  }

  const directoryBreakdown = Array.from(dirMap.entries())
    .map(([name, stat]) => ({ name, ...stat }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 8);

  return {
    totalFiles: files.length,
    totalDirectories: directories.length,
    textFiles,
    codeFiles,
    skippedFiles,
    totalLines,
    codeLines,
    languages: Array.from(languageMap.values()).sort((left, right) => right.lines - left.lines),
    largestFile,
    truncated: listResult.truncated,
    directoryBreakdown,
    fileSizeDistribution: sizeBuckets.filter((b) => b.files > 0),
    codeRatio: {
      code: codeLinesCount,
      config: configLinesCount,
      doc: docLinesCount,
    },
    avgMetrics: {
      avgLinesPerFile: fileLineLengths.length > 0
        ? Math.round(totalLines / fileLineLengths.length)
        : 0,
      medianLinesPerFile: Math.round(computeMedian(fileLineLengths)),
      maxLinesPerFile: fileLineLengths.length > 0 ? Math.max(...fileLineLengths) : 0,
      totalTextFiles: textFiles,
    },
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
              <span className="text-slate-300">{lang.label}</span>
              <span className="text-slate-500">{pct}%</span>
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
      <span className="w-28 flex-shrink-0 text-[11px] text-slate-400 truncate">{label}</span>
      <div className="flex-1 h-5 bg-[#0a0d14] rounded-md overflow-hidden">
        <div
          className="h-full rounded-md transition-all duration-300 flex items-center justify-end pr-1.5"
          style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%`, backgroundColor: color }}
        >
          {pct >= 15 && (
            <span className="text-[10px] font-medium text-white/80">{pct}%</span>
          )}
        </div>
      </div>
      <span className="w-36 flex-shrink-0 text-right text-[11px] text-slate-500 tabular-nums truncate">
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
          <span className="text-slate-300">Code</span>
          <span className="text-slate-500">{total > 0 ? ((code / total) * 100).toFixed(1) : 0}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#f59e0b' }} />
          <span className="text-slate-300">Config</span>
          <span className="text-slate-500">{total > 0 ? ((config / total) * 100).toFixed(1) : 0}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#a855f7' }} />
          <span className="text-slate-300">Doc</span>
          <span className="text-slate-500">{total > 0 ? ((doc / total) * 100).toFixed(1) : 0}%</span>
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
          <span className="w-14 flex-shrink-0 text-[11px] text-slate-400">
            {labels[bucket.label as keyof typeof labels] ?? bucket.label}
          </span>
          <div className="flex-1 h-5 bg-[#0a0d14] rounded-md overflow-hidden relative">
            <div
              className="h-full rounded-md transition-all duration-300"
              style={{
                width: `${Math.max((bucket.files / maxFiles) * 100, bucket.files > 0 ? 3 : 0)}%`,
                backgroundColor: colors[bucket.label] ?? '#4a5568',
              }}
            />
          </div>
          <span className="w-20 flex-shrink-0 text-right text-[11px] text-slate-500 tabular-nums">
            {bucket.files.toLocaleString()} files
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProjectStatsModal({
  workspacePath,
  lang,
  onClose,
}: ProjectStatsModalProps) {
  const t = getTranslation(lang);
  const [stats, setStats] = useState<ProjectStatsResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const refreshStats = useCallback(async () => {
    if (!workspacePath) {
      setStats(null);
      setError('');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const result = await loadProjectStats(workspacePath);
      setStats(result);
    } catch (err) {
      setStats(null);
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const dirMaxFiles = useMemo(() => {
    if (!stats) return 1;
    return Math.max(...stats.directoryBreakdown.map((d) => d.files), 1);
  }, [stats]);

  const fileCountLabel = lang === 'en' ? 'files' : lang === 'zh-TW' ? '個文件' : '个文件';
  const dirLabel = lang === 'en' ? 'dirs' : lang === 'zh-TW' ? '個目錄' : '个目录';
  const truncatedLabel = lang === 'en' ? 'file list truncated' : lang === 'zh-TW' ? '文件列表已截斷' : '文件列表已截断';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">{t.projectStatsTitle}</h2>
            <p className="mt-1 text-xs text-slate-500">{t.projectStatsAnalysisDepth}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshStats()}
              title={t.projectStatsTip}
              disabled={isLoading || !workspacePath}
              className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? t.projectStatsLoading : t.projectStatsRefresh}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t.cancel}
              className="text-lg leading-none text-slate-500 transition-colors hover:text-slate-200"
            >
              ×
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {isLoading && (
            <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3 text-sm text-slate-400">
              {t.projectStatsLoading}
            </div>
          )}

          {!isLoading && error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {t.projectStatsUnavailable}: {error}
            </div>
          )}

          {!isLoading && !error && stats && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3">
                  <div className="text-[11px] text-slate-500">{t.projectStatsTotalFiles}</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{stats.totalFiles.toLocaleString()}</div>
                  <div className="text-[11px] text-slate-600">
                    {stats.totalDirectories.toLocaleString()} {dirLabel}
                  </div>
                </div>
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3">
                  <div className="text-[11px] text-slate-500">{t.projectStatsTotalLines}</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{stats.totalLines.toLocaleString()}</div>
                  <div className="text-[11px] text-slate-600">{stats.codeLines.toLocaleString()} code</div>
                </div>
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3">
                  <div className="text-[11px] text-slate-500">{t.projectStatsTextFiles}</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{stats.textFiles.toLocaleString()}</div>
                  <div className="text-[11px] text-slate-600">{stats.skippedFiles} skipped</div>
                </div>
              </div>

              <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
                <p className="text-xs font-semibold text-slate-300 mb-3">{t.projectStatsAvgMetrics}</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-[11px] text-slate-500">{t.projectStatsAvgLines}</div>
                    <div className="text-base font-semibold text-indigo-300">{stats.avgMetrics.avgLinesPerFile.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">{t.projectStatsMedianLines}</div>
                    <div className="text-base font-semibold text-indigo-300">{stats.avgMetrics.medianLinesPerFile.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">{t.projectStatsMaxLines}</div>
                    <div className="text-base font-semibold text-indigo-300">{stats.avgMetrics.maxLinesPerFile.toLocaleString()}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
                <p className="text-xs font-semibold text-slate-300 mb-3">{t.projectStatsLanguages}</p>
                <LanguageBar languages={stats.languages.slice(0, 12)} totalLines={stats.totalLines} />
              </div>

              <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
                <p className="text-xs font-semibold text-slate-300 mb-3">{t.projectStatsCodeRatio}</p>
                <RatioBar code={stats.codeRatio.code} config={stats.codeRatio.config} doc={stats.codeRatio.doc} />
              </div>

              {stats.directoryBreakdown.length > 0 && (
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
                  <p className="text-xs font-semibold text-slate-300 mb-3">{t.projectStatsDirectories}</p>
                  <div className="space-y-1.5">
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

              {stats.fileSizeDistribution.length > 0 && (
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-4">
                  <p className="text-xs font-semibold text-slate-300 mb-3">{t.projectStatsFileSize}</p>
                  <SizeDistribution buckets={stats.fileSizeDistribution} />
                </div>
              )}

              {stats.largestFile && (
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] px-4 py-3">
                  <div className="text-xs font-semibold text-slate-200">{t.projectStatsLargestFile}</div>
                  <div className="mt-2 text-sm text-slate-300">
                    {stats.largestFile.path} · {stats.largestFile.lines.toLocaleString()} lines
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {stats.truncated ? truncatedLabel : ''}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
