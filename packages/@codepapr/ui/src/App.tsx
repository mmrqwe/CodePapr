import { useEffect, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, isApiConfigured } from './store/agentStore';
import { usePreviewStore } from './store/previewStore';
import { useBrowserViewStore } from './store/browserViewStore';
import { useAppRuntimeStore } from './store/appRuntimeStore';
import { selectDockedPluginId } from './papr/pluginSurface';
import { useCharactersStore } from './store/charactersStore';
import { pushDebugLog } from './store/debugLogStore';
import { registerSettingsFlushListener } from './utils/settingsFlush';
import {
  disposeMcpConfirmListener,
  initMcpConfirmListener,
  setMcpConfirmHandler,
  startMcpHealthCheck,
  stopMcpHealthCheck,
} from './tools/mcpTools';
import { useMcpConfirmStore } from './store/mcpConfirmStore';
import type { ReviewScope } from './utils/codeReview';
import { getTranslation } from './utils/i18n';
import { usePermissionStore } from './store/permissionStore';
import type { PreviewLocation } from './utils/projectDiagnosticLocations';
import type { GitFileSelection } from './utils/workspaceGitPanel';
import { useAppThemeBoot } from './useAppThemeBoot';
import { restoreWorkspaceApps } from './restoreWorkspaceApps';
import { AppMainView } from './AppMainView';

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
    settingsLoaded,
    projectGraphLoading,
    projectGraphPhase,
  } = useAgentStore(
    useShallow((state) => ({
      loadSettings: state.loadSettings,
      showSettings: state.showSettings,
      settings: state.settings,
      setShowSettings: state.setShowSettings,
      workspacePath: state.workspacePath,
      settingsLoaded: state.settingsLoaded,
      projectGraphLoading: state.projectGraphLoading,
      projectGraphPhase: state.projectGraphPhase,
    }))
  );
  const activePreviewSession = usePreviewStore((state) => state.activePreviewSession);
  const browserPanelOpen = useBrowserViewStore((state) => state.panelOpen);
  const browserEngine = useBrowserViewStore((state) => state.engine);
  const openBrowserPanel = useBrowserViewStore((state) => state.openPanel);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const pendingPermission = usePermissionStore((state) => state.pendingRequest);
  const pendingMcpConfirm = useMcpConfirmStore((state) => state.pendingConfirm);
  const dockedPluginId = useAppRuntimeStore((state) =>
    selectDockedPluginId({
      apps: state.apps,
      pinnedPluginIds: state.pinnedPluginIds,
      pluginChrome: state.pluginChrome,
    }),
  );
  const clearApps = useAppRuntimeStore((state) => state.clearApps);
  const mountApp = useAppRuntimeStore((state) => state.mountApp);
  const t = getTranslation(settings.lang);
  const [showStats, setShowStats] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [showSkillMarket, setShowSkillMarket] = useState(false);
  const [showCharacters, setShowCharacters] = useState(false);
  const [showProjectConfig, setShowProjectConfig] = useState(false);
  const [workbenchHidden, setWorkbenchHidden] = useState(false);
  const [showCodeReview, setShowCodeReview] = useState<ReviewScope | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>('chat');
  const pendingChatJump = useAgentStore((state) => state._pendingChatJump);
  useEffect(() => {
    if (pendingChatJump) setActiveMainTab('chat');
  }, [pendingChatJump]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedGitFile, setSelectedGitFile] = useState<GitFileSelection | null>(null);
  const [isGitPanelExpanded, setIsGitPanelExpanded] = useState(false);
  const [selectedDiagnosticLocation, setSelectedDiagnosticLocation] = useState<PreviewLocation | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const selectedFileName = selectedPath ? basename(selectedPath) : null;
  const nativeLayerBlocked = Boolean(
    showSettings
      || (showCharacters && settings.experimentalCharacters)
      || showAbout
      || showProjectSwitcher
      || showStats
      || showProjectConfig
      || showSkillMarket
      || showCodeReview
      || openedAppId
      || activePreviewSession
      || pendingPermission
      || pendingMcpConfirm
      || (settingsLoaded && !isApiConfigured(settings) && !onboardingDismissed && !showSettings),
  );

  useEffect(() => {
    void loadSettings();
    void useCharactersStore.getState().loadCharacters();
    registerSettingsFlushListener();
    void initMcpConfirmListener();
    setMcpConfirmHandler((request) => useMcpConfirmStore.getState().requestConfirm(request));
    startMcpHealthCheck(30_000, (serverIds) => {
      pushDebugLog('mcp', 'pruned dead MCP connections', { serverIds });
    });
    return () => {
      stopMcpHealthCheck();
      setMcpConfirmHandler(null);
      void disposeMcpConfirmListener();
    };
  }, [loadSettings]);

  useAppThemeBoot(settingsLoaded);

  useEffect(() => {
    setShowStats(false);
    setShowProjectConfig(false);
    setActiveMainTab('chat');
    setSelectedPath(null);
    setSelectedGitFile(null);
    setSelectedDiagnosticLocation(null);
    const currentApps = useAppRuntimeStore.getState().apps;
    for (const app of currentApps) {
      invoke('unregister_app_workspace', { appId: app.appId }).catch(() => {});
      if (app.pid) {
        invoke('stop_background_process', { pid: app.pid, source: 'workspace-change-effect' }).catch(() => {});
      }
    }
    clearApps();

    // 扫描 .CodePapr/apps/ 目录，恢复之前创建的应用。
    // 应用文件持久化在磁盘上，但注册信息（内存 map + store）在进程重启后丢失，
    // 因此需要在 workspace 打开时重新注册。
    if (workspacePath) {
      void restoreWorkspaceApps(workspacePath, mountApp);
    }
  }, [workspacePath, clearApps, mountApp]);

  useEffect(() => {
    if (!settings.experimentalCharacters) {
      setShowCharacters(false);
    }
  }, [settings.experimentalCharacters]);

  const handleSelectPath = useCallback(
    (path: string | null) => {
      const normalizedPath = normalizeSelectedPath(path, workspacePath);
      setSelectedPath(normalizedPath);
      setSelectedDiagnosticLocation(null);
      if (!normalizedPath || selectedGitFile?.path !== normalizedPath) {
        setSelectedGitFile(null);
      }
      setActiveMainTab(normalizedPath ? 'code' : 'chat');
    },
    [workspacePath, selectedGitFile]
  );

  const pendingSelectPath = useAgentStore((state) => state._pendingSelectPath);
  useEffect(() => {
    if (!pendingSelectPath) return;
    handleSelectPath(pendingSelectPath);
    useAgentStore.setState({ _pendingSelectPath: null });
  }, [pendingSelectPath, handleSelectPath]);

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
    <AppMainView
      projectGraphLoading={projectGraphLoading}
      projectGraphPhase={projectGraphPhase}
      workspacePath={workspacePath}
      t={t as Record<string, string>}
      openedAppId={openedAppId}
      isGitPanelExpanded={isGitPanelExpanded}
      settings={settings}
      selectedPath={selectedPath}
      selectedGitFile={selectedGitFile}
      handleSelectPath={handleSelectPath}
      setSelectedPath={setSelectedPath}
      setSelectedDiagnosticLocation={setSelectedDiagnosticLocation}
      setSelectedGitFile={setSelectedGitFile}
      setActiveMainTab={setActiveMainTab}
      setShowCodeReview={setShowCodeReview}
      setIsGitPanelExpanded={setIsGitPanelExpanded}
      workbenchHidden={workbenchHidden}
      dockedPluginId={dockedPluginId}
      setShowSettings={setShowSettings}
      setShowCharacters={setShowCharacters}
      setShowStats={setShowStats}
      setShowAbout={setShowAbout}
      handleNavigateToLocation={handleNavigateToLocation}
      activeMainTab={activeMainTab}
      selectedFileName={selectedFileName}
      handleCloseCodeTab={handleCloseCodeTab}
      selectedDiagnosticLocation={selectedDiagnosticLocation}
      showSettings={showSettings}
      showCharacters={showCharacters}
      showAbout={showAbout}
      showProjectSwitcher={showProjectSwitcher}
      setShowProjectSwitcher={setShowProjectSwitcher}
      showStats={showStats}
      showProjectConfig={showProjectConfig}
      setShowProjectConfig={setShowProjectConfig}
      setShowSkillMarket={setShowSkillMarket}
      showSkillMarket={showSkillMarket}
      showCodeReview={showCodeReview}
      settingsLoaded={settingsLoaded}
      onboardingDismissed={onboardingDismissed}
      setOnboardingDismissed={setOnboardingDismissed}
      nativeLayerBlocked={nativeLayerBlocked}
      activePreviewSession={activePreviewSession}
      browserPanelOpen={browserPanelOpen}
      browserEngine={browserEngine}
      openBrowserPanel={openBrowserPanel}
      setWorkbenchHidden={setWorkbenchHidden}
    />
  );
}
