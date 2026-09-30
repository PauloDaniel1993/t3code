import { describe, expect, it } from "vite-plus/test";

import type { StarMapCamera } from "./starMapCamera";
import {
  STAR_MAP_CAMERA_EASE_MS,
  STAR_MAP_CLICK_DRAG_TOLERANCE_PX,
  STAR_MAP_HIT_TOLERANCE_SCREEN_PX,
  STAR_MAP_NARROW_PANEL_THRESHOLD_PX,
  STAR_MAP_SPLIT_BREAKPOINT_PX,
  cameraEaseProgress,
  cameraForNodeFocus,
  defaultStarMapView,
  easeOutCubic,
  hitTestStarMap,
  interpolateCamera,
  shouldSplitStarMapDetail,
  zoomFactorFromWheelDelta,
} from "./starMapInteraction";
import type { StarMapLayoutResult } from "./starMapLayout";

function makeLayout(
  positions: ReadonlyArray<{ id: string; x: number; y: number }>,
): StarMapLayoutResult {
  return {
    positions,
    positionById: new Map(positions.map((position) => [position.id, position])),
    boundingRadius: 100,
    iterations: 1,
    pairChecks: 1,
  };
}

describe("defaultStarMapView", () => {
  it("defaults to the map on a wide panel", () => {
    expect(defaultStarMapView({ containerWidthPx: 500, prefersReducedMotion: false })).toBe("map");
  });

  it("defaults to the list below the narrow threshold", () => {
    expect(
      defaultStarMapView({
        containerWidthPx: STAR_MAP_NARROW_PANEL_THRESHOLD_PX - 1,
        prefersReducedMotion: false,
      }),
    ).toBe("list");
    expect(
      defaultStarMapView({
        containerWidthPx: STAR_MAP_NARROW_PANEL_THRESHOLD_PX,
        prefersReducedMotion: false,
      }),
    ).toBe("map");
  });

  it("defaults to the list under reduced motion regardless of width", () => {
    expect(defaultStarMapView({ containerWidthPx: 1200, prefersReducedMotion: true })).toBe("list");
  });
});

describe("shouldSplitStarMapDetail", () => {
  it("splits at and above the breakpoint only", () => {
    expect(shouldSplitStarMapDetail(STAR_MAP_SPLIT_BREAKPOINT_PX - 1)).toBe(false);
    expect(shouldSplitStarMapDetail(STAR_MAP_SPLIT_BREAKPOINT_PX)).toBe(true);
    expect(shouldSplitStarMapDetail(STAR_MAP_SPLIT_BREAKPOINT_PX + 400)).toBe(true);
  });
});

describe("zoomFactorFromWheelDelta", () => {
  it("zooms in on scroll up and out on scroll down", () => {
    const zoomIn = zoomFactorFromWheelDelta({
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
    });
    const zoomOut = zoomFactorFromWheelDelta({
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
    });
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomOut).toBeLessThan(1);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 10);
  });

  it("returns exactly 1 for a zero or non-finite delta", () => {
    expect(
      zoomFactorFromWheelDelta({ deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false }),
    ).toBe(1);
    expect(
      zoomFactorFromWheelDelta({
        deltaY: Number.NaN,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBe(1);
  });

  it("scales line-mode deltas up to pixels", () => {
    const pixelFactor = zoomFactorFromWheelDelta({
      deltaY: 16,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
    });
    const lineFactor = zoomFactorFromWheelDelta({
      deltaY: 1,
      deltaMode: 1,
      ctrlKey: false,
      metaKey: false,
    });
    expect(lineFactor).toBeCloseTo(pixelFactor, 10);
  });

  it("amplifies ctrl/cmd wheel (pinch) relative to a plain wheel", () => {
    const plain = zoomFactorFromWheelDelta({
      deltaY: 20,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
    });
    const pinch = zoomFactorFromWheelDelta({
      deltaY: 20,
      deltaMode: 0,
      ctrlKey: true,
      metaKey: false,
    });
    expect(1 - pinch).toBeGreaterThan(1 - plain);
  });

  it("clamps a single event so a wheel fling cannot skip the zoom range", () => {
    const factor = zoomFactorFromWheelDelta({
      deltaY: -100_000,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
    });
    expect(factor).toBeLessThanOrEqual(1.6);
  });
});

describe("hitTestStarMap", () => {
  const layout = makeLayout([
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 100, y: 0 },
  ]);

  it("returns the star within tolerance", () => {
    expect(hitTestStarMap(layout, { x: 3, y: 4 }, 10)).toBe("a");
  });

  it("returns null outside tolerance", () => {
    expect(hitTestStarMap(layout, { x: 40, y: 40 }, 10)).toBeNull();
  });

  it("picks the nearest star when several are within tolerance", () => {
    expect(hitTestStarMap(layout, { x: 55, y: 0 }, 60)).toBe("b");
  });

  it("prefers the earlier node on an exact tie, matching label determinism", () => {
    expect(hitTestStarMap(layout, { x: 50, y: 0 }, 60)).toBe("a");
  });

  it("returns null for an empty layout", () => {
    expect(hitTestStarMap(makeLayout([]), { x: 0, y: 0 }, 100)).toBeNull();
  });
});

describe("camera easing", () => {
  const from: StarMapCamera = { centerX: 0, centerY: 0, scale: 1 };
  const to: StarMapCamera = { centerX: 100, centerY: -50, scale: 2 };

  it("easeOutCubic hits both endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("cameraEaseProgress clamps to [0, 1]", () => {
    expect(cameraEaseProgress(-5, STAR_MAP_CAMERA_EASE_MS)).toBe(0);
    expect(cameraEaseProgress(STAR_MAP_CAMERA_EASE_MS * 2, STAR_MAP_CAMERA_EASE_MS)).toBe(1);
    expect(cameraEaseProgress(0, 0)).toBe(1);
  });

  it("interpolateCamera lands on the endpoints", () => {
    expect(interpolateCamera(from, to, 0)).toEqual(from);
    expect(interpolateCamera(from, to, 1)).toEqual(to);
  });

  it("interpolateCamera eases out rather than moving linearly", () => {
    const halfway = interpolateCamera(from, to, 0.5);
    // easeOutCubic(0.5) = 0.875 — most of the move happens in the first half.
    expect(halfway.centerX).toBeCloseTo(87.5, 5);
    expect(halfway.centerY).toBeCloseTo(-43.75, 5);
    expect(halfway.scale).toBeCloseTo(1.875, 5);
  });

  it("cameraForNodeFocus centres the node and keeps the current zoom", () => {
    const layout = makeLayout([{ id: "a", x: 120, y: -80 }]);
    expect(cameraForNodeFocus(layout, "a", { centerX: 0, centerY: 0, scale: 1.5 })).toEqual({
      centerX: 120,
      centerY: -80,
      scale: 1.5,
    });
  });

  it("cameraForNodeFocus returns null for an unknown node", () => {
    const layout = makeLayout([{ id: "a", x: 0, y: 0 }]);
    expect(cameraForNodeFocus(layout, "missing", from)).toBeNull();
  });
});

describe("exported constants", () => {
  it("keeps gesture and breakpoint constants in their documented ranges", () => {
    expect(STAR_MAP_CLICK_DRAG_TOLERANCE_PX).toBeGreaterThan(0);
    expect(STAR_MAP_HIT_TOLERANCE_SCREEN_PX).toBeGreaterThan(STAR_MAP_CLICK_DRAG_TOLERANCE_PX);
    expect(STAR_MAP_SPLIT_BREAKPOINT_PX).toBeGreaterThan(STAR_MAP_NARROW_PANEL_THRESHOLD_PX);
    expect(STAR_MAP_CAMERA_EASE_MS).toBeGreaterThan(0);
  });
});
