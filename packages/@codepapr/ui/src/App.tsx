import { lazy, Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, isApiConfigured } from './store/agentStore';
import { usePreviewStore } from './store/previewStore';
import { useBrowserViewStore } from './store/browserViewStore';
import { useAppRuntimeStore } from './store/appRuntimeStore';
import { isPluginApp, pluginShouldShow, readAppManifest } from './papr/pluginSurface';
import { loadPluginUi } from './papr/pluginUiStorage';
import { useCharactersStore } from './store/charactersStore';
import { useDebugLogStore, pushDebugLog } from './store/debugLogStore';
import { SessionManager } from './components/SessionManager';
import { ChatPanel } from './components/ChatPanel';
import { CodingWorkbench } from './components/CodingWorkbench';
import { AgentOpsPanel } from './components/AgentOpsPanel';
import { BackgroundProcessPanel } from './components/BackgroundProcessPanel';
import { AppModal } from './components/AppModal';
import { PluginOverlayHost } from './components/PluginOverlayHost';
import { SplitPane } from './components/SplitPane';
import { WorkspaceGitPanel } from './components/WorkspaceGitPanel';
import { ToastContainer } from './components/ToastContainer';
import { PermissionDialog } from './components/PermissionDialog';
import { McpConfirmDialog } from './components/McpConfirmDialog';
import { ProjectSwitcherModal } from './components/ProjectSwitcherModal';
import type { GitFileSelection } from './utils/workspaceGitPanel';
import { registerSettingsFlushListener } from './utils/settingsFlush';
import {
  disposeMcpConfirmListener,
  initMcpConfirmListener,
  setMcpConfirmHandler,
  startMcpHealthCheck,
  stopMcpHealthCheck,
} from './tools/mcpTools';
import { useMcpConfirmStore } from './store/mcpConfirmStore';
import { useThemeStore } from './store/themeStore';
import { getBuiltinTheme } from './theme/themes';
import type { ReviewScope } from './utils/codeReview';
import { getTranslation } from './utils/i18n';
import type { PreviewLocation } from './utils/projectDiagnosticLocations';
import { cacheGet, cacheSet } from './utils/cacheStorage';

const THEME_CACHE_KEY = 'ui.theme';

/** 启动缓存镜像（防闪烁）。v2：浅/深主题槽位 + 模式。 */
interface ThemeCacheValue {
  mode: 'light' | 'dark';
  light: string;
  dark: string;
  followSystem: boolean;
  accent: string | null;
}

interface ParsedThemeCache {
  value: ThemeCacheValue;
  /** 旧格式（'dark'|'light' 字符串或 v1 {theme} 对象）：settings 加载后需一次性迁移。 */
  legacy: boolean;
  kind: 'string' | 'v1' | 'v2';
}

/** 解析缓存镜像，兼容旧版 'dark'|'light' 字符串与 v1 {theme, accent} 对象。 */
function parseThemeCache(cached: unknown): ParsedThemeCache | null {
  if (typeof cached === 'string') {
    const mode = cached === 'dark' ? 'dark' : cached === 'light' ? 'light' : null;
    if (!mode) return null;
    return {
      value: { mode, light: 'paper-light', dark: 'paper-dark', followSystem: false, accent: null },
      legacy: true,
      kind: 'string',
    };
  }
  if (cached && typeof cached === 'object') {
    const record = cached as Record<string, unknown>;
    // v2 格式
    if (record.mode === 'light' || record.mode === 'dark') {
      return {
        value: {
          mode: record.mode,
          light: typeof record.light === 'string' ? record.light : 'paper-light',
          dark: typeof record.dark === 'string' ? record.dark : 'paper-dark',
          followSystem: record.followSystem === true,
          accent: typeof record.accent === 'string' ? record.accent : null,
        },
        legacy: false,
        kind: 'v2',
      };
    }
    // v1 格式 {theme, accent}
    if ('theme' in record) {
      const theme = typeof record.theme === 'string' ? record.theme : null;
      const accent = typeof record.accent === 'string' ? record.accent : null;
      if (!theme) {
        return {
          value: {
            mode: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            light: 'paper-light',
            dark: 'paper-dark',
            followSystem: true,
            accent,
          },
          legacy: true,
          kind: 'v1',
        };
      }
      const def = getBuiltinTheme(theme);
      if (!def) return null;
      return {
        value: {
          mode: def.mode,
          light: def.mode === 'light' ? theme : 'paper-light',
          dark: def.mode === 'dark' ? theme : 'paper-dark',
          followSystem: false,
          accent,
        },
        legacy: true,
        kind: 'v1',
      };
    }
  }
  return null;
}

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
const StatsModal = lazy(() =>
  import('./components/StatsModal').then((m) => ({ default: m.StatsModal }))
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
const CodeReviewPanel = lazy(() =>
  import('./components/CodeReviewPanel').then((m) => ({ default: m.CodeReviewPanel }))
);
const OnboardingPanel = lazy(() =>
  import('./components/OnboardingPanel').then((m) => ({ default: m.OnboardingPanel }))
);

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
  } = useAgentStore(
    useShallow((state) => ({
      loadSettings: state.loadSettings,
      showSettings: state.showSettings,
      settings: state.settings,
      setShowSettings: state.setShowSettings,
      workspacePath: state.workspacePath,
      messages: state.messages,
      settingsLoaded: state.settingsLoaded,
      projectGraphLoading: state.projectGraphLoading,
      projectGraphPhase: state.projectGraphPhase,
    }))
  );
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
  const themeId = useThemeStore((state) => state.resolvedThemeId);
  const themeMode = useThemeStore((state) => state.mode);
  const themeLightTheme = useThemeStore((state) => state.lightTheme);
  const themeDarkTheme = useThemeStore((state) => state.darkTheme);
  const themeFollowSystem = useThemeStore((state) => state.followSystem);
  const themeAccent = useThemeStore((state) => state.accent);
  const [showStats, setShowStats] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [showMcpSettings, setShowMcpSettings] = useState(false);
  const [showMcpMarket, setShowMcpMarket] = useState(false);
  const [showSkillMarket, setShowSkillMarket] = useState(false);
  const [showCharacters, setShowCharacters] = useState(false);
  const [showProjectConfig, setShowProjectConfig] = useState(false);
  const [workbenchHidden, setWorkbenchHidden] = useState(false);
  const [showContextDebug, setShowContextDebug] = useState(false);
  const [showContextInspector, setShowContextInspector] = useState(false);
  const [showDebugLog, setShowDebugLog] = useState(false);
  const [showCodeReview, setShowCodeReview] = useState<ReviewScope | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>('chat');
  // 跨面板的消息跳转请求（会话搜索等）：先切回聊天 tab，ChatPanel 挂载后
  // 负责扩窗并滚动到目标消息。
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

  useEffect(() => {
    void loadSettings();
    void useCharactersStore.getState().loadCharacters();
    registerSettingsFlushListener();
    // MCP 高风险调用确认：后端在 requireConfirmation 命中时发出
    // mcp-confirm-request 事件并阻塞等待回复，这里必须注册监听与处理
    // 回调，否则工具调用会挂到 120 秒超时才失败。
    void initMcpConfirmListener();
    setMcpConfirmHandler((request) => useMcpConfirmStore.getState().requestConfirm(request));
    // 周期清理后端已断开的 MCP 连接，剪枝结果写入调试日志便于排障。
    startMcpHealthCheck(30_000, (serverIds) => {
      pushDebugLog('mcp', 'pruned dead MCP connections', { serverIds });
    });
    return () => {
      stopMcpHealthCheck();
      setMcpConfirmHandler(null);
      void disposeMcpConfirmListener();
    };
  }, [loadSettings]);

  // ── 主题引导 ──────────────────────────────────────────────
  // 启动顺序：index.html 静态 data-theme="paper-light" 保证首帧可用；
  // 缓存镜像（防闪烁）→ Settings（权威）→ 旧偏好迁移进 Settings。
  const cachedThemeRef = useRef<ParsedThemeCache | null>(null);
  const themeHydratedRef = useRef(false);

  useEffect(() => {
    void cacheGet<unknown>(THEME_CACHE_KEY).then((cached) => {
      const parsed = parseThemeCache(cached);
      if (parsed) cachedThemeRef.current = parsed;
      const cachedTheme = cachedThemeRef.current;
      const { settings, settingsLoaded } = useAgentStore.getState();
      if (settingsLoaded) {
        const pristineSlots =
          settings.lightTheme === 'paper-light' &&
          settings.darkTheme === 'paper-dark' &&
          settings.followSystem === true;
        if (cachedTheme?.legacy && pristineSlots) {
          // 旧版偏好迁移进 Settings（一次性），随后以 Settings 为准应用。
          const patch =
            cachedTheme.kind === 'string'
              ? { followSystem: false, themeMode: cachedTheme.value.mode }
              : {
                  lightTheme: cachedTheme.value.light,
                  darkTheme: cachedTheme.value.dark,
                  followSystem: cachedTheme.value.followSystem,
                  themeMode: cachedTheme.value.mode,
                };
          useAgentStore.getState().setSettings(
            { ...patch, accent: settings.accent ?? cachedTheme.value.accent },
            { preserveAgent: true },
          );
        }
        const current = useAgentStore.getState().settings;
        useThemeStore.getState().applyFromSettings({
          lightTheme: current.lightTheme,
          darkTheme: current.darkTheme,
          followSystem: current.followSystem,
          themeMode: current.themeMode,
          accent: current.accent,
          customThemes: current.customThemes,
        });
      } else {
        // Settings 尚未加载：先用缓存防闪烁，加载后由下方 effect 接管。
        const value = cachedTheme?.value ?? null;
        useThemeStore.getState().applyFromSettings({
          lightTheme: value?.light ?? 'paper-light',
          darkTheme: value?.dark ?? 'paper-dark',
          followSystem: value?.followSystem ?? true,
          themeMode: value?.mode ?? 'light',
          accent: value?.accent ?? null,
          customThemes: {},
        });
      }
      themeHydratedRef.current = true;
    });
  }, []);

  // Settings 加载完成后以 Settings 为准（含旧偏好迁移兜底）。
  useEffect(() => {
    if (!settingsLoaded) return;
    const current = useAgentStore.getState().settings;
    const cachedTheme = cachedThemeRef.current;
    const pristineSlots =
      current.lightTheme === 'paper-light' &&
      current.darkTheme === 'paper-dark' &&
      current.followSystem === true;
    if (cachedTheme?.legacy && pristineSlots) {
      useAgentStore.getState().setSettings(
        {
          ...(cachedTheme.kind === 'v1'
            ? {
                lightTheme: cachedTheme.value.light,
                darkTheme: cachedTheme.value.dark,
                followSystem: cachedTheme.value.followSystem,
              }
            : { followSystem: false }),
          themeMode: cachedTheme.value.mode,
          accent: current.accent ?? cachedTheme.value.accent,
        },
        { preserveAgent: true },
      );
      const migrated = useAgentStore.getState().settings;
      useThemeStore.getState().applyFromSettings({
        lightTheme: migrated.lightTheme,
        darkTheme: migrated.darkTheme,
        followSystem: migrated.followSystem,
        themeMode: migrated.themeMode,
        accent: migrated.accent,
        customThemes: migrated.customThemes,
      });
      return;
    }
    useThemeStore.getState().applyFromSettings({
      lightTheme: current.lightTheme,
      darkTheme: current.darkTheme,
      followSystem: current.followSystem,
      themeMode: current.themeMode,
      accent: current.accent,
      customThemes: current.customThemes,
    });
  }, [settingsLoaded]);

  // 启动缓存镜像回写：仅在水合完成后允许，避免空值覆盖旧版缓存。
  useEffect(() => {
    if (!themeHydratedRef.current) return;
    const theme = useThemeStore.getState();
    void cacheSet<ThemeCacheValue>(THEME_CACHE_KEY, {
      mode: theme.mode,
      light: theme.lightTheme,
      dark: theme.darkTheme,
      followSystem: theme.followSystem,
      accent: theme.accent,
    });
  }, [themeId, themeMode, themeLightTheme, themeDarkTheme, themeFollowSystem, themeAccent]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      useThemeStore.getState().syncFromSystem(e.matches);
    };
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setShowStats(false);
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
        invoke('stop_background_process', { pid: app.pid, source: 'workspace-change-effect' }).catch(() => {});
      }
    }
    clearApps();

    // 扫描 .CodePapr/apps/ 目录，恢复之前创建的应用。
    // 应用文件持久化在磁盘上，但注册信息（内存 map + store）在进程重启后丢失，
    // 因此需要在 workspace 打开时重新注册。
    if (workspacePath) {
      void (async () => {
        try {
          const discovered = await invoke<Array<{ app_id: string; title: string; html: string; manifest_json: string | null; command: string | null; args: string[] | null; port: number | null; icon: string | null }>>(
            'scan_workspace_apps',
            { workspacePath },
          );
          if (useAgentStore.getState().workspacePath !== workspacePath) return;
          const pluginUi = await loadPluginUi(workspacePath);
          if (useAgentStore.getState().workspacePath !== workspacePath) return;
          useAppRuntimeStore.getState().hydratePluginUi(pluginUi);
          for (const app of discovered) {
            if (useAgentStore.getState().workspacePath !== workspacePath) return;
            await invoke('register_app_workspace', {
              appId: app.app_id,
              workspacePath,
            }).catch(() => {});
            // #15：入口文件尊重 manifest.entry（与 Rust scan_workspace_apps 一致），
            // 旧实现硬编码 index.html。
            let appEntryFile = 'index.html';
            let appIcon: string | undefined;
            if (app.icon && app.icon.trim().length > 0) {
              appIcon = app.icon.trim();
            }
            if (app.manifest_json) {
              try {
                const parsedManifest = JSON.parse(app.manifest_json) as { entry?: string; icon?: string };
                const rawEntry = parsedManifest.entry?.trim();
                if (rawEntry && !rawEntry.includes('..') && !rawEntry.includes('\\')) {
                  appEntryFile = rawEntry;
                }
                if (!appIcon) {
                  const rawIcon = parsedManifest.icon?.trim();
                  if (rawIcon) appIcon = rawIcon;
                }
              } catch {
                // keep default
              }
            }
            mountApp({
              appId: app.app_id,
              title: app.title || app.app_id,
              icon: appIcon,
              html: '',
              filePath: `.CodePapr/apps/${app.app_id}/${appEntryFile}`,
              manifestJson: app.manifest_json ?? undefined,
              command: app.command ?? undefined,
              args: app.args ?? undefined,
              port: app.port ?? undefined,
            });
            if (isPluginApp({ manifestJson: app.manifest_json ?? undefined })) {
              const manifest = readAppManifest({ manifestJson: app.manifest_json ?? undefined });
              const chrome = useAppRuntimeStore.getState().pluginChrome[app.app_id];
              if (pluginShouldShow(manifest, chrome)) {
                useAppRuntimeStore.getState().pinPlugin(app.app_id);
              }
            }
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
              const url = `http://127.0.0.1:${app.port}/`;
              const pid = runningByUrl.get(url) ?? runningByUrl.get(`http://localhost:${app.port}/`);
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

  useEffect(() => {
    if (!settings.experimentalCharacters) {
      setShowCharacters(false);
    }
  }, [settings.experimentalCharacters]);

  const hasContextDebugEntries = messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.promptContent === 'string' &&
      message.promptContent.trim().length > 0
  );

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
      {/* 打开 app 时主界面保持挂载（invisible 仅视觉隐藏），避免退出 app 后
          CodingWorkbench/WorkspaceInsightPanel 重挂载导致 ProjectGraph、LSP 预热、
          文件树等初始化流程全部重跑。AppModal 以全屏覆盖层形式渲染在其上。 */}
      <div className={`h-screen w-screen overflow-hidden bg-base ${openedAppId ? 'invisible' : ''}`}>
      <SplitPane
        direction="horizontal"
        defaultRatio={0.18}
        minFirstSize={200}
        minSecondSize={650}
        className="h-screen w-screen overflow-hidden bg-base select-none"
        firstPaneClassName="bg-base"
        secondPaneClassName="bg-base"
        first={
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
        }
        second={
          <div className="h-full min-h-0">
            <SplitPane
              direction="horizontal"
              defaultRatio={0.68}
              minFirstSize={380}
              minSecondSize={280}
              hideSeparator={workbenchHidden}
              className="h-full"
              firstPaneClassName="min-w-0 bg-base"
              secondPaneClassName="bg-base"
              first={
                <div className="flex h-full min-w-0 flex-col overflow-hidden font-sans">
                    <AgentOpsPanel
                      onOpenSettings={() => setShowSettings(true)}
                      onOpenMcpSettings={() => setShowMcpSettings(true)}
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
                workbenchHidden ? (
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
                <div className="flex h-full min-h-0 flex-col">
                   <div className="flex items-center justify-end gap-2 border-b border-line px-4 min-h-[60px]">
                    <div className="flex items-center gap-2">
                      {settings.debugEnabled && (
                        <button
                          type="button"
                          onClick={() => setShowContextDebug(true)}
                          title={hasContextDebugEntries ? t.contextDebugTip : t.contextDebugEmpty}
                          disabled={!hasContextDebugEntries}
                          className="flex-shrink-0 rounded-lg border border-line px-2.5 py-2 text-xs font-medium text-fg-soft transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {t.contextDebugButton}
                        </button>
                      )}
                      {settings.debugEnabled && (
                        <button
                          type="button"
                          onClick={() => setShowDebugLog(true)}
                          title={t.debugLogTitle}
                          className="flex-shrink-0 rounded-lg border border-line px-2.5 py-2 text-xs font-medium text-fg-soft transition-colors hover:border-warn hover:text-warn"
                        >
                          {t.debugLogButton}
                          {useDebugLogStore.getState().logs.length > 0 && (
                            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-warn-bg px-1.5 text-[9px] text-warn">
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
                )
              }
            />
          </div>
        }
      />

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
              <EmbeddedBrowserPanel workspacePath={workspacePath} lang={settings.lang} />
            </Suspense>
          </div>
        </div>
      )}
      </div>

      {openedAppId && (
        <div className="fixed inset-0 z-[60] overflow-hidden bg-base">
          <AppModal lang={settings.lang} />
        </div>
      )}
      <PluginOverlayHost lang={settings.lang} />

      <Suspense fallback={null}>
        {showSettings && <SettingsModal />}
        {showMcpSettings && <McpSettingsModal onClose={() => setShowMcpSettings(false)} onOpenMarket={() => setShowMcpMarket(true)} />}
        {showMcpMarket && <McpMarketModal onClose={() => setShowMcpMarket(false)} />}
        {showCharacters && settings.experimentalCharacters && <CharacterModal onClose={() => setShowCharacters(false)} />}
        {showAbout && <AboutModal lang={settings.lang} onClose={() => setShowAbout(false)} />}
        {showProjectSwitcher && <ProjectSwitcherModal onClose={() => setShowProjectSwitcher(false)} />}

        {showStats && (
          <StatsModal
            workspacePath={workspacePath}
            lang={settings.lang}
            onClose={() => setShowStats(false)}
            onOpenContextInspector={async () => {
              // 必须按当前会话消息重算：request-context 快照是「即将发出
              // 的请求」，不含本轮已经生成的助手总结。
              await useAgentStore.getState().computeContextSnapshot();
              setShowContextInspector(true);
            }}
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

        {showContextInspector &&
          latestContextSnapshot &&
          latestContextSnapshot.sessionId === activeSessionId && (
            <ContextInspectorModal
              snapshot={latestContextSnapshot.snapshot}
              lang={settings.lang}
              workspacePath={workspacePath ?? undefined}
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
      <McpConfirmDialog />

      <ToastContainer />
    </>
  );
}
