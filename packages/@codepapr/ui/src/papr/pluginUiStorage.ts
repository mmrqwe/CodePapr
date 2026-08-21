import { loadProjectMeta, saveProjectMeta } from '../utils/projectStorage';
import {
  OVERLAY_DEFAULT_HEIGHT,
  OVERLAY_DEFAULT_WIDTH,
  type OverlayLayout,
  type PluginSizeSource,
} from './pluginSurface';

export const PLUGIN_UI_META_KEY = 'papr.plugin_ui';

export interface PluginChrome {
  enabled: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  sizeSource?: PluginSizeSource;
}

export interface PluginUiState {
  chrome: Record<string, PluginChrome>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSizeSource(value: unknown): PluginSizeSource | undefined {
  return value === 'manifest' || value === 'plugin' || value === 'user' ? value : undefined;
}

function parseChrome(value: unknown): PluginChrome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    x: finiteNumber(raw.x),
    y: finiteNumber(raw.y),
    width: finiteNumber(raw.width),
    height: finiteNumber(raw.height),
    sizeSource: parseSizeSource(raw.sizeSource),
  };
}

export function parsePluginUiState(raw: unknown): PluginUiState {
  const chrome: Record<string, PluginChrome> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { chrome };
  }
  const source = (raw as { chrome?: unknown }).chrome;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { chrome };
  }
  for (const [appId, value] of Object.entries(source as Record<string, unknown>)) {
    if (!appId || appId.includes('/') || appId.includes('\\') || appId.includes('..')) continue;
    const parsed = parseChrome(value);
    if (parsed) chrome[appId] = parsed;
  }
  return { chrome };
}

export function emptyPluginUiState(): PluginUiState {
  return { chrome: {} };
}

export function layoutFromChrome(chrome: PluginChrome): OverlayLayout | null {
  if (chrome.x === undefined || chrome.y === undefined) return null;
  return {
    x: chrome.x,
    y: chrome.y,
    width: chrome.width ?? OVERLAY_DEFAULT_WIDTH,
    height: chrome.height ?? OVERLAY_DEFAULT_HEIGHT,
    sizeSource: chrome.sizeSource,
  };
}

export function layoutsFromChrome(chrome: Record<string, PluginChrome>): Record<string, OverlayLayout> {
  const layouts: Record<string, OverlayLayout> = {};
  for (const [appId, record] of Object.entries(chrome)) {
    const layout = layoutFromChrome(record);
    if (layout) layouts[appId] = layout;
  }
  return layouts;
}

export async function loadPluginUi(workspacePath: string): Promise<PluginUiState> {
  try {
    const raw = await loadProjectMeta(workspacePath, PLUGIN_UI_META_KEY);
    return parsePluginUiState(raw);
  } catch {
    return emptyPluginUiState();
  }
}

let saveQueue: Promise<void> = Promise.resolve();

export function queueSavePluginUi(workspacePath: string, state: PluginUiState): Promise<void> {
  const next = saveQueue.then(
    () => saveProjectMeta(workspacePath, PLUGIN_UI_META_KEY, state),
    () => saveProjectMeta(workspacePath, PLUGIN_UI_META_KEY, state),
  );
  saveQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
