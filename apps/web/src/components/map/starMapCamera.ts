/**
 * Camera for the star map canvas: fits the panel-independent world layout to
 * a pixel viewport, keeps panning and zooming from losing the constellation,
 * and converts between world units and screen pixels. This is the only place
 * panel pixels meet the world; the layout solver never sees them.
 *
 * Screen coordinates are CSS pixels with a top-left origin; world coordinates
 * are layout units centered on the world origin. `scale` is screen pixels per
 * world unit.
 */

export const STAR_MAP_MIN_SCALE = 0.05;
export const STAR_MAP_MAX_SCALE = 4;
export const STAR_MAP_FIT_PADDING = 1.12;
/** World units of content kept visible when clamping a pan or zoom. */
const EDGE_VISIBLE_MARGIN = 60;

export interface StarMapPoint {
  readonly x: number;
  readonly y: number;
}

export interface StarMapSize {
  readonly width: number;
  readonly height: number;
}

export interface StarMapBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface StarMapCamera {
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
}

export function boundsFromPoints(points: ReadonlyArray<StarMapPoint>, padding = 0): StarMapBounds {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

export function boundsCenter(bounds: StarMapBounds): StarMapPoint {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, STAR_MAP_MIN_SCALE), STAR_MAP_MAX_SCALE);
}

export function fitCameraToBounds(bounds: StarMapBounds, viewport: StarMapSize): StarMapCamera {
  const center = boundsCenter(bounds);
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { centerX: center.x, centerY: center.y, scale: 1 };
  }
  // A single point (or empty bounds) has no extent; the epsilon keeps the fit
  // finite and simply lands on the max-zoom end of the clamp.
  const contentWidth = Math.max(bounds.maxX - bounds.minX, 1) * STAR_MAP_FIT_PADDING;
  const contentHeight = Math.max(bounds.maxY - bounds.minY, 1) * STAR_MAP_FIT_PADDING;
  const scale = clampScale(
    Math.min(viewport.width / contentWidth, viewport.height / contentHeight),
  );
  return { centerX: center.x, centerY: center.y, scale };
}

export function worldToScreen(
  camera: StarMapCamera,
  viewport: StarMapSize,
  point: StarMapPoint,
): StarMapPoint {
  return {
    x: (point.x - camera.centerX) * camera.scale + viewport.width / 2,
    y: (point.y - camera.centerY) * camera.scale + viewport.height / 2,
  };
}

export function screenToWorld(
  camera: StarMapCamera,
  viewport: StarMapSize,
  point: StarMapPoint,
): StarMapPoint {
  return {
    x: camera.centerX + (point.x - viewport.width / 2) / camera.scale,
    y: camera.centerY + (point.y - viewport.height / 2) / camera.scale,
  };
}

/**
 * Moves the camera opposite a screen-space drag, so the content follows the
 * pointer. Returns the unclamped camera; compose with `clampCamera`.
 */
export function panCameraBy(
  camera: StarMapCamera,
  deltaScreenX: number,
  deltaScreenY: number,
): StarMapCamera {
  return {
    ...camera,
    centerX: camera.centerX - deltaScreenX / camera.scale,
    centerY: camera.centerY - deltaScreenY / camera.scale,
  };
}

/** Zooms by `factor` while keeping the world point under `anchor` fixed. */
export function zoomCameraAt(
  camera: StarMapCamera,
  viewport: StarMapSize,
  anchor: StarMapPoint,
  factor: number,
): StarMapCamera {
  if (!(factor > 0)) return camera;
  const scale = clampScale(camera.scale * factor);
  const worldAnchor = screenToWorld(camera, viewport, anchor);
  return {
    centerX: worldAnchor.x - (anchor.x - viewport.width / 2) / scale,
    centerY: worldAnchor.y - (anchor.y - viewport.height / 2) / scale,
    scale,
  };
}

/**
 * Clamps scale and keeps at least `EDGE_VISIBLE_MARGIN` world units of the
 * content in view, so panning or zooming can never strand the user in empty
 * space. When the content is smaller than that margin the allowed range
 * inverts and the camera settles on the content center instead.
 */
export function clampCamera(
  camera: StarMapCamera,
  bounds: StarMapBounds,
  viewport: StarMapSize,
): StarMapCamera {
  const scale = clampScale(camera.scale);
  const center = boundsCenter(bounds);
  const halfViewWidth = viewport.width / (2 * scale);
  const halfViewHeight = viewport.height / (2 * scale);
  return {
    scale,
    centerX: clampAxis(
      camera.centerX,
      bounds.minX - halfViewWidth + EDGE_VISIBLE_MARGIN,
      bounds.maxX + halfViewWidth - EDGE_VISIBLE_MARGIN,
      center.x,
    ),
    centerY: clampAxis(
      camera.centerY,
      bounds.minY - halfViewHeight + EDGE_VISIBLE_MARGIN,
      bounds.maxY + halfViewHeight - EDGE_VISIBLE_MARGIN,
      center.y,
    ),
  };
}

function clampAxis(value: number, low: number, high: number, fallback: number): number {
  if (low > high) return fallback;
  return Math.min(Math.max(value, low), high);
}
