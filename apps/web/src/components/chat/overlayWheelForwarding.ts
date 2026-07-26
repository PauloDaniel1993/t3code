/**
 * The pinned activity card, the approval/user-input cards, and the composer are
 * overlays stacked on top of the timeline, not descendants of its scroller. A
 * wheel gesture over any of them therefore reaches no scrollable ancestor and
 * the transcript sits frozen under the reader's cursor. These helpers turn such
 * a gesture back into a timeline scroll, while leaving genuinely scrollable
 * overlay content (an expanded worker list, the prompt editor) to consume it.
 */

/** Chrome reports line-mode wheels in ~16px lines. */
export const WHEEL_LINE_HEIGHT_PX = 16;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** Sub-pixel deltas come from inertia tails and are not worth a scroll write. */
const MIN_FORWARDED_DELTA_PX = 0.5;

export function resolveWheelDeltaPixels(input: {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly viewportHeight: number;
}): number {
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) {
    return 0;
  }
  const pixels =
    input.deltaMode === DOM_DELTA_LINE
      ? input.deltaY * WHEEL_LINE_HEIGHT_PX
      : input.deltaMode === DOM_DELTA_PAGE
        ? input.deltaY * Math.max(1, input.viewportHeight)
        : input.deltaY;
  return Math.abs(pixels) < MIN_FORWARDED_DELTA_PX ? 0 : pixels;
}

export interface WheelScrollableElement {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly parentElement: WheelScrollableElement | null;
}

/**
 * Whether this element scrolls on its own axis and still has room to travel in
 * the gesture's direction. An element already pinned at the relevant edge is
 * treated as unable to consume, so the gesture keeps flowing to the timeline
 * instead of dying on an exhausted inner scroller.
 */
export function elementConsumesWheel(
  element: WheelScrollableElement,
  deltaPixels: number,
): boolean {
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  if (maxScrollTop <= 1) {
    return false;
  }
  return deltaPixels < 0 ? element.scrollTop > 1 : element.scrollTop < maxScrollTop - 1;
}

/**
 * Walk from the wheel target up to (and including) the overlay host, looking
 * for content that should handle the gesture itself.
 */
export function overlayConsumesWheel(input: {
  readonly target: WheelScrollableElement | null;
  readonly host: WheelScrollableElement;
  readonly deltaPixels: number;
}): boolean {
  let element = input.target;
  while (element) {
    if (elementConsumesWheel(element, input.deltaPixels)) {
      return true;
    }
    if (element === input.host) {
      return false;
    }
    element = element.parentElement;
  }
  return false;
}
