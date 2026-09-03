import { lazy, Suspense } from 'react';
import { SplitPane } from './components/SplitPane';
import { ChatPanel } from './components/ChatPanel';
import { CodingWorkbench } from './components/CodingWorkbench';
import { AgentOpsPanel } from './components/AgentOpsPanel';
import { setPluginDockSlot } from './papr/pluginDockSlot';
import type { AppMainProps } from './appMainProps';

const CodePreviewPanel = lazy(() =>
  import('./components/CodePreviewPanel').then((m) => ({ default: m.CodePreviewPanel }))
);

export function AppMainRight(p: AppMainProps) {
  const {
    workspacePath, settings, t, selectedPath, selectedGitFile, handleSelectPath,
    setShowProjectSwitcher, setShowProjectConfig, projectGraphLoading,
    workbenchHidden, dockedPluginId, setShowSettings, setShowCharacters, setShowStats,
    setShowAbout, handleNavigateToLocation, activeMainTab, selectedFileName,
    handleCloseCodeTab, selectedDiagnosticLocation, setActiveMainTab, setWorkbenchHidden,
    browserEngine, openBrowserPanel,
  } = p;
  return (
          <div className="h-full min-h-0">
            <SplitPane
              direction="horizontal"
              defaultRatio={0.68}
              minFirstSize={380}
              minSecondSize={280}
              hideSeparator={workbenchHidden && !dockedPluginId}
              className="h-full"
              firstPaneClassName="min-w-0 bg-base"
              secondPaneClassName="bg-base"
              first={
                <div className="flex h-full min-w-0 flex-col overflow-hidden font-sans">
                    <AgentOpsPanel
                      onOpenSettings={() => setShowSettings(true)}
                      onOpenCharacters={() => setShowCharacters(true)}
                      onOpenStats={() => setShowStats(true)}
                      onOpenAbout={() => setShowAbout(true)}
                      onNavigateToFile={handleNavigateToLocation}
                    />
                  <div className="border-b border-line bg-base px-3 py-2">
                    <div className="flex items-center gap-2 overflow-x-auto">
                      <button
                        type="button"
                        onClick={() => setActiveMainTab('chat')}
                        title={t.sessionTabTip}
                        className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          activeMainTab === 'chat'
                            ? 'border-accent-soft bg-accent-soft text-accent-text'
                            : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
                        }`}
                      >
                        {t.session}
                      </button>
                      {selectedFileName && (
                        <div
                          className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1 ${
                            activeMainTab === 'code'
                              ? 'border-accent-soft bg-accent-soft'
                              : 'border-line bg-base'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveMainTab('code')}
                            title={t.codePreviewTabTip}
                            className={`min-w-0 truncate text-left text-xs font-medium transition-colors ${
                              activeMainTab === 'code'
                                ? 'text-accent-text'
                                : 'text-fg-muted hover:text-fg'
                            }`}
                          >
                            {selectedFileName}
                          </button>
                          <button
                            type="button"
                            onClick={handleCloseCodeTab}
                            className="flex-shrink-0 text-sm leading-none text-fg-muted transition-colors hover:text-fg"
                            title={t.closeCodeTabTip}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
                    {activeMainTab === 'code' && selectedPath ? (
                      <Suspense fallback={null}>
                        <CodePreviewPanel
                          workspacePath={workspacePath}
                          selectedPath={selectedPath}
                          selectedGitFile={selectedGitFile}
                          selectedLocation={selectedDiagnosticLocation}
                          onNavigateToLocation={handleNavigateToLocation}
                          lang={settings.lang}
                        />
                      </Suspense>
                    ) : (
                      <ChatPanel
                        onOpenWorkspacePath={handleSelectPath}
                        onOpenProjectSwitcher={() => setShowProjectSwitcher(true)}
                        onOpenProjectConfig={() => setShowProjectConfig(true)}
                        deferMessages={projectGraphLoading && !!workspacePath}
                      />
                    )}
                  </div>
                </div>
              }
              second={
                <div className="flex h-full min-h-0 flex-col">
                  {dockedPluginId ? (
                    <div
                      ref={setPluginDockSlot}
                      data-plugin-dock-slot={dockedPluginId}
                      className="min-h-0 flex-1"
                    />
                  ) : workbenchHidden ? (
                    <div className="flex h-full items-start border-l border-line px-1 pt-3">
                      <button
                        type="button"
                        onClick={() => setWorkbenchHidden(false)}
                        title={t.expandWorkbenchTip}
                        aria-label={t.expandWorkbenchTip}
                        className="flex-shrink-0 rounded-lg border border-line p-1.5 text-fg-muted transition-colors hover:border-accent hover:text-fg"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                   <div className="flex items-center justify-end gap-2 border-b border-line px-4 min-h-[60px]">
                    <div className="flex items-center gap-2">
                      {browserEngine === 'embedded' && workspacePath && (
                        <button
                          type="button"
                          onClick={() => openBrowserPanel()}
                          title={t.embeddedBrowserToolbarTip}
                          className="flex-shrink-0 rounded-lg border border-ok-bg px-2.5 py-2 text-xs font-medium text-ok transition-colors hover:border-ok hover:text-fg"
                        >
                          {t.embeddedBrowserTab}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setWorkbenchHidden(true)}
                        title={t.collapseWorkbenchTip}
                        aria-label={t.collapseWorkbenchTip}
                        className="flex-shrink-0 rounded-lg border border-line p-1.5 text-fg-muted transition-colors hover:border-accent hover:text-fg"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  )}
                  <div className={workbenchHidden || dockedPluginId ? 'hidden' : 'min-h-0 flex-1'}>
                    <CodingWorkbench
                      hideWorkspaceHeader
                      hideProjectSummary
                      previewPlacement="hidden"
                      selectedPath={selectedPath}
                      selectedGitFile={selectedGitFile}
                      selectedLocation={selectedDiagnosticLocation}
                      onSelectPath={handleSelectPath}
                      onNavigateToLocation={handleNavigateToLocation}
                    />
                  </div>
                </div>
              }
            />
          </div>
  );
}
