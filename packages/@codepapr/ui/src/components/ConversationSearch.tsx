import { useState, useRef, useCallback, useMemo, useEffect, useDeferredValue, memo } from 'react';
import { createPortal } from 'react-dom';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import type { PreviewLocation } from '../utils/projectDiagnosticLocations';

const MAX_RESULTS = 50;
const CONTEXT_RADIUS = 25;

interface MsgResult { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; roundIndex: number; }
interface FileResult { path: string; line: number; preview: string; column?: number; }
type SearchTab = 'conversation' | 'files';
type MsgScope = 'all' | 'user' | 'assistant';
type FileMode = 'content' | 'filename';

function getCopy(lang: string) {
  switch (lang) {
    case 'en':
      return {
        placeholder: 'Search…', noResults: 'No matches', noMessages: 'No conversation',
        noWorkspace: 'Open a workspace first',
        resultsCount: (n: number) => `${n} ${n === 1 ? 'result' : 'results'}`,
        truncated: (shown: number, total: number) => `First ${shown} of ${total}. Refine.`,
        keyboardHint: '↑↓ nav  Enter go  Esc close', userLabel: 'You', aiLabel: 'AI',
        scopeAll: 'All', scopeUser: 'You', scopeAI: 'AI',
        tabConv: 'Chat', tabFiles: 'Files', modeContent: 'Content', modeFilename: 'Name',
        searching: 'Searching…',
      };
    case 'zh-TW':
      return {
        placeholder: '搜尋…', noResults: '無匹配結果', noMessages: '暫無對話',
        noWorkspace: '請先開啟工作區',
        resultsCount: (n: number) => `找到 ${n} 個结果`,
        truncated: (shown: number, total: number) => `僅顯示前 ${shown} 條（共 ${total} 條），請細化。`,
        keyboardHint: '↑↓ 選擇  Enter 跳轉  Esc 關閉', userLabel: '你', aiLabel: 'AI',
        scopeAll: '全部', scopeUser: '你', scopeAI: 'AI',
        tabConv: '對話', tabFiles: '文件', modeContent: '內容', modeFilename: '檔名',
        searching: '搜尋中…',
      };
    default:
      return {
        placeholder: '搜索…', noResults: '无匹配结果', noMessages: '暂无对话',
        noWorkspace: '请先打开工作区',
        resultsCount: (n: number) => `找到 ${n} 个结果`,
        truncated: (shown: number, total: number) => `仅显示前 ${shown} 条（共 ${total} 条），请细化。`,
        keyboardHint: '↑↓ 选择  Enter 跳转  Esc 关闭', userLabel: '你', aiLabel: 'AI',
        scopeAll: '全部', scopeUser: '你', scopeAI: 'AI',
        tabConv: '对话', tabFiles: '文件', modeContent: '内容', modeFilename: '文件名',
        searching: '搜索中…',
      };
  }
}

function searchMessages(query: string, scope: MsgScope): { results: MsgResult[]; total: number } {
  const { messages } = useAgentStore.getState();
  const items: MsgResult[] = [];
  const lower = query.toLowerCase();
  let roundIdx = 0, total = 0;
  for (const m of messages) {
    if (m.hidden || m.role === 'error') continue;
    if (scope !== 'all' && m.role !== scope) { if (m.role === 'user') roundIdx++; continue; }
    const text = m.promptContent ?? m.content;
    if (!text) { if (m.role === 'user') roundIdx++; continue; }
    if (text.toLowerCase().includes(lower)) {
      total++;
      if (items.length < MAX_RESULTS) {
        items.push({ id: m.id, role: m.role, content: text, timestamp: m.timestamp, roundIndex: m.role === 'user' ? roundIdx + 1 : roundIdx });
      }
    }
    if (m.role === 'user') roundIdx++;
  }
  return { results: items, total };
}

async function searchFileContent(query: string, workspacePath: string) {
  try {
    const raw = await invoke<{ query: string; matches: Array<{ path: string; line: number; preview: string; column?: number }>; truncated: boolean }>(
      'search_workspace_text', { workspacePath, query, caseSensitive: false, isRegexp: false, contextLines: 0, maxResults: MAX_RESULTS, maxMatchesPerFile: 3, maxBytesPerFile: 100_000 },
    );
    return { results: raw.matches.map((m) => ({ path: m.path, line: m.line, preview: m.preview, column: m.column })), total: raw.matches.length, truncated: raw.truncated };
  } catch { return { results: [] as FileResult[], total: 0, truncated: false }; }
}

async function searchFileNames(query: string, workspacePath: string) {
  try {
    const raw = await invoke<{ query: string; matches: Array<{ path: string; name: string; isDir: boolean; bytes: number }>; truncated: boolean }>(
      'search_workspace_paths', { workspacePath, query, caseSensitive: false, isRegexp: false, maxResults: MAX_RESULTS },
    );
    return { results: raw.matches.map((m) => ({ path: m.path, line: 1, preview: m.name, column: undefined })), total: raw.matches.length, truncated: raw.truncated };
  } catch { return { results: [] as FileResult[], total: 0, truncated: false }; }
}

function formatRelativeTime(ts: number, lang: string): string {
  const diff = Date.now() - ts;
  if (diff < 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return lang === 'en' ? 'just now' : lang === 'zh-TW' ? '剛剛' : '刚刚';
  if (mins < 60) return lang === 'en' ? `${mins}m ago` : lang === 'zh-TW' ? `${mins} 分鐘前` : `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return lang === 'en' ? `${hours}h ago` : lang === 'zh-TW' ? `${hours} 小時前` : `${hours} 小时前`;
  return new Date(ts).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' });
}

function getMsgSnippet(text: string, query: string) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) { const head = text.slice(0, 60).trim(); return { before: '', match: head, after: text.length > 60 ? '…' : '' }; }
  const bs = Math.max(0, idx - CONTEXT_RADIUS);
  return { before: (bs > 0 ? '…' : '') + text.slice(bs, idx), match: text.slice(idx, idx + query.length), after: text.slice(idx + query.length, idx + query.length + CONTEXT_RADIUS) + (idx + query.length + CONTEXT_RADIUS < text.length ? '…' : '') };
}

function renderFileSnippet(preview: string, query: string) {
  const idx = preview.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <span className="text-fg-muted">{preview.slice(0, 80)}</span>;
  const bs = Math.max(0, idx - CONTEXT_RADIUS);
  const ae = idx + query.length + CONTEXT_RADIUS;
  return (
    <span className="text-fg-muted">
      {bs > 0 ? '…' : ''}{preview.slice(bs, idx)}
      <span className="font-semibold text-warn bg-warn-bg rounded-sm px-0.5">{preview.slice(idx, idx + query.length)}</span>
      {preview.slice(idx + query.length, ae)}{ae < preview.length ? '…' : ''}
    </span>
  );
}

interface ConversationSearchProps { onNavigateToFile: (location: PreviewLocation) => void; }

export const ConversationSearch = memo(function ConversationSearch({ onNavigateToFile }: ConversationSearchProps) {
  const lang = useAgentStore((s) => (s.settings.lang ?? 'zh-CN'));
  const copy = getCopy(lang);
  const hasMessages = useAgentStore((s) => s.messages.length > 0);
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tab, setTab] = useState<SearchTab>('conversation');
  const [msgScope, setMsgScope] = useState<MsgScope>('all');
  const [fileMode, setFileMode] = useState<FileMode>('content');
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef<number>(0);

  const { results: msgResults, total: msgTotal } = useMemo(() => {
    const t = deferredQuery.trim();
    if (!t) return { results: [] as MsgResult[], total: 0 } as const;
    return searchMessages(t, msgScope);
    // N14：切换会话后 messages 换源——结果必须随 activeSessionId 失效重算。
    // 旧实现只依赖 query/scope，切换会话后残留旧会话结果，点击跳转到当前
    // 会话不存在的消息（DOM 找不到 + jump 请求落空）→ 无反应。
  }, [deferredQuery, msgScope, activeSessionId]);

  // file search only when files tab + 300ms debounce
  useEffect(() => {
    const trimmed = deferredQuery.trim();
    if (!trimmed || !workspacePath || tab !== 'files') {
      setFileResults([]); setFileTotal(0); setFileTruncated(false); setFileLoading(false);
      return;
    }
    setFileLoading(true);
    const seq = ++seqRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const res = fileMode === 'content' ? await searchFileContent(trimmed, workspacePath) : await searchFileNames(trimmed, workspacePath);
      if (seq !== seqRef.current) return;
      setFileResults(res.results); setFileTotal(res.total); setFileTruncated(res.truncated); setFileLoading(false);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [deferredQuery, fileMode, workspacePath, tab]);

  const results = tab === 'conversation' ? msgResults : fileResults;
  const totalCount = tab === 'conversation' ? msgTotal : fileTotal;
  const isTruncated = tab === 'conversation' ? msgTotal > MAX_RESULTS : fileTruncated;
  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;
  const showPanel = open && hasQuery;

  useEffect(() => { setSelectedIndex(0); }, [results.length, tab]);
  useEffect(() => {
    if (!showPanel) return;
    const h = (e: MouseEvent) => { if (inputRef.current?.contains(e.target as HTMLElement)) return; if (panelRef.current?.contains(e.target as HTMLElement)) return; setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showPanel]);
  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [selectedIndex]);

  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!showPanel) return;
    const upd = () => { const r = inputRef.current?.getBoundingClientRect(); if (!r) return; setPanelStyle({ position: 'fixed', top: r.bottom + 4, left: '50%', transform: 'translateX(-50%)', width: 440, zIndex: 9999 }); };
    upd();
    window.addEventListener('scroll', upd, true);
    window.addEventListener('resize', upd);
    return () => { window.removeEventListener('scroll', upd, true); window.removeEventListener('resize', upd); };
  }, [showPanel]);

  const scrollToMessage = useCallback((id: string) => {
    const c = document.querySelector('[data-chat-scroll="true"]');
    const el = c?.querySelector(`[data-message-id="${id}"]`);
    if (c && el) {
      c.scrollTo?.({ top: Math.max(0, (el as HTMLElement).offsetTop - 80), behavior: 'smooth' });
    } else {
      // Not rendered yet (chat history loads in batches) — ask the chat pane
      // to widen its window and scroll.
      useAgentStore.getState().requestChatScrollToMessage(id);
    }
    setOpen(false);
  }, []);
  const navigateToFile = useCallback((f: FileResult) => { onNavigateToFile({ path: f.path, line: f.line, column: f.column ?? 1 }); setOpen(false); }, [onNavigateToFile]);

  const handleFocus = useCallback(() => { if (query.trim()) setOpen(true); }, [query]);
  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value); setOpen(true); }, []);
  const handleClear = useCallback(() => { setQuery(''); inputRef.current?.focus(); setOpen(false); }, []);
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (!showPanel || !hasResults) { if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((p) => (p + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((p) => (p - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = results[selectedIndex]; if (!it) return; if (tab === 'conversation') scrollToMessage((it as MsgResult).id); else navigateToFile(it as FileResult); }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
  }, [showPanel, hasResults, results, selectedIndex, tab, scrollToMessage, navigateToFile]);

  const tabs: { key: SearchTab; label: string }[] = [{ key: 'conversation', label: copy.tabConv }, { key: 'files', label: copy.tabFiles }];
  const scopeOpts = [{ value: 'all' as MsgScope, label: copy.scopeAll }, { value: 'user' as MsgScope, label: copy.scopeUser }, { value: 'assistant' as MsgScope, label: copy.scopeAI }];
  const modeOpts = [{ value: 'content' as FileMode, label: copy.modeContent }, { value: 'filename' as FileMode, label: copy.modeFilename }];

  const panel = showPanel ? (
    <div ref={panelRef} className="search-panel" style={panelStyle}>
      <div className="search-panel-header">
        <span className="text-[11px] font-medium text-fg-muted">
          {tab === 'conversation' && !hasMessages ? copy.noMessages : tab === 'files' && !workspacePath ? copy.noWorkspace : hasResults ? copy.resultsCount(totalCount) : fileLoading ? copy.searching : copy.noResults}
        </span>
        {hasResults && <span className="text-[10px] text-fg-dim tabular-nums">{selectedIndex + 1}/{results.length}</span>}
      </div>
      <div className="flex items-center border-b border-[var(--border)]">
        {tabs.map((t) => <button key={t.key} type="button" onClick={() => { setTab(t.key); setSelectedIndex(0); }} className={`search-panel-tab ${tab === t.key ? 'active' : ''}`}>{t.label}</button>)}
      </div>
      {tab === 'conversation' && hasMessages && (
        <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
          {scopeOpts.map((o) => <button key={o.value} type="button" onClick={() => { setMsgScope(o.value); setSelectedIndex(0); }} className={`search-filter-btn ${msgScope === o.value ? 'active' : ''}`}>{o.label}</button>)}
        </div>
      )}
      {tab === 'files' && workspacePath && (
        <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
          {modeOpts.map((o) => <button key={o.value} type="button" onClick={() => { setFileMode(o.value); setSelectedIndex(0); }} className={`search-filter-btn ${fileMode === o.value ? 'active' : ''}`}>{o.label}</button>)}
        </div>
      )}
      {hasResults && (
        <>
          <div className="search-panel-list">
            {results.map((item: MsgResult | FileResult, idx: number) => {
              const isSel = idx === selectedIndex;
              if (tab === 'conversation') {
                const m = item as MsgResult; const isUser = m.role === 'user'; const ctx = getMsgSnippet(m.content, query);
                return (<button key={m.id} ref={isSel ? selectedRef : undefined} type="button" className={`search-panel-item ${isSel ? 'selected' : ''}`} onClick={() => scrollToMessage(m.id)} onMouseEnter={() => setSelectedIndex(idx)}>
                  <span className={`search-role-badge ${isUser ? 'user' : 'assistant'}`}>{isUser ? copy.userLabel : copy.aiLabel}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5"><span className="text-[10px] text-fg-muted font-mono tabular-nums">#{m.roundIndex}</span><span className="text-[10px] text-fg-dim">{formatRelativeTime(m.timestamp, lang)}</span></div>
                    <p className="text-[12px] leading-relaxed text-fg-muted line-clamp-1"><span className="text-fg-muted">{ctx.before}</span><span className="font-semibold text-warn bg-warn-bg rounded-sm px-0.5">{ctx.match}</span><span className="text-fg-muted">{ctx.after}</span></p>
                  </div>
                </button>);
              }
              const f = item as FileResult; const fn = f.path.split(/[\\/]/).pop() ?? f.path;
              return (<button key={`${f.path}:${f.line}:${idx}`} ref={isSel ? selectedRef : undefined} type="button" className={`search-panel-item ${isSel ? 'selected' : ''}`} onClick={() => navigateToFile(f)} onMouseEnter={() => setSelectedIndex(idx)}>
                <span className="search-role-badge file">📄</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5"><span className="text-[11px] text-fg-soft truncate font-mono">{fn}</span><span className="flex-shrink-0 text-[10px] text-fg-muted font-mono">:{f.line}</span></div>
                  <p className="text-[12px] leading-relaxed text-fg-muted line-clamp-1">{fileMode === 'filename' ? <span className="text-fg-muted">{f.path}</span> : renderFileSnippet(f.preview, query)}</p>
                </div>
              </button>);
            })}
          </div>
          {isTruncated && (<div className="border-t border-warn-bg bg-warn-bg px-3 py-2"><p className="text-[11px] leading-relaxed text-warn">{copy.truncated(MAX_RESULTS, totalCount)}</p></div>)}
        </>
      )}
      {(hasResults || tab === 'files' || (tab === 'conversation' && !hasMessages)) && (
        <div className="border-t border-[var(--border)] px-3 py-1.5"><span className="text-[10px] text-fg-dim">{copy.keyboardHint}</span></div>
      )}
    </div>
  ) : null;

  return (
    <div className="conversation-search relative flex items-center">
      <svg className="absolute left-2.5 h-3.5 w-3.5 text-fg-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
      <input ref={inputRef} type="text" value={query} onFocus={handleFocus} onChange={handleChange} onKeyDown={handleKeyDown} placeholder={copy.placeholder} className="h-[34px] w-[160px] rounded-lg border border-[var(--border)] bg-[var(--bg-base)] pl-8 pr-7 text-xs text-fg-soft placeholder-slate-600 outline-none transition-colors hover:border-accent-soft focus:border-accent-soft focus:bg-[var(--bg-deep)]" />
      {hasQuery && (<button type="button" onClick={handleClear} tabIndex={-1} className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-fg-muted transition-colors hover:text-fg-soft"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>)}
      {panel && createPortal(panel, document.body)}
    </div>
  );
});
