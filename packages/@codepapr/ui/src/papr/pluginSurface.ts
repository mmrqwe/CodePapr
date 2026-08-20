import type { PaprKind, PaprManifest, PaprOverlayPosition } from '@codepapr/types';

export const OVERLAY_DEFAULT_WIDTH = 320;
export const OVERLAY_DEFAULT_HEIGHT = 200;
export const OVERLAY_MIN_WIDTH = 200;
export const OVERLAY_MAX_WIDTH = 720;
export const OVERLAY_MIN_HEIGHT = 100;
export const OVERLAY_MAX_HEIGHT = 640;
export const OVERLAY_EDGE = 16;
export const OVERLAY_TOP_INSET = 52;

export const OVERLAY_POSITIONS: readonly PaprOverlayPosition[] = [
  'top-right',
  'top-left',
  'bottom-right',
  'bottom-left',
];

export interface OverlayLayout {
  x: number;
  y: number;
}

export interface ResolvedOverlaySurface {
  type: 'overlay';
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
  const width = clampNumber(
    typeof surface?.width === 'number' && Number.isFinite(surface.width)
      ? Math.round(surface.width)
      : OVERLAY_DEFAULT_WIDTH,
    OVERLAY_MIN_WIDTH,
    OVERLAY_MAX_WIDTH,
  );
  const height = clampNumber(
    typeof surface?.height === 'number' && Number.isFinite(surface.height)
      ? Math.round(surface.height)
      : OVERLAY_DEFAULT_HEIGHT,
    OVERLAY_MIN_HEIGHT,
    OVERLAY_MAX_HEIGHT,
  );
  const position = isOverlayPosition(surface?.position) ? surface.position : 'top-right';
  return { type: 'overlay', width, height, position };
}

export function clampOverlayOrigin(
  origin: OverlayLayout,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  edge = 8,
): OverlayLayout {
  const maxX = Math.max(edge, viewport.width - size.width - edge);
  const maxY = Math.max(edge, viewport.height - size.height - edge);
  return {
    x: clampNumber(origin.x, edge, maxX),
    y: clampNumber(origin.y, edge, maxY),
  };
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
  return clampOverlayOrigin({ x, y }, size, viewport);
}

/** 供打开应用时校验 manifest.surface：只接受 overlay。缺省给出默认几何。 */
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
  if (type !== 'overlay') {
    throw new Error(`当前仅支持 surface.type: "overlay"（主窗口悬浮）。收到: ${JSON.stringify(rawType)}`);
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
  return resolveOverlaySurface({ spec: 'papr/0.1', name: 'tmp', surface: { type: 'overlay', width: surface.width, height: surface.height, position: surface.position } });
}
