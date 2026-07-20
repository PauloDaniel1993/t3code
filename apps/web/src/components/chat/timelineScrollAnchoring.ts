export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

/**
 * Bounds for the pinned workflow activity card's expandable content (the
 * inline worker region and the plan-less worker list). The card sits above
 * the virtualized timeline as a layout sibling, so every pixel it claims
 * shrinks the list viewport. The expanded region therefore gets a bounded
 * share of the measured chat column height and scrolls internally instead of
 * crowding the timeline out of short viewports.
 */
export const WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX = 320;
export const WORKFLOW_CARD_EXPANDED_MIN_USABLE_HEIGHT_PX = 120;
export const WORKFLOW_CARD_EXPANDED_VIEWPORT_SHARE = 0.45;

/**
 * Resolve the max-height (px) for the workflow card's expanded content given
 * the measured chat column height. Falls back to the cap when the column has
 * not been measured yet, and keeps a usable minimum on very short viewports
 * so the region's controls stay operable.
 */
export function resolveWorkflowCardExpandedMaxHeight(chatColumnHeight: number): number {
  if (!Number.isFinite(chatColumnHeight) || chatColumnHeight <= 0) {
    return WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX;
  }
  const shared = Math.floor(chatColumnHeight * WORKFLOW_CARD_EXPANDED_VIEWPORT_SHARE);
  return Math.max(
    WORKFLOW_CARD_EXPANDED_MIN_USABLE_HEIGHT_PX,
    Math.min(WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX, shared),
  );
}

// ---------------------------------------------------------------------------
// Pinned workflow card scroll compensation
// ---------------------------------------------------------------------------

/**
 * Settled height delta (px) between two measured workflow-card heights. The
 * card is a layout sibling above LegendList, so every pixel it gains or loses
 * shrinks or grows the list viewport by the same amount. Returns 0 for
 * unchanged or non-finite/negative measurements so callers only react to real
 * settled deltas.
 */
export function resolveWorkflowCardHeightDelta(previousHeight: number, nextHeight: number): number {
  if (
    !Number.isFinite(previousHeight) ||
    !Number.isFinite(nextHeight) ||
    previousHeight < 0 ||
    nextHeight < 0
  ) {
    return 0;
  }
  return nextHeight - previousHeight;
}

export interface WorkflowCardHeightBookkeeping {
  readonly ownerKey: string | null;
  readonly height: number;
  readonly hasBaseline: boolean;
  readonly pendingDelta: number;
}

export function createWorkflowCardHeightBookkeeping(
  ownerKey: string | null,
): WorkflowCardHeightBookkeeping {
  return { ownerKey, height: 0, hasBaseline: false, pendingDelta: 0 };
}

export function reconcileWorkflowCardHeightOwner(
  bookkeeping: WorkflowCardHeightBookkeeping,
  ownerKey: string | null,
): WorkflowCardHeightBookkeeping {
  return bookkeeping.ownerKey === ownerKey
    ? bookkeeping
    : createWorkflowCardHeightBookkeeping(ownerKey);
}

export function recordWorkflowCardHeight(
  bookkeeping: WorkflowCardHeightBookkeeping,
  ownerKey: string | null,
  nextHeight: number,
): WorkflowCardHeightBookkeeping {
  if (bookkeeping.ownerKey !== ownerKey || !Number.isFinite(nextHeight) || nextHeight < 0) {
    return bookkeeping;
  }

  // The first measurement for a newly selected thread establishes that
  // thread's baseline. Treating it as a 0 -> H resize compensates for the
  // entire incoming card after the list has already switched owners, which
  // produces a visible whole-card jump. A real 0 -> H mount is still observed
  // when the current owner first establishes a zero-height baseline while no
  // card is present and then receives a card.
  if (!bookkeeping.hasBaseline) {
    return {
      ownerKey,
      height: nextHeight,
      hasBaseline: true,
      pendingDelta: 0,
    };
  }

  const heightDelta = resolveWorkflowCardHeightDelta(bookkeeping.height, nextHeight);
  if (heightDelta === 0) {
    return bookkeeping;
  }

  return {
    ownerKey,
    height: nextHeight,
    hasBaseline: true,
    pendingDelta: bookkeeping.pendingDelta + heightDelta,
  };
}

export function consumeWorkflowCardHeightDelta(
  bookkeeping: WorkflowCardHeightBookkeeping,
  ownerKey: string | null,
): {
  readonly bookkeeping: WorkflowCardHeightBookkeeping;
  readonly heightDelta: number;
} {
  if (bookkeeping.ownerKey !== ownerKey || bookkeeping.pendingDelta === 0) {
    return { bookkeeping, heightDelta: 0 };
  }

  return {
    bookkeeping: { ...bookkeeping, pendingDelta: 0 },
    heightDelta: bookkeeping.pendingDelta,
  };
}

/**
 * How the timeline should react to a non-zero workflow-card height delta so
 * each LegendList scroll mode is preserved explicitly instead of relying on
 * sibling layout side effects:
 * - `restore-end`: following-end re-scrolls to the latest real row.
 * - `preserve-offset`: free-scrolling shifts the offset by the measured delta
 *   so the row under the reader's eye keeps its document position (the card
 *   pushed the whole list viewport down by the same amount).
 * - `revalidate-anchor`: anchoring-new-turn reruns anchor metrics against the
 *   resized viewport without clearing the anchor or changing modes.
 */
export type WorkflowCardScrollCompensation =
  | { readonly kind: "none" }
  | { readonly kind: "restore-end" }
  | {
      readonly kind: "preserve-offset";
      readonly offsetDelta: number;
      readonly targetOffset: number;
    }
  | { readonly kind: "revalidate-anchor" };

export function resolveWorkflowCardScrollCompensation({
  mode,
  heightDelta,
  state,
}: {
  readonly mode: TimelineScrollMode;
  readonly heightDelta: number;
  readonly state: Pick<TimelineListMeasurementState, "data" | "scroll"> | null | undefined;
}): WorkflowCardScrollCompensation {
  if (!Number.isFinite(heightDelta) || heightDelta === 0) {
    return { kind: "none" };
  }
  if (!state || state.data.length === 0) {
    return { kind: "none" };
  }
  if (mode === "following-end") {
    return { kind: "restore-end" };
  }
  if (mode === "anchoring-new-turn") {
    return { kind: "revalidate-anchor" };
  }
  const currentScroll = Number.isFinite(state.scroll) ? Math.max(0, state.scroll) : 0;
  return {
    kind: "preserve-offset",
    offsetDelta: heightDelta,
    targetOffset: Math.max(0, currentScroll + heightDelta),
  };
}

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
