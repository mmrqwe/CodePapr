import { lazy, Suspense } from 'react';
import { AppModal } from './components/AppModal';
import { PluginOverlayHost } from './components/PluginOverlayHost';
import { PermissionDialog } from './components/PermissionDialog';
import { McpConfirmDialog } from './components/McpConfirmDialog';
import { ProjectSwitcherModal } from './components/ProjectSwitcherModal';
import { ToastContainer } from './components/ToastContainer';
import { isApiConfigured } from './store/agentStore';
import type { ReviewScope } from './utils/codeReview';
import type { Lang } from './utils/i18n';

const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const SkillMarketModal = lazy(() =>
  import('./components/SkillMarketModal').then((m) => ({ default: m.SkillMarketModal }))
);
const CharacterModal = lazy(() =>
  import('./components/CharacterModal').then((m) => ({ default: m.CharacterModal }))
);
const AboutModal = lazy(() =>
  import('./components/AboutModal').then((m) => ({ default: m.AboutModal }))
);
const StatsModal = lazy(() =>
  import('./components/StatsModal').then((m) => ({ default: m.StatsModal }))
);
const ProjectConfigModal = lazy(() =>
  import('./components/ProjectConfigModal').then((m) => ({ default: m.ProjectConfigModal }))
);
const PreviewSessionPanel = lazy(() =>
  import('./components/PreviewSessionPanel').then((m) => ({ default: m.PreviewSessionPanel }))
);
const EmbeddedBrowserPanel = lazy(() =>
  import('./components/EmbeddedBrowserPanel').then((m) => ({ default: m.EmbeddedBrowserPanel }))
);
const CodeReviewPanel = lazy(() =>
  import('./components/CodeReviewPanel').then((m) => ({ default: m.CodeReviewPanel }))
);
const OnboardingPanel = lazy(() =>
  import('./components/OnboardingPanel').then((m) => ({ default: m.OnboardingPanel }))
);

export function AppOverlays(p: {
  workspacePath: string;
  settings: { lang: Lang; experimentalCharacters?: boolean };
  openedAppId: string | null;
  showSettings: boolean;
  showCharacters: boolean;
  showAbout: boolean;
  showProjectSwitcher: boolean;
  setShowProjectSwitcher: (v: boolean) => void;
  showStats: boolean;
  setShowStats: (v: boolean) => void;
  showProjectConfig: boolean;
  setShowProjectConfig: (v: boolean) => void;
  setShowSkillMarket: (v: boolean) => void;
  showSkillMarket: boolean;
  showCodeReview: ReviewScope | null;
  setShowCodeReview: (scope: ReviewScope | null) => void;
  settingsLoaded: boolean;
  onboardingDismissed: boolean;
  setOnboardingDismissed: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  setShowCharacters: (v: boolean) => void;
  nativeLayerBlocked: boolean;
  activePreviewSession: { workspacePath: string } | null;
  browserPanelOpen: boolean;
  browserEngine: string;
}): JSX.Element {
  const {
    workspacePath, settings, openedAppId, showSettings, showCharacters, showAbout,
    showProjectSwitcher, setShowProjectSwitcher, showStats, setShowStats,
    showProjectConfig, setShowProjectConfig, setShowSkillMarket, showSkillMarket,
    showCodeReview, setShowCodeReview, settingsLoaded, onboardingDismissed,
    setOnboardingDismissed, setShowSettings, setShowCharacters, nativeLayerBlocked,
    activePreviewSession, browserPanelOpen, browserEngine,
  } = p;
  return (
    <>
      {activePreviewSession && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-deep/70 p-4 backdrop-blur-sm">
          <div className="h-full w-full overflow-hidden rounded-2xl border border-line bg-base shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
            <Suspense fallback={null}>
              <PreviewSessionPanel workspacePath={activePreviewSession.workspacePath} lang={settings.lang} />
            </Suspense>
          </div>
        </div>
      )}

      {browserPanelOpen && browserEngine === 'embedded' && workspacePath && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-deep/70 p-4 backdrop-blur-sm">
          {/* N19：内置浏览器应只比主界面小一点——旧实现 max-w-6xl +
              max-h-[88vh] 在大屏上过小。现在仅保留小边距，随窗口伸缩。
              覆盖层必须挂在窗口顶层（SplitPane 之外），否则 absolute
              inset-0 只覆盖右侧主 pane，盖不住左侧栏。 */}
          <div className="h-full w-full overflow-hidden rounded-2xl border border-line bg-base p-4 shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
            <Suspense fallback={null}>
              <EmbeddedBrowserPanel
                workspacePath={workspacePath}
                lang={settings.lang}
                nativeLayerBlocked={nativeLayerBlocked}
              />
            </Suspense>
          </div>
        </div>
      )}

      {openedAppId && (
        <div className="fixed inset-0 z-[60] overflow-hidden bg-base">
          <AppModal lang={settings.lang} />
        </div>
      )}
      <PluginOverlayHost lang={settings.lang} />

      <Suspense fallback={null}>
        {showSettings && <SettingsModal />}
        {showCharacters && settings.experimentalCharacters && <CharacterModal onClose={() => setShowCharacters(false)} />}
        {showAbout && <AboutModal lang={settings.lang} onClose={() => setShowAbout(false)} />}
        {showProjectSwitcher && <ProjectSwitcherModal onClose={() => setShowProjectSwitcher(false)} />}

        {showStats && (
          <StatsModal
            workspacePath={workspacePath}
            lang={settings.lang}
            onClose={() => setShowStats(false)}
          />
        )}

        {showProjectConfig && (
          <ProjectConfigModal
            workspacePath={workspacePath}
            lang={settings.lang}
            onClose={() => setShowProjectConfig(false)}
            onOpenSkillMarket={() => setShowSkillMarket(true)}
            skillMarketOpen={showSkillMarket}
          />
        )}

        {showSkillMarket && <SkillMarketModal onClose={() => setShowSkillMarket(false)} />}

        {showCodeReview && workspacePath && (
          <CodeReviewPanel
            scope={showCodeReview}
            onClose={() => setShowCodeReview(null)}
          />
        )}

        {settingsLoaded && !isApiConfigured(settings) && !onboardingDismissed && !showSettings && (
          <OnboardingPanel
            onDismiss={() => setOnboardingDismissed(true)}
            onOpenFullSettings={() => setShowSettings(true)}
          />
        )}
      </Suspense>

      <PermissionDialog />
      <McpConfirmDialog />

      <ToastContainer />
    </>
  );
}
