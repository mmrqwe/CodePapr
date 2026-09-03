import { lazy, Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, isApiConfigured } from './store/agentStore';
import { usePreviewStore } from './store/previewStore';
import { useBrowserViewStore } from './store/browserViewStore';
import { useAppRuntimeStore } from './store/appRuntimeStore';
import { isPluginApp, pluginIsEnabled, pluginShouldAutostartOverlay, readAppManifest, selectDockedPluginId } from './papr/pluginSurface';
import { loadPluginUi } from './papr/pluginUiStorage';
import { setPluginDockSlot } from './papr/pluginDockSlot';
import { useCharactersStore } from './store/charactersStore';
import { pushDebugLog } from './store/debugLogStore';
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
import { findPreviewProcessForPort, processPreviewUrl } from './utils/loopbackPreview';
import { usePermissionStore } from './store/permissionStore';
import type { PreviewLocation } from './utils/projectDiagnosticLocations';
import { cacheGet, cacheSet } from './utils/cacheStorage';
