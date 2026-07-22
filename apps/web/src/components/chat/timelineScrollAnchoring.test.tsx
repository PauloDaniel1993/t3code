import { describe, expect, it } from "vite-plus/test";
import {
  WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX,
  WORKFLOW_CARD_EXPANDED_MIN_USABLE_HEIGHT_PX,
  WORKFLOW_CARD_EXPANDED_VIEWPORT_SHARE,
  WORKFLOW_CARD_COMPOSER_HEIGHT_MULTIPLIER,
  consumeWorkflowCardHeightDelta,
  createWorkflowCardHeightBookkeeping,
  getAnchoredTurnMetrics,
  getRowBottom,
  reconcileWorkflowCardHeightOwner,
  recordWorkflowCardHeight,
  resolveWorkflowCardExpandedMaxHeight,
  resolveWorkflowCardHeightDelta,
  resolveWorkflowCardMaxHeight,
  resolveWorkflowCardScrollCompensation,
  type TimelineScrollMode,
} from "./timelineScrollAnchoring";

describe("resolveWorkflowCardMaxHeight", () => {
  it("caps the activity surface at two composer heights", () => {
    expect(WORKFLOW_CARD_COMPOSER_HEIGHT_MULTIPLIER).toBe(2);
    expect(resolveWorkflowCardMaxHeight(140)).toBe(280);
    expect(resolveWorkflowCardMaxHeight(101)).toBe(202);
  });

  it("waits for a valid positive composer measurement", () => {
    expect(resolveWorkflowCardMaxHeight(0)).toBeUndefined();
    expect(resolveWorkflowCardMaxHeight(-1)).toBeUndefined();
    expect(resolveWorkflowCardMaxHeight(Number.NaN)).toBeUndefined();
  });
});

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});

describe("workflow card expanded max height", () => {
  it("falls back to the cap before the chat column is measured", () => {
    expect(resolveWorkflowCardExpandedMaxHeight(0)).toBe(WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX);
    expect(resolveWorkflowCardExpandedMaxHeight(Number.NaN)).toBe(
      WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX,
    );
    expect(resolveWorkflowCardExpandedMaxHeight(-120)).toBe(WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX);
  });

  it("caps the expanded region on tall columns so the timeline keeps room", () => {
    expect(resolveWorkflowCardExpandedMaxHeight(4000)).toBe(WORKFLOW_CARD_EXPANDED_MAX_HEIGHT_PX);
  });

  it("shares the measured column height on medium columns", () => {
    const columnHeight = 600;
    expect(resolveWorkflowCardExpandedMaxHeight(columnHeight)).toBe(
      Math.floor(columnHeight * WORKFLOW_CARD_EXPANDED_VIEWPORT_SHARE),
    );
  });

  it("keeps a usable minimum on very short viewports so controls stay operable", () => {
    const columnHeight = 200;
    expect(Math.floor(columnHeight * WORKFLOW_CARD_EXPANDED_VIEWPORT_SHARE)).toBeLessThan(
      WORKFLOW_CARD_EXPANDED_MIN_USABLE_HEIGHT_PX,
    );
    expect(resolveWorkflowCardExpandedMaxHeight(columnHeight)).toBe(
      WORKFLOW_CARD_EXPANDED_MIN_USABLE_HEIGHT_PX,
    );
  });
});

describe("resolveWorkflowCardHeightDelta", () => {
  it("returns the settled delta for growing and shrinking cards", () => {
    expect(resolveWorkflowCardHeightDelta(100, 160)).toBe(60);
    expect(resolveWorkflowCardHeightDelta(160, 100)).toBe(-60);
  });

  it("returns zero when the settled height is unchanged", () => {
    expect(resolveWorkflowCardHeightDelta(100, 100)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(0, 0)).toBe(0);
  });

  it("measures mount and unmount transitions from and to zero", () => {
    expect(resolveWorkflowCardHeightDelta(0, 120)).toBe(120);
    expect(resolveWorkflowCardHeightDelta(120, 0)).toBe(-120);
  });

  it("treats non-finite or negative measurements as no delta", () => {
    expect(resolveWorkflowCardHeightDelta(Number.NaN, 100)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(100, Number.NaN)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(100, Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(Number.NEGATIVE_INFINITY, 100)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(-4, 100)).toBe(0);
    expect(resolveWorkflowCardHeightDelta(100, -4)).toBe(0);
  });
});

describe("workflow card height ownership", () => {
  it("preserves a child measurement across the later parent reset before a small resize", () => {
    let bookkeeping = createWorkflowCardHeightBookkeeping("thread-a");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    bookkeeping = consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").bookkeeping;

    bookkeeping = reconcileWorkflowCardHeightOwner(bookkeeping, "thread-b");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-b", 180);

    const afterChildMeasurement = bookkeeping;
    bookkeeping = reconcileWorkflowCardHeightOwner(bookkeeping, "thread-b");
    expect(bookkeeping).toBe(afterChildMeasurement);

    const mounted = consumeWorkflowCardHeightDelta(bookkeeping, "thread-b");
    expect(mounted.heightDelta).toBe(0);
    bookkeeping = recordWorkflowCardHeight(mounted.bookkeeping, "thread-b", 184);

    const resized = consumeWorkflowCardHeightDelta(bookkeeping, "thread-b");
    expect(resized.heightDelta).toBe(4);
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scroll: 320,
    });
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "following-end",
        heightDelta: resized.heightDelta,
        state,
      }),
    ).toEqual({ kind: "restore-end" });
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "anchoring-new-turn",
        heightDelta: resized.heightDelta,
        state,
      }),
    ).toEqual({ kind: "revalidate-anchor" });
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "free-scrolling",
        heightDelta: resized.heightDelta,
        state,
      }),
    ).toEqual({ kind: "preserve-offset", offsetDelta: 4, targetOffset: 324 });
  });

  it("ignores stale measurements and pending-delta consumption from the previous thread", () => {
    let bookkeeping = createWorkflowCardHeightBookkeeping("thread-a");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    bookkeeping = reconcileWorkflowCardHeightOwner(bookkeeping, "thread-b");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-b", 180);

    const beforeStaleCallbacks = bookkeeping;
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 124);
    expect(bookkeeping).toBe(beforeStaleCallbacks);

    const staleFrame = consumeWorkflowCardHeightDelta(bookkeeping, "thread-a");
    expect(staleFrame.heightDelta).toBe(0);
    expect(staleFrame.bookkeeping).toBe(bookkeeping);
    expect(consumeWorkflowCardHeightDelta(bookkeeping, "thread-b").heightDelta).toBe(0);
  });

  it("uses real same-thread replacement and removal deltas", () => {
    let bookkeeping = createWorkflowCardHeightBookkeeping("thread-a");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    bookkeeping = consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").bookkeeping;

    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 156);
    const replacement = consumeWorkflowCardHeightDelta(bookkeeping, "thread-a");
    expect(replacement.heightDelta).toBe(36);

    bookkeeping = recordWorkflowCardHeight(replacement.bookkeeping, "thread-a", 0);
    expect(consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").heightDelta).toBe(-156);
  });

  it("treats a card appearing after a same-owner empty baseline as a real mount", () => {
    let bookkeeping = createWorkflowCardHeightBookkeeping("thread-a");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 0);
    expect(bookkeeping.hasBaseline).toBe(true);
    expect(consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").heightDelta).toBe(0);

    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    expect(consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").heightDelta).toBe(120);
  });

  it("does not enqueue compensation for a repeated settled height", () => {
    let bookkeeping = createWorkflowCardHeightBookkeeping("thread-a");
    bookkeeping = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    bookkeeping = consumeWorkflowCardHeightDelta(bookkeeping, "thread-a").bookkeeping;

    const repeated = recordWorkflowCardHeight(bookkeeping, "thread-a", 120);
    expect(repeated).toBe(bookkeeping);
    expect(consumeWorkflowCardHeightDelta(repeated, "thread-a").heightDelta).toBe(0);
  });
});

describe("resolveWorkflowCardScrollCompensation", () => {
  const ALL_MODES: readonly TimelineScrollMode[] = [
    "following-end",
    "anchoring-new-turn",
    "free-scrolling",
  ];
  const state = buildState({
    positions: [0, 300, 460],
    sizes: [240, 80, 140],
    scroll: 320,
  });

  it("ignores zero and non-finite deltas in every mode", () => {
    for (const mode of ALL_MODES) {
      expect(resolveWorkflowCardScrollCompensation({ mode, heightDelta: 0, state })).toEqual({
        kind: "none",
      });
      expect(
        resolveWorkflowCardScrollCompensation({ mode, heightDelta: Number.NaN, state }),
      ).toEqual({ kind: "none" });
    }
  });

  it("does nothing when the list state is missing or has no rows", () => {
    for (const mode of ALL_MODES) {
      expect(resolveWorkflowCardScrollCompensation({ mode, heightDelta: 48, state: null })).toEqual(
        { kind: "none" },
      );
      expect(
        resolveWorkflowCardScrollCompensation({ mode, heightDelta: 48, state: undefined }),
      ).toEqual({ kind: "none" });
      expect(
        resolveWorkflowCardScrollCompensation({
          mode,
          heightDelta: 48,
          state: buildState({ positions: [], sizes: [] }),
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("restores the latest row in following-end mode for positive and negative deltas", () => {
    expect(
      resolveWorkflowCardScrollCompensation({ mode: "following-end", heightDelta: 48, state }),
    ).toEqual({ kind: "restore-end" });
    expect(
      resolveWorkflowCardScrollCompensation({ mode: "following-end", heightDelta: -48, state }),
    ).toEqual({ kind: "restore-end" });
  });

  it("revalidates the anchor in anchoring-new-turn mode without clearing it", () => {
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "anchoring-new-turn",
        heightDelta: 48,
        state,
      }),
    ).toEqual({ kind: "revalidate-anchor" });
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "anchoring-new-turn",
        heightDelta: -48,
        state,
      }),
    ).toEqual({ kind: "revalidate-anchor" });
  });

  it("shifts the offset by the measured delta in free-scrolling mode", () => {
    expect(
      resolveWorkflowCardScrollCompensation({ mode: "free-scrolling", heightDelta: 48, state }),
    ).toEqual({ kind: "preserve-offset", offsetDelta: 48, targetOffset: 368 });
    expect(
      resolveWorkflowCardScrollCompensation({ mode: "free-scrolling", heightDelta: -48, state }),
    ).toEqual({ kind: "preserve-offset", offsetDelta: -48, targetOffset: 272 });
  });

  it("clamps the preserved offset at zero for large negative deltas", () => {
    expect(
      resolveWorkflowCardScrollCompensation({ mode: "free-scrolling", heightDelta: -9999, state }),
    ).toEqual({ kind: "preserve-offset", offsetDelta: -9999, targetOffset: 0 });
  });

  it("treats a non-finite current scroll as zero when preserving offset", () => {
    const weirdState = { ...state, scroll: Number.NaN };
    expect(
      resolveWorkflowCardScrollCompensation({
        mode: "free-scrolling",
        heightDelta: 48,
        state: weirdState,
      }),
    ).toEqual({ kind: "preserve-offset", offsetDelta: 48, targetOffset: 48 });
  });
});
