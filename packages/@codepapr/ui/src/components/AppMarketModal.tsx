import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { fetchMarketAppListings } from '../tools/marketAppApi';
import { installMarketApp, uninstallMarketApp } from '../tools/marketAppInstall';
import type { PaprAppListing, AppInstallScope } from '../utils/marketAppTypes';
import { isMarketUpdateAvailable, readInstalledAppVersion } from '../utils/marketAppVersion';
import type { Lang } from '../utils/i18n';
import { DangerConfirmDialog } from './DangerConfirmDialog';

interface AppMarketModalProps {
  onClose: () => void;
}

export function AppMarketModal({ onClose }: AppMarketModalProps) {
  return null;
}
