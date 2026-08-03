import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, isApiConfigured } from './store/agentStore';
import { usePreviewStore } from './store/previewStore';
import { useBrowserViewStore } from './store/browserViewStore';
import { useAppRuntimeStore } from './store/appRuntimeStore';
import { useCharactersStore } from './store/charactersStore';
import { useDebugLogStore } from './store/debugLogStore';
import { SessionManager } from './components/SessionManager';
import { ChatPanel } from './components/ChatPanel';
import { CodingWorkbench } from './components/CodingWorkbench';
import { AgentOpsPanel } from './components/AgentOpsPanel';
import { BackgroundProcessPanel } from './components/BackgroundProcessPanel';
import { AppModal } from './components/AppModal';
import { SplitPane } from './components/SplitPane';
import { WorkspaceGitPanel } from './components/WorkspaceGitPanel';
import { ToastContainer } from './components/ToastContainer';
import { PermissionDialog } from './components/PermissionDialog';
import { ProjectSwitcherModal } from './components/ProjectSwitcherModal';
import type { GitFileSelection } from './utils/workspaceGitPanel';
import type { ReviewScope } from './utils/codeReview';
import { getTranslation } from './utils/i18n';
import type { PreviewLocation } from './utils/projectDiagnosticLocations';
import { cacheGet, cacheSet } from './utils/cacheStorage';

const THEME_CACHE_KEY = 'ui.theme';
let storedTheme: 'dark' | 'light' | null = null;

// Code-split: these only render conditionally, so keep them out of the main bundle.
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const McpSettingsModal = lazy(() =>
  import('./components/McpSettingsModal').then((m) => ({ default: m.McpSettingsModal }))
);
const McpMarketModal = lazy(() =>
  import('./components/McpMarketModal').then((m) => ({ default: m.McpMarketModal }))
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
const ProjectStatsModal = lazy(() =>
  import('./components/ProjectStatsModal').then((m) => ({ default: m.ProjectStatsModal }))
);
const ProjectConfigModal = lazy(() =>
  import('./components/ProjectConfigModal').then((m) => ({ default: m.ProjectConfigModal }))
);
const ContextDebugModal = lazy(() =>
  import('./components/ContextDebugModal').then((m) => ({ default: m.ContextDebugModal }))
);
const ContextInspectorModal = lazy(() =>
  import('./components/ContextInspectorModal').then((m) => ({ default: m.ContextInspectorModal }))
);
const DebugLogModal = lazy(() =>
  import('./components/DebugLogModal').then((m) => ({ default: m.DebugLogModal }))
);
const CodePreviewPanel = lazy(() =>
  import('./components/CodePreviewPanel').then((m) => ({ default: m.CodePreviewPanel }))
);
const PreviewSessionPanel = lazy(() =>
  import('./components/PreviewSessionPanel').then((m) => ({ default: m.PreviewSessionPanel }))
);
const EmbeddedBrowserPanel = lazy(() =>
  import('./components/EmbeddedBrowserPanel').then((m) => ({ default: m.EmbeddedBrowserPanel }))
);
const CacheStatsDashboard = lazy(() =>
  import('./components/CacheStatsDashboard').then((m) => ({ default: m.CacheStatsDashboard }))
);
const CodeReviewPanel = lazy(() =>
  import('./components/CodeReviewPanel').then((m) => ({ default: m.CodeReviewPanel }))
);
const OnboardingPanel = lazy(() =>
  import('./components/OnboardingPanel').then((m) => ({ default: m.OnboardingPanel }))
);

function isDarkTheme(): boolean {
  if (storedTheme === 'light') return false;
  if (storedTheme === 'dark') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(dark: boolean): void {
  const root = document.documentElement;
  if (dark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

function normalizeSelectedPath(path: string | null, workspacePath: string): string | null {
  if (!path) {
    return null;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = trimmed.replace(/\\/g, '/');

  if (normalizedWorkspacePath && normalizedPath.startsWith(`${normalizedWorkspacePath}/`)) {
    return normalizedPath.slice(normalizedWorkspacePath.length + 1);
  }

  return normalizedPath.replace(/^\.\//, '');
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

type MainTab = 'chat' | 'code';

export default function App() {
  const {
    loadSettings,
    showSettings,
    settings,
    setShowSettings,
    workspacePath,
    messages,
    settingsLoaded,
    projectGraphLoading,
    projectGraphPhase,
  } = useAgentStore();
  const latestContextSnapshot = useAgentStore((state) => state._latestContextSnapshot);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const activePreviewSession = usePreviewStore((state) => state.activePreviewSession);
  const browserPageSession = useBrowserViewStore((state) => state.pageSession);
  const browserPanelOpen = useBrowserViewStore((state) => state.panelOpen);
  const browserEngine = useBrowserViewStore((state) => state.engine);
  const openBrowserPanel = useBrowserViewStore((state) => state.openPanel);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const clearApps = useAppRuntimeStore((state) => state.clearApps);
  const mountApp = useAppRuntimeStore((state) => state.mountApp);
  const t = getTranslation(settings.lang);
  const [isDark, setIsDark] = useState(isDarkTheme);
  const [showCacheStats, setShowCacheStats] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [showMcpSettings, setShowMcpSettings] = useState(false);
  const [showMcpMarket, setShowMcpMarket] = useState(false);
  const [showSkillMarket, setShowSkillMarket] = useState(false);
  const [showCharacters, setShowCharacters] = useState(false);
  const [showProjectStats, setShowProjectStats] = useState(false);
  const [showProjectConfig, setShowProjectConfig] = useState(false);
  const [showContextDebug, setShowContextDebug] = useState(false);
  const [showContextInspector, setShowContextInspector] = useState(false);
  const [showDebugLog, setShowDebugLog] = useState(false);
  const [showCodeReview, setShowCodeReview] = useState<ReviewScope | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>('chat');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedGitFile, setSelectedGitFile] = useState<GitFileSelection | null>(null);
  const [isGitPanelExpanded, setIsGitPanelExpanded] = useState(false);
  const [selectedDiagnosticLocation, setSelectedDiagnosticLocation] = useState<PreviewLocation | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const projectName = workspacePath ? basename(workspacePath) : t.unselected;
  const selectedFileName = selectedPath ? basename(selectedPath) : null;

  const toggleTheme = useCallback(() => {
    const next = !isDark;
    setIsDark(next);
    storedTheme = next ? 'dark' : 'light';
    void cacheSet(THEME_CACHE_KEY, storedTheme);
  }, [isDark]);

  useEffect(() => {
    void loadSettings();
    void useCharactersStore.getState().loadCharacters();
  }, [loadSettings]);

  useEffect(() => {
    cacheGet<'dark' | 'light'>(THEME_CACHE_KEY).then((theme) => {
      if (theme === 'dark' || theme === 'light') {
        storedTheme = theme;
        setIsDark(theme === 'dark');
      }
    });
  }, []);

  useEffect(() => {
    applyTheme(isDark);
  }, [isDark]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      if (!storedTheme) {
        setIsDark(e.matches);
      }
    };
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setShowProjectStats(false);
    setShowProjectConfig(false);
    setShowContextDebug(false);
    setActiveMainTab('chat');
    setSelectedPath(null);
    setSelectedGitFile(null);
    setSelectedDiagnosticLocation(null);
    const currentApps = useAppRuntimeStore.getState().apps;
    for (const app of currentApps) {
      invoke('unregister_app_workspace', { appId: app.appId }).catch(() => {});
      if (app.pid) {
        invoke('stop_background_process', { pid: app.pid }).catch(() => {});
      }
    }
    clearApps();

    // 扫描 .CodePapr/apps/ 目录，恢复之前创建的应用。
    // 应用文件持久化在磁盘上，但注册信息（内存 map + store）在进程重启后丢失，
    // 因此需要在 workspace 打开时重新注册。
    if (workspacePath) {
      void (async () => {
        try {
          const discovered = await invoke<Array<{ app_id: string; title: string; html: string; manifest_json: string | null; command: string | null; args: string[] | null; port: number | null }>>(
            'scan_workspace_apps',
            { workspacePath },
          );
          for (const app of discovered) {
            if (useAgentStore.getState().workspacePath !== workspacePath) return;
            await invoke('register_app_workspace', {
              appId: app.app_id,
              workspacePath,
            }).catch(() => {});
            mountApp({
              appId: app.app_id,
              title: app.title || app.app_id,
              html: app.html,
              filePath: `.CodePapr/apps/${app.app_id}/index.html`,
              manifestJson: app.manifest_json ?? undefined,
              command: app.command ?? undefined,
              args: app.args ?? undefined,
              port: app.port ?? undefined,
            });
          }

          // The Rust background-process registry survives webview reloads even
          // though the in-memory JS store does not. Re-associate any surviving
          // backend (matched by its preview URL / port) so start/stop/delete and
          // running-state stay accurate after a reload.
          try {
            const procs = await invoke<Array<{ pid: number; preview_url?: string }>>(
              'list_background_processes',
              { workspacePath },
            );
            const runningByUrl = new Map<string, number>();
            for (const proc of procs) {
              if (proc.preview_url) runningByUrl.set(proc.preview_url, proc.pid);
            }
            for (const app of discovered) {
              if (useAgentStore.getState().workspacePath !== workspacePath) return;
              if (!app.port) continue;
              const url = `http://localhost:${app.port}/`;
              const pid = runningByUrl.get(url);
              if (pid !== undefined) {
                useAppRuntimeStore.getState().setAppRunning(app.app_id, pid, url);
              }
            }
          } catch {
            // 对账失败不影响应用列表恢复
          }
        } catch {
          // 扫描失败不影响正常使用
        }
      })();
    }
  }, [workspacePath, clearApps, mountApp]);

  useEffect(() => {
    if (!settings.debugEnabled) {
      setShowContextDebug(false);
    }
  }, [settings.debugEnabled]);

  const hasContextDebugEntries = messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.promptContent === 'string' &&
      message.promptContent.trim().length > 0
  );

  const handleSelectPath = (path: string | null) => {
    const normalizedPath = normalizeSelectedPath(path, workspacePath);
    setSelectedPath(normalizedPath);
    setSelectedDiagnosticLocation(null);
    if (!normalizedPath || selectedGitFile?.path !== normalizedPath) {
      setSelectedGitFile(null);
    }
    setActiveMainTab(normalizedPath ? 'code' : 'chat');
  };

  const handleNavigateToLocation = (location: PreviewLocation) => {
    const normalizedPath = normalizeSelectedPath(location.path, workspacePath);
    if (!normalizedPath) {
      return;
    }

    setSelectedPath(normalizedPath);
    setSelectedGitFile(null);
    setSelectedDiagnosticLocation({
      path: normalizedPath,
      line: location.line,
      column: location.column,
    });
    setActiveMainTab('code');
  };

  const handleCloseCodeTab = () => {
    setActiveMainTab('chat');
    setSelectedPath(null);
    setSelectedGitFile(null);
    setSelectedDiagnosticLocation(null);
  };

  return (
    <>
      {projectGraphLoading && workspacePath && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#07090d]/85 backdrop-blur-md">
          <div className="w-[min(92vw,520px)] rounded-3xl border border-[var(--border-strong)] bg-[#10131b]/95 px-8 py-10 text-center shadow-2xl">
            <div className="loading-spinner mx-auto mb-5 h-12 w-12 animate-spin rounded-full border-2" />
            <h2 className="text-base font-semibold text-slate-100">
              {projectGraphPhase ? t.workspaceInsightsLoading : t.workspaceInitLoading}
            </h2>
            <p className="mt-1.5 text-xs text-slate-500">
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
                <div className="mx-auto h-1.5 w-64 overflow-hidden rounded-full bg-[#1a1f2b]">
                  <div className="status-indicator-bar h-full rounded-full bg-indigo-500/70" />
                </div>
                <p className="mt-2 text-[10px] tabular-nums text-slate-600">
                  {projectGraphPhase.current} / {projectGraphPhase.total}
                </p>
              </div>
            )}
            {!projectGraphPhase && (
              <div className="mt-5">
                <div className="mx-auto h-1.5 w-64 overflow-hidden rounded-full bg-[#1a1f2b]">
                  <div className="status-indicator-bar h-full rounded-full bg-indigo-500/70" />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {openedAppId ? (
        <div className="h-screen w-screen overflow-hidden bg-[#0f1117]">
        <AppModal lang={settings.lang} />
        </div>
      ) : (
      <SplitPane
        direction="horizontal"
        defaultRatio={0.18}
        minFirstSize={200}
        minSecondSize={650}
        className="h-screen w-screen overflow-hidden bg-[#0f1117] select-none"
        firstPaneClassName="bg-[#10131b]"
        secondPaneClassName="bg-[#0f1117]"
        first={
          <div className="flex h-full min-h-0 flex-col border-r border-[#202432] bg-[#10131b]">
            <SplitPane
              key={isGitPanelExpanded ? 'sidebar-expanded' : 'sidebar-collapsed'}
              direction="vertical"
              defaultRatio={isGitPanelExpanded ? 0.42 : 0.72}
              minFirstSize={120}
              minSecondSize={isGitPanelExpanded ? 300 : 160}
              className="h-full"
              firstPaneClassName="min-h-0 bg-[#10131b]"
              secondPaneClassName="flex flex-col min-h-0 bg-[#10131b]"
              first={
                <div className="h-full min-h-0">
                  <SessionManager />
                </div>
              }
              second={
                <div className="flex-1 min-h-0 flex flex-col border-t border-[#202432]">
                  {isGitPanelExpanded ? (
                    <SplitPane
                      direction="vertical"
                      defaultRatio={0.45}
                      minFirstSize={120}
                      minSecondSize={120}
                      className="flex-1 min-h-0"
                      firstPaneClassName="min-h-0 bg-[#10131b]"
                      secondPaneClassName="flex flex-col min-h-0 bg-[#10131b]"
                      first={
                        <div className="h-full min-h-0">
                          <BackgroundProcessPanel workspacePath={workspacePath} lang={settings.lang} />
                        </div>
                      }
                      second={
                        <div className="grid flex-1 min-h-0">
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
                  ) : (
                    <>
                      <BackgroundProcessPanel workspacePath={workspacePath} lang={settings.lang} />
                      <div className="shrink-0">
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
                    </>
                  )}
                </div>
              }
            />
          </div>
        }
        second={
          <div className="relative h-full min-h-0">
            <SplitPane
              direction="horizontal"
              defaultRatio={0.68}
              minFirstSize={380}
              minSecondSize={280}
              className="h-full"
              firstPaneClassName="min-w-0 bg-[#0f1117]"
              secondPaneClassName="bg-[#10141d]"
              first={
                <div className="flex h-full min-w-0 flex-col overflow-hidden font-sans">
                    <AgentOpsPanel
                      onOpenSettings={() => setShowSettings(true)}
                      onOpenMcpSettings={() => setShowMcpSettings(true)}
                      onOpenCharacters={() => setShowCharacters(true)}
                      onOpenCacheStats={() => setShowCacheStats(true)}
                      onOpenAbout={() => setShowAbout(true)}
                      isDark={isDark}
                      onToggleTheme={toggleTheme}
                      onNavigateToFile={handleNavigateToLocation}
                    />
                  <div className="border-b border-[#202432] bg-[#0f141d] px-3 py-2">
                    <div className="flex items-center gap-2 overflow-x-auto">
                      <button
                        type="button"
                        onClick={() => setActiveMainTab('chat')}
                        title={t.sessionTabTip}
                        className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          activeMainTab === 'chat'
                            ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                            : 'border-[#2a2d3a] text-slate-500 hover:border-indigo-500/30 hover:text-slate-200'
                        }`}
                      >
                        {t.session}
                      </button>
                      {selectedFileName && (
                        <div
                          className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1 ${
                            activeMainTab === 'code'
                              ? 'border-indigo-500/50 bg-indigo-500/15'
                              : 'border-[#2a2d3a] bg-[#121722]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveMainTab('code')}
                            title={t.codePreviewTabTip}
                            className={`min-w-0 truncate text-left text-xs font-medium transition-colors ${
                              activeMainTab === 'code'
                                ? 'text-indigo-100'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {selectedFileName}
                          </button>
                          <button
                            type="button"
                            onClick={handleCloseCodeTab}
                            className="flex-shrink-0 text-sm leading-none text-slate-500 transition-colors hover:text-slate-200"
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
                        deferMessages={projectGraphLoading && !!workspacePath}
                      />
                    )}
                  </div>
                </div>
              }
              second={
                <div className="flex h-full min-h-0 flex-col">
                   <div className="flex items-center justify-between gap-3 border-b border-[#202432] px-4 min-h-[60px]">
                    <button
                      type="button"
                      onClick={() => setShowProjectSwitcher(true)}
                      className="min-w-0 truncate text-xs font-semibold text-slate-300 transition-colors hover:text-indigo-300"
                    >
                      {projectName}
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowProjectStats(true)}
                        title={t.projectStatsTip}
                        disabled={!workspacePath}
                        className="flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t.projectStats}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowProjectConfig(true)}
                        title={t.projectConfigTip}
                        disabled={!workspacePath}
                        className="flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t.projectConfigButton}
                      </button>
                      {settings.debugEnabled && (
                        <button
                          type="button"
                          onClick={() => setShowContextDebug(true)}
                          title={hasContextDebugEntries ? t.contextDebugTip : t.contextDebugEmpty}
                          disabled={!hasContextDebugEntries}
                          className="flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {t.contextDebugButton}
                        </button>
                      )}
                      {settings.debugEnabled && (
                        <button
                          type="button"
                          onClick={() => setShowDebugLog(true)}
                          title={t.debugLogTitle}
                          className="flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-amber-400 hover:text-amber-200"
                        >
                          {t.debugLogButton}
                          {useDebugLogStore.getState().logs.length > 0 && (
                            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[9px] text-amber-300">
                              {useDebugLogStore.getState().logs.length}
                            </span>
                          )}
                        </button>
                      )}
                      {browserPageSession && browserEngine === 'embedded' && workspacePath && (
                        <button
                          type="button"
                          onClick={() => openBrowserPanel()}
                          title={t.embeddedBrowserToolbarTip}
                          className="flex-shrink-0 rounded-lg border border-emerald-500/40 px-2.5 py-2 text-xs font-medium text-emerald-200 transition-colors hover:border-emerald-400 hover:text-white"
                        >
                          {t.embeddedBrowserTab}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowProjectSwitcher(true)}
                        title={t.switchProjectTip}
                        className="flex-shrink-0 rounded-lg border border-indigo-500/40 px-2.5 py-2 text-xs font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:text-white"
                      >
                        {t.switchProject}
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
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

            {activePreviewSession && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#07090d]/70 p-6 backdrop-blur-sm">
                <div className="h-full max-h-[88vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#0f1117] shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
                  <Suspense fallback={null}>
                    <PreviewSessionPanel workspacePath={activePreviewSession.workspacePath} lang={settings.lang} />
                  </Suspense>
                </div>
              </div>
            )}

            {browserPanelOpen && browserEngine === 'embedded' && workspacePath && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#07090d]/70 p-6 backdrop-blur-sm">
                <div className="h-full max-h-[88vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#0f1117] p-4 shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
                  <Suspense fallback={null}>
                    <EmbeddedBrowserPanel workspacePath={workspacePath} lang={settings.lang} />
                  </Suspense>
                </div>
              </div>
            )}

          </div>
        }
      />
      )}

      <Suspense fallback={null}>
        {showSettings && <SettingsModal />}
        {showMcpSettings && <McpSettingsModal onClose={() => setShowMcpSettings(false)} onOpenMarket={() => { setShowMcpSettings(false); setShowMcpMarket(true); }} />}
        {showMcpMarket && <McpMarketModal onClose={() => setShowMcpMarket(false)} />}
        {showSkillMarket && <SkillMarketModal onClose={() => setShowSkillMarket(false)} />}
        {showCharacters && <CharacterModal onClose={() => setShowCharacters(false)} />}
        {showAbout && <AboutModal lang={settings.lang} onClose={() => setShowAbout(false)} />}
        {showProjectSwitcher && <ProjectSwitcherModal onClose={() => setShowProjectSwitcher(false)} />}

        {showProjectStats && (
          <ProjectStatsModal
            workspacePath={workspacePath}
            lang={settings.lang}
            onClose={() => setShowProjectStats(false)}
          />
        )}

        {showProjectConfig && (
          <ProjectConfigModal
            workspacePath={workspacePath}
            lang={settings.lang}
            onClose={() => setShowProjectConfig(false)}
            onOpenSkillMarket={() => setShowSkillMarket(true)}
          />
        )}

        {showContextDebug && settings.debugEnabled && (
          <ContextDebugModal
            messages={messages}
            lang={settings.lang}
            onClose={() => setShowContextDebug(false)}
          />
        )}

        {showDebugLog && settings.debugEnabled && (
          <Suspense fallback={null}>
            <DebugLogModal
              lang={settings.lang}
              onClose={() => setShowDebugLog(false)}
            />
          </Suspense>
        )}

        {showCacheStats && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#2a2d3a] px-5 py-4">
                <h2 className="text-sm font-semibold text-slate-200">{t.cacheStatsTitle}</h2>
                <button
                  type="button"
                  onClick={() => setShowCacheStats(false)}
                  className="text-lg leading-none text-slate-500 transition-colors hover:text-slate-200"
                >
                  ×
                </button>
              </div>
              <div className="min-h-0 flex-1 flex flex-col">
                <CacheStatsDashboard
                  lang={settings.lang}
                  collapsible={false}
                  onOpenContextInspector={async () => {
                    const state = useAgentStore.getState();
                    const current = state._latestContextSnapshot;
                    if (!current || current.sessionId !== state.activeSessionId) {
                      await state.computeContextSnapshot();
                    }
                    setShowContextInspector(true);
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {showContextInspector &&
          latestContextSnapshot &&
          latestContextSnapshot.sessionId === activeSessionId && (
            <ContextInspectorModal
              snapshot={latestContextSnapshot.snapshot}
              lang={settings.lang}
              onClose={() => setShowContextInspector(false)}
            />
          )}

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

      <ToastContainer />
    </>
  );
}
