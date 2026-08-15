import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { ContextStage, IContextMessageView, IContextSnapshot } from '@codepapr/types';
import { getTranslation, type Lang } from '../utils/i18n';

interface ContextInspectorModalProps {
  snapshot: IContextSnapshot;
  lang?: Lang;
  onClose: () => void;
}

interface StageStyle {
  dot: string;
  border: string;
  bg: string;
  badge: string;
}

const STAGE_STYLES: Record<ContextStage, StageStyle> = {
  'stable-prefix': {
    dot: 'bg-accent',
    border: 'border-accent-soft',
    bg: 'bg-accent-soft',
    badge: 'bg-accent-soft text-accent-text',
  },
  'session-state': {
    dot: 'bg-warn',
    border: 'border-warn-bg',
    bg: 'bg-warn-bg',
    badge: 'bg-warn-bg text-warn',
  },
  conversation: {
    dot: 'bg-slate-400',
    border: 'border-slate-600/50',
    bg: 'bg-slate-700/10',
    badge: 'bg-slate-600/20 text-fg-soft',
  },
};

const STAGE_ORDER: ContextStage[] = ['stable-prefix', 'session-state', 'conversation'];

type RowCat = 'user' | 'model' | 'tool';

interface TimelineRow {
  key: string;
  cat: RowCat;
  role: IContextMessageView['role'] | 'tools';
  stage: ContextStage;
  content: string;
  tokens: number;
  reasoningTokens: number;
  reasoningContent?: string;
  toolName?: string;
  toolCallNames?: string[];
  timestamp?: number;
  durationMs?: number;
  offset: number;
}

/** 三类泳道的主题色（rgb 三元组来自 index.css 的 --gantt-* 变量） */
function catVar(cat: RowCat): string {
  return cat === 'user' ? '--gantt-user' : cat === 'model' ? '--gantt-body' : '--gantt-tool';
}

function catColor(cat: RowCat, alpha = 1): string {
  return alpha >= 1 ? `rgb(var(${catVar(cat)}))` : `rgba(var(${catVar(cat)}), ${alpha})`;
}

function segmentStyle(cat: RowCat): CSSProperties {
  return {
    background: `linear-gradient(90deg, ${catColor(cat, 0.78)}, ${catColor(cat, 0.42)})`,
  };
}

function thinkingSegmentStyle(): CSSProperties {
  return {
    background: `repeating-linear-gradient(135deg,
      rgba(var(--gantt-think), 0.66) 0px, rgba(var(--gantt-think), 0.66) 5px,
      rgba(var(--gantt-think), 0.3) 5px, rgba(var(--gantt-think), 0.3) 10px)`,
  };
}

function formatTokens(value: number): string {
  return `~${value.toLocaleString()}`;
}

function formatAxisTokens(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)}k`;
  return value.toLocaleString();
}

function formatClock(ts?: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function formatMs(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTimeSpan(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds >= 60) return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}

/** 真实时间戳判定：注入消息（session-bootstrap 等）用哨兵值 timestamp=1，
 *  若参与耗时域会把时间轴拉回 1970 年，必须排除。 */
function isRealTimestamp(ts?: number): ts is number {
  return typeof ts === 'number' && ts > 1_000_000_000_000;
}

export function ContextInspectorModal({ snapshot, lang, onClose }: ContextInspectorModalProps) {
  const t = getTranslation(lang);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [hiddenCats, setHiddenCats] = useState<Set<RowCat>>(new Set());
  const [tip, setTip] = useState<{ x: number; y: number; row: TimelineRow } | null>(null);
  const [axisMode, setAxisMode] = useState<'token' | 'time'>('token');

  const stageLabels: Record<ContextStage, string> = {
    'stable-prefix': t.stageStablePrefix,
    'session-state': t.stageSessionState,
    conversation: t.stageConversation,
  };

  const catMeta: Record<RowCat, { label: string; badge: string }> = {
    user: { label: t.ganttCatUser, badge: t.ganttCatUser },
    model: { label: t.ganttCatModel, badge: t.ganttCatModel },
    tool: { label: t.ganttCatTool, badge: t.ganttCatTool },
  };

  const fullText = useMemo(() => {
    const parts: string[] = [];
    if (snapshot.toolDefinitions && snapshot.toolDefinitions.length > 0) {
      parts.push(
        `[${stageLabels['stable-prefix']} · ${t.toolsEstimate}]\n` +
        snapshot.toolDefinitions.map((td) => `${td.name}: ${td.description}\n${JSON.stringify(td.parameters, null, 2)}`).join('\n\n')
      );
    } else if (snapshot.toolNames.length > 0) {
      parts.push(
        `[${stageLabels['stable-prefix']} · ${t.toolsEstimate}]\n${snapshot.toolNames.join(', ')}`
      );
    }
    for (const message of snapshot.messages) {
      const header = `[${stageLabels[message.stage]} · ${message.role}]`;
      parts.push(`${header}\n${message.content}`);
    }
    return parts.join('\n\n');
  }, [snapshot, stageLabels, t.toolsEstimate]);

  const rows = useMemo<TimelineRow[]>(() => {
    const built: TimelineRow[] = [];
    let offset = 0;
    if (snapshot.toolNames.length > 0 && snapshot.toolsTokenEstimate > 0) {
      built.push({
        key: 'tools',
        cat: 'user',
        role: 'tools',
        stage: 'stable-prefix',
        content: '',
        tokens: snapshot.toolsTokenEstimate,
        reasoningTokens: 0,
        offset,
      });
      offset += snapshot.toolsTokenEstimate;
    }
    for (let index = 0; index < snapshot.messages.length; index += 1) {
      const message = snapshot.messages[index];
      // 分类按 stage 权威判定：稳定前缀（system/工具/few-shot）与会话状态
      // （引导注入，role 是 assistant）都是「发送给模型的内容」，属于用户输入；
      // 对话历史里 UI 注入的 assistant（mode-switch/carry-forward）同样归用户
      // 输入；只有真正的模型生成才归模型输出。
      const cat: RowCat =
        message.stage === 'conversation'
          ? message.role === 'tool'
            ? 'tool'
            : message.role === 'assistant' && !message.uiInjected
              ? 'model'
              : 'user'
          : 'user';
      built.push({
        key: `msg-${index}`,
        cat,
        role: message.role,
        stage: message.stage,
        content: message.content,
        tokens: message.estimatedTokens,
        reasoningTokens: message.reasoningTokens ?? 0,
        reasoningContent: message.reasoningContent,
        toolName: message.toolName,
        toolCallNames: message.toolCallNames,
        timestamp: message.timestamp,
        durationMs: message.durationMs,
        offset,
      });
      offset += message.estimatedTokens + (message.reasoningTokens ?? 0);
    }
    return built;
  }, [snapshot]);

  const axisTotal = useMemo(() => {
    const last = rows[rows.length - 1];
    if (!last) return 0;
    return last.offset + last.tokens + last.reasoningTokens;
  }, [rows]);

  // 真实耗时域：以「带耗时测量」的消息为锚（assistant=生成耗时，tool=执行耗时），
  // 用户消息无耗时概念，作为时间点标记参与域扩展。没有任何耗时数据时不可用。
  const timeDomain = useMemo(() => {
    const timed = rows.filter(
      (row) => isRealTimestamp(row.timestamp) && typeof row.durationMs === 'number' && row.durationMs > 0
    );
    if (timed.length === 0) return null;
    let minStart = Infinity;
    let maxEnd = 0;
    for (const row of rows) {
      if (!isRealTimestamp(row.timestamp)) continue;
      const start = typeof row.durationMs === 'number' && row.durationMs > 0 ? row.timestamp - row.durationMs : row.timestamp;
      if (start < minStart) minStart = start;
      if (row.timestamp > maxEnd) maxEnd = row.timestamp;
    }
    const span = maxEnd - minStart;
    if (span <= 0) return null;
    return { minStart, span };
  }, [rows]);

  const effectiveMode: 'token' | 'time' = axisMode === 'time' && timeDomain ? 'time' : 'token';

  const barTokens = (row: TimelineRow): number => row.tokens + row.reasoningTokens;

  const toggleKey = (key: string, scroll: boolean): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (scroll) {
      const el = document.getElementById(`gantt-detail-${key}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const setAll = (expand: boolean): void => {
    setExpandedKeys(expand ? new Set(rows.map((row) => row.key)) : new Set());
  };

  const showBarTip = (e: MouseEvent, row: TimelineRow): void => {
    const x = Math.min(e.clientX + 14, window.innerWidth - 380);
    const y = Math.min(e.clientY + 16, window.innerHeight - 140);
    setTip((prev) => (prev && prev.row === row && Math.abs(prev.x - x) < 4 && Math.abs(prev.y - y) < 4 ? prev : { x, y, row }));
  };

  const barFor = (row: TimelineRow): ReactNode => {
    const hasThinking = row.cat === 'model' && row.reasoningTokens > 0;

    let left: number;
    let width: number;
    let isMarker = false;
    if (effectiveMode === 'time' && timeDomain) {
      if (typeof row.durationMs === 'number' && row.durationMs > 0 && isRealTimestamp(row.timestamp)) {
        left = ((row.timestamp - row.durationMs - timeDomain.minStart) / timeDomain.span) * 100;
        width = Math.max((row.durationMs / timeDomain.span) * 100, 0.2);
      } else if (isRealTimestamp(row.timestamp)) {
        // 无耗时概念的行（用户输入/工具定义）在耗时轴上渲染为时间点标记
        left = ((row.timestamp - timeDomain.minStart) / timeDomain.span) * 100;
        width = 0.2;
        isMarker = true;
      } else {
        return null;
      }
    } else {
      left = axisTotal > 0 ? (row.offset / axisTotal) * 100 : 0;
      width = axisTotal > 0 ? Math.max((barTokens(row) / axisTotal) * 100, 0.15) : 0;
    }

    return (
      <div
        key={row.key}
        role="button"
        tabIndex={0}
        onClick={() => toggleKey(row.key, true)}
        onMouseMove={(e) => showBarTip(e, row)}
        onMouseLeave={() => setTip(null)}
        className={`absolute top-[3px] bottom-[3px] cursor-pointer overflow-hidden border transition-[filter,box-shadow] hover:brightness-125 hover:shadow-[0_0_10px_rgba(255,255,255,0.16)] ${isMarker ? 'rounded-full' : 'rounded-md'}`}
        style={{
          left: `${left}%`,
          width: `${width}%`,
          minWidth: 3,
          borderColor: catColor(row.cat, 0.85),
          zIndex: 10,
        }}
      >
        {isMarker ? (
          <div className="absolute inset-0" style={segmentStyle(row.cat)} />
        ) : hasThinking ? (
          <>
            <div
              className="absolute inset-y-0 left-0 flex items-center overflow-hidden border-r border-white/25 px-1.5"
              style={{ ...thinkingSegmentStyle(), width: `${(row.reasoningTokens / barTokens(row)) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 flex items-center overflow-hidden px-1.5"
              style={{ ...segmentStyle('model'), left: `${(row.reasoningTokens / barTokens(row)) * 100}%` }}
            />
          </>
        ) : (
          <div className="absolute inset-0 flex items-center overflow-hidden px-1.5" style={segmentStyle(row.cat)} />
        )}
      </div>
    );
  };

  const detailRows = rows.map((row) => {
    const meta = catMeta[row.cat];
    const style = STAGE_STYLES[row.stage];
    const expanded = expandedKeys.has(row.key);
    const hidden = hiddenCats.has(row.cat);
    const isToolsRow = row.role === 'tools';

    const header = (
      <button
        type="button"
        onClick={() => toggleKey(row.key, false)}
        className="flex min-h-[36px] w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <span className={`w-3.5 flex-shrink-0 text-[10px] text-fg-dim transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span
          className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ background: catColor(row.cat, 0.15), color: catColor(row.cat) }}
        >
          {meta.badge}
        </span>
        <span className="flex-shrink-0 font-mono text-[11px] text-fg-muted">
          {isToolsRow ? t.toolsEstimate : row.role}
          {row.toolName ? ` · ${row.toolName}` : ''}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
          {isToolsRow ? snapshot.toolNames.join(', ') : row.toolCallNames && row.toolCallNames.length > 0 ? `工具: ${row.toolCallNames.join(', ')}` : ''}
        </span>
        <span className="flex-shrink-0 font-mono text-[10px] text-fg-dim">
          {row.reasoningTokens > 0
            ? `${(row.tokens + row.reasoningTokens).toLocaleString()} tok (${row.reasoningTokens.toLocaleString()}${t.ganttThinking}+${row.tokens.toLocaleString()}${t.ganttResponse})`
            : formatTokens(row.tokens)}
        </span>
      </button>
    );

    const body = (
      <div className="px-3 pb-2.5 pl-9">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-fg-dim">
          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${style.badge}`}>
            {stageLabels[row.stage]}
          </span>
          {isRealTimestamp(row.timestamp) ? (
            <span>{t.ganttAt} {formatClock(row.timestamp)}</span>
          ) : null}
          {row.durationMs ? (
            <span>{t.ganttDuration} {formatMs(row.durationMs)}</span>
          ) : null}
          <span>
            {formatTokens(row.tokens)} {row.reasoningTokens > 0 ? `+ ${formatTokens(row.reasoningTokens)} ${t.ganttThinking}` : ''}
          </span>
        </div>
        {isToolsRow ? (
          <div className="overflow-hidden rounded-lg border border-line bg-base">
            <div className="divide-y divide-white/5">
              {(snapshot.toolDefinitions ?? snapshot.toolNames.map((n) => ({ name: n, description: '', parameters: null }))).map((td) => {
                const toolExpanded = expandedTools.has(td.name);
                return (
                  <div key={td.name}>
                    <button
                      type="button"
                      onClick={() => setExpandedTools((prev) => {
                        const next = new Set(prev);
                        if (next.has(td.name)) next.delete(td.name); else next.add(td.name);
                        return next;
                      })}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <span className={`text-[10px] text-fg-dim transition-transform ${toolExpanded ? 'rotate-90' : ''}`}>▶</span>
                      <span className="font-mono text-xs font-medium text-accent-text">{td.name}</span>
                      {td.description && (
                        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">{td.description}</span>
                      )}
                    </button>
                    {toolExpanded && td.parameters != null && (
                      <pre className="whitespace-pre-wrap break-words bg-overlay px-4 py-2 text-[10px] leading-relaxed text-fg-muted">
                        {JSON.stringify(td.parameters, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {row.reasoningContent ? (
              <>
                <p className="mb-1 text-[10px] font-semibold tracking-wide" style={{ color: 'rgb(var(--gantt-think))' }}>
                  {t.ganttThinking}
                </p>
                <pre
                  className="mb-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-dashed p-2.5 text-[11px] leading-relaxed scrollbar-thin"
                  style={{ borderColor: 'rgba(var(--gantt-think), 0.4)', background: 'rgba(var(--gantt-think), 0.06)', color: 'rgb(var(--gantt-think))' }}
                >
                  {row.reasoningContent}
                </pre>
              </>
            ) : null}
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-base p-2.5 text-xs leading-relaxed text-fg-soft scrollbar-thin">
              {row.content || ' '}
            </pre>
          </>
        )}
      </div>
    );

    return (
      <div
        key={row.key}
        id={`gantt-detail-${row.key}`}
        className={`overflow-hidden rounded-xl border border-line bg-base transition-opacity ${hidden ? 'opacity-35' : ''}`}
        style={{ borderLeft: `3px solid ${catColor(row.cat, 0.9)}` }}
      >
        {header}
        {expanded ? body : null}
      </div>
    );
  });

  const axisTicks = useMemo(() => {
    const points = [0, 20, 40, 60, 80, 100];
    if (effectiveMode === 'time' && timeDomain) {
      return points.map((p) => ({ p, label: formatTimeSpan((timeDomain.span * p) / 100) }));
    }
    return points.map((p) => ({ p, label: formatAxisTokens((axisTotal * p) / 100) }));
  }, [axisTotal, effectiveMode, timeDomain]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 backdrop-blur-sm md:p-4">
      <div className="flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-fg">{t.contextInspectorTitle}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{t.contextInspectorTip}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(fullText)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-accent hover:text-fg"
            >
              {t.copy}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
              title={t.cancel}
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-raised px-5 py-2.5">
          <span className="text-xs font-semibold text-fg">
            {t.currentContextLength}{' '}
            <span className="font-mono text-accent-text">
              {formatTokens(snapshot.totalTokens)} {t.tokensUnit}
            </span>
          </span>
          {STAGE_ORDER.map((stage) => (
            <span key={stage} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span className={`inline-block h-2 w-2 rounded-full ${STAGE_STYLES[stage].dot}`} />
              {stageLabels[stage]}
              <span className="font-mono text-fg-muted">
                {formatTokens(snapshot.tokensByStage[stage])}
              </span>
            </span>
          ))}
          <span className="ml-auto text-[11px] text-fg-dim">
            {t.roundsLabel} {snapshot.round} · {snapshot.model}
          </span>
        </div>

        {/* ── 甘特图 ── */}
        <div className="border-b border-line bg-raised px-5 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-accent-text">{t.ganttTimeline}</p>
            <span className="flex rounded-md border border-line p-0.5">
              <button
                type="button"
                onClick={() => setAxisMode('token')}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  effectiveMode === 'token'
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-fg-muted hover:text-fg-soft'
                }`}
              >
                {t.ganttAxisToken}
              </button>
              <button
                type="button"
                onClick={() => setAxisMode('time')}
                disabled={!timeDomain}
                title={timeDomain ? undefined : t.ganttTimeUnavailableTip}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  effectiveMode === 'time'
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-fg-muted hover:text-fg-soft'
                }`}
              >
                {t.ganttAxisTime}
              </button>
            </span>
            <span className="text-[10px] text-fg-dim">{t.ganttTimelineHint}</span>
            <span className="ml-auto flex items-center gap-2">
              {(['user', 'model', 'tool'] as RowCat[]).map((cat) => {
                const off = hiddenCats.has(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setHiddenCats((prev) => {
                      const next = new Set(prev);
                      if (next.has(cat)) next.delete(cat); else next.add(cat);
                      return next;
                    })}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-opacity ${off ? 'opacity-40' : ''}`}
                    style={{
                      color: catColor(cat),
                      borderColor: catColor(cat, 0.4),
                      background: catColor(cat, 0.12),
                    }}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-sm"
                      style={cat === 'model' ? { background: 'linear-gradient(90deg, rgb(var(--gantt-think)) 50%, rgb(var(--gantt-body)) 50%)' } : { background: catColor(cat) }}
                    />
                    {catMeta[cat].label}
                    {cat === 'model' ? ` (${t.ganttThinking}+${t.ganttResponse})` : ''}
                  </button>
                );
              })}
            </span>
          </div>
          <p className="mb-2 text-[10px] text-fg-dim">{t.ganttLegendHint}</p>

          <div className="overflow-x-auto scrollbar-thin">
            <div className="relative min-w-[720px]">
              {/* 横轴 */}
              <div className="flex h-[22px] items-stretch">
                <div className="sticky left-0 z-20 w-[200px] flex-shrink-0 bg-raised" />
                <div className="relative flex-1 border-l border-line">
                  {axisTicks.map((tick) => (
                    <span
                      key={tick.p}
                      className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-fg-dim"
                      style={{ left: `${tick.p}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* 三条泳道 */}
              {(['user', 'model', 'tool'] as RowCat[]).map((cat) => {
                if (hiddenCats.has(cat)) return null;
                const meta = catMeta[cat];
                return (
                  <div key={cat} className="flex h-[30px] items-stretch">
                    <div className="sticky left-0 z-20 flex w-[200px] flex-shrink-0 items-center gap-1.5 bg-raised pr-3 shadow-[6px_0_8px_-8px_rgba(0,0,0,0.6)]">
                      <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: catColor(cat) }} />
                      <span className="truncate text-[11px] text-fg-muted">{meta.label}</span>
                    </div>
                    <div className="relative flex-1">
                      {rows.filter((row) => row.cat === cat).map((row) => barFor(row))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── 明细列表 ── */}
        <div className="flex min-h-0 flex-1 flex-col bg-base">
          <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
            <p className="text-xs font-semibold text-fg-soft">{t.ganttDetails}</p>
            <span className="text-[10px] text-fg-dim">{t.ganttDetailsHint}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setAll(true)}
                className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
              >
                {t.ganttExpandAll}
              </button>
              <button
                type="button"
                onClick={() => setAll(false)}
                className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
              >
                {t.ganttCollapseAll}
              </button>
            </span>
          </div>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable bg-base p-4">
            {rows.length === 0 ? (
              <p className="py-10 text-center text-xs text-fg-muted">{t.contextInspectorEmpty}</p>
            ) : (
              detailRows
            )}
          </div>
        </div>
      </div>

      {/* 甘特条悬停提示 */}
      {tip && (() => {
        const meta = catMeta[tip.row.cat];
        const stage = stageLabels[tip.row.stage];
        return (
          <div
            className="pointer-events-none fixed z-[60] max-w-[360px] rounded-lg border border-line bg-base px-3 py-2 text-[11px] leading-relaxed text-fg shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            style={{ left: tip.x, top: tip.y }}
          >
            <p className="font-semibold" style={{ color: catColor(tip.row.cat) }}>
              {meta.label} · {tip.row.role === 'tools' ? t.toolsEstimate : `${tip.row.role}${tip.row.toolName ? ` · ${tip.row.toolName}` : ''}`}
            </p>
            <p className="font-mono text-fg-muted">
              {stage} · {formatTokens(tip.row.tokens)}
              {tip.row.reasoningTokens > 0 ? ` + ${formatTokens(tip.row.reasoningTokens)} ${t.ganttThinking}` : ''}
              {tip.row.durationMs ? ` · ${t.ganttDuration} ${formatMs(tip.row.durationMs)}` : ''}
            </p>
            {isRealTimestamp(tip.row.timestamp) ? (
              <p className="font-mono text-fg-dim">{t.ganttAt} {formatClock(tip.row.timestamp)}</p>
            ) : null}
          </div>
        );
      })()}
    </div>
  );
}
