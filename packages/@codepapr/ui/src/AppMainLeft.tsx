import { SplitPane } from './components/SplitPane';
import { SessionManager } from './components/SessionManager';
import { BackgroundProcessPanel } from './components/BackgroundProcessPanel';
import { WorkspaceGitPanel } from './components/WorkspaceGitPanel';
import type { AppMainProps } from './appMainProps';

export function AppMainLeft(p: AppMainProps) {
  const {
    workspacePath, settings, isGitPanelExpanded, selectedPath, selectedGitFile,
    handleSelectPath, setSelectedPath, setSelectedDiagnosticLocation, setSelectedGitFile,
    setActiveMainTab, setShowCodeReview, setIsGitPanelExpanded,
  } = p;
  return (
          <div className="flex h-full min-h-0 flex-col border-r border-line bg-base">
            <SplitPane
              direction="vertical"
              defaultRatio={isGitPanelExpanded ? 0.42 : 0.72}
              minFirstSize={120}
              minSecondSize={isGitPanelExpanded ? 300 : 160}
              className="h-full"
              firstPaneClassName="min-h-0 bg-base"
              secondPaneClassName="flex flex-col min-h-0 bg-base"
              first={
                <div className="h-full min-h-0">
                  <SessionManager />
                </div>
              }
              second={
                <div className="flex-1 min-h-0 flex flex-col border-t border-line">
                  <SplitPane
                    direction="vertical"
                    defaultRatio={0.45}
                    minFirstSize={120}
                    minSecondSize={isGitPanelExpanded ? 120 : 0}
                    hideSeparator={!isGitPanelExpanded}
                    className="flex-1 min-h-0"
                    firstPaneClassName="min-h-0 bg-base"
                    secondPaneClassName="flex flex-col min-h-0 bg-base"
                    first={
                      <div className="h-full min-h-0">
                        <BackgroundProcessPanel workspacePath={workspacePath} lang={settings.lang} />
                      </div>
                    }
                    second={
                      <div className={isGitPanelExpanded ? 'grid flex-1 min-h-0' : 'shrink-0'}>
                        <WorkspaceGitPanel
                          workspacePath={workspacePath}
                          lang={settings.lang}
                          selectedPath={selectedPath}
                          selectedGitFile={selectedGitFile}
                          onSelectPath={handleSelectPath}
                          onSelectGitFile={(file) => {
                            setSelectedPath(file?.path ?? null);
                            setSelectedDiagnosticLocation(null);
                            setSelectedGitFile(file);
                            setActiveMainTab(file ? 'code' : 'chat');
                          }}
                          onOpenCommitReview={(scope) => setShowCodeReview(scope)}
                          isExpanded={isGitPanelExpanded}
                          onExpandedChange={setIsGitPanelExpanded}
                        />
                      </div>
                    }
                  />
                </div>
              }
            />
          </div>
  );
}
