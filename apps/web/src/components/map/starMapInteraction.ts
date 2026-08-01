import { type StarMapCamera, clampScale } from "./starMapCamera";
import type { StarMapLayoutResult } from "./starMapLayout";

/**
 * Pure pointer/gesture and panel-breakpoint maths for the star map mount.
 * Everything the canvas mount does that can be decided without a DOM lives
 * here so it runs under the Node test harness: wheel-to-zoom conversion,
 * click-vs-drag disambiguation, star hit testing, camera easing, and the
 * width thresholds that pick the default view and the side-by-side split.
 */

/**
 * Panel width (px) at which the ticket detail splits next to the map instead
 * of replacing it. Mirrored by the `@container` rule in `index.css` — keep
 * the two in sync. A container query, not a viewport media query, because
 * `PreviewPanelShell` sizes the panel in explicit pixels.
 */
export const STAR_MAP_SPLIT_BREAKPOINT_PX = 720;
/** Below this panel width the default view is the list, not the canvas. */
export const STAR_MAP_NARROW_PANEL_THRESHOLD_PX = 380;
/** Pointer travel under which a press is a click (select), not a drag (pan). */
export const STAR_MAP_CLICK_DRAG_TOLERANCE_PX = 5;
/** Duration of the eased camera move that follows a selection. */
export const STAR_MAP_CAMERA_EASE_MS = 320;
/**
 * Screen pixels around the pointer that still count as hitting a star. A star
 * core is ~3 px, far too small to click; this is the effective touch target.
 */
export const STAR_MAP_HIT_TOLERANCE_SCREEN_PX = 20;

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
/** Matches `WHEEL_LINE_HEIGHT_PX` in `chat/overlayWheelForwarding.ts`. */
const WHEEL_LINE_HEIGHT_PX = 16;
/** Zoom strength per wheel pixel; smaller is gentler. */
const WHEEL_ZOOM_INTENSITY = 0.0022;
/** Pinch-to-zoom (ctrl+wheel) reports tiny deltas; amplify to feel comparable. */
const PINCH_ZOOM_INTENSITY = 0.01;
/** One wheel gesture never zooms more than this in a single event. */
const MAX_ZOOM_FACTOR_PER_EVENT = 1.6;

export type StarMapView = "map" | "list";

/**
 * The view the panel shows before the user touches the Map/List toggle.
 * Reduced motion always gets the list: the canvas is motion by design, so the
 * static frame it would render is strictly less useful than the list.
 */
export function defaultStarMapView(input: {
  readonly containerWidthPx: number;
  readonly prefersReducedMotion: boolean;
}): StarMapView {
  if (input.prefersReducedMotion) return "list";
  return input.containerWidthPx < STAR_MAP_NARROW_PANEL_THRESHOLD_PX ? "list" : "map";
}

/** Whether the map and the selected ticket render side by side at this width. */
export function shouldSplitStarMapDetail(containerWidthPx: number): boolean {
  return containerWidthPx >= STAR_MAP_SPLIT_BREAKPOINT_PX;
}

/**
 * Converts a wheel event into a multiplicative zoom factor (> 1 zooms in).
 * Delta modes are normalised to pixels first; ctrl/cmd+wheel (browser pinch
 * gesture) uses a stronger intensity because its deltas arrive much smaller.
 * The result is clamped per event so a fling on a high-resolution wheel can
 * not skip past the usable zoom range in one step.
 */
export function zoomFactorFromWheelDelta(input: {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): number {
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) return 1;
  const pixels =
    input.deltaMode === WHEEL_DELTA_LINE
      ? input.deltaY * WHEEL_LINE_HEIGHT_PX
      : input.deltaMode === WHEEL_DELTA_PAGE
        ? input.deltaY * WHEEL_LINE_HEIGHT_PX * 10
        : input.deltaY;
  const intensity = input.ctrlKey || input.metaKey ? PINCH_ZOOM_INTENSITY : WHEEL_ZOOM_INTENSITY;
  const factor = Math.exp(-pixels * intensity);
  return Math.min(Math.max(factor, 1 / MAX_ZOOM_FACTOR_PER_EVENT), MAX_ZOOM_FACTOR_PER_EVENT);
}

/**
 * Nearest star within `toleranceWorld` world units of `worldPoint`, or null.
 * The mount computes the tolerance from screen pixels via the camera scale,
 * so the hit target feels constant at every zoom level. Ties go to the node
 * earlier in the layout's (ordinal, id) order — deterministic, like labels.
 */
export function hitTestStarMap(
  layout: StarMapLayoutResult,
  worldPoint: { readonly x: number; readonly y: number },
  toleranceWorld: number,
): string | null {
  let bestId: string | null = null;
  let bestDistance = toleranceWorld;
  for (const position of layout.positions) {
    const distance = Math.hypot(position.x - worldPoint.x, position.y - worldPoint.y);
    // Strict <: the first (lowest ordinal) node wins an exact tie.
    if (distance < bestDistance || (bestId === null && distance <= bestDistance)) {
      bestDistance = distance;
      bestId = position.id;
    }
  }
  return bestId;
}

/** Ease-out cubic: fast start, gentle settle — reads as a camera "glide". */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - clamped) ** 3;
}

/** Linear progress 0→1 of an eased camera move, clamped at both ends. */
export function cameraEaseProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(Math.max(elapsedMs / durationMs, 0), 1);
}

/** Interpolates center and scale; `t` is eased progress in [0, 1]. */
export function interpolateCamera(
  from: StarMapCamera,
  to: StarMapCamera,
  t: number,
): StarMapCamera {
  const eased = easeOutCubic(t);
  return {
    centerX: from.centerX + (to.centerX - from.centerX) * eased,
    centerY: from.centerY + (to.centerY - from.centerY) * eased,
    scale: from.scale + (to.scale - from.scale) * eased,
  };
}

/**
 * Camera that centres a node while keeping the current zoom. Selection eases
 * the camera to the star; it must not also change the zoom the user picked.
 */
export function cameraForNodeFocus(
  layout: StarMapLayoutResult,
  nodeId: string,
  currentCamera: StarMapCamera,
): StarMapCamera | null {
  const position = layout.positionById.get(nodeId);
  if (position === undefined) return null;
  return {
    centerX: position.x,
    centerY: position.y,
    scale: clampScale(currentCamera.scale),
  };
}
