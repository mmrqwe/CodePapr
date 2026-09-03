import { AppOverlays } from './AppOverlays';
import { SplitPane } from './components/SplitPane';
import { AppMainLeft } from './AppMainLeft';
import { AppMainRight } from './AppMainRight';
import type { AppMainProps } from './appMainProps';

export function AppMainView(p: AppMainProps) {
  const { projectGraphLoading, projectGraphPhase, workspacePath, t, openedAppId } = p;
  return (
    <>
      {projectGraphLoading && workspacePath && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-deep/85 backdrop-blur-md">
          <div className="w-[min(92vw,520px)] rounded-3xl border border-[var(--border-strong)] bg-base/95 px-8 py-10 text-center shadow-2xl">
            <div className="loading-spinner mx-auto mb-5 h-12 w-12 animate-spin rounded-full border-2" />
            <h2 className="text-base font-semibold text-fg">
              {projectGraphPhase ? t.workspaceInsightsLoading : t.workspaceInitLoading}
            </h2>
            <p className="mt-1.5 text-xs text-fg-muted">
              {projectGraphPhase
                ? {
                    'reading-files': 'Reading project files',
                    'resolving-symbols': 'Resolving symbols via LSP',
                    'building': 'Building semantic graph',
                    'enriching': 'Enriching graph metadata',
                    'init-git': 'Initializing git tracking',
                    'prewarming-lsp': 'Warming up LSP servers…',
                  }[projectGraphPhase.phase] ?? 'Loading…'
                : 'Please wait, scanning workspace…'}
            </p>
            {projectGraphPhase && projectGraphPhase.total > 0 && (
              <div className="mt-5">
                <div className="mx-auto h-1.5 w-64 overflow-hidden rounded-full bg-raised">
                  <div className="status-indicator-bar h-full rounded-full bg-accent-soft" />
                </div>
                <p className="mt-2 text-[10px] tabular-nums text-fg-dim">
                  {projectGraphPhase.current} / {projectGraphPhase.total}
                </p>
              </div>
            )}
            {!projectGraphPhase && (
              <div className="mt-5">
                <div className="mx-auto h-1.5 w-64 overflow-hidden rounded-full bg-raised">
                  <div className="status-indicator-bar h-full rounded-full bg-accent-soft" />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={`h-screen w-screen overflow-hidden bg-base ${openedAppId ? 'invisible' : ''}`}>
      <SplitPane
        direction="horizontal"
        defaultRatio={0.18}
        minFirstSize={200}
        minSecondSize={650}
        className="h-screen w-screen overflow-hidden bg-base select-none"
        firstPaneClassName="bg-base"
        secondPaneClassName="bg-base"
        first={<AppMainLeft {...p} />}
        second={<AppMainRight {...p} />}
      />
      </div>
      <AppOverlays
        workspacePath={p.workspacePath}
        settings={p.settings}
        openedAppId={p.openedAppId}
        showSettings={p.showSettings}
        showCharacters={p.showCharacters}
        showAbout={p.showAbout}
        setShowAbout={p.setShowAbout}
        showProjectSwitcher={p.showProjectSwitcher}
        setShowProjectSwitcher={p.setShowProjectSwitcher}
        showStats={p.showStats}
        setShowStats={p.setShowStats}
        showProjectConfig={p.showProjectConfig}
        setShowProjectConfig={p.setShowProjectConfig}
        setShowSkillMarket={p.setShowSkillMarket}
        showSkillMarket={p.showSkillMarket}
        showCodeReview={p.showCodeReview}
        setShowCodeReview={p.setShowCodeReview}
        settingsLoaded={p.settingsLoaded}
        onboardingDismissed={p.onboardingDismissed}
        setOnboardingDismissed={p.setOnboardingDismissed}
        setShowSettings={p.setShowSettings}
        setShowCharacters={p.setShowCharacters}
        nativeLayerBlocked={p.nativeLayerBlocked}
        activePreviewSession={p.activePreviewSession}
        browserPanelOpen={p.browserPanelOpen}
        browserEngine={p.browserEngine}
      />
    </>
  );
}
