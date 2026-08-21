import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceProjectGraphResult } from '@codepapr/core';
import { useAgentStore } from '../../store/agentStore';
import type { ProjectGraphKnowledgeGraphHandle } from '../ProjectGraphKnowledgeGraph';
import { FieldCard } from '../forms';
import type { Lang } from '../../utils/i18n';
import type { Translation } from './types';

const ProjectGraphKnowledgeGraph = lazy(() => import('../ProjectGraphKnowledgeGraph'));

function isGraphDarkTheme(): boolean {
  return (
    document.documentElement.dataset.mode === 'dark' ||
    document.documentElement.classList.contains('dark')
  );
}

function parseCachedGraph(raw: string | null): WorkspaceProjectGraphResult | null {
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as { projectGraph?: WorkspaceProjectGraphResult };
    return cached.projectGraph ?? null;
  } catch {
    return null;
  }
}

export function SettingsKnowledgeGraph({ t, lang }: { t: Translation; lang: Lang }) {
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const setShowSettings = useAgentStore((s) => s.setShowSettings);
  const requestSelectWorkspaceFile = useAgentStore((s) => s.requestSelectWorkspaceFile);
  const [projectGraph, setProjectGraph] = useState<WorkspaceProjectGraphResult | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [graphSearchQuery, setGraphSearchQuery] = useState('');
  const [graphViewModes, setGraphViewModes] = useState<Set<string>>(
    () => new Set(['deps', 'hierarchy', 'calls']),
  );
  const [graphFocus, setGraphFocus] = useState<{ centerId: string; depth: number; label: string } | null>(null);
  const knowledgeGraphRef = useRef<ProjectGraphKnowledgeGraphHandle>(null);

  const loadGraph = useCallback(async () => {
    if (!workspacePath.trim()) {
      setProjectGraph(null);
      return;
    }
    try {
      const cachedRaw = await invoke<string | null>('load_projectgraph_cache', { workspacePath });
      setProjectGraph(parseCachedGraph(cachedRaw));
    } catch {
      setProjectGraph(null);
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    setGraphFocus(null);
  }, [projectGraph]);

  const closeGraph = () => {
    setShowGraph(false);
    setGraphFocus(null);
  };

  const toggleGraphViewMode = (mode: string) => {
    setGraphViewModes((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        if (next.size > 1) next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  };

  const hasWorkspace = Boolean(workspacePath.trim());
  const canOpen = Boolean(projectGraph);

  return (
    <>
      <FieldCard>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">{t.workspaceProjectGraphKnowledgeGraph}</h3>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-soft">
              {t.workspaceProjectGraphKnowledgeGraphTip}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
              {!hasWorkspace
                ? t.settingsLspGraphNeedWorkspace
                : canOpen
                  ? t.settingsLspGraphReady
                  : t.settingsLspGraphEmpty}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!canOpen) {
                void loadGraph();
                return;
              }
              setShowGraph(true);
            }}
            disabled={!canOpen}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-accent-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.settingsLspGraphOpen}
          </button>
        </div>
      </FieldCard>

      {showGraph && projectGraph && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-3 backdrop-blur-sm"
          onClick={closeGraph}
        >
          <div
            className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold text-fg">{t.workspaceProjectGraphKnowledgeGraph}</h2>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={graphSearchQuery}
                  onChange={(event) => setGraphSearchQuery(event.target.value)}
                  placeholder={t.settingsLspGraphSearch}
                  className="w-32 rounded-md border border-line bg-base px-2 py-1 text-[10px] text-fg-soft outline-none transition-colors focus:border-accent-soft placeholder:text-fg-dim"
                />
                <button
                  type="button"
                  onClick={() => knowledgeGraphRef.current?.zoomIn()}
                  title="Zoom In"
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => knowledgeGraphRef.current?.zoomOut()}
                  title="Zoom Out"
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                >
                  &minus;
                </button>
                <button
                  type="button"
                  onClick={() => knowledgeGraphRef.current?.fitView()}
                  title={t.expand}
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                >
                  &#x26F6;
                </button>
                <button
                  type="button"
                  onClick={closeGraph}
                  className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
                >
                  &times;
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3 border-b border-line px-5 py-1.5">
              <span className="text-[10px] text-fg-muted">{t.settingsLspGraphShow}:</span>
              {([
                ['deps', t.settingsLspGraphModeDeps],
                ['hierarchy', t.settingsLspGraphModeHierarchy],
                ['calls', t.settingsLspGraphModeCalls],
              ] as const).map(([mode, label]) => (
                <label key={mode} className="flex cursor-pointer items-center gap-1 text-[10px] text-fg-muted">
                  <input
                    type="checkbox"
                    checked={graphViewModes.has(mode)}
                    onChange={() => toggleGraphViewMode(mode)}
                    className="h-3 w-3"
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {graphFocus && (
                <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[10px]">
                  <span className="shrink-0 text-fg-muted">{t.graphFocusLabel}:</span>
                  <span className="min-w-0 truncate font-medium text-ok" title={graphFocus.label}>
                    {graphFocus.label}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {[1, 2].map((depth) => (
                      <button
                        key={depth}
                        type="button"
                        onClick={() => setGraphFocus({ ...graphFocus, depth })}
                        className={`rounded border px-1.5 py-0.5 transition-colors ${
                          graphFocus.depth === depth
                            ? 'border-ok-bg bg-ok-bg text-ok'
                            : 'border-line text-fg-muted hover:text-fg-soft'
                        }`}
                      >
                        {depth} {t.graphFocusHop}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setGraphFocus(null)}
                      className="rounded border border-line px-1.5 py-0.5 text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
                    >
                      {t.graphFocusBack}
                    </button>
                  </div>
                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col p-2" style={{ minHeight: '400px' }}>
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-xs text-fg-muted">
                      {t.workspaceInsightsLoading}
                    </div>
                  }
                >
                  <ProjectGraphKnowledgeGraph
                  ref={knowledgeGraphRef}
                  projectGraph={projectGraph}
                  dark={isGraphDarkTheme()}
                  viewModes={graphViewModes}
                  searchQuery={graphSearchQuery}
                  lang={lang}
                  focus={graphFocus}
                  onRequestFocus={(nodeId) => {
                    const node = projectGraph.nodes.find((item) => item.id === nodeId);
                    setGraphFocus({ centerId: nodeId, depth: 1, label: node?.path ?? nodeId });
                  }}
                  onNodeClick={(filePath) => {
                    closeGraph();
                    setShowSettings(false);
                    requestSelectWorkspaceFile(filePath);
                  }}
                  />
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
