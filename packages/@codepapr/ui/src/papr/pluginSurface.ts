import type { PaprKind, PaprManifest, PaprOverlayPosition } from '@codepapr/types';

export const OVERLAY_DEFAULT_WIDTH = 320;
export const OVERLAY_DEFAULT_HEIGHT = 200;
export const OVERLAY_MIN_WIDTH = 200;
export const OVERLAY_MIN_HEIGHT = 100;
export const OVERLAY_EDGE = 16;
export const OVERLAY_TOP_INSET = 52;
export const OVERLAY_CHROME_HEIGHT = 28;

export type PluginSizeSource = 'manifest' | 'plugin' | 'user';
export type OverlayResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface OverlayOrigin {
  x: number;
  y: number;
}

export interface OverlayLayout extends OverlayOrigin {
  width: number;
  height: number;
  sizeSource?: PluginSizeSource;
}

export interface PluginWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
}

export const OVERLAY_POSITIONS: readonly PaprOverlayPosition[] = [
  'top-right',
  'top-left',
  'bottom-right',
  'bottom-left',
];

export type PluginPlacement = 'float' | 'right';

export interface ResolvedOverlaySurface {
  type: 'overlay' | 'panel';
  width: number;
  height: number;
  position: PaprOverlayPosition;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isOverlayPosition(value: unknown): value is PaprOverlayPosition {
  return typeof value === 'string' && (OVERLAY_POSITIONS as readonly string[]).includes(value);
}

export function parsePaprKind(manifest: PaprManifest | null | undefined): PaprKind {
  return manifest?.kind === 'plugin' ? 'plugin' : 'app';
}

export function isPluginManifest(manifest: PaprManifest | null | undefined): boolean {
  return parsePaprKind(manifest) === 'plugin';
}

export function readAppManifest(app: { manifestJson?: string } | null | undefined): PaprManifest | null {
  if (!app?.manifestJson) return null;
  try {
    return JSON.parse(app.manifestJson) as PaprManifest;
  } catch {
    return null;
  }
}

export function isPluginApp(app: { manifestJson?: string } | null | undefined): boolean {
  return isPluginManifest(readAppManifest(app));
}

export function resolvePaprEntryFile(manifest: PaprManifest | null | undefined): string {
  const raw = manifest?.entry?.trim();
  if (!raw || raw.includes('..') || raw.includes('\\')) {
    return 'index.html';
  }
  return raw;
}

export function resolveOverlaySurface(manifest: PaprManifest | null | undefined): ResolvedOverlaySurface {
  const surface = manifest?.surface;
  const type = surface?.type === 'panel' ? 'panel' : 'overlay';
  const rawWidth = typeof surface?.width === 'number' && Number.isFinite(surface.width)
    ? Math.round(surface.width)
    : OVERLAY_DEFAULT_WIDTH;
  const rawHeight = typeof surface?.height === 'number' && Number.isFinite(surface.height)
    ? Math.round(surface.height)
    : OVERLAY_DEFAULT_HEIGHT;
  const width = Math.max(OVERLAY_MIN_WIDTH, rawWidth);
  const height = Math.max(OVERLAY_MIN_HEIGHT, rawHeight);
  const position = isOverlayPosition(surface?.position) ? surface.position : 'top-right';
  return { type, width, height, position };
}

export function isOverlayResizable(manifest: PaprManifest | null | undefined): boolean {
  return manifest?.surface?.resizable !== false;
}

export function shouldPersistPluginPosition(manifest: PaprManifest | null | undefined): boolean {
  return manifest?.lifecycle?.persistPosition !== false;
}

export type PluginShowPolicy = 'always' | 'onDemand' | 'never';

export function pluginHasInbox(manifest: PaprManifest | null | undefined): boolean {
  const inbox = manifest?.inbox;
  return !!inbox && typeof inbox === 'object' && !Array.isArray(inbox) && Object.keys(inbox).length > 0;
}

export function resolvePluginShowPolicy(manifest: PaprManifest | null | undefined): PluginShowPolicy {
  const show = manifest?.lifecycle?.show;
  if (show === 'always' || show === 'onDemand' || show === 'never') return show;
  return pluginHasInbox(manifest) ? 'onDemand' : 'always';
}

export function pluginIsEnabled(
  manifest: PaprManifest | null | undefined,
  chrome: { enabled?: boolean } | null | undefined,
): boolean {
  if (chrome && typeof chrome.enabled === 'boolean') return chrome.enabled;
  return manifest?.lifecycle?.autostart !== false;
}

/** 工作区扫描时要不要自动钉 overlay。用户已持久化 visible 时以用户为准。 */
export function pluginShouldAutostartOverlay(
  manifest: PaprManifest | null | undefined,
  chrome: { enabled?: boolean; visible?: boolean } | null | undefined,
): boolean {
  if (!pluginIsEnabled(manifest, chrome)) return false;
  if (chrome && typeof chrome.visible === 'boolean') return chrome.visible;
  return resolvePluginShowPolicy(manifest) === 'always';
}

export function shouldRevealOnPublish(
  manifest: PaprManifest | null | undefined,
  chrome: { enabled?: boolean } | null | undefined,
  isVisible: boolean,
): boolean {
  if (isVisible) return false;
  if (!pluginIsEnabled(manifest, chrome)) return false;
  return resolvePluginShowPolicy(manifest) === 'onDemand';
}

export function defaultPluginPlacement(manifest: PaprManifest | null | undefined): PluginPlacement {
  if (manifest?.surface?.type === 'panel') return 'right';
  if (pluginHasInbox(manifest)) return 'right';
  return 'float';
}

/** 用户显式 placement 优先。有几何的旧 chrome 一律 float，避免升级吞掉工作台。 */
export function resolveShowPlacement(
  manifest: PaprManifest | null | undefined,
  chrome: { placement?: PluginPlacement; x?: number; y?: number } | null | undefined,
): PluginPlacement {
  if (chrome?.placement === 'right' || chrome?.placement === 'float') return chrome.placement;
  if (chrome && (chrome.x !== undefined || chrome.y !== undefined)) return 'float';
  return defaultPluginPlacement(manifest);
}

export function selectDockedPluginId(state: {
  apps: readonly { appId: string; manifestJson?: string }[];
  pinnedPluginIds: readonly string[];
  pluginChrome: Record<string, { placement?: PluginPlacement; x?: number; y?: number }>;
}): string | null {
  const byId = new Map(state.apps.map((app) => [app.appId, app]));
  for (const appId of state.pinnedPluginIds) {
    const app = byId.get(appId);
    if (!app || !isPluginApp(app)) continue;
    if (resolveShowPlacement(readAppManifest(app), state.pluginChrome[appId]) === 'right') {
      return appId;
    }
  }
  return null;
}

export function clampOverlayOrigin(
  origin: OverlayOrigin,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  edge = 8,
): OverlayOrigin {
  const maxX = Math.max(edge, viewport.width - size.width - edge);
  const maxY = Math.max(edge, viewport.height - size.height - edge);
  return {
    x: clampNumber(origin.x, edge, maxX),
    y: clampNumber(origin.y, edge, maxY),
  };
}

export function clampOverlaySize(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  edge = 8,
): { width: number; height: number } {
  const maxWidth = Math.max(OVERLAY_MIN_WIDTH, viewport.width - edge * 2);
  const maxHeight = Math.max(OVERLAY_MIN_HEIGHT, viewport.height - edge * 2);
  return {
    width: clampNumber(Math.round(size.width), OVERLAY_MIN_WIDTH, maxWidth),
    height: clampNumber(Math.round(size.height), OVERLAY_MIN_HEIGHT, maxHeight),
  };
}

export function clampOverlayRect(
  layout: OverlayLayout,
  viewport: { width: number; height: number },
  edge = 8,
): OverlayLayout {
  const size = clampOverlaySize(layout, viewport, edge);
  const origin = clampOverlayOrigin(layout, size, viewport, edge);
  return { ...layout, ...origin, ...size };
}

export function defaultOverlayOrigin(
  position: PaprOverlayPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  index: number,
): OverlayLayout {
  const offset = index * 28;
  let x: number;
  let y: number;
  switch (position) {
    case 'top-left':
      x = OVERLAY_EDGE + offset;
      y = OVERLAY_TOP_INSET + offset;
      break;
    case 'bottom-left':
      x = OVERLAY_EDGE + offset;
      y = viewport.height - size.height - OVERLAY_EDGE - offset;
      break;
    case 'bottom-right':
      x = viewport.width - size.width - OVERLAY_EDGE - offset;
      y = viewport.height - size.height - OVERLAY_EDGE - offset;
      break;
    case 'top-right':
    default:
      x = viewport.width - size.width - OVERLAY_EDGE - offset;
      y = OVERLAY_TOP_INSET + offset;
      break;
  }
  return clampOverlayRect(
    { x, y, width: size.width, height: size.height, sizeSource: 'manifest' },
    viewport,
  );
}

export function applyOverlayResize(
  start: OverlayLayout,
  dir: OverlayResizeDir,
  dx: number,
  dy: number,
): OverlayLayout {
  let { x, y, width, height } = start;
  if (dir.includes('e')) width += dx;
  if (dir.includes('s')) height += dy;
  if (dir.includes('w')) {
    width -= dx;
    x += dx;
  }
  if (dir.includes('n')) {
    height -= dy;
    y += dy;
  }
  return { ...start, x, y, width, height, sizeSource: 'user' };
}

export function overlayToWindowBounds(layout: OverlayLayout): PluginWindowBounds {
  return {
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    contentWidth: layout.width,
    contentHeight: Math.max(0, layout.height - OVERLAY_CHROME_HEIGHT),
  };
}

export function overlayFromSetSize(
  current: OverlayLayout,
  payload: { width: number; height: number; box?: unknown },
): OverlayLayout {
  const box = payload.box === 'overlay' ? 'overlay' : 'content';
  const width = payload.width;
  const height = box === 'overlay' ? payload.height : payload.height + OVERLAY_CHROME_HEIGHT;
  return { ...current, width, height, sizeSource: 'plugin' };
}

/** 供打开应用时校验 manifest.surface：overlay 浮卡或 panel 右栏。缺省给出默认几何。 */
export function parsePluginSurfaceArg(raw: unknown): ResolvedOverlaySurface {
  if (raw === undefined || raw === null) {
    return {
      type: 'overlay',
      width: OVERLAY_DEFAULT_WIDTH,
      height: OVERLAY_DEFAULT_HEIGHT,
      position: 'top-right',
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`surface 必须是对象，收到: ${JSON.stringify(raw)}`);
  }
  const surface = raw as Record<string, unknown>;
  const rawType = surface.type;
  const type = rawType === undefined || rawType === null || rawType === ''
    ? 'overlay'
    : rawType;
  if (type !== 'overlay' && type !== 'panel') {
    throw new Error(`当前仅支持 surface.type: "overlay" 或 "panel"。收到: ${JSON.stringify(rawType)}`);
  }
  if (surface.width !== undefined && (typeof surface.width !== 'number' || !Number.isFinite(surface.width))) {
    throw new Error(`surface.width 必须是数字，收到: ${JSON.stringify(surface.width)}`);
  }
  if (surface.height !== undefined && (typeof surface.height !== 'number' || !Number.isFinite(surface.height))) {
    throw new Error(`surface.height 必须是数字，收到: ${JSON.stringify(surface.height)}`);
  }
  if (surface.position !== undefined && !isOverlayPosition(surface.position)) {
    throw new Error(
      `surface.position 必须是 ${OVERLAY_POSITIONS.join('/')}，收到: ${JSON.stringify(surface.position)}`,
    );
  }
  return resolveOverlaySurface({
    spec: 'papr/0.1',
    name: 'tmp',
    surface: {
      type,
      width: surface.width as number | undefined,
      height: surface.height as number | undefined,
      position: surface.position as PaprOverlayPosition | undefined,
    },
  });
}
